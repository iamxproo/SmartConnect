// Registration, login, refresh and logout (ADR 0009). The caller is identified only by credentials it presents
// (password, refresh token) or by the verified access-token principal; never by ids in the request.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { PasswordHasher } from '../crypto/password-hasher.js';
import { normalizeEmail } from '../crypto/tokens.js';
import { PRISMA, type IdentityPrisma } from '../database/prisma.token.js';
import { recordEvents } from '../events/outbox.js';
import { ACCOUNT_NOTIFIER, notifySafely, type AccountNotifier } from '../notifications/account-notifier.js';
import { AccessTokenIssuer } from './access-token-issuer.js';
import type { LoginDto, MeDto, RegisterDto } from './dto.js';
import { EmailVerificationService, type IssuedVerification } from './email-verification.service.js';
import { invalidCredentials, invalidRefreshToken, isUniqueViolation, sessionEnded } from './errors.js';
import { SessionService, type ClientMetadata, type SessionHandle } from './session.service.js';

export interface IssuedTokens {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  sessionId: string;
  sessionExpiresAt: Date;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(PRISMA) private readonly prisma: IdentityPrisma,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(AccessTokenIssuer) private readonly issuer: AccessTokenIssuer,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ACCOUNT_NOTIFIER) private readonly notifier: AccountNotifier,
    @Inject(EmailVerificationService) private readonly verification: EmailVerificationService,
  ) {}

  /**
   * Creates the account, or (if the address is taken) notifies the address's owner instead. Both paths hash the
   * password and return the same response, so registration cannot be used to discover accounts.
   */
  async register(input: RegisterDto): Promise<void> {
    const email = input.email.trim();
    const emailNormalized = normalizeEmail(email);
    const secret = await this.hasher.hash(input.password);
    let verification: IssuedVerification;
    try {
      verification = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            emailNormalized,
            profile: { create: { displayName: input.displayName } },
            credentials: { create: { type: 'password', secret } },
          },
          select: { id: true },
        });
        await recordEvents(tx, [
          {
            eventType: 'identity.user.registered',
            aggregateType: 'user',
            aggregateId: user.id,
            payload: { userId: user.id },
          },
        ]);
        return this.verification.issue(tx, user.id, email);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.user.findUnique({
        where: { emailNormalized },
        select: { email: true, status: true, deletedAt: true },
      });
      if (existing?.status === 'active' && !existing.deletedAt) {
        await notifySafely(this.notifier, this.logger, { kind: 'registration_attempt', to: existing.email });
      }
      return;
    }
    await this.verification.send(verification);
  }

  /**
   * The caller's own account, for clients and for other services acting on the caller's behalf. `platformRoles` and
   * `passwordChangeRequired` let the organization service apply the same Super Admin rule as this one (ADR 0015).
   */
  async me(userId: string): Promise<MeDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        status: true,
        deletedAt: true,
        profile: { select: { displayName: true } },
        platformRoles: { select: { role: true }, orderBy: { role: 'asc' } },
        credentials: { where: { type: 'password' }, select: { changeRequired: true } },
      },
    });
    // Other services rely on this answer (organization creation, invitation acceptance): an inactive account is no
    // account, even while its access token has not expired yet.
    if (!user || user.status !== 'active' || user.deletedAt) throw sessionEnded();
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      displayName: user.profile?.displayName ?? null,
      platformRoles: user.platformRoles.map((assignment) => assignment.role),
      passwordChangeRequired: user.credentials[0]?.changeRequired ?? false,
    };
  }

  async login(input: LoginDto, client: ClientMetadata): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalizeEmail(input.email) },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        credentials: { where: { type: 'password' }, select: { id: true, secret: true } },
      },
    });
    const credential = user?.credentials[0];
    // Always one Argon2 verification, against a dummy hash when there is no account: equal timing either way.
    const valid = await this.hasher.verify(credential?.secret, input.password);
    if (!user || !credential || !valid || user.status !== 'active' || user.deletedAt) throw invalidCredentials();

    const upgradedSecret = this.hasher.needsRehash(credential.secret)
      ? await this.hasher.hash(input.password)
      : undefined;
    const { session, refreshToken } = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.credential.update({
        where: { id: credential.id },
        data: { lastUsedAt: now, ...(upgradedSecret ? { secret: upgradedSecret } : {}) },
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      return this.sessions.create(tx, user.id, client);
    });
    return this.issue(session, refreshToken);
  }

  async refresh(req: Request, refreshToken: string | undefined): Promise<IssuedTokens> {
    if (!refreshToken) throw invalidRefreshToken();
    const { session, refreshToken: next } = await this.sessions.rotate(req, refreshToken);
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { status: true, deletedAt: true },
    });
    if (user?.status !== 'active' || user.deletedAt) {
      await this.sessions.revokeOwned(session.userId, session.id, 'account_inactive');
      throw invalidRefreshToken();
    }
    return this.issue(session, next);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.sessions.revokeByRefreshToken(refreshToken, 'logout');
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.sessions.revokeAllForUser(tx, userId, 'logout_all'));
  }

  async revokeOtherSessions(principal: Principal): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.sessions.revokeAllForUser(tx, principal.userId, 'revoked_others', principal.sessionId),
    );
  }

  private async issue(session: SessionHandle, refreshToken: string): Promise<IssuedTokens> {
    const access = await this.issuer.issue(session.userId, session.id);
    return {
      accessToken: access.token,
      tokenType: 'Bearer',
      expiresIn: this.issuer.ttlSeconds,
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      refreshToken,
    };
  }
}
