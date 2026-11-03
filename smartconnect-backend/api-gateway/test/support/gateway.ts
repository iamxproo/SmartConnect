// Test harness: builds the real gateway (same factory as main.ts) with an in-memory logger. Each test file owns its
// app instance and closes it; nothing listens on a fixed port and nothing outside the process is touched.
import type { Server } from 'node:http';
import type { LoggerService, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ProblemDetails } from '@smartconnect/backend-kit';
import type { Response } from 'supertest';
import { createGateway } from '../../src/app.factory.js';
import { loadConfig, type GatewayConfig } from '../../src/config/config.js';
import type { RateLimitStore } from '../../src/rate-limit/rate-limit.js';
import { MemoryRateLimitStore } from '../../src/rate-limit/stores.js';
import { trustedJwks } from './tokens.js';

type Level = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface LogRecord {
  level: Level;
  message: unknown;
  context?: string;
  stack?: string;
}

export class CapturingLogger implements LoggerService {
  readonly records: LogRecord[] = [];

  log(message: unknown, context?: string): void {
    this.records.push({ level: 'log', message, context });
  }
  error(message: unknown, stack?: string, context?: string): void {
    this.records.push({ level: 'error', message, stack, context });
  }
  warn(message: unknown, context?: string): void {
    this.records.push({ level: 'warn', message, context });
  }
  debug(message: unknown, context?: string): void {
    this.records.push({ level: 'debug', message, context });
  }
  verbose(message: unknown, context?: string): void {
    this.records.push({ level: 'verbose', message, context });
  }
  fatal(message: unknown, context?: string): void {
    this.records.push({ level: 'fatal', message, context });
  }

  /** Structured records whose message has the given `event`. */
  events<T = Record<string, unknown>>(event: string): (LogRecord & { message: T })[] {
    return this.records.filter(
      (record): record is LogRecord & { message: T } =>
        typeof record.message === 'object' &&
        record.message !== null &&
        (record.message as { event?: unknown }).event === event,
    );
  }
}

/** Test configuration: trusts the in-memory test signing key; upstream defaults to an unused local port. */
export function testConfig(env: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_JWT_PUBLIC_JWKS: trustedJwks,
    IDENTITY_SERVICE_URL: 'http://127.0.0.1:9',
    ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:9',
    WORKSPACE_SERVICE_URL: 'http://127.0.0.1:9',
    MESSAGING_SERVICE_URL: 'http://127.0.0.1:9',
    FILES_SERVICE_URL: 'http://127.0.0.1:9',
    ...env,
  });
}

export interface TestGateway {
  app: NestExpressApplication;
  server: Server;
  logger: CapturingLogger;
}

/** Creates and initialises (but does not listen) a gateway; supertest binds an ephemeral port per request. */
export async function startGateway(
  options: {
    env?: Record<string, string>;
    extraModules?: Type[];
    init?: boolean;
    rateLimitStore?: RateLimitStore;
  } = {},
): Promise<TestGateway> {
  const logger = new CapturingLogger();
  const app = await createGateway({
    config: testConfig(options.env),
    logger,
    extraModules: options.extraModules,
    // A fresh store per app: rate-limit state never leaks between test files.
    rateLimitStore: options.rateLimitStore ?? new MemoryRateLimitStore(),
  });
  if (options.init !== false) await app.init();
  return { app, server: app.getHttpServer(), logger };
}

export function problemOf(res: Response): ProblemDetails {
  return res.body as ProblemDetails;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
