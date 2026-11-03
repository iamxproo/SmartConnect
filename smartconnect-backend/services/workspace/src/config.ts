// Workspace service configuration from environment variables, validated once at startup (fail fast, all problems
// at once, values never echoed). Secrets: DATABASE_URL (runtime role sc_workspace_app).
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

export interface WorkspaceConfig {
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
  /** Owns organization membership; asked on every request. */
  organizationServiceUrl: string;
}

/** Injection token for the validated WorkspaceConfig. */
export const WORKSPACE_CONFIG = Symbol('WORKSPACE_CONFIG');

export function loadConfig(env: Env = process.env): WorkspaceConfig {
  const problems: string[] = [];

  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const host = env.HOST ?? '127.0.0.1';
  const port = parseInteger('PORT', env.PORT ?? '3103', 1, 65535, problems);
  const apiDocsEnabled =
    env.API_DOCS_ENABLED === undefined
      ? appEnv === 'development'
      : parseBoolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, problems);
  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '1', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  const databaseUrl = readSecret(env, 'DATABASE_URL', problems);
  if (databaseUrl === undefined && env.DATABASE_URL_FILE === undefined)
    problems.push('DATABASE_URL is required (locally: make db-bootstrap writes it to services/workspace/.env)');
  else if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push('DATABASE_URL must be a postgresql:// URL');

  const rawJwks = readSecret(env, 'AUTH_JWT_PUBLIC_JWKS', problems);
  let jwks: JSONWebKeySet | undefined;
  if (rawJwks === undefined && env.AUTH_JWT_PUBLIC_JWKS_FILE === undefined)
    problems.push('AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys');
  else if (rawJwks !== undefined) jwks = parsePublicJwks('AUTH_JWT_PUBLIC_JWKS', rawJwks, problems);

  let organizationServiceUrl = '';
  if (env.ORGANIZATION_SERVICE_URL === undefined) {
    if (isProduction) problems.push('ORGANIZATION_SERVICE_URL is required in production');
    else organizationServiceUrl = 'http://127.0.0.1:3102';
  } else {
    organizationServiceUrl = parseServiceUrl('ORGANIZATION_SERVICE_URL', env.ORGANIZATION_SERVICE_URL, problems);
  }

  if (problems.length) throw new ConfigError('workspace', problems);
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
    organizationServiceUrl,
  };
}
