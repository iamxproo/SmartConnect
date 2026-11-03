// Messaging service configuration from environment variables, validated once at startup (fail fast, all problems
// at once, values never echoed). Secrets: DATABASE_URL (runtime role sc_messaging_app).
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

export interface MessagingConfig {
  env: Environment;
  host: string;
  port: number;
  apiDocsEnabled: boolean;
  /** Reverse proxies in front of the service: 1 = the API gateway. */
  trustProxyHops: number;
  logLevel: LogLevel;
  errorTypeBaseUrl: string;
  bodyLimitBytes: number;
  databaseUrl: string;
  /** Public keys of the identity service, to verify access tokens. */
  jwks: JSONWebKeySet;
  issuer: string;
  audience: string;
  /** Decides channel visibility and membership; asked on every request. */
  workspaceServiceUrl: string;
  /** Decides organization membership (direct and group conversations); asked as the caller on every request. */
  organizationServiceUrl: string;
  /** Owns files; asked as the caller whether a file may be attached to a message. */
  filesServiceUrl: string;
  /** Post-commit fan-out to the realtime gateway (ADR 0004 interim). Unset REDIS_URL disables publishing. */
  realtime: { redisUrl: string | undefined; eventsChannel: string };
}

/** Injection token for the validated MessagingConfig. */
export const MESSAGING_CONFIG = Symbol('MESSAGING_CONFIG');

export function loadConfig(env: Env = process.env): MessagingConfig {
  const problems: string[] = [];

  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const host = env.HOST ?? '127.0.0.1';
  const port = parseInteger('PORT', env.PORT ?? '3104', 1, 65535, problems);
  const apiDocsEnabled =
    env.API_DOCS_ENABLED === undefined
      ? appEnv === 'development'
      : parseBoolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, problems);
  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '1', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  const databaseUrl = readSecret(env, 'DATABASE_URL', problems);
  if (databaseUrl === undefined && env.DATABASE_URL_FILE === undefined)
    problems.push('DATABASE_URL is required (locally: make db-bootstrap writes it to services/messaging/.env)');
  else if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push('DATABASE_URL must be a postgresql:// URL');

  const rawJwks = readSecret(env, 'AUTH_JWT_PUBLIC_JWKS', problems);
  let jwks: JSONWebKeySet | undefined;
  if (rawJwks === undefined && env.AUTH_JWT_PUBLIC_JWKS_FILE === undefined)
    problems.push('AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys');
  else if (rawJwks !== undefined) jwks = parsePublicJwks('AUTH_JWT_PUBLIC_JWKS', rawJwks, problems);

  let workspaceServiceUrl = '';
  if (env.WORKSPACE_SERVICE_URL === undefined) {
    if (isProduction) problems.push('WORKSPACE_SERVICE_URL is required in production');
    else workspaceServiceUrl = 'http://127.0.0.1:3103';
  } else {
    workspaceServiceUrl = parseServiceUrl('WORKSPACE_SERVICE_URL', env.WORKSPACE_SERVICE_URL, problems);
  }

  let organizationServiceUrl = '';
  if (env.ORGANIZATION_SERVICE_URL === undefined) {
    if (isProduction) problems.push('ORGANIZATION_SERVICE_URL is required in production');
    else organizationServiceUrl = 'http://127.0.0.1:3102';
  } else {
    organizationServiceUrl = parseServiceUrl('ORGANIZATION_SERVICE_URL', env.ORGANIZATION_SERVICE_URL, problems);
  }

  let filesServiceUrl = '';
  if (env.FILES_SERVICE_URL === undefined) {
    if (isProduction) problems.push('FILES_SERVICE_URL is required in production');
    else filesServiceUrl = 'http://127.0.0.1:3106';
  } else {
    filesServiceUrl = parseServiceUrl('FILES_SERVICE_URL', env.FILES_SERVICE_URL, problems);
  }

  const redisUrl = readSecret(env, 'REDIS_URL', problems);
  if (redisUrl !== undefined && !/^rediss?:\/\/[^\s]+$/.test(redisUrl))
    problems.push('REDIS_URL must be a redis:// or rediss:// URL');
  const eventsChannel = env.REALTIME_EVENTS_CHANNEL ?? 'smartconnect:events';
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(eventsChannel))
    problems.push('REALTIME_EVENTS_CHANNEL must be 1-200 characters of letters, digits and : . _ -');

  if (problems.length) throw new ConfigError('messaging', problems);
  return {
    env: appEnv,
    host,
    port,
    apiDocsEnabled,
    trustProxyHops,
    logLevel,
    errorTypeBaseUrl,
    bodyLimitBytes: 1024 * 1024,
    databaseUrl: databaseUrl!,
    jwks: jwks!,
    issuer: env.AUTH_JWT_ISSUER ?? DEFAULT_ACCESS_TOKEN_ISSUER,
    audience: env.AUTH_JWT_AUDIENCE ?? DEFAULT_ACCESS_TOKEN_AUDIENCE,
    workspaceServiceUrl,
    organizationServiceUrl,
    filesServiceUrl,
    realtime: { redisUrl, eventsChannel },
  };
}
