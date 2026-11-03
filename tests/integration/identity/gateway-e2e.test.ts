// The real gateway in front of the real identity service (listening on an ephemeral port) and the test database:
// the full browser flow, edge rejection, request-id propagation, client-address forwarding, spoofed headers.
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from '../../../smartconnect-backend/api-gateway/src/app.factory.js';
import { loadConfig } from '../../../smartconnect-backend/api-gateway/src/config/config.js';
import { MemoryRateLimitStore } from '../../../smartconnect-backend/api-gateway/src/rate-limit/stores.js';
import {
  auth,
  CapturingLogger,
  db,
  PASSWORD,
  problemOf,
  refreshCookieValue,
  startIdentity,
  uniqueEmail,
  urlOf,
  type TestIdentity,
  type Tokens,
} from './support/identity.js';

const WEB = 'http://127.0.0.1:5173';

describe('gateway → identity service (end to end)', () => {
  let identity: TestIdentity;
  let gateway: NestExpressApplication;
  let server: Server;
  let gatewayLogger: CapturingLogger;
  let clientIp = 0;
  const nextIp = () => `203.0.113.${++clientIp}`;

  beforeAll(async () => {
    identity = await startIdentity({ listen: true });
    gatewayLogger = new CapturingLogger();
    gateway = await createGateway({
      config: loadConfig({
        NODE_ENV: 'test',
        IDENTITY_SERVICE_URL: urlOf(identity),
        AUTH_JWT_PUBLIC_JWKS: identity.publicJwks,
        TRUST_PROXY_HOPS: '1', // tests act as the edge proxy and set X-Forwarded-For
      }),
      logger: gatewayLogger,
      rateLimitStore: new MemoryRateLimitStore(),
    });
    await gateway.init();
    server = gateway.getHttpServer();
  });
  afterAll(async () => {
    await gateway.close();
    await identity.close();
  });

  it('runs the browser flow: register → login (cookie) → protected call → refresh → logout', async () => {
    const email = uniqueEmail('web');
    await request(server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PASSWORD, displayName: 'Web User' })
      .expect(202);

    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', WEB)
      .send({ email, password: PASSWORD })
      .expect(200);
    expect(loginRes.headers['access-control-allow-origin']).toBe(WEB);
    expect(loginRes.body).not.toHaveProperty('refreshToken');
    const { accessToken } = loginRes.body as Tokens;
    const cookie = refreshCookieValue(loginRes)!;
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await request(server).get('/api/v1/auth/sessions').set(auth(accessToken)).expect(200);

    const refreshed = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Origin', WEB)
      .set('Cookie', `__Secure-sc_refresh=${cookie}; unrelated=1`)
      .send()
      .expect(200);
    const rotatedCookie = refreshCookieValue(refreshed)!;
    expect(rotatedCookie).not.toBe(cookie);

    const loggedOut = await request(server)
      .post('/api/v1/auth/logout')
      .set('Origin', WEB)
      .set('Cookie', `__Secure-sc_refresh=${rotatedCookie}`)
      .send()
      .expect(204);
    expect(loggedOut.headers['set-cookie']).toEqual([
      '__Secure-sc_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict',
    ]);
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Origin', WEB)
      .set('Cookie', `__Secure-sc_refresh=${rotatedCookie}`)
      .send()
      .expect(401);
  });

  it('rejects cookie-carrying refresh without an allowed Origin at the edge (CSRF)', async () => {
    const res = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', '__Secure-sc_refresh=x')
      .send()
      .expect(403);
    expect(problemOf(res).code).toBe('origin_not_allowed');
  });

  it('accepts identity-issued tokens and rejects missing or tampered ones before they reach the service', async () => {
    const email = uniqueEmail('bearer');
    await request(server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PASSWORD, displayName: 'B' });
    const { accessToken } = (
      await request(server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email, password: PASSWORD, tokenDelivery: 'body' })
        .expect(200)
    ).body as Tokens;

    await request(server).get('/api/v1/auth/sessions').set(auth(accessToken)).expect(200);
    expect(problemOf(await request(server).get('/api/v1/auth/sessions').expect(401)).code).toBe('unauthenticated');
    const tampered = `${accessToken.slice(0, -2)}${accessToken.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(problemOf(await request(server).get('/api/v1/auth/sessions').set(auth(tampered)).expect(401)).code).toBe(
      'invalid_token',
    );
  });

  it('propagates the request id to the identity service and back', async () => {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set('X-Request-Id', 'e2e-request-id-0001')
      .send({ email: uniqueEmail('nobody'), password: 'wrong password entirely' })
      .expect(401);
    expect(res.headers['x-request-id']).toBe('e2e-request-id-0001');
    expect(problemOf(res)).toMatchObject({ code: 'invalid_credentials', requestId: 'e2e-request-id-0001' });
    const identityLog = identity.logger
      .events('http_request')
      .find((entry) => entry.requestId === 'e2e-request-id-0001');
    expect(identityLog).toMatchObject({ path: '/api/v1/auth/login', status: 401 });
  });

  it("passes the service's standardized errors through unchanged", async () => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'nope', password: 'short', displayName: 'X', isAdmin: true })
      .expect(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(
      problemOf(res)
        .errors?.map((error) => error.code)
        .sort(),
    ).toEqual(['invalid_email', 'too_short', 'unknown_field']);
  });

  it('records the client address as resolved by the gateway, not one a client could forge', async () => {
    const email = uniqueEmail('ip');
    await request(server)
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PASSWORD, displayName: 'I' });
    const { sessionId } = (
      await request(server)
        .post('/api/v1/auth/login')
        // The edge proxy appended the real client (198.51.100.77) to a value the client sent (10.0.0.1).
        .set('X-Forwarded-For', '10.0.0.1, 198.51.100.77')
        .send({ email, password: PASSWORD, tokenDelivery: 'body' })
        .expect(200)
    ).body as Tokens;
    const [row] = await db<{ ip_address: string }>(
      'select host(ip_address) as ip_address from identity.sessions where id = $1',
      [sessionId],
    );
    expect(row!.ip_address).toBe('198.51.100.77');
  });

  it('ignores client-supplied user and tenant headers: the caller is always the token subject', async () => {
    const make = async (label: string) => {
      const email = uniqueEmail(label);
      await request(server)
        .post('/api/v1/auth/register')
        .set('X-Forwarded-For', nextIp())
        .send({ email, password: PASSWORD, displayName: label });
      return (
        await request(server)
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', nextIp())
          .send({ email, password: PASSWORD, tokenDelivery: 'body' })
          .expect(200)
      ).body as Tokens;
    };
    const alice = await make('alice');
    const bob = await make('bob');
    const [bobRow] = await db<{ user_id: string }>('select user_id from identity.sessions where id = $1', [
      bob.sessionId,
    ]);
    const res = await request(server)
      .get('/api/v1/auth/sessions')
      .set(auth(alice.accessToken))
      .set('X-User-Id', bobRow!.user_id)
      .set('X-Organization-Id', '019a4a00-0000-7000-8000-000000000001')
      .expect(200);
    expect((res.body as { data: { id: string }[] }).data.map((session) => session.id)).toEqual([alice.sessionId]);
    // Bob's session cannot be ended with Alice's token, whatever the headers claim.
    await request(server)
      .delete(`/api/v1/auth/sessions/${bob.sessionId}`)
      .set(auth(alice.accessToken))
      .set('X-User-Id', bobRow!.user_id)
      .expect(404);
  });

  it('rate-limits login attempts per account before they reach the service', async () => {
    const email = uniqueEmail('target');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(server)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email, password: `guess ${i}` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
