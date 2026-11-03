// Files service configuration from environment variables, validated once at startup (fail fast, all problems at
// once, values never echoed). Secrets: DATABASE_URL (runtime role sc_files_app) and, with the R2 driver,
// FILES_R2_SECRET_ACCESS_KEY.
import { tmpdir } from 'node:os';
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

export const storageProviders = ['local', 'r2'] as const;
export type StorageProvider = (typeof storageProviders)[number];
/** Cloudflare R2's free storage, 10 GB, in decimal bytes: the smaller reading of "GB", so the safe one. */
export const DEFAULT_STORAGE_BUDGET_BYTES = 10_000_000_000;
const R2_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.r2\.cloudflarestorage\.com$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface R2StorageConfig {
  provider: 'r2';
  /** https://<account id>.r2.cloudflarestorage.com */
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs: number;
}

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
  /** Where the bytes live: the local-filesystem driver, or Cloudflare R2. */
  storage: { provider: 'local' } | R2StorageConfig;
  /** Absolute directory of the local-filesystem storage driver. Never served. */
  storageDir: string;
  /** Where the R2 driver stages uploads before sending them (the local driver stages inside storageDir). */
  stagingDir: string;
  /** Total bytes the application lets the storage hold (storage-budget.ts); not a provider billing cap. */
  storageBudgetBytes: number;
  /** How often the stored bytes are re-counted from the storage itself. */
  storageUsageScanIntervalMs: number;
  /** Lifetime of a presigned download link (R2 only). */
  signedUrlTtlSeconds: number;
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

  // Production names its storage explicitly; elsewhere the local directory stays the default, and R2 needs nothing.
  let provider: StorageProvider = 'local';
  if (env.FILES_STORAGE_PROVIDER === undefined) {
    if (isProduction)
      problems.push(
        'FILES_STORAGE_PROVIDER is required in production ("r2": Cloudflare R2; "local": FILES_STORAGE_DIR on this machine)',
      );
  } else if (!(storageProviders as readonly string[]).includes(env.FILES_STORAGE_PROVIDER)) {
    problems.push(`FILES_STORAGE_PROVIDER must be one of ${storageProviders.join(', ')}`);
  } else {
    provider = env.FILES_STORAGE_PROVIDER as StorageProvider;
  }

  const absoluteDir = (name: string): string | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    if (!path.isAbsolute(raw)) {
      problems.push(`${name} must be an absolute path`);
      return undefined;
    }
    return path.resolve(raw);
  };
  const configuredDir = absoluteDir('FILES_STORAGE_DIR');
  if (configuredDir === undefined && isProduction && provider === 'local' && env.FILES_STORAGE_PROVIDER !== undefined)
    problems.push('FILES_STORAGE_DIR is required in production with FILES_STORAGE_PROVIDER=local');
  const storageDir = configuredDir ?? DEV_STORAGE_DIR;
  const stagingDir = absoluteDir('FILES_STAGING_DIR') ?? path.join(tmpdir(), 'smartconnect-files-staging');

  const storage = provider === 'r2' ? parseR2(env, problems, isProduction) : { provider: 'local' as const };

  const storageBudgetBytes = parseInteger(
    'FILES_STORAGE_BUDGET_BYTES',
    env.FILES_STORAGE_BUDGET_BYTES ?? String(DEFAULT_STORAGE_BUDGET_BYTES),
    MIB,
    10_000_000_000_000,
    problems,
  );
  const storageUsageScanSeconds = parseInteger(
    'FILES_STORAGE_USAGE_SCAN_SECONDS',
    env.FILES_STORAGE_USAGE_SCAN_SECONDS ?? '900',
    60,
    86_400,
    problems,
  );
  const signedUrlTtlSeconds = parseInteger(
    'FILES_SIGNED_URL_TTL_SECONDS',
    env.FILES_SIGNED_URL_TTL_SECONDS ?? '60',
    10,
    600,
    problems,
  );

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
    storage: storage ?? { provider: 'local' },
    storageDir,
    stagingDir,
    storageBudgetBytes,
    storageUsageScanIntervalMs: storageUsageScanSeconds * 1000,
    signedUrlTtlSeconds,
    maxFileBytes,
    maxPendingUploadsPerUser,
    maxConcurrentUploadsPerUser,
    pendingUploadTtlMs: PENDING_UPLOAD_TTL_MS,
  };
}

/**
 * The R2 driver's settings. The endpoint is the account's S3 endpoint and nothing else: https, no path, query or
 * credentials, and in production a host under r2.cloudflarestorage.com, so a typo can never send files (and bills)
 * to another provider. Outside production a loopback http endpoint is allowed for local fakes.
 */
function parseR2(env: Env, problems: string[], isProduction: boolean): R2StorageConfig | undefined {
  const before = problems.length;
  let endpoint: URL | undefined;
  const raw = env.FILES_R2_ENDPOINT?.trim();
  if (!raw) {
    problems.push(
      'FILES_R2_ENDPOINT is required with FILES_STORAGE_PROVIDER=r2 (https://<account id>.r2.cloudflarestorage.com)',
    );
  } else {
    try {
      endpoint = new URL(raw);
    } catch {
      problems.push('FILES_R2_ENDPOINT must be a URL');
    }
    if (endpoint) {
      const loopbackFake = !isProduction && endpoint.protocol === 'http:' && LOOPBACK.has(endpoint.hostname);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/')
        problems.push('FILES_R2_ENDPOINT must be the endpoint alone: no path, query or credentials');
      else if (endpoint.protocol !== 'https:' && !loopbackFake) problems.push('FILES_R2_ENDPOINT must be https');
      else if (isProduction && !R2_HOST.test(endpoint.hostname))
        problems.push('FILES_R2_ENDPOINT must be a Cloudflare R2 endpoint (<account id>.r2.cloudflarestorage.com)');
    }
  }
  const bucket = env.FILES_R2_BUCKET?.trim();
  if (!bucket) problems.push('FILES_R2_BUCKET is required with FILES_STORAGE_PROVIDER=r2');
  else if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    problems.push('FILES_R2_BUCKET must be 3-63 lowercase letters, digits or hyphens');
  const accessKeyId = env.FILES_R2_ACCESS_KEY_ID?.trim();
  if (!accessKeyId) problems.push('FILES_R2_ACCESS_KEY_ID is required with FILES_STORAGE_PROVIDER=r2');
  else if (!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId))
    problems.push('FILES_R2_ACCESS_KEY_ID must be 16-128 letters or digits');
  const secretAccessKey = readSecret(env, 'FILES_R2_SECRET_ACCESS_KEY', problems)?.trim();
  if (secretAccessKey === undefined && env.FILES_R2_SECRET_ACCESS_KEY_FILE === undefined)
    problems.push(
      'FILES_R2_SECRET_ACCESS_KEY (or FILES_R2_SECRET_ACCESS_KEY_FILE) is required with FILES_STORAGE_PROVIDER=r2',
    );
  else if (secretAccessKey !== undefined && !/^\S{16,256}$/.test(secretAccessKey))
    problems.push('FILES_R2_SECRET_ACCESS_KEY must be 16-256 characters without spaces');
  const region = env.FILES_R2_REGION?.trim() || 'auto';
  if (!/^[a-z0-9-]{1,32}$/.test(region)) problems.push('FILES_R2_REGION must be lowercase letters, digits or hyphens');
  const timeoutMs = parseInteger('FILES_R2_TIMEOUT_MS', env.FILES_R2_TIMEOUT_MS ?? '30000', 1000, 120_000, problems);
  if (problems.length > before || !endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return { provider: 'r2', endpoint, bucket, region, accessKeyId, secretAccessKey, timeoutMs };
}
