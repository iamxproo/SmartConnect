// Builds the realtime gateway: a Nest app (shared HTTP pipeline, health probes) whose HTTP server also carries the
// Socket.IO server. Used by main.ts and by the tests, so tests exercise exactly the production configuration.
import type { LoggerService, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttpPipeline } from '@smartconnect/backend-kit';
import { AppModule } from './app.module.js';
import type { RealtimeConfig } from './config.js';
import { RedisEventSource, type EventSource } from './events/event-source.js';

export interface CreateRealtimeGatewayOptions {
  config: RealtimeConfig;
  logger: LoggerService;
  /** Tests only: an injected source instead of the Redis subscription the configuration describes. */
  eventSource?: EventSource;
  /** Tests only. */
  extraModules?: Type[];
}

export async function createRealtimeGateway({
  config,
  logger,
  eventSource = new RedisEventSource(config.redisUrl, config.eventsChannel),
  extraModules = [],
}: CreateRealtimeGatewayOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, eventSource, extraModules), {
    bodyParser: false, // registered by configureHttpPipeline with an explicit limit and JSON-only policy
    logger,
    abortOnError: false,
    forceCloseConnections: true, // long-lived sockets must not hold shutdown open
  });

  // Browsers never call these HTTP routes (health probes only), so no CORS headers. Socket origins are checked by
  // the Socket.IO server itself.
  configureHttpPipeline(app, {
    logger,
    errorTypeBaseUrl: config.errorTypeBaseUrl,
    trustProxyHops: config.trustProxyHops,
    bodyLimitBytes: config.bodyLimitBytes,
    production: config.env === 'production',
  });
  return app;
}
