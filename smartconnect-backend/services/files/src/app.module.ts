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
import { R2FileStorage } from './storage/r2-file-storage.js';
import { StagingSweeper } from './storage/staging-sweeper.js';
import { StorageBudget } from './storage/storage-budget.js';

export interface FilesDependencies {
  config: FilesConfig;
  prisma: FilesPrisma;
  /** Tests only: a storage other than the one the configuration names. */
  storage?: FileStorage;
}

/** The driver FILES_STORAGE_PROVIDER names: the local directory (default outside production) or Cloudflare R2. */
export function createStorage(config: FilesConfig): FileStorage {
  if (config.storage.provider === 'r2') {
    const { endpoint, bucket, region, accessKeyId, secretAccessKey, timeoutMs } = config.storage;
    return new R2FileStorage({
      endpoint,
      bucket,
      region,
      credentials: { accessKeyId, secretAccessKey },
      timeoutMs,
      stagingDir: config.stagingDir,
    });
  }
  return new LocalFileStorage(config.storageDir);
}

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: FilesPrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Closes the storage driver's idle connections (R2's keep-alive sockets) on shutdown. */
@Injectable()
class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStorage & { close?: () => void }) {}

  onApplicationShutdown(): void {
    this.storage.close?.();
  }
}

/**
 * Files service root module. Owns schema "files" and nothing else. Every route is protected unless marked
 * @Public() (AccessTokenGuard), and protected routes must be under /orgs/{orgId} with the caller an active member of
 * that organization (OrgMembershipGuard, asked of the organization service on every request).
 */
@Module({})
export class AppModule {
  static register({ config, prisma, storage = createStorage(config) }: FilesDependencies): DynamicModule {
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
        StorageLifecycle,
        StagingSweeper,
        StorageBudget,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_GUARD, useClass: OrgMembershipGuard },
      ],
    };
  }
}
