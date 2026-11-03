import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateOpaqueToken, sha256Hex } from '../../../smartconnect-backend/services/identity/src/crypto/tokens.js';
import {
  auth,
  db,
  login,
  PASSWORD,
  problemOf,
  register,
  registerAndLogin,
  startIdentity,
  uniqueEmail,
  type TestIdentity,
} from './support/identity.js';

const FORGOT = '/api/v1/auth/password/forgot';
const RESET = '/api/v1/auth/password/reset';
const CHANGE = '/api/v1/auth/password/change';
const NEW_PASSWORD = 'a brand new passphrase 2026';

describe('password reset', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  /** Requests a reset and returns the raw token the (dev) mailbox received. */
  async function requestReset(email: string): Promise<string> {
    await request(identity.server).post(FORGOT).send({ email }).expect(202);
    const [message] = identity.mailbox.list(email).filter((m) => m.kind === 'password_reset');
    if (message?.kind !== 'password_reset') throw new Error('no reset email');
    return message.token;
  }

  it('answers 202 alike for unknown and known accounts; only the owner of a real account gets a token', async () => {
    const unknown = uniqueEmail('nobody');
    const unknownRes = await request(identity.server).post(FORGOT).send({ email: unknown }).expect(202);
    expect(identity.mailbox.list(unknown)).toEqual([]);

    const { email } = await register(identity.server);
    const knownRes = await request(identity.server).post(FORGOT).send({ email }).expect(202);
    expect(knownRes.body).toEqual(unknownRes.body);
    // Newest first: the reset, then the verification email sent at registration.
    expect(identity.mailbox.list(email).map((m) => m.kind)).toEqual(['password_reset', 'email_verification']);
  });

  it('stores only the SHA-256 of a 256-bit token, expiring in 30 minutes, and never logs it', async () => {
    const { email } = await register(identity.server);
    const token = await requestReset(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db<{ token_hash: string; expires_at: Date; consumed_at: Date | null }>(
      `select t.token_hash, t.expires_at, t.consumed_at from identity.verification_tokens t
         join identity.users u on u.id = t.user_id where u.email_normalized = $1 and t.purpose = 'password_reset'`,
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256Hex(token));
    expect(rows[0]!.consumed_at).toBeNull();
    const minutes = (rows[0]!.expires_at.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
    expect(identity.logger.dump()).not.toContain(token);
  });

  it('resets the password with the token, ends EVERY session, and records the change', async () => {
    const tokens = await registerAndLogin(identity.server);
    const second = await login(identity.server, tokens.email);
    const token = await requestReset(tokens.email);

    await request(identity.server).post(RESET).send({ token, newPassword: NEW_PASSWORD }).expect(204);

    for (const session of [tokens, second]) {
      await request(identity.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      await request(identity.server).get('/api/v1/auth/sessions').set(auth(session.accessToken)).expect(401);
    }
    const reasons = await db<{ revoked_reason: string }>(
      'select revoked_reason from identity.sessions where id = any($1::uuid[])',
      [[tokens.sessionId, second.sessionId]],
    );
    expect(reasons.map((row) => row.revoked_reason)).toEqual(['password_reset', 'password_reset']);

    await request(identity.server)
      .post('/api/v1/auth/login')
      .send({ email: tokens.email, password: PASSWORD })
      .expect(401);
    await login(identity.server, tokens.email, NEW_PASSWORD);
    expect(identity.mailbox.list(tokens.email).map((m) => m.kind)).toContain('password_changed');
    expect(
      await db('select payload from identity.outbox_events where event_type = $1 and aggregate_id = $2', [
        'identity.user.password_changed',
        tokens.userId,
      ]),
    ).toEqual([{ payload: { userId: tokens.userId, method: 'reset' } }]);
  });

  it('is single-use', async () => {
    const { email } = await register(identity.server);
    const token = await requestReset(email);
    await request(identity.server).post(RESET).send({ token, newPassword: NEW_PASSWORD }).expect(204);
    const again = await request(identity.server)
      .post(RESET)
      .send({ token, newPassword: 'yet another passphrase' })
      .expect(400);
    expect(problemOf(again).code).toBe('invalid_reset_token');
    await login(identity.server, email, NEW_PASSWORD);
  });

  it('is single-use under concurrent requests: exactly one succeeds', async () => {
    const { email } = await register(identity.server);
    const token = await requestReset(email);
    const passwords = Array.from({ length: 5 }, (_, i) => `${NEW_PASSWORD} variant ${i}`);
    const responses = await Promise.all(
      passwords.map((newPassword) => request(identity.server).post(RESET).send({ token, newPassword })),
    );
    expect(responses.map((res) => res.status).sort()).toEqual([204, 400, 400, 400, 400]);
    const winner = passwords[responses.findIndex((res) => res.status === 204)]!;
    await login(identity.server, email, winner);
  });

  it('expires', async () => {
    const { email } = await register(identity.server);
    const token = await requestReset(email);
    await db("update identity.verification_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [
      sha256Hex(token),
    ]);
    await request(identity.server).post(RESET).send({ token, newPassword: NEW_PASSWORD }).expect(400);
    await login(identity.server, email, PASSWORD);
  });

  it('only the newest link works: requesting again invalidates the previous token', async () => {
    const { email } = await register(identity.server);
    const older = await requestReset(email);
    const newer = await requestReset(email);
    expect(newer).not.toBe(older);
    await request(identity.server).post(RESET).send({ token: older, newPassword: NEW_PASSWORD }).expect(400);
    await request(identity.server).post(RESET).send({ token: newer, newPassword: NEW_PASSWORD }).expect(204);
  });

  it.each([
    ['a malformed token', 'abc'],
    ['an unknown token', generateOpaqueToken()],
  ])('rejects %s', async (_case, token) => {
    const res = await request(identity.server).post(RESET).send({ token, newPassword: NEW_PASSWORD }).expect(400);
    expect(problemOf(res)).toMatchObject({ code: 'invalid_reset_token' });
  });

  it('validates the new password BEFORE consuming the token', async () => {
    const { email } = await register(identity.server);
    const token = await requestReset(email);
    await request(identity.server).post(RESET).send({ token, newPassword: 'too short' }).expect(422);
    await request(identity.server).post(RESET).send({ token, newPassword: NEW_PASSWORD }).expect(204);
  });
});

describe('password change', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  it('requires the current password and leaves everything intact when it is wrong', async () => {
    const tokens = await registerAndLogin(identity.server);
    const res = await request(identity.server)
      .post(CHANGE)
      .set(auth(tokens.accessToken))
      .send({ currentPassword: 'not my password', newPassword: NEW_PASSWORD })
      .expect(403);
    expect(problemOf(res).code).toBe('current_password_incorrect');
    await login(identity.server, tokens.email, PASSWORD);
  });

  it('changes the password, ends every OTHER session, keeps the current one, and records the change', async () => {
    const current = await registerAndLogin(identity.server);
    const other = await login(identity.server, current.email);
    await request(identity.server)
      .post(CHANGE)
      .set(auth(current.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);

    await request(identity.server).post('/api/v1/auth/refresh').send({ refreshToken: other.refreshToken }).expect(401);
    const [row] = await db<{ revoked_reason: string }>('select revoked_reason from identity.sessions where id = $1', [
      other.sessionId,
    ]);
    expect(row!.revoked_reason).toBe('password_changed');
    await request(identity.server).get('/api/v1/auth/sessions').set(auth(current.accessToken)).expect(200);
    await request(identity.server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: current.refreshToken })
      .expect(200);

    await request(identity.server)
      .post('/api/v1/auth/login')
      .send({ email: current.email, password: PASSWORD })
      .expect(401);
    await login(identity.server, current.email, NEW_PASSWORD);
    expect(
      await db('select payload from identity.outbox_events where event_type = $1 and aggregate_id = $2', [
        'identity.user.password_changed',
        current.userId,
      ]),
    ).toEqual([{ payload: { userId: current.userId, method: 'change' } }]);
  });

  it('enforces the password policy on the new password', async () => {
    const tokens = await registerAndLogin(identity.server);
    const res = await request(identity.server)
      .post(CHANGE)
      .set(auth(tokens.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'short' })
      .expect(422);
    expect(problemOf(res).errors).toContainEqual(expect.objectContaining({ field: 'newPassword', code: 'too_short' }));
  });

  it('requires authentication', async () => {
    await request(identity.server)
      .post(CHANGE)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(401);
  });
});
