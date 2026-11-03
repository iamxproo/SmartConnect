import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_IDENTITY_SERVICE_URL,
  DEV_FILES_SERVICE_URL,
  DEV_MESSAGING_SERVICE_URL,
  DEV_ORGANIZATION_SERVICE_URL,
  DEV_WEB_ORIGINS,
  DEV_WORKSPACE_SERVICE_URL,
  loadConfig,
} from '../src/config/config.js';
import { generateTestKeyPair, trustedJwks, trustedKeys } from './support/tokens.js';

/** Every configuration needs the public keys; tests add them unless they are testing their absence. */
const base = { AUTH_JWT_PUBLIC_JWKS: trustedJwks };
const PRODUCTION = {
  ...base,
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  IDENTITY_SERVICE_URL: 'http://identity.internal:3101',
  ORGANIZATION_SERVICE_URL: 'http://organization.internal:3102',
  WORKSPACE_SERVICE_URL: 'http://workspace.internal:3103',
  MESSAGING_SERVICE_URL: 'http://messaging.internal:3104',
  FILES_SERVICE_URL: 'http://files.internal:3106',
  REDIS_URL: 'redis://:secret@redis.internal:6379/0',
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

describe('loadConfig', () => {
  it('has safe local defaults: loopback, port 3000, dev web origins, docs on, no proxy trust', () => {
    expect(loadConfig(base)).toEqual({
      env: 'development',
      host: '127.0.0.1',
      port: 3000,
      corsAllowedOrigins: DEV_WEB_ORIGINS,
      apiDocsEnabled: true,
      trustProxyHops: 0,
      logLevel: 'log',
      errorTypeBaseUrl: 'https://docs.smartconnect.dev/errors/',
      bodyLimitBytes: 1024 * 1024,
      auth: {
        jwks: { keys: [{ ...trustedKeys.publicJwk, alg: 'EdDSA', use: 'sig' }] },
        issuer: 'smartconnect-identity',
        audience: 'smartconnect-api',
      },
      upstreams: {
        identity: DEV_IDENTITY_SERVICE_URL,
        organization: DEV_ORGANIZATION_SERVICE_URL,
        workspace: DEV_WORKSPACE_SERVICE_URL,
        messaging: DEV_MESSAGING_SERVICE_URL,
        files: DEV_FILES_SERVICE_URL,
      },
      upstreamTimeoutMs: 10_000,
      filesMaxBytes: 25 * 1024 * 1024,
      rateLimitStore: { kind: 'memory' },
    });
  });

  it('accepts a complete production configuration with Redis-backed rate limits', () => {
    const config = loadConfig(PRODUCTION);
    expect(config.rateLimitStore).toEqual({ kind: 'redis', url: PRODUCTION.REDIS_URL });
    expect(config.upstreams.identity).toBe('http://identity.internal:3101');
  });

  it('requires the access-token public keys everywhere', () => {
    expect(problemsOf({})).toEqual([
      'AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys',
    ]);
  });

  it('reads the public keys from a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gateway-config-'));
    const file = path.join(dir, 'jwks.json');
    writeFileSync(file, `${trustedJwks}\n`);
    expect(loadConfig({ AUTH_JWT_PUBLIC_JWKS_FILE: file }).auth.jwks.keys).toHaveLength(1);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS_FILE: path.join(dir, 'missing.json') })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS_FILE could not be read (check the path and permissions)',
    ]);
    expect(problemsOf({ ...base, AUTH_JWT_PUBLIC_JWKS_FILE: file })).toEqual([
      'set either AUTH_JWT_PUBLIC_JWKS or AUTH_JWT_PUBLIC_JWKS_FILE, not both',
    ]);
  });

  it('rejects private key material, non-Ed25519 keys, missing or duplicate kids, and malformed sets', () => {
    const { privateJwk, publicJwk } = generateTestKeyPair('k1');
    const jwks = (...keys: object[]) => JSON.stringify({ keys });
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: jwks(privateJwk) })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS key 0 contains private key material; publish only public keys',
    ]);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: jwks({ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'r' }) })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS key 0 must be an Ed25519 public key (kty "OKP", crv "Ed25519", x)',
    ]);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: jwks({ ...publicJwk, kid: undefined }) })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS key 0 needs a non-empty "kid"',
    ]);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: jwks(publicJwk, publicJwk) })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS key 1 repeats kid "k1"',
    ]);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: jwks({ ...publicJwk, alg: 'HS256' }) })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS key 0 alg must be "EdDSA"',
    ]);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: '{"keys":[]}' })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS must contain at least one key',
    ]);
    expect(problemsOf({ AUTH_JWT_PUBLIC_JWKS: 'not json' })).toEqual([
      'AUTH_JWT_PUBLIC_JWKS must be a JSON Web Key Set: {"keys":[…]}',
    ]);
  });

  it('requires the service URLs and Redis in production', () => {
    const {
      IDENTITY_SERVICE_URL: _identity,
      ORGANIZATION_SERVICE_URL: _organization,
      WORKSPACE_SERVICE_URL: _workspace,
      MESSAGING_SERVICE_URL: _messaging,
      FILES_SERVICE_URL: _files,
      REDIS_URL: _redis,
      ...withoutAll
    } = PRODUCTION;
    expect(problemsOf(withoutAll)).toEqual([
      'IDENTITY_SERVICE_URL is required in production',
      'ORGANIZATION_SERVICE_URL is required in production',
      'WORKSPACE_SERVICE_URL is required in production',
      'MESSAGING_SERVICE_URL is required in production',
      'FILES_SERVICE_URL is required in production',
      'REDIS_URL is required in production (rate limits must be shared by all gateway instances)',
    ]);
  });

  it('bounds FILES_MAX_BYTES', () => {
    expect(loadConfig({ ...base, FILES_MAX_BYTES: '4096' }).filesMaxBytes).toBe(4096);
    for (const bad of ['1023', String(100 * 1024 * 1024 + 1), 'lots'])
      expect(problemsOf({ ...base, FILES_MAX_BYTES: bad })).toEqual([
        'FILES_MAX_BYTES must be an integer from 1024 to 104857600',
      ]);
  });

  it('validates upstream and Redis URLs without echoing them', () => {
    expect(
      problemsOf({ ...base, IDENTITY_SERVICE_URL: 'http://user:pw@identity:3101', REDIS_URL: 'http://redis' }),
    ).toEqual([
      'IDENTITY_SERVICE_URL must be an http(s) URL without credentials, query or fragment',
      'REDIS_URL must be a redis:// or rediss:// URL',
    ]);
  });

  it('turns API docs off by default outside development, and lets them be set explicitly', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).apiDocsEnabled).toBe(false);
    expect(loadConfig(PRODUCTION).apiDocsEnabled).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'test', API_DOCS_ENABLED: 'true' }).apiDocsEnabled).toBe(true);
    expect(loadConfig({ ...base, API_DOCS_ENABLED: 'false' }).apiDocsEnabled).toBe(false);
  });

  it('requires explicit CORS origins in production', () => {
    const { CORS_ALLOWED_ORIGINS: _origins, ...withoutOrigins } = PRODUCTION;
    expect(problemsOf(withoutOrigins)).toEqual(['CORS_ALLOWED_ORIGINS is required in production']);
  });

  it('parses a comma-separated origin list and normalises a trailing slash', () => {
    const config = loadConfig({ ...base, CORS_ALLOWED_ORIGINS: ' https://app.example.com/ , http://127.0.0.1:4173' });
    expect(config.corsAllowedOrigins).toEqual(['https://app.example.com', 'http://127.0.0.1:4173']);
  });

  it.each([
    '*',
    'https://*.example.com',
    'app.example.com',
    'https://app.example.com/path',
    'ftp://example.com',
    'https://user@example.com',
  ])('rejects %j as a CORS origin', (origin) => {
    expect(problemsOf({ ...base, CORS_ALLOWED_ORIGINS: origin })).toHaveLength(1);
  });

  it('reports every problem at once', () => {
    const problems = problemsOf({
      ...base,
      NODE_ENV: 'staging',
      PORT: '70000',
      API_DOCS_ENABLED: 'yes',
      TRUST_PROXY_HOPS: '-1',
      LOG_LEVEL: 'trace',
      ERROR_TYPE_BASE_URL: 'http://docs.example.com/errors',
    });
    expect(problems).toEqual([
      'NODE_ENV must be one of development, test, production',
      'PORT must be an integer from 1 to 65535',
      'API_DOCS_ENABLED must be "true" or "false"',
      'TRUST_PROXY_HOPS must be an integer from 0 to 10',
      'LOG_LEVEL must be one of fatal, error, warn, log, debug, verbose',
      'ERROR_TYPE_BASE_URL must be an https URL ending with "/"',
    ]);
  });

  it.each(['0', '3000.5', ' 3000', '1e3', ''])('rejects PORT=%j', (port) => {
    expect(problemsOf({ ...base, PORT: port })).toEqual(['PORT must be an integer from 1 to 65535']);
  });
});
