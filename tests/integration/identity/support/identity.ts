// Builds the REAL identity service (same factory as its main.ts) against the disposable test database, using the
// identity runtime role's ephemeral credentials from the test-instance provisioning. Signing keys are generated
// in memory per suite; account emails go to an in-memory DevMailbox. Nothing touches the dev database.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ProblemDetails } from '@smartconnect/backend-kit';
import type { JWK } from 'jose';
import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import { createIdentityApp } from '../../../../smartconnect-backend/services/identity/src/app.factory.js';
import { loadConfig, type IdentityConfig } from '../../../../smartconnect-backend/services/identity/src/config.js';
import type { PasswordHasher } from '../../../../smartconnect-backend/services/identity/src/crypto/password-hasher.js';
import { createPrismaClient } from '../../../../smartconnect-backend/services/identity/src/database/client.js';
import {
  DevMailbox,
  type AccountNotifier,
} from '../../../../smartconnect-backend/services/identity/src/notifications/account-notifier.js';
import { appUrl, query } from '../../../support/database.js';

type Level = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';
export interface LogRecord {
  level: Level;
  message: unknown;
  context?: string;
}

/** Collects log records so tests can assert on them (and on what is NOT logged). */
export class CapturingLogger implements LoggerService {
  readonly records: LogRecord[] = [];
  log(message: unknown, context?: string) {
    this.records.push({ level: 'log', message, context });
  }
  error(message: unknown, _stack?: string, context?: string) {
    this.records.push({ level: 'error', message, context });
  }
  warn(message: unknown, context?: string) {
    this.records.push({ level: 'warn', message, context });
  }
  debug(message: unknown, context?: string) {
    this.records.push({ level: 'debug', message, context });
  }
  verbose(message: unknown, context?: string) {
    this.records.push({ level: 'verbose', message, context });
  }
  fatal(message: unknown, context?: string) {
    this.records.push({ level: 'fatal', message, context });
  }
  events(event: string): Record<string, unknown>[] {
    return this.records
      .map((record) => record.message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === 'object' && message !== null && (message as { event?: unknown }).event === event,
      );
  }
  /** Everything that was logged, serialised: for "never logs secrets" assertions. */
  dump(): string {
    return JSON.stringify(this.records);
  }
}

export function generateSigningKey(): JWK & { kid: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { ...(privateKey.export({ format: 'jwk' }) as JWK), kid: `test-${randomUUID()}` };
}

export interface TestIdentity {
  app: NestExpressApplication;
  server: Server;
  config: IdentityConfig;
  mailbox: DevMailbox;
  logger: CapturingLogger;
  /** Public JWKS (JSON) for a gateway that should trust this identity service. */
  publicJwks: string;
  close(): Promise<void>;
}

export async function startIdentity(
  options: {
    env?: Record<string, string>;
    hasher?: PasswordHasher;
    listen?: boolean;
    /** Replaces the DevMailbox; built with the service's capturing logger so log assertions see everything. */
    notifier?: (logger: CapturingLogger) => AccountNotifier;
  } = {},
): Promise<TestIdentity> {
  const signingKey = generateSigningKey();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl('identity'),
    AUTH_JWT_PRIVATE_JWK: JSON.stringify(signingKey),
    ...options.env,
  });
  const prisma = createPrismaClient({ connectionString: config.databaseUrl, maxConnections: 8 });
  const mailbox = new DevMailbox();
  const logger = new CapturingLogger();
  const notifier = options.notifier?.(logger) ?? mailbox;
  const app = await createIdentityApp({ config, logger, prisma, notifier, hasher: options.hasher });
  if (options.listen) await app.listen(0, '127.0.0.1');
  else await app.init();
  const { kty, crv, x, kid } = signingKey;
  return {
    app,
    server: app.getHttpServer(),
    config,
    mailbox,
    logger,
    publicJwks: JSON.stringify({ keys: [{ kty, crv, x, kid, alg: 'EdDSA', use: 'sig' }] }),
    close: () => app.close(), // also disconnects Prisma (PrismaLifecycle)
  };
}

export function urlOf(identity: TestIdentity): string {
  const { port } = identity.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// ---- Data helpers -----------------------------------------------------------------------------------------------

export const uniqueEmail = (label = 'user') => `${label}-${randomUUID()}@example.com`;
export const PASSWORD = 'correct horse battery staple';

export const problemOf = (res: Response) => res.body as ProblemDetails;

export async function register(
  server: Server,
  email = uniqueEmail(),
  password = PASSWORD,
  displayName = 'Test User',
): Promise<{ email: string; password: string }> {
  await request(server).post('/api/v1/auth/register').send({ email, password, displayName }).expect(202);
  return { email, password };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/** Logs in with body delivery (native-app style) so tests hold the refresh token directly. */
export async function login(server: Server, email: string, password = PASSWORD, userAgent = 'vitest'): Promise<Tokens> {
  const res = await request(server)
    .post('/api/v1/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password, tokenDelivery: 'body' })
    .expect(200);
  const body = res.body as Tokens;
  expect(body.refreshToken).toBeDefined();
  return body;
}

export async function registerAndLogin(server: Server): Promise<Tokens & { email: string; userId: string }> {
  const { email } = await register(server);
  const tokens = await login(server, email);
  const [row] = await query<{ id: string }>(
    appUrl('identity'),
    'select id from identity.users where email_normalized = $1',
    [email.toLowerCase()],
  );
  return { ...tokens, email, userId: row!.id };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Rows straight from the test database (identity runtime role: it owns these tables' data, not their DDL). */
export const db = <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  query<R>(appUrl('identity'), sql, params);

export const setCookies = (res: Response): string[] => {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  return header === undefined ? [] : Array.isArray(header) ? header : [header];
};

export function refreshCookieValue(res: Response): string | undefined {
  const cookie = setCookies(res).find((value) => value.startsWith('__Secure-sc_refresh='));
  return cookie?.split(';')[0]!.slice('__Secure-sc_refresh='.length) || undefined;
}
