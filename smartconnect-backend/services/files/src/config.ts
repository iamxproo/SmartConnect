// Files service configuration from environment variables, validated once at startup (fail fast, all problems at
// once, values never echoed). Secrets: DATABASE_URL (runtime role sc_files_app).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

export const MIB = 1024 * 1024;
export const DEFAULT_FILES_MAX_BYTES = 25 * MIB;
export const MIN_FILES_MAX_BYTES = 1024;
export const MAX_FILES_MAX_BYTES = 100 * MIB;

export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** <repo>/.local/files, relative to this module (src/ and dist/ sit at the same depth). Development and test only. */
const DEV_STORAGE_DIR = fileURLToPath(new URL('../../../../.local/files', import.meta.url));

export interface FilesConfig {
  env: Environment;
  host: string;
  port: number;
  apiDocsEnabled: boolean;
  /** Reverse proxies in front of the service: 1 = the API gateway. */
  trustProxyHops: number;
  logLevel: LogLevel;
  errorTypeBaseUrl: string;
  /** Maximum JSON request body (the content route is raw bytes and bounded by maxFileBytes instead). */
  bodyLimitBytes: number;
  databaseUrl: string;
  /** Public keys of the identity service, to verify access tokens. */
  jwks: JSONWebKeySet;
  issuer: string;
  audience: string;
  /** Owns organization membership; asked on every request. */
  organizationServiceUrl: string;
  /** Owns message attachments; asked (as the caller) whether a non-uploader may read a file. */
  messagingServiceUrl: string;
  /** Absolute directory of the local-filesystem storage driver. Never served. */
  storageDir: string;
  /** Largest accepted file. */
  maxFileBytes: number;
  /** Declared-but-not-yet-uploaded files one user may hold; beyond it, create answers 409 too_many_pending_uploads. */
  maxPendingUploadsPerUser: number;
  /** Uploads one user may have in flight at once on this instance; beyond it, 429 too_many_concurrent_uploads. */
  maxConcurrentUploadsPerUser: number;
  /** A pending upload older than this is abandoned: it stops counting and is marked deleted. */
  pendingUploadTtlMs: number;
}

/** Injection token for the validated FilesConfig. */
export const FILES_CONFIG = Symbol('FILES_CONFIG');

export function loadConfig(env: Env = process.env): FilesConfig {
  const problems: string[] = [];

  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const host = env.HOST ?? '127.0.0.1';
  const port = parseInteger('PORT', env.PORT ?? '3106', 1, 65535, problems);
  const apiDocsEnabled =
    env.API_DOCS_ENABLED === undefined
      ? appEnv === 'development'
      : parseBoolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, problems);
  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '1', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  const databaseUrl = readSecret(env, 'DATABASE_URL', problems);
  if (databaseUrl === undefined && env.DATABASE_URL_FILE === undefined)
    problems.push('DATABASE_URL is required (locally: make db-bootstrap writes it to services/files/.env)');
  else if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push('DATABASE_URL must be a postgresql:// URL');

  const rawJwks = readSecret(env, 'AUTH_JWT_PUBLIC_JWKS', problems);
  let jwks: JSONWebKeySet | undefined;
  if (rawJwks === undefined && env.AUTH_JWT_PUBLIC_JWKS_FILE === undefined)
    problems.push('AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys');
  else if (rawJwks !== undefined) jwks = parsePublicJwks('AUTH_JWT_PUBLIC_JWKS', rawJwks, problems);

  const serviceUrl = (name: string, devDefault: string): string => {
    const raw = env[name];
    if (raw !== undefined) return parseServiceUrl(name, raw, problems);
    if (isProduction) problems.push(`${name} is required in production`);
    return isProduction ? '' : devDefault;
  };
  const organizationServiceUrl = serviceUrl('ORGANIZATION_SERVICE_URL', 'http://127.0.0.1:3102');
  const messagingServiceUrl = serviceUrl('MESSAGING_SERVICE_URL', 'http://127.0.0.1:3104');

  let storageDir = DEV_STORAGE_DIR;
  if (env.FILES_STORAGE_DIR === undefined || env.FILES_STORAGE_DIR.trim() === '') {
    if (isProduction) problems.push('FILES_STORAGE_DIR is required in production');
  } else if (!path.isAbsolute(env.FILES_STORAGE_DIR)) {
    problems.push('FILES_STORAGE_DIR must be an absolute path');
  } else {
    storageDir = path.resolve(env.FILES_STORAGE_DIR);
  }

  const maxFileBytes = parseInteger(
    'FILES_MAX_BYTES',
    env.FILES_MAX_BYTES ?? String(DEFAULT_FILES_MAX_BYTES),
    MIN_FILES_MAX_BYTES,
    MAX_FILES_MAX_BYTES,
    problems,
  );

  const maxPendingUploadsPerUser = parseInteger(
    'FILES_MAX_PENDING_PER_USER',
    env.FILES_MAX_PENDING_PER_USER ?? '20',
    1,
    1000,
    problems,
  );
  const maxConcurrentUploadsPerUser = parseInteger(
    'FILES_MAX_CONCURRENT_UPLOADS_PER_USER',
    env.FILES_MAX_CONCURRENT_UPLOADS_PER_USER ?? '3',
    1,
    100,
    problems,
  );

  if (problems.length) throw new ConfigError('files', problems);
  return {
    env: appEnv,
    host,
    port,
    apiDocsEnabled,
    trustProxyHops,
    logLevel,
    errorTypeBaseUrl,
    bodyLimitBytes: 64 * 1024,
    databaseUrl: databaseUrl!,
    jwks: jwks!,
    issuer: env.AUTH_JWT_ISSUER ?? DEFAULT_ACCESS_TOKEN_ISSUER,
    audience: env.AUTH_JWT_AUDIENCE ?? DEFAULT_ACCESS_TOKEN_AUDIENCE,
    organizationServiceUrl,
    messagingServiceUrl,
    storageDir,
    maxFileBytes,
    maxPendingUploadsPerUser,
    maxConcurrentUploadsPerUser,
    pendingUploadTtlMs: PENDING_UPLOAD_TTL_MS,
  };
}
