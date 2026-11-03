// Password reset (single-use, expiring, hashed tokens in identity.verification_tokens) and password change.
// A reset ends EVERY session (the account may be compromised); a change ends every session except the caller's.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@smartconnect/backend-kit';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { generateOpaqueToken, normalizeEmail, OPAQUE_TOKEN, sha256Hex } from '../crypto/tokens.js';
import type { Prisma } from '../database/client.js';
import { PRISMA, type IdentityPrisma } from '../database/prisma.token.js';
import { recordEvents } from '../events/outbox.js';
import { ACCOUNT_NOTIFIER, notifySafely, type AccountNotifier } from '../notifications/account-notifier.js';
import { currentPasswordIncorrect, invalidResetToken, newPasswordSameAsIssued } from './errors.js';
import { SessionService } from './session.service.js';

class ResetRejected extends Error {}

@Injectable()
export class PasswordService {
  private readonly logger = new Logger('Password');

  constructor(
    @Inject(PRISMA) private readonly prisma: IdentityPrisma,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ACCOUNT_NOTIFIER) private readonly notifier: AccountNotifier,
  ) {}

  /** Issues a reset token if (and only if) an active account with a password exists. The caller learns nothing. */
  async requestReset(emailInput: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalizeEmail(emailInput) },
      select: { id: true, email: true, status: true, deletedAt: true, credentials: { where: { type: 'password' } } },
    });
    if (!user || user.status !== 'active' || user.deletedAt || user.credentials.length === 0) return;

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.config.passwordResetTtlSeconds * 1000);
    await this.prisma.$transaction([
      // Only the newest link works: earlier unused ones are discarded.
      this.prisma.verificationToken.deleteMany({
        where: { userId: user.id, purpose: 'password_reset', consumedAt: null },
      }),
      this.prisma.verificationToken.create({
        data: { userId: user.id, purpose: 'password_reset', tokenHash: sha256Hex(token), expiresAt },
      }),
    ]);
    const link = `${this.config.webAppUrl}/reset-password#token=${token}`;
    await notifySafely(this.notifier, this.logger, { kind: 'password_reset', to: user.email, token, link, expiresAt });
  }

  /** Consumes the token atomically (single use, even under concurrent requests), sets the password, ends sessions. */
  async reset(token: string, newPassword: string): Promise<void> {
    if (!OPAQUE_TOKEN.test(token)) throw invalidResetToken();
    const tokenHash = sha256Hex(token);
    const secret = await this.hasher.hash(newPassword);
    let email: string;
    try {
      email = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const consumed = await tx.verificationToken.updateMany({
          where: { tokenHash, purpose: 'password_reset', consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw new ResetRejected();
        const { userId } = await tx.verificationToken.findUniqueOrThrow({
          where: { tokenHash },
          select: { userId: true },
        });
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { email: true, status: true, deletedAt: true },
        });
        if (user?.status !== 'active' || user.deletedAt) throw new ResetRejected();
        await this.setPassword(tx, userId, secret);
        // The reset link reached this inbox, which proves control of the address.
        await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
        await this.sessions.revokeAllForUser(tx, userId, 'password_reset');
        await recordEvents(tx, [
          {
            eventType: 'identity.user.password_changed',
            aggregateType: 'user',
            aggregateId: userId,
            payload: { userId, method: 'reset' },
          },
        ]);
        return user.email;
      });
    } catch (error) {
      if (error instanceof ResetRejected) throw invalidResetToken();
      throw error;
    }
    await notifySafely(this.notifier, this.logger, { kind: 'password_changed', to: email });
  }

  async change(principal: Principal, currentPassword: string, newPassword: string): Promise<void> {
    const credential = await this.prisma.credential.findUnique({
      where: { userId_type: { userId: principal.userId, type: 'password' } },
      select: { secret: true, changeRequired: true, user: { select: { email: true } } },
    });
    if (!credential || !(await this.hasher.verify(credential.secret, currentPassword))) {
      throw currentPasswordIncorrect();
    }
    // An issued password (ADR 0015) must really be replaced, not re-entered.
    if (credential.changeRequired && (await this.hasher.verify(credential.secret, newPassword))) {
      throw newPasswordSameAsIssued();
    }
    const secret = await this.hasher.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await this.setPassword(tx, principal.userId, secret);
      await this.sessions.revokeAllForUser(tx, principal.userId, 'password_changed', principal.sessionId);
      await recordEvents(tx, [
        {
          eventType: 'identity.user.password_changed',
          aggregateType: 'user',
          aggregateId: principal.userId,
          payload: { userId: principal.userId, method: 'change' },
        },
      ]);
    });
    await notifySafely(this.notifier, this.logger, { kind: 'password_changed', to: credential.user.email });
  }

  /**
   * Sets the password hash and invalidates every outstanding reset link for the user. The password is now the
   * holder's own, so an issued-password flag (ADR 0015) is cleared.
   */
  private async setPassword(tx: Prisma.TransactionClient, userId: string, secret: string): Promise<void> {
    await tx.credential.upsert({
      where: { userId_type: { userId, type: 'password' } },
      create: { userId, type: 'password', secret },
      update: { secret, changeRequired: false },
    });
    await tx.verificationToken.updateMany({
      where: { userId, purpose: 'password_reset', consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
}
