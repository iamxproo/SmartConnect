import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './support/fake-upstream.js';
import { generateTestKeyPair, signAccessToken, TEST_USER_ID, unsignedToken, trustedKeys } from './support/tokens.js';
import { SignJWT } from 'jose';

const PROTECTED = '/api/v1/auth/sessions';

describe('access-token guard (deny by default)', () => {
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
    upstream.respondWith(jsonResponse(200, { data: [], nextCursor: null }));
  });

  async function expectRejected(authorization: string | undefined, code: string) {
    const call = request(gateway.server).get(PROTECTED);
    const res = await (authorization === undefined ? call : call.set('Authorization', authorization)).expect(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemOf(res)).toMatchObject({ status: 401, code, instance: PROTECTED });
    expect(res.headers['www-authenticate']).toMatch(/^Bearer realm="smartconnect"/);
    // Rejected at the edge: the service never sees the request.
    expect(upstream.requests).toHaveLength(0);
    return res;
  }

  it('forwards a request with a valid token, Authorization header intact', async () => {
    const token = await signAccessToken();
    await request(gateway.server).get(PROTECTED).set('Authorization', `Bearer ${token}`).expect(200);
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('accepts the Bearer scheme case-insensitively (RFC 6750)', async () => {
    await request(gateway.server)
      .get(PROTECTED)
      .set('Authorization', `bearer ${await signAccessToken()}`)
      .expect(200);
  });

  it('rejects a request without a token: 401 unauthenticated', async () => {
    const res = await expectRejected(undefined, 'unauthenticated');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="smartconnect"');
  });

  it.each([
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a malformed token', 'Bearer not-a-jwt'],
    ['an empty bearer', 'Bearer '],
  ])('rejects %s: 401 invalid_token', async (_case, header) => {
    await expectRejected(header, 'invalid_token');
  });

  it('rejects an expired token with token_expired', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({ issuedAt: now - 3600, expiresIn: -1800 });
    const res = await expectRejected(`Bearer ${token}`, 'token_expired');
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('rejects a token with a tampered payload (signature no longer matches)', async () => {
    const [header, , signature] = (await signAccessToken()).split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: '019a4a00-0000-7000-8000-00000000beef', sid: TEST_USER_ID, exp: 9_999_999_999 }),
    ).toString('base64url');
    await expectRejected(`Bearer ${header}.${forgedPayload}.${signature}`, 'invalid_token');
  });

  it('rejects a token signed by an untrusted key, even with a trusted kid', async () => {
    const attacker = generateTestKeyPair(trustedKeys.kid);
    await expectRejected(`Bearer ${await signAccessToken({ keys: attacker })}`, 'invalid_token');
  });

  it('rejects an unsigned (alg "none") token', async () => {
    await expectRejected(`Bearer ${unsignedToken()}`, 'invalid_token');
  });

  it('rejects an HS256 token keyed with the public key (algorithm confusion)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sid: '019a4a00-0000-7000-8000-000000005e55' })
      .setProtectedHeader({ alg: 'HS256', kid: trustedKeys.kid, typ: 'at+jwt' })
      .setSubject(TEST_USER_ID)
      .setIssuer('smartconnect-identity')
      .setAudience('smartconnect-api')
      .setJti('x')
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode(trustedKeys.publicJwk.x));
    await expectRejected(`Bearer ${token}`, 'invalid_token');
  });

  it.each([
    ['wrong issuer', { issuer: 'someone-else' }],
    ['wrong audience', { audience: 'another-api' }],
    ['wrong type (not an access token)', { typ: 'JWT' }],
    ['a non-UUID subject', { sub: 'admin' }],
  ])('rejects a token with %s', async (_case, options) => {
    await expectRejected(`Bearer ${await signAccessToken(options)}`, 'invalid_token');
  });

  it('keeps public routes public: login needs no token', async () => {
    await request(gateway.server)
      .post('/api/v1/auth/login')
      .send({ email: 'a@example.com', password: 'x' })
      .expect(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it('keeps health public and unknown routes 404 (not 401)', async () => {
    await request(gateway.server).get('/health/live').expect(200);
    const res = await request(gateway.server).get('/api/v1/organizations').expect(404);
    expect(problemOf(res).code).toBe('not_found');
  });
});
