import 'reflect-metadata';
import { ConfigError, createJsonLogger } from '@smartconnect/backend-kit';
import { createRealtimeGateway } from './app.factory.js';
import { loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createJsonLogger(config.logLevel);
  const app = await createRealtimeGateway({ config, logger });
  app.enableShutdownHooks(); // SIGTERM/SIGINT: readiness turns false, sockets close, the server closes
  await app.listen(config.port, config.host);
  logger.log(
    {
      event: 'realtime_gateway_started',
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      origins: config.corsAllowedOrigins.length,
      reauthorizeIntervalSeconds: config.reauthorizeIntervalSeconds,
    },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Realtime gateway failed to start:', error);
  process.exit(1);
});
