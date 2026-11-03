// The DEVELOPMENT Super Admin (ADR 0015): one account with the super_admin platform role, created or reset by
// `make admin-seed`. Like `make db-seed`, it writes through the identity service's own runtime credentials and code
// (Prisma client, Argon2id PasswordHasher), and only to the local development database. Unlike it, the initial
// password is never in source: the person types it at a hidden prompt, and it must be replaced at the first sign-in.
import { PasswordHasher } from '../services/identity/src/crypto/password-hasher.js';
import { normalizeEmail } from '../services/identity/src/crypto/tokens.js';
import type { IdentityPrisma } from '../services/identity/src/database/prisma.token.js';

/** `.localhost` is reserved (RFC 6761) and never routable: no email to this account can leave the machine. */
export const SUPER_ADMIN_EMAIL = 'admin@smartconnect.localhost';
export const SUPER_ADMIN_DISPLAY_NAME = 'Super Admin';
/** Development only, and replaced at the first sign-in, where the normal 12-character policy applies. */
export const INITIAL_PASSWORD_MIN_LENGTH = 8;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Throws unless this is an explicit local development setup: NODE_ENV unset or "development" (never test, staging
 * or production), and the database is the local development instance (`smartconnect` on the development port).
 */
export function assertDevelopmentSeed(env: Record<string, string | undefined>, databaseUrl: string, devPort: number) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development') {
    throw new Error(`refusing to seed the Super Admin with NODE_ENV=${nodeEnv}: development only`);
  }
  const { hostname, port, pathname } = new URL(databaseUrl);
  if (!LOCAL_HOSTS.has(hostname) || Number(port || 5432) !== devPort || pathname !== '/smartconnect') {
    throw new Error(
      `refusing to seed the Super Admin outside the local development database (${hostname}:${port}${pathname})`,
    );
  }
}

/**
 * Creates the account, or resets it if it exists: active, email verified, the given password (Argon2id) marked
 * "change required", and the super_admin role. A reset is a password reset: every session of the account ends.
 */
export async function seedSuperAdmin(
  db: IdentityPrisma,
  password: string,
  { email = SUPER_ADMIN_EMAIL, hasher = new PasswordHasher() }: { email?: string; hasher?: PasswordHasher } = {},
): Promise<{ userId: string; created: boolean }> {
  if (password.length < INITIAL_PASSWORD_MIN_LENGTH) {
    throw new Error(`the initial password needs at least ${INITIAL_PASSWORD_MIN_LENGTH} characters`);
  }
  const secret = await hasher.hash(password);
  const emailNormalized = normalizeEmail(email);
  return db.$transaction(async (tx) => {
    const now = new Date();
    const existing = await tx.user.findUnique({ where: { emailNormalized }, select: { id: true } });
    const { id: userId } =
      existing ??
      (await tx.user.create({
        data: { email, emailNormalized, profile: { create: { displayName: SUPER_ADMIN_DISPLAY_NAME } } },
        select: { id: true },
      }));
    await tx.user.update({ where: { id: userId }, data: { status: 'active', deletedAt: null } });
    await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    await tx.credential.upsert({
      where: { userId_type: { userId, type: 'password' } },
      create: { userId, type: 'password', secret, changeRequired: true },
      update: { secret, changeRequired: true },
    });
    await tx.platformRoleAssignment.upsert({
      where: { userId_role: { userId, role: 'super_admin' } },
      create: { userId, role: 'super_admin' },
      update: {},
    });
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'password_reset' },
    });
    await tx.verificationToken.updateMany({
      where: { userId, purpose: 'password_reset', consumedAt: null },
      data: { consumedAt: now },
    });
    return { userId, created: !existing };
  });
}
