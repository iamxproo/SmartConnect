// Database access for the identity service: the only module that constructs a PrismaClient.
// Runtime connections use DATABASE_URL (role sc_identity_app: DML only, no DDL), never the migrator role.
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';

export const DATABASE_SCHEMA = 'identity';

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

// Identity data is global: one account can belong to many organizations, so these tables carry no
// organization_id and no row-level security. Isolation is enforced per user id in the service layer,
// and the runtime role can reach nothing outside the identity schema.
