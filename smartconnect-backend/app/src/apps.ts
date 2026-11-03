// The seven applications the unified backend hosts (ADR 0016, Phase 1). Six are internal, each on a fixed loopback
// port (the existing development ports, so the Vite proxy and every development default keep working); the API
// gateway owns the one public port. Start order follows the service dependency graph: an application only calls
// applications started before it, except the messaging <-> files pair, whose addresses are fixed in advance.
export const INTERNAL_APPS = ['identity', 'organization', 'workspace', 'messaging', 'realtime', 'files'] as const;
export type InternalApp = (typeof INTERNAL_APPS)[number];
export type AppName = InternalApp | 'gateway';
export const APP_NAMES: readonly AppName[] = [...INTERNAL_APPS, 'gateway'];

/** Prefix of an internal application's own variables in the unified environment (`IDENTITY_DATABASE_URL`, …). */
export const PREFIX: Record<InternalApp, string> = {
  identity: 'IDENTITY',
  organization: 'ORGANIZATION',
  workspace: 'WORKSPACE',
  messaging: 'MESSAGING',
  realtime: 'REALTIME',
  files: 'FILES',
};

export const DEFAULT_INTERNAL_PORTS: Record<InternalApp, number> = {
  identity: 3101,
  organization: 3102,
  workspace: 3103,
  messaging: 3104,
  realtime: 3105,
  files: 3106,
};

/** Applications with a database, each connecting with its own runtime role (`sc_<service>_app`). */
export const DATABASE_APPS: readonly InternalApp[] = ['identity', 'organization', 'workspace', 'messaging', 'files'];

/** Internal applications listen here only; it is never configurable. */
export const INTERNAL_HOST = '127.0.0.1';

export const START_ORDER: readonly AppName[] = [
  'identity',
  'organization',
  'workspace',
  'files',
  'messaging',
  'realtime',
  'gateway',
];

/**
 * Closed one group after another; the applications of a group together. The gateway and realtime go first and
 * together: the public server cannot finish closing while it still holds upgraded sockets, which only end when the
 * realtime gateway disconnects them. Then consumers before the services they call.
 */
export const SHUTDOWN_GROUPS: readonly (readonly AppName[])[] = [
  ['gateway', 'realtime'],
  ['messaging'],
  ['files'],
  ['workspace'],
  ['organization'],
  ['identity'],
];
