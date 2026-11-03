import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createJsonLogger, type RequestLogEntry } from '@smartconnect/backend-kit';
import { startGateway, type TestGateway } from './support/gateway.js';
import { ProbeModule } from './support/probe.module.js';

const WEB = 'http://127.0.0.1:5173';

describe('CORS', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ env: { CORS_ALLOWED_ORIGINS: `${WEB},https://app.example.test` } });
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  it('answers preflight from an allowed origin with credentials, the allowed headers and a max age', async () => {
    const res = await request(gateway.server)
      .options('/api/v1/channels')
      .set('Origin', 'https://app.example.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-request-id')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    const allowed = (res.headers['access-control-allow-headers'] as string).toLowerCase();
    for (const header of ['content-type', 'idempotency-key', 'x-request-id', 'authorization']) {
      expect(allowed).toContain(header);
    }
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('grants nothing to an origin that is not allowed', async () => {
    const res = await request(gateway.server)
      .options('/api/v1/channels')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    // Without a matching Access-Control-Allow-Origin the browser blocks the request. (The cors package sends the
    // static Allow-Credentials/Allow-Headers values regardless of origin; on their own they grant nothing.)
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not treat a lookalike origin as allowed', async () => {
    const res = await request(gateway.server)
      .get('/health/live')
      .set('Origin', 'https://app.example.test.evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets allowed browser origins read X-Request-Id and the other documented response headers', async () => {
    const res = await request(gateway.server).get('/health/live').set('Origin', WEB).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['vary']).toContain('Origin');
    const exposed = res.headers['access-control-expose-headers'] as string;
    for (const header of ['X-Request-Id', 'Location', 'ETag', 'Retry-After']) expect(exposed).toContain(header);
  });
});

describe('secure HTTP defaults', () => {
  it('sets security headers and hides the framework', async () => {
    const gateway = await startGateway();
    const res = await request(gateway.server).get('/health/live');
    await gateway.app.close();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('adds upgrade-insecure-requests in production', async () => {
    const gateway = await startGateway({
      // REDIS_URL satisfies production validation; the test harness injects a memory store, so it is never dialled.
      env: {
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.test',
        REDIS_URL: 'redis://127.0.0.1:1',
        IDENTITY_SERVICE_URL: 'http://127.0.0.1:9',
        ORGANIZATION_SERVICE_URL: 'http://127.0.0.1:9',
        WORKSPACE_SERVICE_URL: 'http://127.0.0.1:9',
        MESSAGING_SERVICE_URL: 'http://127.0.0.1:9',
      },
    });
    const res = await request(gateway.server).get('/health/live');
    await gateway.app.close();
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });
});

describe('request logging', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  const entriesFor = (requestId: string) =>
    gateway.logger.events<RequestLogEntry>('http_request').filter((record) => record.message.requestId === requestId);

  it('writes exactly one structured entry per request, without the query string', async () => {
    await request(gateway.server)
      .get('/api/v1/__probe/context?token=secret-token')
      .set('X-Request-Id', 'log-test-0001');
    const entries = entriesFor('log-test-0001');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('log');
    expect(entries[0]?.message).toEqual({
      event: 'http_request',
      requestId: 'log-test-0001',
      method: 'GET',
      path: '/api/v1/__probe/context',
      status: 200,
      durationMs: expect.any(Number) as number,
      aborted: false,
    });
    expect(JSON.stringify(gateway.logger.records)).not.toContain('secret-token');
  });

  it('logs 4xx at warn, 5xx at error and health probes at debug', async () => {
    await request(gateway.server).get('/api/v1/nope').set('X-Request-Id', 'log-test-0404');
    await request(gateway.server).get('/api/v1/__probe/boom').set('X-Request-Id', 'log-test-0500');
    await request(gateway.server).get('/health/live').set('X-Request-Id', 'log-test-live');
    expect(entriesFor('log-test-0404').map((entry) => entry.level)).toEqual(['warn']);
    expect(entriesFor('log-test-0500').map((entry) => entry.level)).toEqual(['error']);
    expect(entriesFor('log-test-live').map((entry) => entry.level)).toEqual(['debug']);
  });
});

describe('JSON logger', () => {
  it('writes one JSON object per line and honours the configured level', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createJsonLogger('warn');
    logger.log({ event: 'below_threshold' });
    logger.warn({ event: 'at_threshold' }, 'Test');
    logger.error({ event: 'above_threshold' }, undefined, 'Test');

    const lines = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk).trim());
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as { level: string; message: { event: string } });
    expect(parsed.map((entry) => [entry.level, entry.message.event]).sort()).toEqual([
      ['error', 'above_threshold'],
      ['warn', 'at_threshold'],
    ]);
  });
});

describe('server timeouts', () => {
  it('sets explicit header and request timeouts', async () => {
    const gateway = await startGateway();
    try {
      const server = gateway.app.getHttpServer();
      expect(server.headersTimeout).toBe(15_000);
      expect(server.requestTimeout).toBe(120_000);
    } finally {
      await gateway.app.close();
    }
  });
});
