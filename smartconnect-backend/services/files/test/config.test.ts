import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { generateSigningKey } from './keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { kty, crv, x, kid } = generateSigningKey('k1');
const jwks = JSON.stringify({ keys: [{ kty, crv, x, kid }] });
const base = {
  DATABASE_URL: 'postgresql://sc_files_app:pw@127.0.0.1:15433/smartconnect_test?schema=files',
  AUTH_JWT_PUBLIC_JWKS: jwks,
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

describe('files loadConfig', () => {
  it('has safe defaults: loopback :3106, one trusted proxy, organization :3102, messaging :3104', () => {
    expect(loadConfig(base)).toMatchObject({
      env: 'development',
      host: '127.0.0.1',
      port: 3106,
      trustProxyHops: 1,
      issuer: 'smartconnect-identity',
      audience: 'smartconnect-api',
      organizationServiceUrl: 'http://127.0.0.1:3102',
      messagingServiceUrl: 'http://127.0.0.1:3104',
      maxFileBytes: 25 * 1024 * 1024,
      maxPendingUploadsPerUser: 20,
      maxConcurrentUploadsPerUser: 3,
    });
  });

  it('has no default secrets: the database URL and public keys are required', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL is required (locally: make db-bootstrap writes it to services/files/.env)',
      'AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys',
    ]);
  });

  it('reads the public keys from a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'files-config-'));
    const file = path.join(dir, 'jwks.json');
    writeFileSync(file, jwks);
    expect(loadConfig({ DATABASE_URL: base.DATABASE_URL, AUTH_JWT_PUBLIC_JWKS_FILE: file }).jwks.keys).toHaveLength(1);
  });

  it('rejects private key material in the verifier configuration', () => {
    const problems = problemsOf({
      ...base,
      AUTH_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [generateSigningKey('k2')] }),
    });
    expect(problems.join(' ')).toContain('private key material');
  });

  it('requires the service URLs and the storage directory in production, and validates them', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production' })).toEqual([
      'ORGANIZATION_SERVICE_URL is required in production',
      'MESSAGING_SERVICE_URL is required in production',
      'FILES_STORAGE_DIR is required in production',
    ]);
    expect(problemsOf({ ...base, MESSAGING_SERVICE_URL: 'ftp://x' })).toEqual([
      'MESSAGING_SERVICE_URL must be an http(s) URL without credentials, query or fragment',
    ]);
    const production = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ORGANIZATION_SERVICE_URL: 'http://organization:3102/',
      MESSAGING_SERVICE_URL: 'http://messaging:3104',
      FILES_STORAGE_DIR: '/var/lib/smartconnect/files',
    });
    expect(production.organizationServiceUrl).toBe('http://organization:3102');
    expect(production.storageDir).toBe('/var/lib/smartconnect/files');
  });

  it('defaults the storage directory to <repo>/.local/files outside production and wants an absolute path', () => {
    const dir = loadConfig(base).storageDir;
    expect(dir).toBe(path.resolve(__dirname, '../../../../.local/files'));
    expect(problemsOf({ ...base, FILES_STORAGE_DIR: 'relative/dir' })).toEqual([
      'FILES_STORAGE_DIR must be an absolute path',
    ]);
  });

  it('bounds FILES_MAX_BYTES', () => {
    expect(loadConfig({ ...base, FILES_MAX_BYTES: '2048' }).maxFileBytes).toBe(2048);
    for (const bad of ['0', '1023', String(100 * 1024 * 1024 + 1), '25MB', '-1'])
      expect(problemsOf({ ...base, FILES_MAX_BYTES: bad })).toEqual([
        'FILES_MAX_BYTES must be an integer from 1024 to 104857600',
      ]);
  });

  it('validates the database URL and port without echoing values', () => {
    const problems = problemsOf({ ...base, DATABASE_URL: 'mysql://user:topsecret@db/x', PORT: '99999' });
    expect(problems).toEqual(['PORT must be an integer from 1 to 65535', 'DATABASE_URL must be a postgresql:// URL']);
    expect(problems.join(' ')).not.toContain('topsecret');
  });
});
