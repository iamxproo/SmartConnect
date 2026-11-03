import { Module, type DynamicModule, type Type } from '@nestjs/common';
import {
  ACCESS_TOKEN_VERIFIER,
  AccessTokenVerifier,
  HealthController,
  READINESS_CHECKS,
  ReadinessState,
  rootNotFoundHandler,
  ServiceClient,
  type ReadinessCheck,
} from '@smartconnect/backend-kit';
import { REALTIME_CONFIG, type RealtimeConfig } from './config.js';
import type { EventSource } from './events/event-source.js';
import { EVENT_SOURCE } from './events/tokens.js';
import { ChannelDirectory, WORKSPACE_CLIENT } from './realtime/channel-directory.js';
import { RealtimeHub } from './realtime/hub.js';
import { InboxDirectory, MESSAGING_CLIENT } from './realtime/inbox-directory.js';

/**
 * Root module. The gateway serves only the health probes over HTTP; everything else happens on the Socket.IO server
 * the RealtimeHub attaches to the same HTTP server. No database, no REST API: there is nothing to authorize
 * with a guard, because sockets are authenticated in the connection middleware.
 */
@Module({})
export class AppModule {
  /** `extraModules` exists for tests only; production passes none. */
  static register(config: RealtimeConfig, eventSource: EventSource, extraModules: Type[] = []): DynamicModule {
    const readinessChecks: ReadinessCheck[] = [
      {
        name: 'event-source',
        check: () => (eventSource.isReady() ? Promise.resolve() : Promise.reject(new Error('not subscribed'))),
      },
    ];
    return {
      module: AppModule,
      imports: extraModules,
      controllers: [HealthController],
      providers: [
        { provide: REALTIME_CONFIG, useValue: config },
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useValue: new AccessTokenVerifier(config.auth.jwks, {
            issuer: config.auth.issuer,
            audience: config.auth.audience,
          }),
        },
        { provide: WORKSPACE_CLIENT, useValue: new ServiceClient('workspace', config.workspaceServiceUrl) },
        { provide: MESSAGING_CLIENT, useValue: new ServiceClient('messaging', config.messagingServiceUrl) },
        { provide: EVENT_SOURCE, useValue: eventSource },
        { provide: READINESS_CHECKS, useValue: readinessChecks },
        ReadinessState,
        ChannelDirectory,
        InboxDirectory,
        RealtimeHub,
        rootNotFoundHandler(config.errorTypeBaseUrl),
      ],
    };
  }
}
