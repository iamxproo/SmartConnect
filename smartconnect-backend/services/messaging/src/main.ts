import 'reflect-metadata';
import { ConfigError, createJsonLogger } from '@smartconnect/backend-kit';
import { createMessagingApp } from './app.factory.js';
import { loadConfig } from './config.js';
import { createPrismaClient } from './database/client.js';

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
  const prisma = createPrismaClient({ connectionString: config.databaseUrl });
  const app = await createMessagingApp({ config, logger, prisma });
  app.enableShutdownHooks(); // SIGTERM/SIGINT: readiness turns false, the server closes, the pool disconnects
  await app.listen(config.port, config.host);
  logger.log(
    {
      event: 'messaging_started',
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      docs: config.apiDocsEnabled ? '/docs' : 'disabled',
    },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Messaging service failed to start:', error);
  process.exit(1);
});
