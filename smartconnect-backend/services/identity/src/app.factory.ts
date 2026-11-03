// Builds the identity service with the shared HTTP pipeline. Used by main.ts and by the tests, so tests exercise
// exactly the production configuration.
import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  buildOpenApiDocument,
  configureHttpPipeline,
  configureServerTimeouts,
  DEV_MAILBOX_ROUTE,
  setupOpenApi,
} from '@smartconnect/backend-kit';
import { AppModule, exposesDevMailbox, type IdentityDependencies } from './app.module.js';

export async function createIdentityApp(
  deps: IdentityDependencies & { logger: LoggerService },
): Promise<NestExpressApplication> {
  const { config, logger } = deps;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    bodyParser: false, // registered by configureHttpPipeline with an explicit limit and JSON-only policy
    logger,
    abortOnError: false,
  });

  // Internal service behind the gateway: no CORS (browsers never call it directly); trusts the gateway's
  // X-Forwarded-For for the client address (TRUST_PROXY_HOPS, default 1).
  configureHttpPipeline(app, {
    logger,
    errorTypeBaseUrl: config.errorTypeBaseUrl,
    trustProxyHops: config.trustProxyHops,
    bodyLimitBytes: config.bodyLimitBytes,
    production: config.env === 'production',
    unprefixedRoutes: exposesDevMailbox(deps) ? [DEV_MAILBOX_ROUTE] : [],
  });

  configureServerTimeouts(app);

  if (config.apiDocsEnabled) {
    const document = buildOpenApiDocument(app, {
      title: 'SmartConnect identity service',
      description:
        'Authentication and sessions (ADR 0009). Internal service: clients reach these routes through the API ' +
        'gateway under the same paths. Errors use RFC 9457 `application/problem+json` (docs/api/conventions.md).',
    });
    setupOpenApi(app, document);
  }
  return app;
}
