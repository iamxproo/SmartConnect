// Email ownership verification (identity.verification_tokens, purpose email_verification). A verified address is
// required wherever an email address grants something: creating organizations, accepting invitations (ADR 0010).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';
import { generateOpaqueToken, OPAQUE_TOKEN, sha256Hex } from '../crypto/tokens.js';
import type { Prisma } from '../database/client.js';
import { PRISMA, type IdentityPrisma } from '../database/prisma.token.js';
import { ACCOUNT_NOTIFIER, notifySafely, type AccountNotifier } from '../notifications/account-notifier.js';
import { invalidVerificationToken } from './errors.js';

export interface IssuedVerification {
  to: string;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger('EmailVerification');

  constructor(
    @Inject(PRISMA) private readonly prisma: IdentityPrisma,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
    @Inject(ACCOUNT_NOTIFIER) private readonly notifier: AccountNotifier,
  ) {}

  /** Creates a token inside the caller's transaction; only the newest one is valid. Send it after commit. */
  async issue(tx: Prisma.TransactionClient, userId: string, to: string): Promise<IssuedVerification> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.config.emailVerificationTtlSeconds * 1000);
    await tx.verificationToken.deleteMany({ where: { userId, purpose: 'email_verification', consumedAt: null } });
    await tx.verificationToken.create({
      data: { userId, purpose: 'email_verification', tokenHash: sha256Hex(token), expiresAt },
    });
    return { to, token, expiresAt };
  }

  async send({ to, token, expiresAt }: IssuedVerification): Promise<void> {
    const link = `${this.config.webAppUrl}/verify-email#token=${token}`;
    await notifySafely(this.notifier, this.logger, { kind: 'email_verification', to, token, link, expiresAt });
  }

  /** Sends a fresh link if the caller's address is not verified yet. Silent otherwise. */
  async resend(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, status: true, deletedAt: true },
    });
    if (!user || user.emailVerifiedAt || user.status !== 'active' || user.deletedAt) return;
    const issued = await this.prisma.$transaction((tx) => this.issue(tx, userId, user.email));
    await this.send(issued);
  }

  /** Consumes the token atomically (single use) and marks the address verified. */
  async verify(token: string): Promise<void> {
    if (!OPAQUE_TOKEN.test(token)) throw invalidVerificationToken();
    const tokenHash = sha256Hex(token);
    const verified = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const consumed = await tx.verificationToken.updateMany({
        where: { tokenHash, purpose: 'email_verification', consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return false;
      const { userId } = await tx.verificationToken.findUniqueOrThrow({
        where: { tokenHash },
        select: { userId: true },
      });
      await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      return true;
    });
    if (!verified) throw invalidVerificationToken();
  }
}
