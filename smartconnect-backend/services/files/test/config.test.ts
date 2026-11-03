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

  it('requires the service URLs and an explicit storage (with its directory, if local) in production, and validates them', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production' })).toEqual([
      'ORGANIZATION_SERVICE_URL is required in production',
      'MESSAGING_SERVICE_URL is required in production',
      'FILES_STORAGE_PROVIDER is required in production ("r2": Cloudflare R2; "local": FILES_STORAGE_DIR on this machine)',
    ]);
    expect(problemsOf({ ...base, NODE_ENV: 'production', FILES_STORAGE_PROVIDER: 'local' })).toEqual([
      'ORGANIZATION_SERVICE_URL is required in production',
      'MESSAGING_SERVICE_URL is required in production',
      'FILES_STORAGE_DIR is required in production with FILES_STORAGE_PROVIDER=local',
    ]);
    expect(problemsOf({ ...base, MESSAGING_SERVICE_URL: 'ftp://x' })).toEqual([
      'MESSAGING_SERVICE_URL must be an http(s) URL without credentials, query or fragment',
    ]);
    const production = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ORGANIZATION_SERVICE_URL: 'http://organization:3102/',
      MESSAGING_SERVICE_URL: 'http://messaging:3104',
      FILES_STORAGE_PROVIDER: 'local',
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

  describe('storage', () => {
    const r2 = {
      FILES_STORAGE_PROVIDER: 'r2',
      FILES_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      FILES_R2_BUCKET: 'smartconnect-files',
      FILES_R2_ACCESS_KEY_ID: 'f0a1b2c3d4e5f60718293a4b5c6d7e8f',
      FILES_R2_SECRET_ACCESS_KEY: 'not-a-real-secret-0123456789abcdef',
    };
    const production = {
      ...base,
      NODE_ENV: 'production',
      ORGANIZATION_SERVICE_URL: 'http://organization:3102',
      MESSAGING_SERVICE_URL: 'http://messaging:3104',
    };

    it('defaults to the local directory, a 10 GB budget, a 15-minute usage scan and 60-second links', () => {
      expect(loadConfig(base)).toMatchObject({
        storage: { provider: 'local' },
        storageBudgetBytes: 10_000_000_000,
        storageUsageScanIntervalMs: 900_000,
        signedUrlTtlSeconds: 60,
      });
    });

    it('reads the R2 settings, with region auto and the secret from a variable or a file', () => {
      const config = loadConfig({ ...production, ...r2 });
      expect(config.storage).toMatchObject({
        provider: 'r2',
        bucket: 'smartconnect-files',
        region: 'auto',
        accessKeyId: r2.FILES_R2_ACCESS_KEY_ID,
        secretAccessKey: r2.FILES_R2_SECRET_ACCESS_KEY,
        timeoutMs: 30_000,
      });
      expect(config.storage.provider === 'r2' && config.storage.endpoint.href).toBe(`${r2.FILES_R2_ENDPOINT}/`);
      // R2 needs no storage directory, even in production; uploads are staged in a temporary directory.
      expect(config.stagingDir).toMatch(/smartconnect-files-staging$/);
    });

    it('names every missing R2 setting, never echoing values', () => {
      expect(problemsOf({ ...base, FILES_STORAGE_PROVIDER: 'r2' })).toEqual([
        'FILES_R2_ENDPOINT is required with FILES_STORAGE_PROVIDER=r2 (https://<account id>.r2.cloudflarestorage.com)',
        'FILES_R2_BUCKET is required with FILES_STORAGE_PROVIDER=r2',
        'FILES_R2_ACCESS_KEY_ID is required with FILES_STORAGE_PROVIDER=r2',
        'FILES_R2_SECRET_ACCESS_KEY (or FILES_R2_SECRET_ACCESS_KEY_FILE) is required with FILES_STORAGE_PROVIDER=r2',
      ]);
      const problems = problemsOf({
        ...base,
        ...r2,
        FILES_R2_SECRET_ACCESS_KEY: 'has spaces in it, not a key',
        FILES_R2_BUCKET: 'Bad_Bucket',
      });
      expect(problems).toEqual([
        'FILES_R2_BUCKET must be 3-63 lowercase letters, digits or hyphens',
        'FILES_R2_SECRET_ACCESS_KEY must be 16-256 characters without spaces',
      ]);
      expect(problems.join(' ')).not.toContain('has spaces');
      expect(problemsOf({ ...base, FILES_STORAGE_PROVIDER: 's3' })).toEqual([
        'FILES_STORAGE_PROVIDER must be one of local, r2',
      ]);
    });

    it('accepts only a Cloudflare R2 endpoint in production, over https, with nothing but the host', () => {
      for (const endpoint of [
        'https://s3.amazonaws.com',
        'https://evil.example.com',
        'https://r2.cloudflarestorage.com.evil.example',
      ]) {
        expect(problemsOf({ ...production, ...r2, FILES_R2_ENDPOINT: endpoint })).toEqual([
          'FILES_R2_ENDPOINT must be a Cloudflare R2 endpoint (<account id>.r2.cloudflarestorage.com)',
        ]);
      }
      expect(problemsOf({ ...production, ...r2, FILES_R2_ENDPOINT: 'http://abc.r2.cloudflarestorage.com' })).toEqual([
        'FILES_R2_ENDPOINT must be https',
      ]);
      for (const endpoint of [
        `${r2.FILES_R2_ENDPOINT}/bucket`,
        `${r2.FILES_R2_ENDPOINT}?x=1`,
        'https://user:pw@abc.r2.cloudflarestorage.com',
      ])
        expect(problemsOf({ ...production, ...r2, FILES_R2_ENDPOINT: endpoint })).toEqual([
          'FILES_R2_ENDPOINT must be the endpoint alone: no path, query or credentials',
        ]);
      // An EU-jurisdiction endpoint is still R2.
      expect(
        problemsOf({ ...production, ...r2, FILES_R2_ENDPOINT: 'https://abc.eu.r2.cloudflarestorage.com' }),
      ).toEqual([]);
    });

    it('allows a loopback http endpoint (a local fake) outside production only', () => {
      expect(problemsOf({ ...base, ...r2, FILES_R2_ENDPOINT: 'http://127.0.0.1:9000' })).toEqual([]);
      expect(problemsOf({ ...production, ...r2, FILES_R2_ENDPOINT: 'http://127.0.0.1:9000' })).toEqual([
        'FILES_R2_ENDPOINT must be https',
      ]);
      expect(problemsOf({ ...base, ...r2, FILES_R2_ENDPOINT: 'http://files.internal:9000' })).toEqual([
        'FILES_R2_ENDPOINT must be https',
      ]);
    });

    it('bounds the budget, the scan interval and the link lifetime', () => {
      expect(loadConfig({ ...base, FILES_STORAGE_BUDGET_BYTES: '5000000000' }).storageBudgetBytes).toBe(5_000_000_000);
      expect(
        problemsOf({
          ...base,
          FILES_STORAGE_BUDGET_BYTES: '1000',
          FILES_STORAGE_USAGE_SCAN_SECONDS: '5',
          FILES_SIGNED_URL_TTL_SECONDS: '3600',
        }),
      ).toEqual([
        'FILES_STORAGE_BUDGET_BYTES must be an integer from 1048576 to 10000000000000',
        'FILES_STORAGE_USAGE_SCAN_SECONDS must be an integer from 60 to 86400',
        'FILES_SIGNED_URL_TTL_SECONDS must be an integer from 10 to 600',
      ]);
    });
  });
});
