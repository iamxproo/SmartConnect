// Organization service configuration from environment variables, validated once at startup (fail fast, all problems
// at once, values never echoed). Decision record: docs/decisions/0010-organizations-and-membership.md.
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
  parseSmtpConfig,
  readSecret,
  type Env,
  type Environment,
  type LogLevel,
  type SmtpConfig,
} from '@smartconnect/backend-kit';
import type { JSONWebKeySet } from 'jose';

export { ConfigError };

export const invitationNotifiers = ['dev-mailbox', 'smtp', 'disabled'] as const;
export type InvitationNotifierKind = (typeof invitationNotifiers)[number];

/** Who may create organizations (ADR 0017): any verified account, or only the allowlist. */
export const organizationCreationModes = ['open', 'allowlist'] as const;
export type OrganizationCreationMode = (typeof organizationCreationModes)[number];

export interface OrganizationConfig {
  env: Environment;
  host: string;
  port: number;
  apiDocsEnabled: boolean;
  trustProxyHops: number;
  logLevel: LogLevel;
  errorTypeBaseUrl: string;
  bodyLimitBytes: number;
  databaseUrl: string;
  auth: { jwks: JSONWebKeySet; issuer: string; audience: string };
  identityServiceUrl: string;
  webAppUrl: string;
  /**
   * "open": any active account with a verified email creates organizations (self-service), up to
   * `maxOwnedOrganizations` each. "allowlist": only `organizationCreatorEmails`. Platform Super Admins never do.
   */
  organizationCreation: OrganizationCreationMode;
  /**
   * Verified email addresses allowed to create organizations: the only creators in "allowlist" mode (empty = nobody,
   * fail closed); exempt from `maxOwnedOrganizations` in "open" mode.
   */
  organizationCreatorEmails: ReadonlySet<string>;
  /** "open" mode: organizations one person may own; a further one is refused (organization_limit_reached). */
  maxOwnedOrganizations: number;
  invitationNotifier: InvitationNotifierKind;
  /** Present when `invitationNotifier` is "smtp". */
  smtp?: SmtpConfig;
}

export const ORGANIZATION_CONFIG = Symbol('ORGANIZATION_CONFIG');

const DEV_IDENTITY_SERVICE_URL = 'http://127.0.0.1:3101';
const DEV_WEB_APP_URL = 'http://127.0.0.1:5173';

export function loadConfig(env: Env = process.env): OrganizationConfig {
  const problems: string[] = [];
  const appEnv = parseEnvironment(env, problems);
  const isProduction = appEnv === 'production';

  const port = parseInteger('PORT', env.PORT ?? '3102', 1, 65535, problems);
  const apiDocsEnabled =
    env.API_DOCS_ENABLED === undefined
      ? appEnv === 'development'
      : parseBoolean('API_DOCS_ENABLED', env.API_DOCS_ENABLED, problems);
  const trustProxyHops = parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS ?? '1', 0, 10, problems);
  const logLevel = parseLogLevel(env, problems);
  const errorTypeBaseUrl = parseErrorTypeBaseUrl(env, problems);

  const databaseUrl = readSecret(env, 'DATABASE_URL', problems);
  if (databaseUrl === undefined && env.DATABASE_URL_FILE === undefined)
    problems.push('DATABASE_URL is required (locally: make db-bootstrap writes it to services/organization/.env)');

  const rawJwks = readSecret(env, 'AUTH_JWT_PUBLIC_JWKS', problems);
  let jwks: JSONWebKeySet = { keys: [] };
  if (rawJwks === undefined && env.AUTH_JWT_PUBLIC_JWKS_FILE === undefined)
    problems.push('AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys');
  else if (rawJwks !== undefined) jwks = parsePublicJwks('AUTH_JWT_PUBLIC_JWKS', rawJwks, problems) ?? jwks;

  const requiredInProduction = (name: string, devDefault: string): string => {
    const raw = env[name];
    if (raw !== undefined) return parseServiceUrl(name, raw, problems);
    if (isProduction) problems.push(`${name} is required in production`);
    return devDefault;
  };
  const identityServiceUrl = requiredInProduction('IDENTITY_SERVICE_URL', DEV_IDENTITY_SERVICE_URL);
  const webAppUrl = requiredInProduction('WEB_APP_URL', DEV_WEB_APP_URL);
  if (isProduction && webAppUrl !== '' && env.WEB_APP_URL !== undefined && !webAppUrl.startsWith('https://'))
    problems.push('WEB_APP_URL must be https in production (invitation links carry one-time tokens)');

  const creators = (env.ORGANIZATION_CREATOR_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  for (const email of creators) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      problems.push('ORGANIZATION_CREATOR_EMAILS must be a comma-separated list of email addresses');
  }

  // Outside production the default stays the allowlist (local stacks and tests opt in to self-service); production
  // must choose explicitly, as for INVITATION_NOTIFIER.
  let organizationCreation: OrganizationCreationMode = 'allowlist';
  if (env.ORGANIZATION_CREATION === undefined) {
    if (isProduction)
      problems.push(
        'ORGANIZATION_CREATION is required in production ("open": any verified account; "allowlist": ORGANIZATION_CREATOR_EMAILS only)',
      );
  } else if (!(organizationCreationModes as readonly string[]).includes(env.ORGANIZATION_CREATION)) {
    problems.push(`ORGANIZATION_CREATION must be one of ${organizationCreationModes.join(', ')}`);
  } else {
    organizationCreation = env.ORGANIZATION_CREATION as OrganizationCreationMode;
  }
  const maxOwnedOrganizations = parseInteger(
    'ORGANIZATION_MAX_OWNED_PER_USER',
    env.ORGANIZATION_MAX_OWNED_PER_USER ?? '10',
    1,
    1000,
    problems,
  );

  let invitationNotifier: InvitationNotifierKind = 'dev-mailbox';
  if (env.INVITATION_NOTIFIER === undefined) {
    if (isProduction)
      problems.push('INVITATION_NOTIFIER is required in production ("smtp" sends mail; "disabled" drops it)');
  } else if (!(invitationNotifiers as readonly string[]).includes(env.INVITATION_NOTIFIER)) {
    problems.push(`INVITATION_NOTIFIER must be one of ${invitationNotifiers.join(', ')}`);
  } else {
    invitationNotifier = env.INVITATION_NOTIFIER as InvitationNotifierKind;
  }
  if (isProduction && invitationNotifier === 'dev-mailbox')
    problems.push(
      'INVITATION_NOTIFIER=dev-mailbox is not allowed in production (it exposes invitation tokens over HTTP)',
    );

  const smtp = invitationNotifier === 'smtp' ? parseSmtpConfig(env, problems, { production: isProduction }) : undefined;

  if (problems.length) throw new ConfigError('organization', problems);
  return {
    env: appEnv,
    host: env.HOST ?? '127.0.0.1',
    port,
    apiDocsEnabled,
    trustProxyHops,
    logLevel,
    errorTypeBaseUrl,
    bodyLimitBytes: 1024 * 1024,
    databaseUrl: databaseUrl!,
    auth: {
      jwks,
      issuer: env.AUTH_JWT_ISSUER ?? DEFAULT_ACCESS_TOKEN_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE ?? DEFAULT_ACCESS_TOKEN_AUDIENCE,
    },
    identityServiceUrl,
    webAppUrl,
    organizationCreation,
    organizationCreatorEmails: new Set(creators),
    maxOwnedOrganizations,
    invitationNotifier,
    ...(smtp && { smtp }),
  };
}
