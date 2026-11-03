import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown, type Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  ACCESS_TOKEN_VERIFIER,
  AccessTokenGuard,
  AccessTokenVerifier,
  HealthController,
  READINESS_CHECKS,
  ReadinessState,
  rootNotFoundHandler,
  type ReadinessCheck,
} from '@smartconnect/backend-kit';
import { GATEWAY_CONFIG, type GatewayConfig } from './config/config.js';
import { UpstreamProxy } from './proxy/upstream-proxy.js';
import { RATE_LIMIT_STORE, RateLimitGuard, type RateLimitStore } from './rate-limit/rate-limit.js';
import { AdminRoutesController } from './routes/admin-routes.controller.js';
import { AuthRoutesController } from './routes/auth-routes.controller.js';
import {
  FilesRoutesController,
  MessagingRoutesController,
  OrganizationRoutesController,
  WorkspaceRoutesController,
} from './routes/tenant-routes.controller.js';

@Injectable()
class RateLimitStoreLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore) {}

  async onApplicationShutdown(): Promise<void> {
    await this.store.close();
  }
}

/**
 * Root module. The gateway is stateless: no database and no business logic. It authenticates, rate-limits and
 * routes; services behind it own their data and behaviour. Routes exist only for services that exist.
 */
@Module({})
export class AppModule {
  /** `extraModules` exists for tests only (e.g. a validation probe); production passes none. */
  static register(config: GatewayConfig, rateLimitStore: RateLimitStore, extraModules: Type[] = []): DynamicModule {
    const readinessChecks: ReadinessCheck[] =
      config.rateLimitStore.kind === 'redis' ? [{ name: 'rate-limit-store', check: () => rateLimitStore.ping() }] : [];
    return {
      module: AppModule,
      imports: extraModules,
      // Order matters: Express takes the first match, so more specific paths come first
      // (messages ⊂ workspaces ⊂ organizations).
      controllers: [
        HealthController,
        AuthRoutesController,
        AdminRoutesController,
        MessagingRoutesController,
        FilesRoutesController,
        WorkspaceRoutesController,
        OrganizationRoutesController,
      ],
      providers: [
        { provide: GATEWAY_CONFIG, useValue: config },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(config.auth.jwks, {
            issuer: config.auth.issuer,
            audience: config.auth.audience,
          }),
        },
        { provide: RATE_LIMIT_STORE, useValue: rateLimitStore },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        UpstreamProxy,
        RateLimitStoreLifecycle,
        rootNotFoundHandler(config.errorTypeBaseUrl),
        // Global guards run in this order: authenticate (deny by default, @Public() opts out), then rate-limit, so
        // per-user buckets see the verified principal.
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    };
  }
}
