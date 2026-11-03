// Gateway configuration from environment variables, validated once at startup (fail fast, all problems at
// once). The gateway holds no database credentials; its only secret is REDIS_URL (rate limiting). It verifies
// access tokens with the identity service's PUBLIC keys. Decision records: docs/decisions/0008, 0009.
import {
  ConfigError,
  DEFAULT_ACCESS_TOKEN_AUDIENCE,
  DEFAULT_ACCESS_TOKEN_ISSUER,
  parseBoolean,
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

export interface GatewayConfig {
  env: Environment;
  host: string;
  port: number;
  /** Exact browser origins allowed to call the API with credentials. Never "*". */
  corsAllowedOrigins: string[];
  /** Serve Swagger UI at /docs and the document at /docs/openapi.json. */
  apiDocsEnabled: boolean;
  /** Number of reverse-proxy hops to trust for client IP / protocol (Express "trust proxy"); 0 = none. */
  trustProxyHops: number;
  logLevel: LogLevel;
  /** Prefix of RFC 9457 `type` URIs (docs/api/conventions.md). */
  errorTypeBaseUrl: string;
  /** Maximum JSON request body (docs/api/conventions.md: 1 MB). */
  bodyLimitBytes: number;
  /** Access-token verification: the identity service's public keys and the expected issuer/audience. */
  auth: { jwks: JSONWebKeySet; issuer: string; audience: string };
  /** Base URLs of the services the gateway routes to. */
  upstreams: { identity: string; organization: string; workspace: string; messaging: string; files: string };
  upstreamTimeoutMs: number;
  /** Largest file body streamed through the two file-content routes (413 above it). Same variable as the files service. */
  filesMaxBytes: number;
  /** Rate-limit buckets: Redis (shared by all gateway instances; required in production) or process memory. */
  rateLimitStore: { kind: 'redis'; url: string } | { kind: 'memory' };
}

/** Injection token for the validated GatewayConfig. */
export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

/** Web dev server origins (smartconnect-frontend/web/vite.config.ts). Development and test only. */
export const DEV_WEB_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/** Local service ports (smartconnect-backend/services/*). Development and test only. */
export const DEV_IDENTITY_SERVICE_URL = 'http://127.0.0.1:3101';
export const DEV_ORGANIZATION_SERVICE_URL = 'http://127.0.0.1:3102';
export const DEV_WORKSPACE_SERVICE_URL = 'http://127.0.0.1:3103';
export const DEV_MESSAGING_SERVICE_URL = 'http://127.0.0.1:3104';
export const DEV_FILES_SERVICE_URL = 'http://127.0.0.1:3106';

/** An origin is scheme://host[:port] with no path, query, credentials or wildcard. */
function parseOrigin(raw: string, problems: string[]): string | undefined {
  if (raw === '*' || raw.includes('*')) {
    problems.push('CORS_ALLOWED_ORIGINS must list exact origins; "*" is not allowed (credentials are enabled)');
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

export function loadConfig(env: Env = process.env): GatewayConfig {
  const problems: string[] = [];

  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const host = env.HOST ?? '127.0.0.1';
  const port = parseInteger('PORT', env.PORT ?? '3000', 1, 65535, problems);

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

  const apiDocsEnabled =
    env.API_DOCS_ENABLED === undefined
      ? appEnv === 'development'
      : parseBoolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, problems);

  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '0', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  // Public keys are not secret, but they may come from a mounted file like the private key does.
  const rawJwks = readSecret(env, 'AUTH_JWT_PUBLIC_JWKS', problems);
  let jwks: JSONWebKeySet = { keys: [] };
  if (rawJwks === undefined && env.AUTH_JWT_PUBLIC_JWKS === undefined && env.AUTH_JWT_PUBLIC_JWKS_FILE === undefined) {
    problems.push('AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys');
  } else if (rawJwks !== undefined) {
    jwks = parsePublicJwks('AUTH_JWT_PUBLIC_JWKS', rawJwks, problems) ?? jwks;
  }
  const issuer = env.AUTH_JWT_ISSUER ?? DEFAULT_ACCESS_TOKEN_ISSUER;
  const audience = env.AUTH_JWT_AUDIENCE ?? DEFAULT_ACCESS_TOKEN_AUDIENCE;

  const serviceUrl = (name: string, devDefault: string): string => {
    const raw = env[name];
    if (raw !== undefined) return parseServiceUrl(name, raw, problems);
    if (isProduction) problems.push(`${name} is required in production`);
    return isProduction ? '' : devDefault;
  };
  const upstreams = {
    identity: serviceUrl('IDENTITY_SERVICE_URL', DEV_IDENTITY_SERVICE_URL),
    organization: serviceUrl('ORGANIZATION_SERVICE_URL', DEV_ORGANIZATION_SERVICE_URL),
    workspace: serviceUrl('WORKSPACE_SERVICE_URL', DEV_WORKSPACE_SERVICE_URL),
    messaging: serviceUrl('MESSAGING_SERVICE_URL', DEV_MESSAGING_SERVICE_URL),
    files: serviceUrl('FILES_SERVICE_URL', DEV_FILES_SERVICE_URL),
  };
  const upstreamTimeoutMs = parseInteger(
    'UPSTREAM_TIMEOUT_MS',
    env.UPSTREAM_TIMEOUT_MS ?? '10000',
    100,
    60000,
    problems,
  );

  const filesMaxBytes = parseInteger(
    'FILES_MAX_BYTES',
    env.FILES_MAX_BYTES ?? String(25 * 1024 * 1024),
    1024,
    100 * 1024 * 1024,
    problems,
  );

  const redisUrl = readSecret(env, 'REDIS_URL', problems);
  if (redisUrl !== undefined && !/^rediss?:\/\/[^\s]+$/.test(redisUrl))
    problems.push('REDIS_URL must be a redis:// or rediss:// URL');
  if (redisUrl === undefined && isProduction)
    problems.push('REDIS_URL is required in production (rate limits must be shared by all gateway instances)');

  if (problems.length) throw new ConfigError('gateway', problems);
  return {
    env: appEnv,
    host,
    port,
    corsAllowedOrigins,
    apiDocsEnabled,
    trustProxyHops,
    logLevel,
    errorTypeBaseUrl,
    bodyLimitBytes: 1024 * 1024,
    auth: { jwks, issuer, audience },
    upstreams,
    upstreamTimeoutMs,
    filesMaxBytes,
    rateLimitStore: redisUrl === undefined ? { kind: 'memory' } : { kind: 'redis', url: redisUrl },
  };
}
