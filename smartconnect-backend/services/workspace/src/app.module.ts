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
import { ChannelsController, OrgChannelsController } from './channels/channels.controller.js';
import { ChannelsService } from './channels/channels.service.js';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from './config.js';
import { PRISMA, type WorkspacePrisma } from './database/prisma.token.js';
import { OrgMembershipGuard } from './org/org-membership.guard.js';
import { ORGANIZATION_CLIENT, OrganizationDirectory } from './org/organization-directory.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';

export interface WorkspaceDependencies {
  config: WorkspaceConfig;
  prisma: WorkspacePrisma;
}

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: WorkspacePrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Workspace service root module. Owns schema "workspace" and nothing else. Every route is protected unless marked
 * @Public() (AccessTokenGuard), and protected routes must be under /orgs/{orgId} with the caller an active member of
 * that organization (OrgMembershipGuard, asked of the organization service on every request).
 */
@Module({})
export class AppModule {
  static register({ config, prisma }: WorkspaceDependencies): DynamicModule {
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
      controllers: [HealthController, WorkspacesController, ChannelsController, OrgChannelsController],
      providers: [
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: PRISMA, useValue: prisma },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(config.jwks, { issuer: config.issuer, audience: config.audience }),
        },
        { provide: ORGANIZATION_CLIENT, useValue: new ServiceClient('organization', config.organizationServiceUrl) },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        OrganizationDirectory,
        WorkspacesService,
        ChannelsService,
        PrismaLifecycle,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_GUARD, useClass: OrgMembershipGuard },
      ],
    };
  }
}
