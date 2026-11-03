// Database access for the presence service: the only module that constructs a PrismaClient.
// Runtime connections use DATABASE_URL (role sc_presence_app: DML only, no DDL), never the migrator role.
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';

export const DATABASE_SCHEMA = 'presence';

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
