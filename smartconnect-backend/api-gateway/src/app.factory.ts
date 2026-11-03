// Builds the gateway application with its full HTTP pipeline. Used by main.ts and by the tests, so tests exercise
// exactly the production configuration.
import type { LoggerService, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  buildOpenApiDocument,
  configureHttpPipeline,
  configureServerTimeouts,
  isFileContentUpload,
  REQUEST_ID_HEADER,
  setupOpenApi,
} from '@smartconnect/backend-kit';
import { AppModule } from './app.module.js';
import type { GatewayConfig } from './config/config.js';
import { requireAllowedOriginForCookies } from './http/cookie-origin.js';
import type { RateLimitStore } from './rate-limit/rate-limit.js';
import { MemoryRateLimitStore, RedisRateLimitStore } from './rate-limit/stores.js';

/** Request headers browsers may send cross-origin (docs/api/conventions.md). */
const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'If-Match',
  REQUEST_ID_HEADER,
  'traceparent',
];
/** Response headers browsers may read cross-origin. */
const CORS_EXPOSED_HEADERS = [
  REQUEST_ID_HEADER,
  'Location',
  'ETag',
  'Retry-After',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
];

export interface CreateGatewayOptions {
  config: GatewayConfig;
  logger: LoggerService;
  /** Tests only: a pre-built store instead of the one the configuration describes. */
  rateLimitStore?: RateLimitStore;
  /** Tests only. */
  extraModules?: Type[];
}

function createRateLimitStore(config: GatewayConfig): RateLimitStore {
  if (config.rateLimitStore.kind === 'memory') return new MemoryRateLimitStore();
  const store = new RedisRateLimitStore(config.rateLimitStore.url);
  // Not awaited: the client keeps reconnecting in the background. Until it is connected, rate-limited routes
  // answer 503 (fail closed) and /health/ready reports not ready.
  store.connect().catch(() => undefined);
  return store;
}

export async function createGateway({
  config,
  logger,
  rateLimitStore = createRateLimitStore(config),
  extraModules = [],
}: CreateGatewayOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, rateLimitStore, extraModules),
    {
      bodyParser: false, // registered by configureHttpPipeline with an explicit limit and JSON-only policy
      logger,
      abortOnError: false,
    },
  );

  configureHttpPipeline(app, {
    logger,
    errorTypeBaseUrl: config.errorTypeBaseUrl,
    trustProxyHops: config.trustProxyHops,
    bodyLimitBytes: config.bodyLimitBytes,
    production: config.env === 'production',
    isRawBodyRoute: isFileContentUpload, // exactly PUT …/files/{id}/content streams raw bytes; all else is JSON only
    cors: {
      origin: config.corsAllowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      maxAge: 600,
    },
    beforeBody: [requireAllowedOriginForCookies(config.corsAllowedOrigins, config.errorTypeBaseUrl)],
  });

  configureServerTimeouts(app);

  if (config.apiDocsEnabled) {
    const document = buildOpenApiDocument(app, {
      title: 'SmartConnect API',
      description:
        'HTTP API of SmartConnect, served by the API gateway. Conventions (errors, pagination, idempotency, ' +
        'request ids): docs/api/conventions.md. Errors use RFC 9457 `application/problem+json`. Auth request and ' +
        'response schemas are documented by the identity service (ADR 0009).',
    });
    setupOpenApi(app, document);
  }
  return app;
}
