// Shared helpers for the database suites. Every suite runs against the DISPOSABLE test instance
// provisioned by integration/database/global-setup.ts; only infrastructure.test.ts reads (never
// writes) the dev instance.
import pg from 'pg';
import { inject } from 'vitest';

export interface ProvidedDb {
  services: Record<string, { appUrl: string; migratorUrl: string }>;
  admin: { host: string; port: number; database: string; user: string; password: string };
  /** The role that ran the bootstrap and provisioned the roles (a superuser, or a managed administrator). */
  bootstrapUser: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    db: ProvidedDb;
  }
}

const provided = () => inject('db');

export const appUrl = (svc: string): string => provided().services[svc]!.appUrl;
export const bootstrapUser = (): string => provided().bootstrapUser;
export const migratorUrl = (svc: string): string => provided().services[svc]!.migratorUrl;

export function adminUrl(database = provided().admin.database): string {
  const { host, port, user, password } = provided().admin;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/** Replaces the user's password in a connection URL (authentication-failure tests). */
export function withPassword(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.toString();
}

/** Same URL, different database (e.g. `postgres`, or a restored copy). */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  return withClient(url, async (client) => (await client.query<R>(sql, params)).rows);
}

/**
 * Runs SQL inside a transaction that is always rolled back, so probes never leave state behind.
 * Resolves to the PostgreSQL error message, or null when every statement succeeded.
 * `transaction: false` is only for statements PostgreSQL refuses inside a transaction block
 * (e.g. CREATE DATABASE); use it solely for probes that are expected to fail.
 */
export async function sqlError(
  url: string,
  sql: string,
  { params = [], transaction = true }: { params?: unknown[]; transaction?: boolean } = {},
): Promise<string | null> {
  try {
    await withClient(url, async (client) => {
      if (!transaction) {
        await client.query(sql, params);
        return;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql, params);
      } finally {
        await client.query('ROLLBACK');
      }
    });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
