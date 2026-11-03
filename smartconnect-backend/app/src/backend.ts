// The unified backend: validate everything, then start the seven applications in dependency order, each only after
// the previous one is ready, and the public listener last (decision D6). On any failure, everything this process
// started is closed again, in shutdown order. Shutdown runs once, group by group, with a deadline.
import { loadConfig as loadGatewayConfig } from '@smartconnect/api-gateway/dist/config/config.js';
import { ConfigError, type LogLevel } from '@smartconnect/backend-kit';
import { loadConfig as loadFilesConfig } from '@smartconnect/files-service/dist/config.js';
import { loadConfig as loadIdentityConfig } from '@smartconnect/identity-service/dist/config.js';
import { loadConfig as loadMessagingConfig } from '@smartconnect/messaging-service/dist/config.js';
import { loadConfig as loadOrganizationConfig } from '@smartconnect/organization-service/dist/config.js';
import { loadConfig as loadRealtimeConfig } from '@smartconnect/realtime-gateway/dist/config.js';
import { loadConfig as loadWorkspaceConfig } from '@smartconnect/workspace-service/dist/config.js';
import { INTERNAL_APPS, INTERNAL_HOST, SHUTDOWN_GROUPS, START_ORDER, type AppName, type InternalApp } from './apps.js';
import { STARTERS, type Configs, type RunningApp, type Starter } from './compose.js';
import { buildEnvironment, type Env, type EnvironmentOptions } from './env.js';
import { closeInGroups, onceWithDeadline, waitUntilReady, type ShutdownResult } from './lifecycle.js';
import { AppLogger, resetStaticLogger } from './logger.js';
import type { PortClaim } from './ports.js';

const LOADERS: { [A in AppName]: (env: Env) => Configs[A] } = {
  identity: loadIdentityConfig,
  organization: loadOrganizationConfig,
  workspace: loadWorkspaceConfig,
  messaging: loadMessagingConfig,
  files: loadFilesConfig,
  realtime: loadRealtimeConfig,
  gateway: loadGatewayConfig,
};

export interface BackendPlan {
  configs: Configs;
  internalPorts: Record<InternalApp, number>;
  /** Every port the backend will listen on, for the check before anything starts. */
  ports: PortClaim[];
  logLevel: LogLevel;
}

export type Preparation = { plan: BackendPlan; problems: [] } | { plan: undefined; problems: string[] };

/**
 * Builds every application's environment view and runs every application's own loadConfig() on it, collecting
 * all problems of all applications at once. Nothing is started and no port is opened.
 */
export function prepareBackend(source: Env, options: EnvironmentOptions = {}): Preparation {
  const environment = buildEnvironment(source, options);
  const problems = [...environment.problems];
  const configs: Partial<Configs> = {};
  for (const app of START_ORDER) {
    try {
      (configs as Record<AppName, unknown>)[app] = LOADERS[app](environment.views[app]);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems.map((problem) => `${app}: ${problem}`));
    }
  }
  if (problems.length > 0) return { plan: undefined, problems };
  const complete = configs as Configs;
  return {
    plan: {
      configs: complete,
      internalPorts: environment.internalPorts,
      ports: [
        ...INTERNAL_APPS.map((app) => ({ app, host: INTERNAL_HOST, port: environment.internalPorts[app] })),
        { app: 'gateway', host: complete.gateway.host, port: complete.gateway.port },
      ],
      logLevel: complete.gateway.logLevel,
    },
    problems: [],
  };
}

export interface Backend {
  /** The public URL: REST under /api/v1, Socket.IO at /realtime/socket.io. */
  publicUrl: string;
  apps: readonly RunningApp[];
  /** Idempotent: every call returns the same shutdown. */
  close(): Promise<ShutdownResult>;
}

export interface StartOptions {
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Tests only: replacements for the real application starters. */
  starters?: Partial<Record<AppName, Starter>>;
}

/** A URL that reaches a listener from this process: a wildcard bind is reached over loopback. */
const reachable = (host: string, port: number) =>
  `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;

/** Error text for logs, with any credentials inside URLs removed. */
export const redact = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\/\/[^/@\s]*@/g, '//***@');

export async function startBackend(plan: BackendPlan, options: StartOptions = {}): Promise<Backend> {
  const { readyTimeoutMs = 60_000, shutdownTimeoutMs = 25_000 } = options;
  const starters = { ...STARTERS, ...options.starters };
  const log = new AppLogger('backend', plan.logLevel);
  const started = new Map<AppName, RunningApp>();
  const closeStarted = () => closeInGroups(started, SHUTDOWN_GROUPS);

  for (const name of START_ORDER) {
    try {
      const app = await starters[name]({
        configs: plan.configs,
        logger: new AppLogger(name, plan.logLevel),
        started,
        afterCreate: () => resetStaticLogger(plan.logLevel),
      });
      started.set(name, app);
      await waitUntilReady(`${reachable(app.host, app.port)}/health/ready`, { timeoutMs: readyTimeoutMs });
      log.log({ event: 'app_ready', app: name, url: app.url, public: name === 'gateway' }, 'Backend');
    } catch (error) {
      log.error({ event: 'backend_start_failed', app: name, error: redact(error) }, undefined, 'Backend');
      const report = await closeStarted();
      log.warn(
        { event: 'backend_start_rolled_back', closed: report.closed, failed: report.failed.map((f) => f.name) },
        'Backend',
      );
      throw error;
    }
  }

  const gateway = started.get('gateway')!;
  const publicUrl = reachable(gateway.host, gateway.port);
  log.log(
    {
      event: 'backend_started',
      url: gateway.url,
      apps: START_ORDER.map((name) => ({ app: name, url: started.get(name)!.url })),
      startupMs: Math.round(performance.now()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    'Backend',
  );

  const close = onceWithDeadline(async () => {
    log.log({ event: 'backend_stopping' }, 'Backend');
    const report = await closeStarted();
    log.log({ event: 'backend_stopped', closed: report.closed, failed: report.failed }, 'Backend');
    return report;
  }, shutdownTimeoutMs);
  return { publicUrl, apps: [...started.values()], close };
}
