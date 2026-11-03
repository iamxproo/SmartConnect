import 'reflect-metadata';
import type { LoggerService } from '@nestjs/common';
import { BackgroundMailer, ConfigError, createJsonLogger, SmtpTransport } from '@smartconnect/backend-kit';
import { createOrganizationApp } from './app.factory.js';
import { loadConfig, type OrganizationConfig } from './config.js';
import { createPrismaClient } from './database/client.js';
import {
  DisabledInvitationNotifier,
  InvitationDevMailbox,
  SmtpInvitationNotifier,
  type InvitationNotifier,
} from './notifications/invitation-notifier.js';

function createNotifier(config: OrganizationConfig, logger: LoggerService): InvitationNotifier {
  if (config.invitationNotifier === 'dev-mailbox') return new InvitationDevMailbox();
  if (config.invitationNotifier === 'disabled' || !config.smtp) return new DisabledInvitationNotifier(logger);
  const transport = new SmtpTransport(config.smtp);
  // A bad password or host shows up now, in the log, instead of at the first invitation. Never blocks startup.
  transport.verify().then(
    () => {
      logger.log({ event: 'smtp_ready' }, 'Bootstrap');
    },
    (error: unknown) => {
      const { category = 'unknown' } = error as { category?: string };
      logger.warn({ event: 'smtp_verify_failed', category }, 'Bootstrap');
    },
  );
  return new SmtpInvitationNotifier(new BackgroundMailer(transport, logger));
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
  const app = await createOrganizationApp({ config, logger, prisma, notifier });
  app.enableShutdownHooks(); // queued mail is sent (up to 5 s) before the pool disconnects
  await app.listen(config.port, config.host);
  logger.log(
    {
      event: 'organization_started',
      url: `http://${config.host}:${config.port}`,
      env: config.env,
      docs: config.apiDocsEnabled ? '/docs' : 'disabled',
      invitationNotifier: config.invitationNotifier,
      organizationCreation: config.organizationCreation,
      organizationCreators: config.organizationCreatorEmails.size,
    },
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Organization service failed to start:', error);
  process.exit(1);
});
