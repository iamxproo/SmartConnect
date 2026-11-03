// prepareBackend() with the applications' REAL config loaders: each application's own validation runs on its view,
// all problems of all applications come back together, and only identity's configuration holds the signing key.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DATABASE_APPS } from '../src/apps.js';
import { prepareBackend } from '../src/backend.js';
import type { Env } from '../src/env.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateJwk = { ...privateKey.export({ format: 'jwk' }), kid: 'unit', alg: 'EdDSA' };
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'unit', alg: 'EdDSA', use: 'sig' };
const dbUrl = (svc: string) => `postgresql://sc_${svc}_app:pw-${svc}-secret@127.0.0.1:15432/smartconnect?schema=${svc}`;

const development: Env = {
  NODE_ENV: 'development',
  AUTH_JWT_PRIVATE_JWK: JSON.stringify(privateJwk),
  AUTH_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  ...Object.fromEntries(DATABASE_APPS.map((svc) => [`${svc.toUpperCase()}_DATABASE_URL`, dbUrl(svc)])),
};

describe('prepareBackend', () => {
  it("returns every application's own validated configuration for a valid environment", () => {
    const { plan, problems } = prepareBackend(development);
    expect(problems).toEqual([]);
    const configs = plan!.configs;
    expect(configs.identity).toMatchObject({ host: '127.0.0.1', port: 3101, databaseUrl: dbUrl('identity') });
    expect(configs.organization).toMatchObject({ port: 3102, identityServiceUrl: 'http://127.0.0.1:3101' });
    expect(configs.workspace).toMatchObject({ port: 3103, organizationServiceUrl: 'http://127.0.0.1:3102' });
    expect(configs.messaging).toMatchObject({
      port: 3104,
      filesServiceUrl: 'http://127.0.0.1:3106',
      workspaceServiceUrl: 'http://127.0.0.1:3103',
    });
    expect(configs.files).toMatchObject({ port: 3106, messagingServiceUrl: 'http://127.0.0.1:3104' });
    expect(configs.realtime).toMatchObject({
      host: '127.0.0.1',
      port: 3105,
      messagingServiceUrl: 'http://127.0.0.1:3104',
    });
    expect(configs.gateway).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      upstreams: {
        identity: 'http://127.0.0.1:3101',
        organization: 'http://127.0.0.1:3102',
        workspace: 'http://127.0.0.1:3103',
        messaging: 'http://127.0.0.1:3104',
        files: 'http://127.0.0.1:3106',
      },
    });
    expect(plan!.ports.map((p) => `${p.app}@${p.host}:${p.port}`)).toEqual([
      'identity@127.0.0.1:3101',
      'organization@127.0.0.1:3102',
      'workspace@127.0.0.1:3103',
      'messaging@127.0.0.1:3104',
      'realtime@127.0.0.1:3105',
      'files@127.0.0.1:3106',
      'gateway@127.0.0.1:3000',
    ]);
  });

  it("keeps the signing key in identity's configuration only (D7)", () => {
    const { plan } = prepareBackend(development);
    const secret = privateJwk.d!;
    for (const [app, config] of Object.entries(plan!.configs)) {
      const serialized = JSON.stringify(config, (_key, value: unknown) =>
        typeof value === 'object' && value !== null && 'export' in value
          ? (value as { export(o: object): unknown }).export({ format: 'jwk' })
          : value,
      );
      expect(serialized.includes(secret), app).toBe(app === 'identity');
    }
  });

  it("runs each application's own validation and reports every problem of every application at once", () => {
    const { plan, problems } = prepareBackend({ ...development, NODE_ENV: 'production', FILES_MAX_BYTES: 'lots' });
    expect(plan).toBeUndefined();
    expect(problems).toEqual(
      expect.arrayContaining([
        'gateway: CORS_ALLOWED_ORIGINS is required in production',
        'realtime: CORS_ALLOWED_ORIGINS is required in production',
        expect.stringMatching(/^identity: ACCOUNT_NOTIFIER is required in production/),
        expect.stringMatching(/^organization: ORGANIZATION_CREATION is required in production/),
        expect.stringMatching(/^organization: INVITATION_NOTIFIER is required in production/),
        expect.stringMatching(/^files: FILES_MAX_BYTES/),
        expect.stringMatching(/^gateway: FILES_MAX_BYTES/),
      ]),
    );
    const text = problems.join('\n');
    expect(text).not.toContain(privateJwk.d);
    for (const svc of DATABASE_APPS) expect(text).not.toContain(`pw-${svc}-secret`);
  });

  it('opens nothing while preparing: a bad environment never reaches the starters', () => {
    const { plan, problems } = prepareBackend({ ...development, MESSAGING_SERVICE_URL: 'https://public.example.com' });
    expect(plan).toBeUndefined();
    expect(problems[0]).toMatch(/^MESSAGING_SERVICE_URL must not be set/);
  });
});
