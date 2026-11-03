import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_NAMES, DATABASE_APPS, INTERNAL_APPS, type AppName } from '../src/apps.js';
import { buildEnvironment, PASS_THROUGH, SERVICE_URLS, type Env } from '../src/env.js';

const dbUrl = (svc: string) => `postgresql://sc_${svc}_app:secret-${svc}@127.0.0.1:15432/smartconnect?schema=${svc}`;
const databases: Env = Object.fromEntries(
  DATABASE_APPS.map((svc) => [`${svc.toUpperCase()}_DATABASE_URL`, dbUrl(svc)]),
);
const PRIVATE_JWK = '{"kty":"OKP","crv":"Ed25519","d":"PRIVATE-KEY-MATERIAL","x":"x","kid":"k"}';

const internalExtras = (app: AppName) =>
  app === 'gateway'
    ? []
    : [
        'HOST',
        'PORT',
        'TRUST_PROXY_HOPS',
        ...(app === 'realtime' ? [] : ['API_DOCS_ENABLED']),
        ...(DATABASE_APPS.includes(app) ? ['DATABASE_URL', 'DATABASE_URL_FILE'] : []),
      ];
const allowed = (app: AppName) =>
  new Set([...PASS_THROUGH[app], ...Object.keys(SERVICE_URLS[app]), ...internalExtras(app)]);

describe('per-application environment views', () => {
  it('give every application only its own list and its computed settings, never anything else', () => {
    const everything: Env = { ...databases, UNRELATED_SECRET: 'x', AWS_SECRET_ACCESS_KEY: 'x', GATEWAY_TOKEN: 'x' };
    for (const app of APP_NAMES) for (const name of PASS_THROUGH[app]) everything[name] = `value-of-${name}`;
    const { views, problems } = buildEnvironment(everything);
    expect(problems).toEqual([]);
    for (const app of APP_NAMES) {
      const unexpected = Object.keys(views[app]).filter((name) => !allowed(app).has(name));
      expect(unexpected, app).toEqual([]);
      expect(views[app]).not.toHaveProperty('UNRELATED_SECRET');
      expect(views[app]).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    }
  });

  it('keep the identity signing key to identity (D7)', () => {
    const { views } = buildEnvironment({
      ...databases,
      AUTH_JWT_PRIVATE_JWK: PRIVATE_JWK,
      AUTH_JWT_PRIVATE_JWK_FILE: '/k',
    });
    for (const app of APP_NAMES) {
      const has = JSON.stringify(views[app]).includes('PRIVATE-KEY-MATERIAL');
      expect(has, app).toBe(app === 'identity');
      expect('AUTH_JWT_PRIVATE_JWK_FILE' in views[app], app).toBe(app === 'identity');
    }
  });

  it('give each service its own database URL as DATABASE_URL, and the gateways none (D7)', () => {
    const { views } = buildEnvironment(databases);
    for (const app of APP_NAMES) {
      const own = DATABASE_APPS.includes(app as never) ? dbUrl(app) : undefined;
      expect(views[app].DATABASE_URL, app).toBe(own);
      for (const other of DATABASE_APPS.filter((svc) => svc !== app))
        expect(JSON.stringify(views[app]).includes(`secret-${other}`), `${app} sees ${other}`).toBe(false);
    }
  });

  it('give mail settings to identity and organization only, and Redis to the gateway, realtime and messaging only', () => {
    const { views } = buildEnvironment({ ...databases, SMTP_PASSWORD: 'smtp-secret', REDIS_URL: 'redis://:r@h:1/0' });
    const withSmtp = APP_NAMES.filter((app) => 'SMTP_PASSWORD' in views[app]);
    const withRedis = APP_NAMES.filter((app) => 'REDIS_URL' in views[app]);
    expect(withSmtp.sort()).toEqual(['identity', 'organization']);
    expect(withRedis.sort()).toEqual(['gateway', 'messaging', 'realtime']);
  });

  it('give the object-storage credentials to the files service only', () => {
    const { views } = buildEnvironment({
      ...databases,
      FILES_STORAGE_PROVIDER: 'r2',
      FILES_R2_ACCESS_KEY_ID: 'r2-key-id',
      FILES_R2_SECRET_ACCESS_KEY: 'r2-secret',
    });
    for (const app of APP_NAMES) {
      const holds = JSON.stringify(views[app]).includes('r2-secret');
      expect(holds, app).toBe(app === 'files');
    }
    expect(views.files).toMatchObject({ FILES_STORAGE_PROVIDER: 'r2', FILES_R2_ACCESS_KEY_ID: 'r2-key-id' });
  });

  it('give PORT, HOST, TRUST_PROXY_HOPS and API_DOCS_ENABLED to the public gateway, and each internal app its own', () => {
    const { views } = buildEnvironment({
      ...databases,
      PORT: '4000',
      HOST: '0.0.0.0',
      TRUST_PROXY_HOPS: '1',
      API_DOCS_ENABLED: 'false',
      IDENTITY_TRUST_PROXY_HOPS: '2',
      WORKSPACE_API_DOCS_ENABLED: 'true',
      REALTIME_API_DOCS_ENABLED: 'true',
    });
    expect(views.gateway).toMatchObject({
      PORT: '4000',
      HOST: '0.0.0.0',
      TRUST_PROXY_HOPS: '1',
      API_DOCS_ENABLED: 'false',
    });
    expect(views.identity).toMatchObject({ HOST: '127.0.0.1', PORT: '3101', TRUST_PROXY_HOPS: '2' });
    expect(views.identity).not.toHaveProperty('API_DOCS_ENABLED');
    expect(views.workspace).toMatchObject({ HOST: '127.0.0.1', PORT: '3103', API_DOCS_ENABLED: 'true' });
    // Not set for the organization service: its own default applies, as when it runs alone.
    expect(views.organization).not.toHaveProperty('TRUST_PROXY_HOPS');
    expect(views.realtime).not.toHaveProperty('API_DOCS_ENABLED');
    for (const app of INTERNAL_APPS) expect(views[app].HOST, app).toBe('127.0.0.1');
  });

  it('never strip a service-like prefix: ORGANIZATION_CREATOR_EMAILS and FILES_* keep their names', () => {
    const { views } = buildEnvironment({
      ...databases,
      ORGANIZATION_CREATION: 'open',
      ORGANIZATION_CREATOR_EMAILS: 'a@example.com',
      ORGANIZATION_MAX_OWNED_PER_USER: '3',
      FILES_MAX_BYTES: '1048576',
      FILES_STORAGE_DIR: '/var/files',
      FILES_MAX_PENDING_PER_USER: '3',
      FILES_MAX_CONCURRENT_UPLOADS_PER_USER: '2',
    });
    expect(views.organization).toMatchObject({
      ORGANIZATION_CREATION: 'open',
      ORGANIZATION_CREATOR_EMAILS: 'a@example.com',
      ORGANIZATION_MAX_OWNED_PER_USER: '3',
    });
    expect(views.files).toMatchObject({
      FILES_MAX_BYTES: '1048576',
      FILES_STORAGE_DIR: '/var/files',
      FILES_MAX_PENDING_PER_USER: '3',
      FILES_MAX_CONCURRENT_UPLOADS_PER_USER: '2',
    });
    expect(views.gateway.FILES_MAX_BYTES).toBe('1048576');
    for (const app of APP_NAMES) {
      for (const stripped of ['CREATOR_EMAILS', 'CREATION', 'MAX_OWNED_PER_USER', 'MAX_BYTES', 'STORAGE_DIR'])
        expect(views[app]).not.toHaveProperty(stripped);
      if (app !== 'organization')
        for (const name of ['ORGANIZATION_CREATION', 'ORGANIZATION_CREATOR_EMAILS', 'ORGANIZATION_MAX_OWNED_PER_USER'])
          expect(views[app]).not.toHaveProperty(name);
    }
  });

  it('compute every internal URL on loopback, both ways between messaging and files, from the internal ports', () => {
    const { views, internalPorts } = buildEnvironment({
      ...databases,
      MESSAGING_INTERNAL_PORT: '3204',
      FILES_INTERNAL_PORT: '3206',
    });
    expect(internalPorts).toMatchObject({ messaging: 3204, files: 3206, identity: 3101 });
    expect(views.messaging.FILES_SERVICE_URL).toBe('http://127.0.0.1:3206');
    expect(views.files.MESSAGING_SERVICE_URL).toBe('http://127.0.0.1:3204');
    expect(views.organization.IDENTITY_SERVICE_URL).toBe('http://127.0.0.1:3101');
    expect(views.realtime).toMatchObject({
      WORKSPACE_SERVICE_URL: 'http://127.0.0.1:3103',
      MESSAGING_SERVICE_URL: 'http://127.0.0.1:3204',
    });
    expect(views.gateway).toMatchObject({
      IDENTITY_SERVICE_URL: 'http://127.0.0.1:3101',
      ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:3102',
      WORKSPACE_SERVICE_URL: 'http://127.0.0.1:3103',
      MESSAGING_SERVICE_URL: 'http://127.0.0.1:3204',
      FILES_SERVICE_URL: 'http://127.0.0.1:3206',
    });
    expect(views.messaging.PORT).toBe('3204');
  });

  it('reject a supplied *_SERVICE_URL or an unprefixed DATABASE_URL, naming the variable but never its value', () => {
    const { problems } = buildEnvironment({
      ...databases,
      IDENTITY_SERVICE_URL: 'https://public.example.com',
      SOMETHING_SERVICE_URL: 'https://other.example.com',
      DATABASE_URL: 'postgresql://shared:shared-secret@db/smartconnect',
    });
    expect(problems.some((p) => p.startsWith('IDENTITY_SERVICE_URL must not be set'))).toBe(true);
    expect(problems.some((p) => p.startsWith('SOMETHING_SERVICE_URL must not be set'))).toBe(true);
    expect(problems.some((p) => p.startsWith('DATABASE_URL must not be set'))).toBe(true);
    const text = problems.join('\n');
    for (const value of ['public.example.com', 'other.example.com', 'shared-secret']) expect(text).not.toContain(value);
  });

  it('require valid, distinct internal ports that differ from the public port', () => {
    expect(buildEnvironment({ ...databases, IDENTITY_INTERNAL_PORT: 'abc' }).problems).toContain(
      'IDENTITY_INTERNAL_PORT must be an integer from 1 to 65535',
    );
    expect(buildEnvironment({ ...databases, ORGANIZATION_INTERNAL_PORT: '3101' }).problems).toContain(
      'port 3101 is assigned to more than one application: identity, organization',
    );
    expect(buildEnvironment({ ...databases, PORT: '3104' }).problems).toContain(
      'port 3104 is assigned to more than one application: messaging, gateway (PORT)',
    );
    expect(buildEnvironment({ ...databases, IDENTITY_INTERNAL_PORT: '3000' }).problems).toContain(
      'port 3000 is assigned to more than one application: identity, gateway (PORT)',
    );
  });

  describe('local development defaults', () => {
    const files: Record<string, Env> = {
      '.env': { REDIS_PASSWORD: 'p@ss', REDIS_PORT: '6380', POSTGRES_PASSWORD: 'admin-secret' },
      ...Object.fromEntries(
        DATABASE_APPS.map((svc) => [
          path.join('smartconnect-backend', 'services', svc, '.env'),
          { DATABASE_URL: `from-file-${svc}`, DATABASE_SCHEMA: svc },
        ]),
      ),
    };
    const readEnvFile = (file: string) => files[path.relative('/repo', file)];

    it("read each service's DATABASE_URL from its generated .env, and REDIS_URL from the root .env (D5)", () => {
      const { views, problems } = buildEnvironment({ NODE_ENV: 'development' }, { repoRoot: '/repo', readEnvFile });
      expect(problems).toEqual([]);
      for (const svc of DATABASE_APPS) expect(views[svc].DATABASE_URL).toBe(`from-file-${svc}`);
      for (const app of APP_NAMES) {
        expect(views[app]).not.toHaveProperty('DATABASE_SCHEMA');
        expect(JSON.stringify(views[app])).not.toContain('admin-secret');
      }
      for (const app of ['gateway', 'realtime', 'messaging'] as const)
        expect(views[app].REDIS_URL).toBe('redis://:p%40ss@127.0.0.1:6380/0');
    });

    it('let explicit values win over the files', () => {
      const { views } = buildEnvironment(
        { NODE_ENV: 'development', IDENTITY_DATABASE_URL: 'explicit', REDIS_URL: 'redis://explicit' },
        { repoRoot: '/repo', readEnvFile },
      );
      expect(views.identity.DATABASE_URL).toBe('explicit');
      expect(views.organization.DATABASE_URL).toBe('from-file-organization');
      expect(views.realtime.REDIS_URL).toBe('redis://explicit');
    });

    it('never read local files in production, and require every database URL explicitly', () => {
      const spy = vi.fn(readEnvFile);
      const { problems, views } = buildEnvironment({ NODE_ENV: 'production' }, { repoRoot: '/repo', readEnvFile: spy });
      expect(spy).not.toHaveBeenCalled();
      for (const svc of DATABASE_APPS)
        expect(problems).toContain(
          `${svc.toUpperCase()}_DATABASE_URL (or ${svc.toUpperCase()}_DATABASE_URL_FILE) is required`,
        );
      expect(views.realtime).not.toHaveProperty('REDIS_URL');
    });
  });
});
