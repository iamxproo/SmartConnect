import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { takeToken, type RateLimitStore } from '../src/rate-limit/rate-limit.js';
import { MemoryRateLimitStore } from '../src/rate-limit/stores.js';
import { AUTH_RATE_LIMITS } from '../src/routes/auth-routes.controller.js';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './support/fake-upstream.js';
import { signAccessToken, TEST_USER_ID } from './support/tokens.js';

describe('token bucket', () => {
  it('allows `limit` requests, then rejects until a token refills', () => {
    let bucket: Parameters<typeof takeToken>[0];
    const results = [];
    for (let i = 0; i < 4; i++) {
      const step = takeToken(bucket, 0, 3, 60_000);
      bucket = step.bucket;
      results.push(step.result);
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfterMs).toBe(20_000); // one token every 60 s / 3
    expect(takeToken(bucket, 20_000, 3, 60_000).result.allowed).toBe(true);
  });

  it('never refills above the limit', () => {
    const { bucket } = takeToken(undefined, 0, 3, 60_000);
    expect(takeToken(bucket, 10 * 60_000, 3, 60_000).result.remaining).toBe(2);
  });

  it('memory store: buckets are independent per key and expire', async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(() => now);
    try {
      expect((await store.consume('a', 1, 1000)).allowed).toBe(true);
      expect((await store.consume('a', 1, 1000)).allowed).toBe(false);
      expect((await store.consume('b', 1, 1000)).allowed).toBe(true);
      now = 1000;
      expect((await store.consume('a', 1, 1000)).allowed).toBe(true);
    } finally {
      await store.close();
    }
  });
});

describe('gateway rate limits', () => {
  let upstream: FakeUpstream;
  let gateway: TestGateway;
  let clientIp = 0;
  /** Distinct client address per test (TRUST_PROXY_HOPS=1), so IP buckets do not interfere across tests. */
  const nextIp = () => `198.51.100.${++clientIp}`;

  beforeAll(async () => {
    upstream = await startFakeUpstream();
    upstream.respondWith(jsonResponse(200, { ok: true }));
    gateway = await startGateway({ env: { IDENTITY_SERVICE_URL: upstream.url, TRUST_PROXY_HOPS: '1' } });
  });
  afterAll(async () => {
    await gateway.app.close();
    await upstream.close();
  });
  beforeEach(() => {
    upstream.requests.length = 0;
  });

  const login = (ip: string, email: string) =>
    request(gateway.server).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'guess' });

  it('limits login attempts per account across client addresses (distributed brute force)', async () => {
    const [accountRule] = AUTH_RATE_LIMITS.login.filter((rule) => rule.name === 'login-account');
    const email = 'victim@example.com';
    for (let i = 0; i < accountRule!.limit; i++) await login(nextIp(), email).expect(200);
    // Same account, new address, different spelling: still the same bucket.
    const res = await login(nextIp(), '  Victim@Example.COM ').expect(429);
    expect(problemOf(res)).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['ratelimit-limit']).toBe(String(accountRule!.limit));
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(upstream.requests).toHaveLength(accountRule!.limit);
  });

  it('limits login attempts per client address across accounts (credential stuffing)', async () => {
    const [ipRule] = AUTH_RATE_LIMITS.login.filter((rule) => rule.name === 'login-ip');
    const ip = nextIp();
    for (let i = 0; i < ipRule!.limit; i++) await login(ip, `user${i}@example.com`).expect(200);
    await login(ip, 'one-more@example.com').expect(429);
    await login(nextIp(), 'one-more@example.com').expect(200);
  });

  it('applies the per-account bucket to unknown accounts too (no enumeration through 429s)', async () => {
    const [accountRule] = AUTH_RATE_LIMITS.login.filter((rule) => rule.name === 'login-account');
    for (let i = 0; i < accountRule!.limit; i++) await login(nextIp(), 'nobody@example.com').expect(200);
    await login(nextIp(), 'nobody@example.com').expect(429);
  });

  it('reports remaining budget on allowed requests', async () => {
    const res = await login(nextIp(), 'fresh@example.com').expect(200);
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(Number(res.headers['ratelimit-remaining'])).toBeGreaterThan(0);
  });

  it('limits password changes per authenticated user', async () => {
    const token = await signAccessToken({ sub: TEST_USER_ID });
    const [userRule] = AUTH_RATE_LIMITS.passwordChange;
    const change = () =>
      request(gateway.server)
        .post('/api/v1/auth/password/change')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'a', newPassword: 'b' });
    for (let i = 0; i < userRule!.limit; i++) await change().expect(200);
    await change().expect(429);
  });

  it('limits password-reset requests per account', async () => {
    const [accountRule] = AUTH_RATE_LIMITS.passwordForgot.filter((rule) => rule.name === 'password-forgot-account');
    const forgot = () =>
      request(gateway.server)
        .post('/api/v1/auth/password/forgot')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'reset-target@example.com' });
    for (let i = 0; i < accountRule!.limit; i++) await forgot().expect(200);
    await forgot().expect(429);
  });
});

describe('rate limiter failure', () => {
  it('fails closed: 503 when the store is unavailable, and the request never reaches the service', async () => {
    const upstream = await startFakeUpstream();
    const broken: RateLimitStore = {
      consume: () => Promise.reject(new Error('connection refused')),
      ping: () => Promise.reject(new Error('connection refused')),
      close: () => Promise.resolve(),
    };
    const gateway = await startGateway({ env: { IDENTITY_SERVICE_URL: upstream.url }, rateLimitStore: broken });
    try {
      const res = await request(gateway.server)
        .post('/api/v1/auth/login')
        .send({ email: 'a@example.com', password: 'x' })
        .expect(503);
      expect(problemOf(res)).toMatchObject({ code: 'rate_limiter_unavailable' });
      expect(JSON.stringify(res.body)).not.toContain('connection refused');
      expect(upstream.requests).toHaveLength(0);
      expect(gateway.logger.events('rate_limit_store_unavailable')).toHaveLength(1);
    } finally {
      await gateway.app.close();
      await upstream.close();
    }
  });
});
