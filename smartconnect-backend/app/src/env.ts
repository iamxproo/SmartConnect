// One environment view per hosted application, built from the unified backend's environment (ADR 0016 Phase 1,
// decision D3). Each application's own loadConfig() then validates its view exactly as it validates process.env when
// it runs alone.
//
// Rules:
// - An application receives ONLY the variables on its list below. Nothing is passed through by default, so one
//   application never sees another's settings or secrets (the identity signing key reaches identity only; each
//   database URL reaches its own service only).
// - Variables that mean different things per application are namespaced: `<APP>_DATABASE_URL[_FILE]`,
//   `<APP>_INTERNAL_PORT`, `<APP>_TRUST_PROXY_HOPS`, `<APP>_API_DOCS_ENABLED`. The unprefixed `PORT`, `HOST`,
//   `TRUST_PROXY_HOPS` and `API_DOCS_ENABLED` belong to the public API gateway. Names that merely start with a service
//   name (`ORGANIZATION_CREATOR_EMAILS`, `FILES_MAX_BYTES`, …) are passed under their own name: no prefix stripping.
// - Internal applications always listen on 127.0.0.1, and every `*_SERVICE_URL` is computed from the internal ports.
//   Supplying one, or an unprefixed `DATABASE_URL`, is an error rather than being silently ignored.
// - Outside production only: a service's DATABASE_URL may come from its generated services/<svc>/.env, and REDIS_URL
//   from the root .env (decision D5), when they are not set explicitly.
// Problems name variables, never their values.
import path from 'node:path';
import {
  DATABASE_APPS,
  DEFAULT_INTERNAL_PORTS,
  INTERNAL_APPS,
  INTERNAL_HOST,
  PREFIX,
  type AppName,
  type InternalApp,
} from './apps.js';

export type Env = Record<string, string | undefined>;

const SHARED = ['NODE_ENV', 'LOG_LEVEL', 'ERROR_TYPE_BASE_URL', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE'];
const PUBLIC_KEYS = ['AUTH_JWT_PUBLIC_JWKS', 'AUTH_JWT_PUBLIC_JWKS_FILE'];
const SIGNING_KEY = ['AUTH_JWT_PRIVATE_JWK', 'AUTH_JWT_PRIVATE_JWK_FILE'];
const MAIL = [
  'WEB_APP_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_PASSWORD_FILE',
  'SMTP_FROM',
  'SMTP_REPLY_TO',
  'SMTP_TIMEOUT_MS',
];
const REDIS = ['REDIS_URL', 'REDIS_URL_FILE'];

/** Variables each application receives under their own name. */
export const PASS_THROUGH: Readonly<Record<AppName, readonly string[]>> = {
  identity: [
    ...SHARED,
    ...SIGNING_KEY,
    'ACCESS_TOKEN_TTL_SECONDS',
    'REFRESH_TOKEN_IDLE_DAYS',
    'SESSION_MAX_LIFETIME_DAYS',
    'EMAIL_VERIFICATION_TTL_HOURS',
    'PASSWORD_RESET_TTL_MINUTES',
    'ACCOUNT_NOTIFIER',
    ...MAIL,
  ],
  organization: [
    ...SHARED,
    ...PUBLIC_KEYS,
    'ORGANIZATION_CREATION',
    'ORGANIZATION_CREATOR_EMAILS',
    'ORGANIZATION_MAX_OWNED_PER_USER',
    'INVITATION_NOTIFIER',
    ...MAIL,
  ],
  workspace: [...SHARED, ...PUBLIC_KEYS],
  messaging: [...SHARED, ...PUBLIC_KEYS, ...REDIS, 'REALTIME_EVENTS_CHANNEL'],
  files: [
    ...SHARED,
    ...PUBLIC_KEYS,
    'FILES_MAX_BYTES',
    'FILES_STORAGE_PROVIDER',
    'FILES_STORAGE_DIR',
    'FILES_STAGING_DIR',
    'FILES_MAX_PENDING_PER_USER',
    'FILES_MAX_CONCURRENT_UPLOADS_PER_USER',
    'FILES_STORAGE_BUDGET_BYTES',
    'FILES_STORAGE_USAGE_SCAN_SECONDS',
    'FILES_SIGNED_URL_TTL_SECONDS',
    'FILES_R2_ENDPOINT',
    'FILES_R2_BUCKET',
    'FILES_R2_REGION',
    'FILES_R2_TIMEOUT_MS',
    'FILES_R2_ACCESS_KEY_ID',
    'FILES_R2_SECRET_ACCESS_KEY',
    'FILES_R2_SECRET_ACCESS_KEY_FILE',
  ],
  realtime: [
    ...SHARED,
    ...PUBLIC_KEYS,
    ...REDIS,
    'REALTIME_EVENTS_CHANNEL',
    'CORS_ALLOWED_ORIGINS',
    'REAUTHORIZE_INTERVAL_SECONDS',
    'MAX_CHANNELS_PER_SOCKET',
    'MAX_SOCKETS_PER_USER',
  ],
  gateway: [
    ...SHARED,
    ...PUBLIC_KEYS,
    ...REDIS,
    'CORS_ALLOWED_ORIGINS',
    'FILES_MAX_BYTES',
    'UPSTREAM_TIMEOUT_MS',
    'PORT',
    'HOST',
    'TRUST_PROXY_HOPS',
    'API_DOCS_ENABLED',
  ],
};

/** Internal service URLs each application reads, and the application each one points at. Always computed. */
export const SERVICE_URLS: Readonly<Record<AppName, Readonly<Record<string, InternalApp>>>> = {
  identity: {},
  organization: { IDENTITY_SERVICE_URL: 'identity' },
  workspace: { ORGANIZATION_SERVICE_URL: 'organization' },
  messaging: {
    WORKSPACE_SERVICE_URL: 'workspace',
    ORGANIZATION_SERVICE_URL: 'organization',
    FILES_SERVICE_URL: 'files',
  },
  files: { ORGANIZATION_SERVICE_URL: 'organization', MESSAGING_SERVICE_URL: 'messaging' },
  realtime: { WORKSPACE_SERVICE_URL: 'workspace', MESSAGING_SERVICE_URL: 'messaging' },
  gateway: {
    IDENTITY_SERVICE_URL: 'identity',
    ORGANIZATION_SERVICE_URL: 'organization',
    WORKSPACE_SERVICE_URL: 'workspace',
    MESSAGING_SERVICE_URL: 'messaging',
    FILES_SERVICE_URL: 'files',
  },
};

/** The gateway's own default (api-gateway/src/config/config.ts), needed to check it against the internal ports. */
const DEFAULT_PUBLIC_PORT = 3000;

export interface EnvironmentOptions {
  /** Repository root: the per-service .env files and the root .env are read from here (local development only). */
  repoRoot?: string;
  /** Parses a dotenv file; undefined when it does not exist. */
  readEnvFile?: (file: string) => Env | undefined;
}

export interface Environment {
  views: Record<AppName, Env>;
  internalPorts: Record<InternalApp, number>;
  problems: string[];
}

export const serviceUrl = (port: number) => `http://${INTERNAL_HOST}:${port}`;

export function buildEnvironment(source: Env, options: EnvironmentOptions = {}): Environment {
  const problems: string[] = [];
  const production = source.NODE_ENV === 'production';
  const readLocal = (file: string): Env | undefined =>
    !production && options.repoRoot && options.readEnvFile
      ? options.readEnvFile(path.join(options.repoRoot, file))
      : undefined;

  for (const name of Object.keys(source).sort()) {
    if (/^[A-Z0-9_]+_SERVICE_URL$/.test(name))
      problems.push(
        `${name} must not be set: the unified backend points every internal service URL at that service's own loopback port`,
      );
  }
  for (const name of ['DATABASE_URL', 'DATABASE_URL_FILE'])
    if (source[name] !== undefined)
      problems.push(
        `${name} must not be set: each service connects with its own runtime role; set ${DATABASE_APPS.map((app) => `${PREFIX[app]}_${name}`).join(', ')}`,
      );

  const internalPorts = {} as Record<InternalApp, number>;
  for (const app of INTERNAL_APPS) {
    const name = `${PREFIX[app]}_INTERNAL_PORT`;
    const raw = source[name];
    if (raw === undefined) {
      internalPorts[app] = DEFAULT_INTERNAL_PORTS[app];
      continue;
    }
    const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(port >= 1 && port <= 65535)) problems.push(`${name} must be an integer from 1 to 65535`);
    internalPorts[app] = port;
  }
  const byPort = new Map<number, string[]>();
  for (const app of INTERNAL_APPS) byPort.set(internalPorts[app], [...(byPort.get(internalPorts[app]) ?? []), app]);
  const publicPort = /^\d+$/.test(source.PORT ?? '') ? Number(source.PORT) : DEFAULT_PUBLIC_PORT;
  byPort.set(publicPort, [...(byPort.get(publicPort) ?? []), 'gateway (PORT)']);
  for (const [port, apps] of byPort)
    if (apps.length > 1 && Number.isFinite(port))
      problems.push(`port ${port} is assigned to more than one application: ${apps.join(', ')}`);

  // Values every application reading them shares, with the local default for REDIS_URL.
  const shared: Env = { ...source };
  if (shared.REDIS_URL === undefined && shared.REDIS_URL_FILE === undefined) {
    const root = readLocal('.env');
    if (root?.REDIS_PASSWORD)
      shared.REDIS_URL = `redis://:${encodeURIComponent(root.REDIS_PASSWORD)}@127.0.0.1:${root.REDIS_PORT ?? '6379'}/0`;
  }

  const views = {} as Record<AppName, Env>;
  for (const app of [...INTERNAL_APPS, 'gateway'] as AppName[]) {
    const view: Env = {};
    for (const name of PASS_THROUGH[app]) if (shared[name] !== undefined) view[name] = shared[name];
    for (const [name, target] of Object.entries(SERVICE_URLS[app])) view[name] = serviceUrl(internalPorts[target]);

    if (app !== 'gateway') {
      const own = (name: string) => source[`${PREFIX[app]}_${name}`];
      view.HOST = INTERNAL_HOST;
      view.PORT = String(internalPorts[app]);
      if (own('TRUST_PROXY_HOPS') !== undefined) view.TRUST_PROXY_HOPS = own('TRUST_PROXY_HOPS');
      if (app !== 'realtime' && own('API_DOCS_ENABLED') !== undefined) view.API_DOCS_ENABLED = own('API_DOCS_ENABLED');
      if (DATABASE_APPS.includes(app)) {
        if (own('DATABASE_URL') !== undefined) view.DATABASE_URL = own('DATABASE_URL');
        if (own('DATABASE_URL_FILE') !== undefined) view.DATABASE_URL_FILE = own('DATABASE_URL_FILE');
        if (view.DATABASE_URL === undefined && view.DATABASE_URL_FILE === undefined) {
          // Only DATABASE_URL is taken from the generated file; nothing else in it reaches the service.
          const generated = readLocal(path.join('smartconnect-backend', 'services', app, '.env'))?.DATABASE_URL;
          if (generated) view.DATABASE_URL = generated;
          else
            problems.push(
              `${PREFIX[app]}_DATABASE_URL (or ${PREFIX[app]}_DATABASE_URL_FILE) is required` +
                (production
                  ? ''
                  : `; locally it is read from smartconnect-backend/services/${app}/.env (make db-bootstrap)`),
            );
        }
      }
    }
    views[app] = view;
  }
  return { views, internalPorts, problems };
}
