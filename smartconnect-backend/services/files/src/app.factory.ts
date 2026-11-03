// Builds the files service with the shared HTTP pipeline. Used by main.ts and by the tests, so tests exercise
// exactly the production configuration.
import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  buildOpenApiDocument,
  configureHttpPipeline,
  configureServerTimeouts,
  isFileContentUpload,
  setupOpenApi,
} from '@smartconnect/backend-kit';
import { AppModule, type FilesDependencies } from './app.module.js';

export async function createFilesApp(
  deps: FilesDependencies & { logger: LoggerService },
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
    isRawBodyRoute: isFileContentUpload, // the content route streams raw bytes; everything else stays JSON only
  });

  configureServerTimeouts(app);

  if (config.apiDocsEnabled) {
    const document = buildOpenApiDocument(app, {
      title: 'SmartConnect files service',
      description:
        'File upload and download. Internal service: clients reach these routes through the API gateway under the ' +
        'same paths. Errors use RFC 9457 `application/problem+json` (docs/api/conventions.md).',
    });
    setupOpenApi(app, document);
  }
  return app;
}
