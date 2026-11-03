import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { problemOf, startGateway, UUID, type TestGateway } from './support/gateway.js';
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './support/fake-upstream.js';
import { signAccessToken } from './support/tokens.js';

const WEB = 'http://127.0.0.1:5173';

describe('routing to the identity service', () => {
  let upstream: FakeUpstream;
  let gateway: TestGateway;
  beforeAll(async () => {
    upstream = await startFakeUpstream();
    gateway = await startGateway({ env: { IDENTITY_SERVICE_URL: upstream.url, UPSTREAM_TIMEOUT_MS: '300' } });
  });
  afterAll(async () => {
    await gateway.app.close();
    await upstream.close();
  });
  beforeEach(() => {
    upstream.requests.length = 0;
    upstream.respondWith(jsonResponse(200, { ok: true }));
  });

  it('forwards method, path, query and the JSON body', async () => {
    const token = await signAccessToken();
    await request(gateway.server)
      .get('/api/v1/auth/sessions?limit=5&cursor=abc')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(gateway.server)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'correct horse battery' })
      .expect(200);
    expect(upstream.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /api/v1/auth/sessions?limit=5&cursor=abc',
      'POST /api/v1/auth/login',
    ]);
    expect(JSON.parse(upstream.requests[1]!.body)).toEqual({
      email: 'a@example.com',
      password: 'correct horse battery',
    });
    expect(upstream.requests[1]!.headers['content-type']).toMatch(/^application\/json/);
  });

  it('propagates the request id, and sets the client address itself', async () => {
    await request(gateway.server)
      .post('/api/v1/auth/logout')
      .set('X-Request-Id', 'edge-correlation-0001')
      .set('X-Forwarded-For', '203.0.113.66')
      .send({})
      .expect(200);
    const headers = upstream.requests[0]!.headers;
    expect(headers['x-request-id']).toBe('edge-correlation-0001');
    // TRUST_PROXY_HOPS=0: the client-sent X-Forwarded-For is not trusted; the socket address is used.
    expect(headers['x-forwarded-for']).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it('never forwards client-supplied identity, tenant or routing headers', async () => {
    await request(gateway.server)
      .post('/api/v1/auth/register')
      .set('X-User-Id', '019a4a00-0000-7000-8000-0000000a11ce')
      .set('X-Organization-Id', '019a4a00-0000-7000-8000-000000000001')
      .set('X-Authenticated-User', 'admin')
      .set('X-Forwarded-Host', 'evil.example')
      .send({ email: 'a@example.com', password: 'x', displayName: 'A' })
      .expect(200);
    const forwarded = Object.keys(upstream.requests[0]!.headers);
    for (const header of ['x-user-id', 'x-organization-id', 'x-authenticated-user', 'x-forwarded-host']) {
      expect(forwarded).not.toContain(header);
    }
  });

  it('forwards only the refresh-token cookie, never other cookies', async () => {
    await request(gateway.server)
      .post('/api/v1/auth/refresh')
      .set('Origin', WEB)
      .set('Cookie', 'analytics=abc; __Secure-sc_refresh=opaque-token-value; session=other')
      .send({})
      .expect(200);
    expect(upstream.requests[0]!.headers.cookie).toBe('__Secure-sc_refresh=opaque-token-value');
  });

  it('passes the service status, problem body, Set-Cookie and cache headers back', async () => {
    upstream.respondWith(
      jsonResponse(
        401,
        { type: 'x', title: 'Authentication required', status: 401, code: 'invalid_credentials' },
        {
          'content-type': 'application/problem+json; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': ['__Secure-sc_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict'],
          'x-internal-debug': 'should-not-pass',
        },
      ),
    );
    const res = await request(gateway.server)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'wrong' })
      .expect(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemOf(res).code).toBe('invalid_credentials');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toEqual([
      '__Secure-sc_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict',
    ]);
    expect(res.headers['x-internal-debug']).toBeUndefined();
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('passes 204 responses through without a body', async () => {
    upstream.respondWith((_request, res) => {
      res.writeHead(204);
      res.end();
    });
    const res = await request(gateway.server).post('/api/v1/auth/logout').send({}).expect(204);
    expect(res.text).toBe('');
  });

  it('answers 502 problem details when the service is unreachable', async () => {
    const unreachable = await startGateway({ env: { IDENTITY_SERVICE_URL: 'http://127.0.0.1:9' } });
    try {
      const res = await request(unreachable.server).post('/api/v1/auth/login').send({ email: 'a@example.com' });
      expect(res.status).toBe(502);
      expect(problemOf(res)).toMatchObject({
        code: 'bad_gateway',
        detail: 'An upstream service could not be reached.',
      });
      expect(JSON.stringify(res.body)).not.toContain('127.0.0.1:9');
    } finally {
      await unreachable.app.close();
    }
  });

  it('answers 504 problem details when the service does not respond in time', async () => {
    upstream.respondWith(() => undefined); // never answers
    const res = await request(gateway.server).post('/api/v1/auth/login').send({ email: 'a@example.com' }).expect(504);
    expect(problemOf(res).code).toBe('gateway_timeout');
  });

  it('cannot be steered to another host by the request target', async () => {
    await request(gateway.server).post('//evil.example/api/v1/auth/login').send({}).expect(404);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('cookie requests need an allowed Origin (CSRF)', () => {
  let upstream: FakeUpstream;
  let gateway: TestGateway;
  beforeAll(async () => {
    upstream = await startFakeUpstream();
    gateway = await startGateway({ env: { IDENTITY_SERVICE_URL: upstream.url } });
  });
  afterAll(async () => {
    await gateway.app.close();
    await upstream.close();
  });
  beforeEach(() => {
    upstream.requests.length = 0;
  });

  const refreshWithCookie = () =>
    request(gateway.server).post('/api/v1/auth/refresh').set('Cookie', '__Secure-sc_refresh=token').send({});

  it('rejects a cookie-carrying POST without Origin', async () => {
    const res = await refreshWithCookie().expect(403);
    expect(problemOf(res)).toMatchObject({ code: 'origin_not_allowed' });
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a cookie-carrying POST from a foreign origin', async () => {
    await refreshWithCookie().set('Origin', 'https://evil.example').expect(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it('forwards a cookie-carrying POST from an allowed origin', async () => {
    await refreshWithCookie().set('Origin', WEB).expect(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it('does not affect requests without cookies (mobile clients, bearer calls)', async () => {
    await request(gateway.server).post('/api/v1/auth/refresh').send({ refreshToken: 'x' }).expect(200);
  });
});
