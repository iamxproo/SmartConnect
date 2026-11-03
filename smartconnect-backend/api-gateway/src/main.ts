import 'reflect-metadata';
import { ConfigError, createJsonLogger } from '@smartconnect/backend-kit';
import { createGateway } from './app.factory.js';
import { loadConfig } from './config/config.js';

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
  const app = await createGateway({ config, logger });
  app.enableShutdownHooks(); // SIGTERM/SIGINT: readiness turns false, then the server closes
  await app.listen(config.port, config.host);
  logger.log(
    {
      event: 'gateway_started',
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      docs: config.apiDocsEnabled ? '/docs' : 'disabled',
      identity: config.upstreams.identity,
      rateLimitStore: config.rateLimitStore.kind,
    },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Gateway failed to start:', error);
  process.exit(1);
});
