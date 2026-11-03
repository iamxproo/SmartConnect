import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_WEB_ORIGINS, loadConfig } from '../src/config.js';
import { trustedJwks } from './support/harness.js';

const base = { AUTH_JWT_PUBLIC_JWKS: trustedJwks, REDIS_URL: 'redis://:pw@127.0.0.1:6379/0' };
const PRODUCTION = {
  ...base,
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  WORKSPACE_SERVICE_URL: 'http://workspace.internal:3103',
  MESSAGING_SERVICE_URL: 'http://messaging.internal:3104',
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('realtime loadConfig', () => {
  it('has safe local defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      env: 'development',
      host: '127.0.0.1',
      port: 3105,
      trustProxyHops: 0,
      corsAllowedOrigins: DEV_WEB_ORIGINS,
      workspaceServiceUrl: 'http://127.0.0.1:3103',
      messagingServiceUrl: 'http://127.0.0.1:3104',
      eventsChannel: 'smartconnect:events',
      reauthorizeIntervalSeconds: 60,
      auth: { issuer: 'smartconnect-identity', audience: 'smartconnect-api' },
    });
  });

  it('requires the public keys and Redis in every environment', () => {
    expect(problemsOf({})).toEqual([
      'AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys',
      'REDIS_URL (or REDIS_URL_FILE) is required: Redis pub/sub is the gateway’s only event source',
    ]);
  });

  it('reads REDIS_URL and the keys from files; rejects setting both forms', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'realtime-config-'));
    const redis = path.join(dir, 'redis');
    const jwks = path.join(dir, 'jwks.json');
    writeFileSync(redis, 'redis://:pw@redis:6379/0\n');
    writeFileSync(jwks, trustedJwks);
    expect(loadConfig({ REDIS_URL_FILE: redis, AUTH_JWT_PUBLIC_JWKS_FILE: jwks }).redisUrl).toBe(
      'redis://:pw@redis:6379/0',
    );
    expect(problemsOf({ ...base, REDIS_URL_FILE: redis })).toEqual([
      'set either REDIS_URL or REDIS_URL_FILE, not both',
    ]);
  });

  it('validates values without echoing secrets', () => {
    const problems = problemsOf({
      ...base,
      REDIS_URL: 'http://user:topsecret@redis',
      REAUTHORIZE_INTERVAL_SECONDS: '0',
      REALTIME_EVENTS_CHANNEL: 'bad channel!',
      PORT: '99999',
    });
    expect(problems).toHaveLength(4);
    expect(problems.join(' ')).not.toContain('topsecret');
  });

  it('bounds sockets per user: 10 by default, 1-1000', () => {
    expect(loadConfig(base).maxSocketsPerUser).toBe(10);
    expect(problemsOf({ ...base, MAX_SOCKETS_PER_USER: '0' })).toHaveLength(1);
  });

  it('allows a 1 second re-authorization interval for tests', () => {
    expect(loadConfig({ ...base, REAUTHORIZE_INTERVAL_SECONDS: '1' }).reauthorizeIntervalSeconds).toBe(1);
  });

  it('requires exact origins and the workspace and messaging service URLs in production; never "*"', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production' })).toEqual([
      'CORS_ALLOWED_ORIGINS is required in production',
      'WORKSPACE_SERVICE_URL is required in production',
      'MESSAGING_SERVICE_URL is required in production',
    ]);
    expect(loadConfig(PRODUCTION).messagingServiceUrl).toBe('http://messaging.internal:3104');
    expect(problemsOf({ ...base, CORS_ALLOWED_ORIGINS: '*' })).toEqual([
      'CORS_ALLOWED_ORIGINS must list exact origins; "*" is not allowed',
    ]);
    expect(problemsOf({ ...base, CORS_ALLOWED_ORIGINS: 'https://a.example/path' })).toHaveLength(1);
    expect(loadConfig(PRODUCTION).corsAllowedOrigins).toEqual(['https://app.example.com']);
  });

  it('rejects private key material in the verifier configuration', () => {
    const { privateJwk } = { privateJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AA', d: 'AA', kid: 'k' } };
    expect(problemsOf({ ...base, AUTH_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [privateJwk] }) }).join(' ')).toContain(
      'private key material',
    );
  });
});
