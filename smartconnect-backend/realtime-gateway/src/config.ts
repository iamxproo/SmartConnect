// Realtime gateway configuration from environment variables, validated once at startup (fail fast, all problems at
// once, values never echoed). Secrets: REDIS_URL (may carry a password). The gateway verifies access tokens with
// the identity service's PUBLIC keys and has no database. Decision record: docs/decisions/0004.
import {
  ConfigError,
  DEFAULT_ACCESS_TOKEN_AUDIENCE,
  DEFAULT_ACCESS_TOKEN_ISSUER,
  parseEnvironment,
  parseErrorTypeBaseUrl,
  parseInteger,
  parseLogLevel,
  parsePublicJwks,
  parseServiceUrl,
  readSecret,
  type Env,
  type Environment,
  type LogLevel,
} from '@smartconnect/backend-kit';
import type { JSONWebKeySet } from 'jose';

export { ConfigError };

export interface RealtimeConfig {
  env: Environment;
  host: string;
  port: number;
  logLevel: LogLevel;
  errorTypeBaseUrl: string;
  trustProxyHops: number;
  bodyLimitBytes: number;
  /** Exact browser origins allowed to open a socket. Never "*". */
  corsAllowedOrigins: string[];
  auth: { jwks: JSONWebKeySet; issuer: string; audience: string };
  /** Decides channel visibility, asked as the socket's own user. */
  workspaceServiceUrl: string;
  /** Decides access to conversation inboxes, asked as the socket's own user. */
  messagingServiceUrl: string;
  /** The gateway's only event source: Redis pub/sub channel the services publish id-only events to. */
  redisUrl: string;
  eventsChannel: string;
  /** How often every joined room is re-checked against the service that authorized it. */
  reauthorizeIntervalSeconds: number;
  /** Upper bound on rooms (channels and inboxes) per socket: each costs one check per re-authorization cycle. */
  maxChannelsPerSocket: number;
  /** Upper bound on open sockets per user on this instance: bounds the checks one account can cause. */
  maxSocketsPerUser: number;
}

/** Injection token for the validated RealtimeConfig. */
export const REALTIME_CONFIG = Symbol('REALTIME_CONFIG');

/** Web dev server origins (smartconnect-frontend/web/vite.config.ts). Development and test only. */
export const DEV_WEB_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
export const DEV_WORKSPACE_SERVICE_URL = 'http://127.0.0.1:3103';
export const DEV_MESSAGING_SERVICE_URL = 'http://127.0.0.1:3104';

/** An origin is scheme://host[:port] with no path, query, credentials or wildcard. */
function parseOrigin(raw: string, problems: string[]): string | undefined {
  if (raw.includes('*')) {
    problems.push('CORS_ALLOWED_ORIGINS must list exact origins; "*" is not allowed');
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw.replace(/\/$/, '') || url.username) {
      throw new Error('not an origin');
    }
    return url.origin;
  } catch {
    problems.push(`CORS_ALLOWED_ORIGINS entry "${raw}" is not an origin like https://app.example.com`);
    return undefined;
  }
}

export function loadConfig(env: Env = process.env): RealtimeConfig {
  const problems: string[] = [];

  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const host = env.HOST ?? '127.0.0.1';
  const port = parseInteger('PORT', env.PORT ?? '3105', 1, 65535, problems);
  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '0', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  let corsAllowedOrigins: string[];
  if (env.CORS_ALLOWED_ORIGINS === undefined || env.CORS_ALLOWED_ORIGINS.trim() === '') {
    if (isProduction) problems.push('CORS_ALLOWED_ORIGINS is required in production');
    corsAllowedOrigins = isProduction ? [] : [...DEV_WEB_ORIGINS];
  } else {
    corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => parseOrigin(origin, problems))
      .filter((origin): origin is string => origin !== undefined);
  }

  const rawJwks = readSecret(env, 'AUTH_JWT_PUBLIC_JWKS', problems);
  let jwks: JSONWebKeySet = { keys: [] };
  if (rawJwks === undefined && env.AUTH_JWT_PUBLIC_JWKS === undefined && env.AUTH_JWT_PUBLIC_JWKS_FILE === undefined) {
    problems.push('AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys');
  } else if (rawJwks !== undefined) {
    jwks = parsePublicJwks('AUTH_JWT_PUBLIC_JWKS', rawJwks, problems) ?? jwks;
  }

  const serviceUrl = (name: string, devDefault: string): string => {
    const raw = env[name];
    if (raw !== undefined) return parseServiceUrl(name, raw, problems);
    if (isProduction) problems.push(`${name} is required in production`);
    return isProduction ? '' : devDefault;
  };
  const workspaceServiceUrl = serviceUrl('WORKSPACE_SERVICE_URL', DEV_WORKSPACE_SERVICE_URL);
  const messagingServiceUrl = serviceUrl('MESSAGING_SERVICE_URL', DEV_MESSAGING_SERVICE_URL);

  const redisUrl = readSecret(env, 'REDIS_URL', problems);
  if (redisUrl === undefined && env.REDIS_URL === undefined && env.REDIS_URL_FILE === undefined)
    problems.push('REDIS_URL (or REDIS_URL_FILE) is required: Redis pub/sub is the gateway’s only event source');
  else if (redisUrl !== undefined && !/^rediss?:\/\/[^\s]+$/.test(redisUrl))
    problems.push('REDIS_URL must be a redis:// or rediss:// URL');

  const eventsChannel = env.REALTIME_EVENTS_CHANNEL ?? 'smartconnect:events';
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(eventsChannel))
    problems.push('REALTIME_EVENTS_CHANNEL must be 1-200 characters of letters, digits and : . _ -');

  const reauthorizeIntervalSeconds = parseInteger(
    'REAUTHORIZE_INTERVAL_SECONDS',
    env.REAUTHORIZE_INTERVAL_SECONDS ?? '60',
    1,
    3600,
    problems,
  );
  const maxChannelsPerSocket = parseInteger(
    'MAX_CHANNELS_PER_SOCKET',
    env.MAX_CHANNELS_PER_SOCKET ?? '200',
    1,
    1000,
    problems,
  );
  const maxSocketsPerUser = parseInteger('MAX_SOCKETS_PER_USER', env.MAX_SOCKETS_PER_USER ?? '10', 1, 1000, problems);

  if (problems.length) throw new ConfigError('realtime-gateway', problems);
  return {
    env: appEnv,
    host,
    port,
    logLevel,
    errorTypeBaseUrl,
    trustProxyHops,
    bodyLimitBytes: 1024 * 1024,
    corsAllowedOrigins,
    auth: {
      jwks,
      issuer: env.AUTH_JWT_ISSUER ?? DEFAULT_ACCESS_TOKEN_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE ?? DEFAULT_ACCESS_TOKEN_AUDIENCE,
    },
    workspaceServiceUrl,
    messagingServiceUrl,
    redisUrl: redisUrl!,
    eventsChannel,
    reauthorizeIntervalSeconds,
    maxChannelsPerSocket,
    maxSocketsPerUser,
  };
}
