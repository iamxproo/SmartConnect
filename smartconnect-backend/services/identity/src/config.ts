// Identity service configuration from environment variables, validated once at startup (fail fast, all problems
// at once, values never echoed). Secrets: DATABASE_URL (runtime role sc_identity_app) and the access-token signing
// key. No defaults exist for either. Decision record: docs/decisions/0009-identity-and-authentication.md.
import {
  ConfigError,
  DEFAULT_ACCESS_TOKEN_AUDIENCE,
  DEFAULT_ACCESS_TOKEN_ISSUER,
  parseBoolean,
  parseEnvironment,
  parseErrorTypeBaseUrl,
  parseInteger,
  parseLogLevel,
  parseServiceUrl,
  parseSmtpConfig,
  readSecret,
  type Env,
  type Environment,
  type LogLevel,
  type SmtpConfig,
} from '@smartconnect/backend-kit';
import type { JWK } from 'jose';

export { ConfigError };

export const accountNotifiers = ['dev-mailbox', 'smtp', 'disabled'] as const;
export type AccountNotifierKind = (typeof accountNotifiers)[number];

export interface IdentityConfig {
  env: Environment;
  host: string;
  port: number;
  apiDocsEnabled: boolean;
  /** Reverse proxies in front of the service: 1 = the API gateway (whose X-Forwarded-For carries the client IP). */
  trustProxyHops: number;
  logLevel: LogLevel;
  errorTypeBaseUrl: string;
  bodyLimitBytes: number;
  databaseUrl: string;
  /** Ed25519 private JWK (with `kid`) that signs access tokens. */
  signingKey: JWK & { kid: string };
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  /** A refresh token unused for this long expires (sliding). */
  refreshIdleTtlSeconds: number;
  /** Hard cap on a session's age, however often it is refreshed. */
  sessionMaxLifetimeSeconds: number;
  passwordResetTtlSeconds: number;
  emailVerificationTtlSeconds: number;
  /** Origin of the web app, for links in account emails. */
  webAppUrl: string;
  /** Where account emails (verification, password reset, security notices) go. */
  accountNotifier: AccountNotifierKind;
  /** Present when `accountNotifier` is "smtp". */
  smtp?: SmtpConfig;
}

/** The Vite dev server (smartconnect-frontend/web). Development and test only. */
export const DEV_WEB_APP_URL = 'http://127.0.0.1:5173';

/** Injection token for the validated IdentityConfig. */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

const DAY = 24 * 60 * 60;

function parseSigningKey(raw: string, problems: string[]): IdentityConfig['signingKey'] | undefined {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    problems.push('AUTH_JWT_PRIVATE_JWK must be a JSON Web Key');
    return undefined;
  }
  if (
    typeof jwk !== 'object' ||
    jwk === null ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.d !== 'string' ||
    typeof jwk.x !== 'string'
  ) {
    problems.push('AUTH_JWT_PRIVATE_JWK must be an Ed25519 private key (kty "OKP", crv "Ed25519", d, x)');
    return undefined;
  }
  if (typeof jwk.kid !== 'string' || !jwk.kid) {
    problems.push('AUTH_JWT_PRIVATE_JWK needs a non-empty "kid" (verifiers select the key by it)');
    return undefined;
  }
  return { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x, kid: jwk.kid };
}

export function loadConfig(env: Env = process.env): IdentityConfig {
  const problems: string[] = [];

  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const host = env.HOST ?? '127.0.0.1';
  const port = parseInteger('PORT', env.PORT ?? '3101', 1, 65535, problems);
  const apiDocsEnabled =
    env.API_DOCS_ENABLED === undefined
      ? appEnv === 'development'
      : parseBoolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, problems);
  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '1', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  const databaseUrl = readSecret(env, 'DATABASE_URL', problems);
  if (databaseUrl === undefined && env.DATABASE_URL_FILE === undefined)
    problems.push('DATABASE_URL is required (locally: make db-bootstrap writes it to services/identity/.env)');
  else if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push('DATABASE_URL must be a postgresql:// URL');

  const rawKey = readSecret(env, 'AUTH_JWT_PRIVATE_JWK', problems);
  let signingKey: IdentityConfig['signingKey'] | undefined;
  if (rawKey === undefined && env.AUTH_JWT_PRIVATE_JWK_FILE === undefined)
    problems.push('AUTH_JWT_PRIVATE_JWK (or AUTH_JWT_PRIVATE_JWK_FILE) is required; locally: make auth-dev-keys');
  else if (rawKey !== undefined) signingKey = parseSigningKey(rawKey, problems);

  const accessTokenTtlSeconds = parseInteger(
    'ACCESS_TOKEN_TTL_SECONDS',
    env.ACCESS_TOKEN_TTL_SECONDS ?? '900',
    60,
    3600,
    problems,
  );
  const refreshIdleDays = parseInteger('REFRESH_TOKEN_IDLE_DAYS', env.REFRESH_TOKEN_IDLE_DAYS ?? '30', 1, 90, problems);
  const maxLifetimeDays = parseInteger(
    'SESSION_MAX_LIFETIME_DAYS',
    env.SESSION_MAX_LIFETIME_DAYS ?? '90',
    1,
    365,
    problems,
  );
  if (maxLifetimeDays < refreshIdleDays)
    problems.push('SESSION_MAX_LIFETIME_DAYS must be at least REFRESH_TOKEN_IDLE_DAYS');
  const verificationHours = parseInteger(
    'EMAIL_VERIFICATION_TTL_HOURS',
    env.EMAIL_VERIFICATION_TTL_HOURS ?? '48',
    1,
    168,
    problems,
  );
  let webAppUrl = DEV_WEB_APP_URL;
  if (env.WEB_APP_URL === undefined) {
    if (isProduction) problems.push('WEB_APP_URL is required in production (links in account emails)');
  } else {
    webAppUrl = parseServiceUrl('WEB_APP_URL', env.WEB_APP_URL, problems);
    if (isProduction && webAppUrl !== '' && !webAppUrl.startsWith('https://'))
      problems.push('WEB_APP_URL must be https in production (links in account emails carry one-time tokens)');
  }
  const resetMinutes = parseInteger(
    'PASSWORD_RESET_TTL_MINUTES',
    env.PASSWORD_RESET_TTL_MINUTES ?? '30',
    5,
    1440,
    problems,
  );

  let accountNotifier: AccountNotifierKind = 'dev-mailbox';
  if (env.ACCOUNT_NOTIFIER === undefined) {
    if (isProduction)
      problems.push('ACCOUNT_NOTIFIER is required in production ("smtp" sends mail; "disabled" drops it)');
  } else if (!(accountNotifiers as readonly string[]).includes(env.ACCOUNT_NOTIFIER)) {
    problems.push(`ACCOUNT_NOTIFIER must be one of ${accountNotifiers.join(', ')}`);
  } else {
    accountNotifier = env.ACCOUNT_NOTIFIER as AccountNotifierKind;
  }
  if (isProduction && accountNotifier === 'dev-mailbox')
    problems.push('ACCOUNT_NOTIFIER=dev-mailbox is not allowed in production (it exposes reset tokens over HTTP)');

  const smtp = accountNotifier === 'smtp' ? parseSmtpConfig(env, problems, { production: isProduction }) : undefined;

  if (problems.length) throw new ConfigError('identity', problems);
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
    signingKey: signingKey!,
    issuer: env.AUTH_JWT_ISSUER ?? DEFAULT_ACCESS_TOKEN_ISSUER,
    audience: env.AUTH_JWT_AUDIENCE ?? DEFAULT_ACCESS_TOKEN_AUDIENCE,
    accessTokenTtlSeconds,
    refreshIdleTtlSeconds: refreshIdleDays * DAY,
    sessionMaxLifetimeSeconds: maxLifetimeDays * DAY,
    passwordResetTtlSeconds: resetMinutes * 60,
    emailVerificationTtlSeconds: verificationHours * 3600,
    webAppUrl,
    accountNotifier,
    ...(smtp && { smtp }),
  };
}
