import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateOpaqueToken, sha256Hex } from '../../../smartconnect-backend/services/identity/src/crypto/tokens.js';
import {
  auth,
  db,
  login,
  problemOf,
  refreshCookieValue,
  register,
  registerAndLogin,
  setCookies,
  startIdentity,
  type TestIdentity,
  type Tokens,
} from './support/identity.js';

const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';
const SESSIONS = '/api/v1/auth/sessions';
const CLEARED = '__Secure-sc_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict';
const DAY_MS = 86_400_000;

type SessionRow = {
  refresh_token_hash: string;
  previous_refresh_token_hash: string | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  expires_at: Date;
  created_at: Date;
};
const sessionRow = async (id: string) =>
  (
    await db<SessionRow>(
      'select refresh_token_hash, previous_refresh_token_hash, revoked_at, revoked_reason, expires_at, created_at from identity.sessions where id = $1',
      [id],
    )
  )[0]!;

describe('refresh-token lifecycle', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  const refresh = (refreshToken: string) => request(identity.server).post(REFRESH).send({ refreshToken });

  it('rotates: a new refresh token and access token each time, storing only hashes of current and previous', async () => {
    const tokens = await registerAndLogin(identity.server);
    const first = await refresh(tokens.refreshToken).expect(200);
    const rotated = first.body as Tokens;
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    expect(rotated.accessToken).not.toBe(tokens.accessToken);
    expect(rotated.sessionId).toBe(tokens.sessionId);
    expect(first.headers['cache-control']).toBe('no-store');

    const row = await sessionRow(tokens.sessionId);
    expect(row.refresh_token_hash).toBe(sha256Hex(rotated.refreshToken));
    expect(row.previous_refresh_token_hash).toBe(sha256Hex(tokens.refreshToken));

    // The rotated token keeps working.
    await refresh(rotated.refreshToken).expect(200);
  });

  it('detects reuse of a rotated token: revokes the whole session (token family) and records why', async () => {
    const tokens = await registerAndLogin(identity.server);
    const rotated = (await refresh(tokens.refreshToken).expect(200)).body as Tokens;

    // The old token is replayed (e.g. stolen and used after the legitimate client rotated it).
    const replay = await refresh(tokens.refreshToken).expect(401);
    expect(problemOf(replay).code).toBe('invalid_refresh_token');
    expect(setCookies(replay)).toEqual([CLEARED]);

    const row = await sessionRow(tokens.sessionId);
    expect(row.revoked_reason).toBe('refresh_token_reuse');
    // The legitimate holder's current token dies with the family...
    await refresh(rotated.refreshToken).expect(401);
    // ...and so does the session's access token on identity routes.
    const res = await request(identity.server).get(SESSIONS).set(auth(rotated.accessToken)).expect(401);
    expect(problemOf(res).code).toBe('session_revoked');

    expect(
      await db('select payload from identity.outbox_events where event_type = $1 and aggregate_id = $2', [
        'identity.session.revoked',
        tokens.sessionId,
      ]),
    ).toEqual([{ payload: { sessionId: tokens.sessionId, userId: tokens.userId, reason: 'refresh_token_reuse' } }]);
    const [warning] = identity.logger.events('refresh_token_reuse_detected');
    expect(warning).toMatchObject({ sessionId: tokens.sessionId, userId: tokens.userId });
    expect(identity.logger.dump()).not.toContain(tokens.refreshToken);
  });

  it('lets exactly one of many concurrent refreshes with the same token succeed; the rest revoke the family', async () => {
    const tokens = await registerAndLogin(identity.server);
    const responses = await Promise.all(Array.from({ length: 8 }, () => refresh(tokens.refreshToken)));
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 401, 401, 401, 401, 401, 401, 401]);
    expect((await sessionRow(tokens.sessionId)).revoked_reason).toBe('refresh_token_reuse');
    const winner = responses.find((res) => res.status === 200)!.body as Tokens;
    await refresh(winner.refreshToken).expect(401);
  });

  it('rotates the browser cookie: token in, new HttpOnly cookie out, never in the body', async () => {
    const { email } = await register(identity.server);
    const loginRes = await request(identity.server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'correct horse battery staple' })
      .expect(200);
    const cookieToken = refreshCookieValue(loginRes)!;
    const res = await request(identity.server)
      .post(REFRESH)
      .set('Cookie', `__Secure-sc_refresh=${cookieToken}`)
      .send()
      .expect(200);
    expect(res.body).not.toHaveProperty('refreshToken');
    const next = refreshCookieValue(res);
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next).not.toBe(cookieToken);
  });

  it.each([
    ['no token at all', undefined],
    ['a malformed token', 'not-a-token'],
    ['an unknown token', generateOpaqueToken()],
  ])('rejects %s with 401 and clears the cookie', async (_case, token) => {
    const res = await request(identity.server)
      .post(REFRESH)
      .send(token === undefined ? {} : { refreshToken: token })
      .expect(401);
    expect(problemOf(res).code).toBe('invalid_refresh_token');
    expect(setCookies(res)).toEqual([CLEARED]);
  });

  it('enforces expiry: an expired session cannot be refreshed', async () => {
    const tokens = await registerAndLogin(identity.server);
    await db(
      "update identity.sessions set created_at = now() - interval '40 days', expires_at = now() - interval '1 minute' where id = $1",
      [tokens.sessionId],
    );
    await refresh(tokens.refreshToken).expect(401);
    expect((await sessionRow(tokens.sessionId)).revoked_at).toBeNull(); // expired, not a reuse
  });

  it('slides the idle expiry on refresh but never past the absolute session lifetime', async () => {
    const tokens = await registerAndLogin(identity.server);
    const fresh = (await refresh(tokens.refreshToken).expect(200)).body as Tokens;
    const slid = await sessionRow(tokens.sessionId);
    expect(slid.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * DAY_MS);

    // 89 days into a 90-day session: the next refresh may extend it by one day at most.
    await db("update identity.sessions set created_at = now() - interval '89 days' where id = $1", [tokens.sessionId]);
    await refresh(fresh.refreshToken).expect(200);
    const capped = await sessionRow(tokens.sessionId);
    expect(capped.expires_at.getTime()).toBeLessThanOrEqual(capped.created_at.getTime() + 90 * DAY_MS);
    expect(capped.expires_at.getTime() - Date.now()).toBeLessThan(1.01 * DAY_MS);
  });
});

describe('logout', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  it('ends the session of the presented refresh token, clears the cookie, and is idempotent', async () => {
    const tokens = await registerAndLogin(identity.server);
    const res = await request(identity.server).post(LOGOUT).send({ refreshToken: tokens.refreshToken }).expect(204);
    expect(setCookies(res)).toEqual([CLEARED]);
    expect((await sessionRow(tokens.sessionId)).revoked_reason).toBe('logout');
    await request(identity.server).post(REFRESH).send({ refreshToken: tokens.refreshToken }).expect(401);
    // Identity's own protected routes refuse the session's access token right away.
    await request(identity.server).get(SESSIONS).set(auth(tokens.accessToken)).expect(401);
    // Repeating, or logging out with nothing, still answers 204.
    await request(identity.server).post(LOGOUT).send({ refreshToken: tokens.refreshToken }).expect(204);
    await request(identity.server).post(LOGOUT).send({}).expect(204);
  });

  it('accepts the browser cookie', async () => {
    const tokens = await registerAndLogin(identity.server);
    await request(identity.server)
      .post(LOGOUT)
      .set('Cookie', `__Secure-sc_refresh=${tokens.refreshToken}`)
      .send()
      .expect(204);
    expect((await sessionRow(tokens.sessionId)).revoked_reason).toBe('logout');
  });

  it("logout-all ends every session of the caller and nobody else's", async () => {
    const first = await registerAndLogin(identity.server);
    const second = await login(identity.server, first.email);
    const stranger = await registerAndLogin(identity.server);

    await request(identity.server).post('/api/v1/auth/logout-all').set(auth(first.accessToken)).send().expect(204);
    expect((await sessionRow(first.sessionId)).revoked_reason).toBe('logout_all');
    expect((await sessionRow(second.sessionId)).revoked_reason).toBe('logout_all');
    expect((await sessionRow(stranger.sessionId)).revoked_at).toBeNull();
    await request(identity.server).post(REFRESH).send({ refreshToken: second.refreshToken }).expect(401);
    await request(identity.server).get(SESSIONS).set(auth(stranger.accessToken)).expect(200);
  });

  it('logout-all requires an access token', async () => {
    const res = await request(identity.server).post('/api/v1/auth/logout-all').send().expect(401);
    expect(problemOf(res).code).toBe('unauthenticated');
  });
});
