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
import { AdminController } from './admin/admin.controller.js';
import { SuperAdminGuard } from './admin/super-admin.guard.js';
import { AccessTokenIssuer } from './auth/access-token-issuer.js';
import { ActiveSessionGuard } from './auth/active-session.guard.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { EmailController } from './auth/email.controller.js';
import { EmailVerificationService } from './auth/email-verification.service.js';
import { PasswordController } from './auth/password.controller.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { SessionsController } from './auth/sessions.controller.js';
import { IDENTITY_CONFIG, type IdentityConfig } from './config.js';
import { PasswordHasher } from './crypto/password-hasher.js';
import { PRISMA, type IdentityPrisma } from './database/prisma.token.js';
import { ACCOUNT_NOTIFIER, DevMailbox, type AccountNotifier } from './notifications/account-notifier.js';

export interface IdentityDependencies {
  config: IdentityConfig;
  prisma: IdentityPrisma;
  notifier: AccountNotifier;
  /** Tests only: e.g. cheaper or outdated Argon2 parameters. */
  hasher?: PasswordHasher;
}

/** The dev mailbox endpoint exists only for the in-memory mailbox, and never in production. */
export const exposesDevMailbox = (deps: IdentityDependencies) =>
  deps.notifier instanceof DevMailbox && deps.config.env !== 'production';

@Injectable()
class PrismaLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: IdentityPrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Identity service root module. Owns schema "identity" and nothing else; it never reads another service's schema.
 * Every route is protected unless marked @Public() (AccessTokenGuard), and protected routes also require the
 * token's session to be active (ActiveSessionGuard). Platform administration routes add SuperAdminGuard (ADR 0015).
 */
@Module({})
export class AppModule {
  static register(deps: IdentityDependencies): DynamicModule {
    const { config, prisma } = deps;
    const issuer = new AccessTokenIssuer(config.signingKey, {
      issuer: config.issuer,
      audience: config.audience,
      ttlSeconds: config.accessTokenTtlSeconds,
    });
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
        AuthController,
        EmailController,
        SessionsController,
        PasswordController,
        AdminController,
        ...(exposesDevMailbox(deps) ? [DevMailboxController] : []),
      ],
      providers: [
        { provide: IDENTITY_CONFIG, useValue: config },
        { provide: PRISMA, useValue: prisma },
        { provide: ACCOUNT_NOTIFIER, useValue: deps.notifier },
        { provide: DEV_MAILBOX, useValue: deps.notifier },
        { provide: PasswordHasher, useValue: deps.hasher ?? new PasswordHasher() },
        { provide: AccessTokenIssuer, useValue: issuer },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(issuer.publicJwks(), { issuer: config.issuer, audience: config.audience }),
        },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        SessionService,
        EmailVerificationService,
        AuthService,
        PasswordService,
        SuperAdminGuard,
        PrismaLifecycle,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_GUARD, useClass: ActiveSessionGuard },
      ],
    };
  }
}
