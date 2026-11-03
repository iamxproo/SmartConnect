import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { generateSigningKey } from './keys.js';

const { kty, crv, x, kid } = generateSigningKey('k1');
const jwks = JSON.stringify({ keys: [{ kty, crv, x, kid }] });
const base = {
  DATABASE_URL: 'postgresql://sc_workspace_app:pw@127.0.0.1:15433/smartconnect_test?schema=workspace',
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

describe('workspace loadConfig', () => {
  it('has safe defaults: loopback :3103, one trusted proxy, organization service on :3102', () => {
    expect(loadConfig(base)).toMatchObject({
      env: 'development',
      host: '127.0.0.1',
      port: 3103,
      trustProxyHops: 1,
      issuer: 'smartconnect-identity',
      audience: 'smartconnect-api',
      organizationServiceUrl: 'http://127.0.0.1:3102',
    });
  });

  it('has no default secrets: the database URL and public keys are required', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL is required (locally: make db-bootstrap writes it to services/workspace/.env)',
      'AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys',
    ]);
  });

  it('reads the public keys from a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workspace-config-'));
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

  it('requires ORGANIZATION_SERVICE_URL in production and validates it', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production' })).toEqual([
      'ORGANIZATION_SERVICE_URL is required in production',
    ]);
    expect(problemsOf({ ...base, ORGANIZATION_SERVICE_URL: 'ftp://x' })).toEqual([
      'ORGANIZATION_SERVICE_URL must be an http(s) URL without credentials, query or fragment',
    ]);
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', ORGANIZATION_SERVICE_URL: 'http://organization:3102/' })
        .organizationServiceUrl,
    ).toBe('http://organization:3102');
  });

  it('validates the database URL and port without echoing values', () => {
    const problems = problemsOf({ ...base, DATABASE_URL: 'mysql://user:topsecret@db/x', PORT: '99999' });
    expect(problems).toEqual(['PORT must be an integer from 1 to 65535', 'DATABASE_URL must be a postgresql:// URL']);
    expect(problems.join(' ')).not.toContain('topsecret');
  });
});
