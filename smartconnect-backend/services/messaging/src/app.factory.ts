// Builds the messaging service with the shared HTTP pipeline. Used by main.ts and by the tests, so tests exercise
// exactly the production configuration.
import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  buildOpenApiDocument,
  configureHttpPipeline,
  configureServerTimeouts,
  setupOpenApi,
} from '@smartconnect/backend-kit';
import { AppModule, type MessagingDependencies } from './app.module.js';

export async function createMessagingApp(
  deps: MessagingDependencies & { logger: LoggerService },
): Promise<NestExpressApplication> {
  const { config, logger } = deps;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    bodyParser: false, // registered by configureHttpPipeline with an explicit limit and JSON-only policy
    logger,
    abortOnError: false,
  });

  // Internal service behind the gateway: no CORS (browsers never call it directly).
  configureHttpPipeline(app, {
    logger,
    errorTypeBaseUrl: config.errorTypeBaseUrl,
    trustProxyHops: config.trustProxyHops,
    bodyLimitBytes: config.bodyLimitBytes,
    production: config.env === 'production',
  });

  configureServerTimeouts(app);

  if (config.apiDocsEnabled) {
    const document = buildOpenApiDocument(app, {
      title: 'SmartConnect messaging service',
      description:
        'Channel messages. Access is decided by the workspace service on every request. Internal service: clients reach these ' +
        'routes through the API gateway under the same paths. Errors use RFC 9457 `application/problem+json` ' +
        '(docs/api/conventions.md).',
    });
    setupOpenApi(app, document);
  }
  return app;
}
