// Sessions and their rotating refresh tokens (identity.sessions; ADR 0009). A session IS the refresh-token family:
// the table keeps the hash of the current token and of the one it replaced. Every state change is one atomic SQL
// statement, so concurrent requests cannot both succeed with the same token.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { requestIdOf, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { isIP } from 'node:net';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';
import { generateOpaqueToken, OPAQUE_TOKEN, sha256Hex } from '../crypto/tokens.js';
import type { Prisma } from '../database/client.js';
import { PRISMA, type IdentityPrisma } from '../database/prisma.token.js';
import { recordEvents, sessionRevoked, type SessionRevocationReason } from '../events/outbox.js';
import { invalidRefreshToken } from './errors.js';

export interface ClientMetadata {
  /** As resolved through the gateway (X-Forwarded-For, TRUST_PROXY_HOPS). */
  ipAddress: string | null;
  userAgent: string | null;
}

export function clientMetadataOf(req: Request): ClientMetadata {
  const ip = req.ip && isIP(req.ip) ? req.ip : null;
  const userAgent = req.get('user-agent')?.slice(0, 512) || null;
  return { ipAddress: ip, userAgent };
}

export interface SessionHandle {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionView {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

type Db = IdentityPrisma | Prisma.TransactionClient;

@Injectable()
export class SessionService {
  private readonly logger = new Logger('Sessions');

  constructor(
    @Inject(PRISMA) private readonly prisma: IdentityPrisma,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  /** Seconds a new or refreshed session lives: the idle timeout, never beyond the absolute maximum. */
  private get initialLifetimeSeconds(): number {
    return Math.min(this.config.refreshIdleTtlSeconds, this.config.sessionMaxLifetimeSeconds);
  }

  async create(
    tx: Prisma.TransactionClient,
    userId: string,
    client: ClientMetadata,
  ): Promise<{ session: SessionHandle; refreshToken: string }> {
    const refreshToken = generateOpaqueToken();
    const session = await tx.session.create({
      data: {
        userId,
        refreshTokenHash: sha256Hex(refreshToken),
        ipAddress: client.ipAddress,
        userAgent: client.userAgent,
        expiresAt: new Date(Date.now() + this.initialLifetimeSeconds * 1000),
      },
      select: { id: true, userId: true, expiresAt: true },
    });
    return { session, refreshToken };
  }

  /**
   * Exchanges a refresh token for a new one. Exactly one of any number of concurrent calls with the same token can
   * match the UPDATE. Every other call, and any later replay, presents what is now the session's PREVIOUS token:
   * that is treated as theft, and the whole session is revoked (OAuth 2.0 Security BCP, refresh token rotation).
   */
  async rotate(req: Request, refreshToken: string): Promise<{ session: SessionHandle; refreshToken: string }> {
    if (!OPAQUE_TOKEN.test(refreshToken)) throw invalidRefreshToken();
    const presented = sha256Hex(refreshToken);
    const next = generateOpaqueToken();
    const rotated = await this.prisma.$queryRaw<SessionHandle[]>`
      UPDATE "sessions"
         SET "previous_refresh_token_hash" = "refresh_token_hash",
             "refresh_token_hash" = ${sha256Hex(next)},
             "last_used_at" = now(),
             "expires_at" = LEAST(
               now() + make_interval(secs => ${this.config.refreshIdleTtlSeconds}::double precision),
               "created_at" + make_interval(secs => ${this.config.sessionMaxLifetimeSeconds}::double precision)),
             "updated_at" = now()
       WHERE "refresh_token_hash" = ${presented}
         AND "revoked_at" IS NULL
         AND "expires_at" > now()
   RETURNING "id", "user_id" AS "userId", "expires_at" AS "expiresAt"`;
    const session = rotated[0];
    if (session) return { session, refreshToken: next };

    await this.prisma.$transaction(async (tx) => {
      const reused = await tx.$queryRaw<{ id: string; userId: string }[]>`
        UPDATE "sessions"
           SET "revoked_at" = now(), "revoked_reason" = 'refresh_token_reuse', "updated_at" = now()
         WHERE "previous_refresh_token_hash" = ${presented} AND "revoked_at" IS NULL
     RETURNING "id", "user_id" AS "userId"`;
      for (const { id, userId } of reused) {
        this.logger.warn({ event: 'refresh_token_reuse_detected', sessionId: id, userId, requestId: requestIdOf(req) });
      }
      await recordEvents(
        tx,
        reused.map(({ id, userId }) => sessionRevoked(id, userId, 'refresh_token_reuse')),
      );
    });
    throw invalidRefreshToken();
  }

  /** Ends the session a refresh token belongs to. Silent when the token is unknown (logout is idempotent). */
  async revokeByRefreshToken(refreshToken: string, reason: SessionRevocationReason): Promise<void> {
    if (!OPAQUE_TOKEN.test(refreshToken)) return;
    await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.$queryRaw<{ id: string; userId: string }[]>`
        UPDATE "sessions"
           SET "revoked_at" = now(), "revoked_reason" = ${reason}, "updated_at" = now()
         WHERE "refresh_token_hash" = ${sha256Hex(refreshToken)} AND "revoked_at" IS NULL
     RETURNING "id", "user_id" AS "userId"`;
      await recordEvents(
        tx,
        revoked.map(({ id, userId }) => sessionRevoked(id, userId, reason)),
      );
    });
  }

  /** Ends one of the user's own active sessions. False when no such session exists FOR THIS USER. */
  async revokeOwned(userId: string, sessionId: string, reason: SessionRevocationReason): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "sessions"
           SET "revoked_at" = now(), "revoked_reason" = ${reason}, "updated_at" = now()
         WHERE "id" = ${sessionId}::uuid AND "user_id" = ${userId}::uuid
           AND "revoked_at" IS NULL AND "expires_at" > now()
     RETURNING "id"`;
      await recordEvents(
        tx,
        revoked.map(({ id }) => sessionRevoked(id, userId, reason)),
      );
      return revoked.length === 1;
    });
  }

  /** Ends all of a user's active sessions, optionally except one (the caller's). Returns how many ended. */
  async revokeAllForUser(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: SessionRevocationReason,
    exceptSessionId?: string,
  ): Promise<number> {
    const revoked = exceptSessionId
      ? await tx.$queryRaw<{ id: string }[]>`
          UPDATE "sessions"
             SET "revoked_at" = now(), "revoked_reason" = ${reason}, "updated_at" = now()
           WHERE "user_id" = ${userId}::uuid AND "revoked_at" IS NULL AND "expires_at" > now()
             AND "id" <> ${exceptSessionId}::uuid
       RETURNING "id"`
      : await tx.$queryRaw<{ id: string }[]>`
          UPDATE "sessions"
             SET "revoked_at" = now(), "revoked_reason" = ${reason}, "updated_at" = now()
           WHERE "user_id" = ${userId}::uuid AND "revoked_at" IS NULL AND "expires_at" > now()
       RETURNING "id"`;
    await recordEvents(
      tx,
      revoked.map(({ id }) => sessionRevoked(id, userId, reason)),
    );
    return revoked.length;
  }

  /** The principal's session is still active (not revoked, not expired, and really the user's). */
  async isActive(principal: Principal, db: Db = this.prisma): Promise<boolean> {
    const session = await db.session.findFirst({
      where: { id: principal.sessionId, userId: principal.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return session !== null;
  }

  /** The user's active sessions, newest first (UUIDv7 ids are time-ordered), keyset-paginated by id. */
  async listActive(
    principal: Principal,
    limit: number,
    afterId?: string,
  ): Promise<{ sessions: SessionView[]; nextAfterId: string | null }> {
    const rows = await this.prisma.session.findMany({
      where: {
        userId: principal.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(afterId ? { id: { lt: afterId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, ipAddress: true, userAgent: true },
    });
    const page = rows.slice(0, limit);
    return {
      sessions: page.map((row) => ({ ...row, current: row.id === principal.sessionId })),
      nextAfterId: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }
}
