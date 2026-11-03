import 'reflect-metadata';
import type { LoggerService } from '@nestjs/common';
import { BackgroundMailer, ConfigError, createJsonLogger, SmtpTransport } from '@smartconnect/backend-kit';
import { createIdentityApp } from './app.factory.js';
import { loadConfig, type IdentityConfig } from './config.js';
import { createPrismaClient } from './database/client.js';
import {
  DevMailbox,
  DisabledAccountNotifier,
  SmtpAccountNotifier,
  type AccountNotifier,
} from './notifications/account-notifier.js';

function createNotifier(config: IdentityConfig, logger: LoggerService): AccountNotifier {
  if (config.accountNotifier === 'dev-mailbox') return new DevMailbox();
  if (config.accountNotifier === 'disabled' || !config.smtp) return new DisabledAccountNotifier(logger);
  const transport = new SmtpTransport(config.smtp);
  // A bad password or host shows up now, in the log, instead of at the first registration. Never blocks startup.
  transport.verify().then(
    () => {
      logger.log({ event: 'smtp_ready' }, 'Bootstrap');
    },
    (error: unknown) => {
      const { category = 'unknown' } = error as { category?: string };
      logger.warn({ event: 'smtp_verify_failed', category }, 'Bootstrap');
    },
  );
  return new SmtpAccountNotifier(new BackgroundMailer(transport, logger), config.webAppUrl);
}

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
  const notifier = createNotifier(config, logger);
  const app = await createIdentityApp({ config, logger, prisma, notifier });
  app.enableShutdownHooks(); // SIGTERM/SIGINT: readiness turns false, the server closes, queued mail is sent (5 s), the pool disconnects
  await app.listen(config.port, config.host);
  logger.log(
    {
      event: 'identity_started',
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      docs: config.apiDocsEnabled ? '/docs' : 'disabled',
      accountNotifier: config.accountNotifier,
      signingKeyId: config.signingKey.kid,
    },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Identity service failed to start:', error);
  process.exit(1);
});
