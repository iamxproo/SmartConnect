// Database access for the organization service: the only module that constructs a PrismaClient.
// Runtime connections use DATABASE_URL (role sc_organization_app: DML only, no DDL), never the migrator role.
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';

export const DATABASE_SCHEMA = 'organization';

export interface CreatePrismaClientOptions {
  connectionString?: string;
  /** Pool size per instance. Budget: 14 services × 5 = 70 of the dev server's 100 connections; each
   *  role is capped at CONNECTION LIMIT 25. Production pools through PgBouncer (docs/database/architecture.md). */
  maxConnections?: number;
}

export function createPrismaClient({
  connectionString = process.env.DATABASE_URL,
  maxConnections = 5,
}: CreatePrismaClientOptions = {}): PrismaClient {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const adapter = new PrismaPg({ connectionString, max: maxConnections }, { schema: DATABASE_SCHEMA });
  return new PrismaClient({ adapter });
}

export type { Prisma };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantContext {
  organizationId: string;
  userId?: string;
}

/**
 * Runs `fn` in a transaction bound to one organization. Row-level security policies read
 * app.current_organization_id / app.current_user_id; set_config(..., true) scopes them to this
 * transaction, so pooled connections never leak tenant context (also safe behind PgBouncer in
 * transaction mode). Tenant tables queried outside withTenant() return no rows: RLS fails closed.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  context: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<T> {
  if (!UUID.test(context.organizationId) || (context.userId !== undefined && !UUID.test(context.userId))) {
    throw new Error('withTenant: organizationId and userId must be UUIDs');
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${context.organizationId}, true),
                                set_config('app.current_user_id', ${context.userId ?? ''}, true)`;
      return fn(tx);
    },
    { timeout: timeoutMs },
  );
}

/**
 * Cross-organization reads for one signed-in user (organization switcher, "my invitations"). Only the
 * user-scoped `member_read` / `self_read` policies apply: the user sees the organizations, roles and
 * memberships they belong to, and nothing tenant-scoped. Writes still require withTenant().
 */
export async function withUser<T>(
  prisma: PrismaClient,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<T> {
  if (!UUID.test(userId)) throw new Error('withUser: userId must be a UUID');
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx);
    },
    { timeout: timeoutMs },
  );
}

/**
 * Creating an organization: one transaction in two phases. `decide` runs first with the user context only, so only the
 * user-scoped read policies apply (exactly as in withUser: the caller's own memberships and organizations, nothing
 * tenant-scoped); `create` then runs in the new organization's tenant context (exactly as in withTenant), which is the
 * only place it can write. Being one transaction lets an advisory lock taken in `decide` cover both, so a decision
 * from the caller's other organizations (a cap, a repeated request) still holds when the new one is written.
 */
export async function withUserThenNewTenant<D, T>(
  prisma: PrismaClient,
  context: { userId: string; organizationId: string },
  decide: (tx: Prisma.TransactionClient) => Promise<D>,
  create: (tx: Prisma.TransactionClient, decided: D) => Promise<T>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<T> {
  if (!UUID.test(context.userId) || !UUID.test(context.organizationId)) {
    throw new Error('withUserThenNewTenant: userId and organizationId must be UUIDs');
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', '', true),
                                set_config('app.current_user_id', ${context.userId}, true)`;
      const decided = await decide(tx);
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${context.organizationId}, true)`;
      return create(tx, decided);
    },
    { timeout: timeoutMs },
  );
}
