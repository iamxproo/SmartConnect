import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  ACCESS_TOKEN_VERIFIER,
  AccessTokenGuard,
  AccessTokenVerifier,
  HealthController,
  READINESS_CHECKS,
  ReadinessState,
  rootNotFoundHandler,
  ServiceClient,
  type ReadinessCheck,
} from '@smartconnect/backend-kit';
import { ActivityController } from './activity/activity.controller.js';
import { ActivityService } from './activity/activity.service.js';
import { PreferencesController } from './preferences/preferences.controller.js';
import { PreferencesService } from './preferences/preferences.service.js';
import { AccessGuard } from './access/access.guard.js';
import { ORGANIZATION_CLIENT, OrganizationDirectory } from './access/organization-directory.js';
import { AttachmentsController } from './attachments/attachments.controller.js';
import { AttachmentsService } from './attachments/attachments.service.js';
import { FILES_CLIENT, FileDirectory } from './attachments/file-directory.js';
import { ChannelDirectory, WORKSPACE_CLIENT } from './channels/channel-directory.js';
import { ConversationMessagesService } from './conversations/conversation-messages.service.js';
import { ConversationsController } from './conversations/conversations.controller.js';
import { ConversationsService } from './conversations/conversations.service.js';
import { MESSAGING_CONFIG, type MessagingConfig } from './config.js';
import { PRISMA, type MessagingPrisma } from './database/prisma.token.js';
import { MessagesController } from './messages/messages.controller.js';
import { RealtimePublisher } from './events/realtime-publisher.js';
import { MessagesService } from './messages/messages.service.js';
import { SavedMessagesController } from './saved/saved-messages.controller.js';
import { SavedMessagesService } from './saved/saved-messages.service.js';
import { SearchController } from './search/search.controller.js';
import { SearchService } from './search/search.service.js';
import { VisibleChannels } from './search/visible-channels.js';

export interface MessagingDependencies {
  config: MessagingConfig;
  prisma: MessagingPrisma;
}

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: MessagingPrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Messaging service root module. Owns schema "messaging" and nothing else. Every route is protected unless marked
 * @Public() (AccessTokenGuard). Protected routes must address a channel the workspace service shows to the caller, or
 * be an organization-scoped conversation route for an active member (AccessGuard, asked on every request).
 */
@Module({})
export class AppModule {
  static register({ config, prisma }: MessagingDependencies): DynamicModule {
    const readinessChecks: ReadinessCheck[] = [
      {
        name: 'database',
        check: async () => {
          await prisma.$queryRaw`SELECT 1`;
        },
      },
    ];
    return {
      module: AppModule,
      controllers: [
        HealthController,
        MessagesController,
        ConversationsController,
        SavedMessagesController,
        AttachmentsController,
        SearchController,
        ActivityController,
        PreferencesController,
      ],
      providers: [
        { provide: MESSAGING_CONFIG, useValue: config },
        { provide: PRISMA, useValue: prisma },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(config.jwks, { issuer: config.issuer, audience: config.audience }),
        },
        { provide: WORKSPACE_CLIENT, useValue: new ServiceClient('workspace', config.workspaceServiceUrl) },
        { provide: ORGANIZATION_CLIENT, useValue: new ServiceClient('organization', config.organizationServiceUrl) },
        { provide: FILES_CLIENT, useValue: new ServiceClient('files', config.filesServiceUrl) },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        ChannelDirectory,
        OrganizationDirectory,
        RealtimePublisher,
        MessagesService,
        ConversationsService,
        ConversationMessagesService,
        SavedMessagesService,
        FileDirectory,
        AttachmentsService,
        ActivityService,
        PreferencesService,
        SearchService,
        VisibleChannels,
        PrismaLifecycle,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_GUARD, useClass: AccessGuard },
      ],
    };
  }
}
