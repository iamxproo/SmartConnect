// The seven applications, composed as each one's own main.ts composes it (decision D2). The service main.ts files are
// unchanged and are not imported: importing one would start that service on its own. Each starter builds what its
// main.ts builds (a database client with the service's own runtime role, the email notifier, the application from its
// existing factory), then listens where its configuration says. A starter that fails releases what it created.
import type { Server } from 'node:http';
import type { LoggerService } from '@nestjs/common';
import { createGateway } from '@smartconnect/api-gateway/dist/app.factory.js';
import type { GatewayConfig } from '@smartconnect/api-gateway/dist/config/config.js';
import { BackgroundMailer, SmtpTransport } from '@smartconnect/backend-kit';
import { createFilesApp } from '@smartconnect/files-service/dist/app.factory.js';
import type { FilesConfig } from '@smartconnect/files-service/dist/config.js';
import { createPrismaClient as createFilesPrisma } from '@smartconnect/files-service/dist/database/client.js';
import { createIdentityApp } from '@smartconnect/identity-service/dist/app.factory.js';
import type { IdentityConfig } from '@smartconnect/identity-service/dist/config.js';
import { createPrismaClient as createIdentityPrisma } from '@smartconnect/identity-service/dist/database/client.js';
import {
  DevMailbox,
  DisabledAccountNotifier,
  SmtpAccountNotifier,
  type AccountNotifier,
} from '@smartconnect/identity-service/dist/notifications/account-notifier.js';
import { createMessagingApp } from '@smartconnect/messaging-service/dist/app.factory.js';
import type { MessagingConfig } from '@smartconnect/messaging-service/dist/config.js';
import { createPrismaClient as createMessagingPrisma } from '@smartconnect/messaging-service/dist/database/client.js';
import { createOrganizationApp } from '@smartconnect/organization-service/dist/app.factory.js';
import type { OrganizationConfig } from '@smartconnect/organization-service/dist/config.js';
import { createPrismaClient as createOrganizationPrisma } from '@smartconnect/organization-service/dist/database/client.js';
import {
  DisabledInvitationNotifier,
  InvitationDevMailbox,
  SmtpInvitationNotifier,
  type InvitationNotifier,
} from '@smartconnect/organization-service/dist/notifications/invitation-notifier.js';
import { createRealtimeGateway } from '@smartconnect/realtime-gateway/dist/app.factory.js';
import type { RealtimeConfig } from '@smartconnect/realtime-gateway/dist/config.js';
import { createWorkspaceApp } from '@smartconnect/workspace-service/dist/app.factory.js';
import type { WorkspaceConfig } from '@smartconnect/workspace-service/dist/config.js';
import { createPrismaClient as createWorkspacePrisma } from '@smartconnect/workspace-service/dist/database/client.js';
import type { AppName } from './apps.js';
import { attachRealtimeUpgrade } from './realtime-upgrade.js';

export interface Configs {
  identity: IdentityConfig;
  organization: OrganizationConfig;
  workspace: WorkspaceConfig;
  messaging: MessagingConfig;
  files: FilesConfig;
  realtime: RealtimeConfig;
  gateway: GatewayConfig;
}

export interface RunningApp {
  name: AppName;
  /** Where it listens, as configured. */
  url: string;
  host: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

export interface StartContext {
  configs: Configs;
  /** This application's own logger. */
  logger: LoggerService;
  /** Applications already started (the gateway needs the realtime gateway's server). */
  started: ReadonlyMap<AppName, RunningApp>;
  /** Called once the application object exists, before it listens. */
  afterCreate: () => void;
}

export type Starter = (context: StartContext) => Promise<RunningApp>;

interface NestHttpApp {
  listen(port: number, host: string): Promise<unknown>;
  close(): Promise<void>;
  getHttpServer(): unknown;
}

async function serve(name: AppName, app: NestHttpApp, port: number, host: string): Promise<RunningApp> {
  try {
    await app.listen(port, host);
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  return {
    name,
    url: `http://${host}:${port}`,
    host,
    port,
    server: app.getHttpServer() as Server,
    close: () => app.close(),
  };
}

/** Creates the application with its database client, disconnecting the client if the application cannot be built. */
async function withDatabase<P extends { $disconnect(): Promise<void> }, A>(
  prisma: P,
  create: (prisma: P) => Promise<A>,
): Promise<A> {
  try {
    return await create(prisma);
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
}

/** services/identity/src/main.ts createNotifier(), unchanged. */
function createAccountNotifier(config: IdentityConfig, logger: LoggerService): AccountNotifier {
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

/** services/organization/src/main.ts createNotifier(), unchanged. */
function createInvitationNotifier(config: OrganizationConfig, logger: LoggerService): InvitationNotifier {
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

export const STARTERS: Readonly<Record<AppName, Starter>> = {
  async identity({ configs: { identity: config }, logger, afterCreate }) {
    const app = await withDatabase(createIdentityPrisma({ connectionString: config.databaseUrl }), (prisma) =>
      createIdentityApp({ config, logger, prisma, notifier: createAccountNotifier(config, logger) }),
    );
    afterCreate();
    return serve('identity', app, config.port, config.host);
  },

  async organization({ configs: { organization: config }, logger, afterCreate }) {
    const app = await withDatabase(createOrganizationPrisma({ connectionString: config.databaseUrl }), (prisma) =>
      createOrganizationApp({ config, logger, prisma, notifier: createInvitationNotifier(config, logger) }),
    );
    afterCreate();
    return serve('organization', app, config.port, config.host);
  },

  async workspace({ configs: { workspace: config }, logger, afterCreate }) {
    const app = await withDatabase(createWorkspacePrisma({ connectionString: config.databaseUrl }), (prisma) =>
      createWorkspaceApp({ config, logger, prisma }),
    );
    afterCreate();
    return serve('workspace', app, config.port, config.host);
  },

  async files({ configs: { files: config }, logger, afterCreate }) {
    const app = await withDatabase(createFilesPrisma({ connectionString: config.databaseUrl }), (prisma) =>
      createFilesApp({ config, logger, prisma }),
    );
    afterCreate();
    return serve('files', app, config.port, config.host);
  },

  async messaging({ configs: { messaging: config }, logger, afterCreate }) {
    const app = await withDatabase(createMessagingPrisma({ connectionString: config.databaseUrl }), (prisma) =>
      createMessagingApp({ config, logger, prisma }),
    );
    afterCreate();
    return serve('messaging', app, config.port, config.host);
  },

  async realtime({ configs: { realtime: config }, logger, afterCreate }) {
    const app = await createRealtimeGateway({ config, logger });
    afterCreate();
    return serve('realtime', app, config.port, config.host);
  },

  async gateway({ configs: { gateway: config }, logger, started, afterCreate }) {
    const realtime = started.get('realtime');
    if (!realtime) throw new Error('the realtime gateway must be started before the API gateway');
    const app = await createGateway({ config, logger });
    afterCreate();
    attachRealtimeUpgrade(app.getHttpServer(), realtime.server);
    return serve('gateway', app, config.port, config.host);
  },
};
