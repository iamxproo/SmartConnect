import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  ACCESS_TOKEN_VERIFIER,
  AccessTokenGuard,
  AccessTokenVerifier,
  DEV_MAILBOX,
  DevMailboxController,
  HealthController,
  READINESS_CHECKS,
  ReadinessState,
  rootNotFoundHandler,
  type ReadinessCheck,
} from '@smartconnect/backend-kit';
import { IdentityClient } from './access/identity.client.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { SuperAdminGuard } from './admin/super-admin.guard.js';
import { OrgMemberGuard } from './access/org-member.guard.js';
import { ORGANIZATION_CONFIG, type OrganizationConfig } from './config.js';
import { PRISMA, type OrganizationPrisma } from './database/prisma.token.js';
import {
  InvitationAcceptanceController,
  OrganizationInvitationsController,
} from './invitations/invitations.controller.js';
import { InvitationsService } from './invitations/invitations.service.js';
import {
  INVITATION_DELIVERIES,
  INVITATION_NOTIFIER,
  InvitationDeliveries,
  InvitationDevMailbox,
  type InvitationNotifier,
} from './notifications/invitation-notifier.js';
import { OrganizationsController } from './organizations/organizations.controller.js';
import { OrganizationsService } from './organizations/organizations.service.js';
import { DepartmentsController, TeamsController } from './structure/structure.controller.js';
import { StructureService } from './structure/structure.service.js';

export interface OrganizationDependencies {
  config: OrganizationConfig;
  prisma: OrganizationPrisma;
  notifier: InvitationNotifier;
}

/** The dev mailbox endpoint exists only for the in-memory mailbox, and never in production. */
export const exposesDevMailbox = (deps: OrganizationDependencies) =>
  deps.notifier instanceof InvitationDevMailbox && deps.config.env !== 'production';

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: OrganizationPrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Organization service root module. Owns schema "organization" only. Every route needs an access token unless marked
 * @Public(); organization-scoped routes additionally pass OrgMemberGuard (active membership + declared permission),
 * and platform administration routes pass SuperAdminGuard instead (ADR 0015).
 */
@Module({})
export class AppModule {
  static register(deps: OrganizationDependencies): DynamicModule {
    const { config, prisma } = deps;
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
        OrganizationsController,
        OrganizationInvitationsController,
        InvitationAcceptanceController,
        DepartmentsController,
        TeamsController,
        AdminController,
        ...(exposesDevMailbox(deps) ? [DevMailboxController] : []),
      ],
      providers: [
        { provide: ORGANIZATION_CONFIG, useValue: config },
        { provide: PRISMA, useValue: prisma },
        { provide: INVITATION_NOTIFIER, useValue: deps.notifier },
        { provide: INVITATION_DELIVERIES, useValue: new InvitationDeliveries() },
        { provide: DEV_MAILBOX, useValue: deps.notifier },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(config.auth.jwks, {
            issuer: config.auth.issuer,
            audience: config.auth.audience,
          }),
        },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        IdentityClient,
        OrgMemberGuard,
        SuperAdminGuard,
        AdminService,
        OrganizationsService,
        InvitationsService,
        StructureService,
        PrismaLifecycle,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        { provide: APP_GUARD, useClass: AccessTokenGuard },
      ],
    };
  }
}
