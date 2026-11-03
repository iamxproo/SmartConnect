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
import { AttachmentAccess, MESSAGING_CLIENT } from './files/attachment-access.js';
import { FilesController } from './files/files.controller.js';
import { FilesService } from './files/files.service.js';
import { FILES_CONFIG, type FilesConfig } from './config.js';
import { PRISMA, type FilesPrisma } from './database/prisma.token.js';
import { OrgMembershipGuard } from './org/org-membership.guard.js';
import { ORGANIZATION_CLIENT, OrganizationDirectory } from './org/organization-directory.js';
import { FILE_STORAGE, type FileStorage } from './storage/file-storage.js';
import { LocalFileStorage } from './storage/local-file-storage.js';
import { StagingSweeper } from './storage/staging-sweeper.js';

export interface FilesDependencies {
  config: FilesConfig;
  prisma: FilesPrisma;
  /** Tests only: a storage other than the local-filesystem driver. */
  storage?: FileStorage;
}

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: FilesPrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Files service root module. Owns schema "files" and nothing else. Every route is protected unless marked
 * @Public() (AccessTokenGuard), and protected routes must be under /orgs/{orgId} with the caller an active member of
 * that organization (OrgMembershipGuard, asked of the organization service on every request).
 */
@Module({})
export class AppModule {
  static register({
    config,
    prisma,
    storage = new LocalFileStorage(config.storageDir),
  }: FilesDependencies): DynamicModule {
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
      controllers: [HealthController, FilesController],
      providers: [
        { provide: FILES_CONFIG, useValue: config },
        { provide: PRISMA, useValue: prisma },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(config.jwks, { issuer: config.issuer, audience: config.audience }),
        },
        { provide: ORGANIZATION_CLIENT, useValue: new ServiceClient('organization', config.organizationServiceUrl) },
        { provide: MESSAGING_CLIENT, useValue: new ServiceClient('messaging', config.messagingServiceUrl) },
        { provide: FILE_STORAGE, useValue: storage },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        OrganizationDirectory,
        AttachmentAccess,
        FilesService,
        PrismaLifecycle,
        StagingSweeper,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_GUARD, useClass: OrgMembershipGuard },
      ],
    };
  }
}
