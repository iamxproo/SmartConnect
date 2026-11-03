// Building blocks for service configuration loaders: each service validates its environment once at startup and
// reports every problem at once (fail fast). Values are never echoed in problems, because some are secrets.
import { readFileSync } from 'node:fs';

export const environments = ['development', 'test', 'production'] as const;
export type Environment = (typeof environments)[number];

export const logLevels = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof logLevels)[number];

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(
    service: string,
    readonly problems: string[],
  ) {
    super(`Invalid ${service} configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function parseEnvironment(env: Env, problems: string[]): Environment {
  const raw = env.NODE_ENV ?? 'development';
  if (!(environments as readonly string[]).includes(raw))
    problems.push(`NODE_ENV must be one of ${environments.join(', ')}`);
  return raw as Environment;
}

export function parseBoolean(name: string, raw: string, problems: string[]): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be "true" or "false"`);
  return false;
}

export function parseInteger(name: string, raw: string, min: number, max: number, problems: string[]): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max)
    problems.push(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function parseLogLevel(env: Env, problems: string[]): LogLevel {
  const raw = env.LOG_LEVEL ?? 'log';
  if (!(logLevels as readonly string[]).includes(raw))
    problems.push(`LOG_LEVEL must be one of ${logLevels.join(', ')}`);
  return raw as LogLevel;
}

export const DEFAULT_ERROR_TYPE_BASE_URL = 'https://docs.smartconnect.dev/errors/';

export function parseErrorTypeBaseUrl(env: Env, problems: string[]): string {
  const value = env.ERROR_TYPE_BASE_URL ?? DEFAULT_ERROR_TYPE_BASE_URL;
  if (!/^https:\/\/[^\s]+\/$/.test(value)) problems.push('ERROR_TYPE_BASE_URL must be an https URL ending with "/"');
  return value;
}

/**
 * Reads a secret from `NAME`, or from the file named by `NAME_FILE` (secrets managers and Docker/Kubernetes secrets
 * mount files). Setting both is an error. Returns undefined when neither is set; the caller decides whether the
 * value is required. Surrounding whitespace (e.g. a trailing newline in the file) is removed.
 */
export function readSecret(env: Env, name: string, problems: string[]): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    problems.push(`set either ${name} or ${name}_FILE, not both`);
    return undefined;
  }
  if (file !== undefined) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (!value) problems.push(`${name}_FILE points to an empty file`);
      return value || undefined;
    } catch {
      problems.push(`${name}_FILE could not be read (check the path and permissions)`);
      return undefined;
    }
  }
  const value = direct?.trim();
  return value ? value : undefined;
}

/** An absolute http(s) URL with no credentials, query or fragment; the trailing slash is removed. */
export function parseServiceUrl(name: string, raw: string, problems: string[]): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('invalid');
    return url.toString().replace(/\/$/, '');
  } catch {
    problems.push(`${name} must be an http(s) URL without credentials, query or fragment`);
    return '';
  }
}
