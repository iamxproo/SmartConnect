import { randomUUID } from 'node:crypto';
import { AccessTokenVerifier } from '@smartconnect/backend-kit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD_HASH_PARAMS,
  PasswordHasher,
} from '../../../smartconnect-backend/services/identity/src/crypto/password-hasher.js';
import { sha256Hex } from '../../../smartconnect-backend/services/identity/src/crypto/tokens.js';
import {
  db,
  login,
  PASSWORD,
  problemOf,
  refreshCookieValue,
  register,
  setCookies,
  startIdentity,
  uniqueEmail,
  type TestIdentity,
} from './support/identity.js';

const REGISTER = '/api/v1/auth/register';
const LOGIN = '/api/v1/auth/login';

describe('registration', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  it('creates the account: normalised email, Argon2id hash (no plaintext), profile, outbox event', async () => {
    const entered = `  Ada.${randomUUID()}@Example.COM `;
    const normalized = entered.trim().toLowerCase();
    const res = await request(identity.server)
      .post(REGISTER)
      .set('X-Request-Id', 'register-request-0001')
      .send({ email: entered, password: PASSWORD, displayName: '  Ada  ' })
      .expect(202);
    expect(res.body).toEqual({ status: 'accepted' });

    const [user] = await db<{ id: string; email: string; status: string; display_name: string; secret: string }>(
      `select u.id, u.email, u.status, p.display_name, c.secret
         from identity.users u
         join identity.user_profiles p on p.user_id = u.id
         join identity.credentials c on c.user_id = u.id and c.type = 'password'
        where u.email_normalized = $1`,
      [normalized],
    );
    expect(user).toMatchObject({ email: entered.trim(), status: 'active', display_name: 'Ada' });
    expect(user!.secret).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user!.secret).not.toContain(PASSWORD);

    const events = await db('select event_type, payload, headers from identity.outbox_events where aggregate_id = $1', [
      user!.id,
    ]);
    expect(events).toEqual([
      {
        event_type: 'identity.user.registered',
        payload: { userId: user!.id },
        headers: { requestId: 'register-request-0001' },
      },
    ]);
  });

  it('answers an already-registered email exactly like a new one, creates nothing, and notifies the owner', async () => {
    const email = uniqueEmail('owner');
    const first = await request(identity.server)
      .post(REGISTER)
      .send({ email, password: PASSWORD, displayName: 'Owner' })
      .expect(202);
    const second = await request(identity.server)
      .post(REGISTER)
      .send({ email: email.toUpperCase(), password: 'attacker chosen password', displayName: 'Attacker' })
      .expect(202);
    expect(second.body).toEqual(first.body);

    expect(await db('select count(*)::int as n from identity.users where email_normalized = $1', [email])).toEqual([
      { n: 1 },
    ]);
    await login(identity.server, email, PASSWORD);
    await request(identity.server).post(LOGIN).send({ email, password: 'attacker chosen password' }).expect(401);
    // Newest first: the notice about the second attempt, then the first registration's verification email.
    expect(identity.mailbox.list(email).map((message) => message.kind)).toEqual([
      'registration_attempt',
      'email_verification',
    ]);
  });

  it('creates exactly one account under concurrent registrations of the same email', async () => {
    const email = uniqueEmail('race');
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(identity.server)
          .post(REGISTER)
          .send({ email, password: `${PASSWORD} ${i}`, displayName: 'Racer' }),
      ),
    );
    expect(responses.map((res) => res.status)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(await db('select count(*)::int as n from identity.users where email_normalized = $1', [email])).toEqual([
      { n: 1 },
    ]);
  });

  it.each([
    ['an invalid email', { email: 'not-an-email', password: PASSWORD, displayName: 'X' }, 'email', 'invalid_email'],
    [
      'a password under 12 characters',
      { email: 'a@example.com', password: 'short pass1', displayName: 'X' },
      'password',
      'too_short',
    ],
    [
      'a password over 128 characters',
      { email: 'a@example.com', password: 'x'.repeat(129), displayName: 'X' },
      'password',
      'too_long',
    ],
    ['a missing display name', { email: 'a@example.com', password: PASSWORD }, 'displayName', 'invalid_type'],
    [
      'a display name over 80 characters',
      { email: 'a@example.com', password: PASSWORD, displayName: 'x'.repeat(81) },
      'displayName',
      'too_long',
    ],
    [
      'an unknown field',
      { email: 'a@example.com', password: PASSWORD, displayName: 'X', role: 'admin' },
      'role',
      'unknown_field',
    ],
    ['a non-string email', { email: 42, password: PASSWORD, displayName: 'X' }, 'email', 'invalid_email'],
  ])('rejects %s with 422 problem details', async (_case, body, field, code) => {
    const res = await request(identity.server).post(REGISTER).send(body).expect(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemOf(res)).toMatchObject({ status: 422, code: 'validation_failed' });
    expect(problemOf(res).errors).toContainEqual(expect.objectContaining({ field, code }));
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  it('rejects malformed JSON (400) and non-JSON bodies (415)', async () => {
    await request(identity.server).post(REGISTER).set('Content-Type', 'application/json').send('{"email":').expect(400);
    await request(identity.server).post(REGISTER).set('Content-Type', 'text/plain').send('email=a').expect(415);
  });
});

describe('login', () => {
  let identity: TestIdentity;
  let verifier: AccessTokenVerifier;
  beforeAll(async () => {
    identity = await startIdentity();
    verifier = new AccessTokenVerifier(JSON.parse(identity.publicJwks) as { keys: [] }, {
      issuer: identity.config.issuer,
      audience: identity.config.audience,
    });
  });
  afterAll(() => identity.close());

  it('issues an access token and a refresh cookie (web default), and records the session', async () => {
    const { email } = await register(identity.server);
    const res = await request(identity.server)
      .post(LOGIN)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'sessionExpiresAt',
      'sessionId',
      'tokenType',
    ]);
    expect(body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(res.headers['cache-control']).toBe('no-store');

    const [cookie] = setCookies(res);
    expect(cookie).toMatch(
      /^__Secure-sc_refresh=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/api\/v1\/auth; HttpOnly; Secure; SameSite=Strict$/,
    );
    const refreshToken = refreshCookieValue(res)!;

    const principal = await verifier.verify(body.accessToken as string);
    expect(principal.sessionId).toBe(body.sessionId);
    const [session] = await db<Record<string, unknown>>(
      'select user_id, refresh_token_hash, previous_refresh_token_hash, user_agent, revoked_at from identity.sessions where id = $1',
      [body.sessionId],
    );
    expect(session).toEqual({
      user_id: principal.userId,
      refresh_token_hash: sha256Hex(refreshToken), // only the hash is stored
      previous_refresh_token_hash: null,
      user_agent: 'Mozilla/5.0 (test)',
      revoked_at: null,
    });
    const [user] = await db<{ last_login_at: Date | null }>('select last_login_at from identity.users where id = $1', [
      principal.userId,
    ]);
    expect(user!.last_login_at).not.toBeNull();
  });

  it('returns the refresh token in the body (and sets no cookie) for native apps', async () => {
    const { email } = await register(identity.server);
    const res = await request(identity.server)
      .post(LOGIN)
      .send({ email, password: PASSWORD, tokenDelivery: 'body' })
      .expect(200);
    expect((res.body as { refreshToken: string }).refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookies(res)).toEqual([]);
  });

  it('gives one generic 401 for an unknown email, a wrong password and an inactive account', async () => {
    const { email } = await register(identity.server);
    const suspended = await register(identity.server);
    await db("update identity.users set status = 'suspended' where email_normalized = $1", [suspended.email]);

    const attempts = await Promise.all([
      request(identity.server)
        .post(LOGIN)
        .send({ email: uniqueEmail('nobody'), password: PASSWORD }),
      request(identity.server).post(LOGIN).send({ email, password: 'wrong password entirely' }),
      request(identity.server).post(LOGIN).send({ email: suspended.email, password: PASSWORD }),
    ]);
    expect(attempts.map((res) => res.status)).toEqual([401, 401, 401]);
    const shapes = attempts.map((res) => {
      const { requestId: _requestId, ...rest } = problemOf(res);
      return rest;
    });
    expect(shapes[0]).toEqual({
      status: 401,
      type: 'https://docs.smartconnect.dev/errors/invalid-credentials',
      title: 'Authentication required',
      code: 'invalid_credentials',
      detail: 'The email or password is incorrect.',
      instance: LOGIN,
    });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it('upgrades a hash with outdated parameters on the next successful login', async () => {
    const { email } = await register(identity.server);
    const weak = await new PasswordHasher({ ...PASSWORD_HASH_PARAMS, memoryCost: 8192, timeCost: 1 }).hash(PASSWORD);
    await db(
      "update identity.credentials set secret = $1 where type = 'password' and user_id = (select id from identity.users where email_normalized = $2)",
      [weak, email],
    );
    await login(identity.server, email);
    const [row] = await db<{ secret: string }>(
      "select c.secret from identity.credentials c join identity.users u on u.id = c.user_id where u.email_normalized = $1 and c.type = 'password'",
      [email],
    );
    expect(row!.secret).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await login(identity.server, email); // still the same password
  });

  it('never logs passwords, emails or tokens', async () => {
    const { email } = await register(identity.server);
    const tokens = await login(identity.server, email);
    await request(identity.server).post(LOGIN).send({ email, password: 'wrong password entirely' }).expect(401);
    const logs = identity.logger.dump();
    for (const secret of [PASSWORD, 'wrong password entirely', email, tokens.refreshToken, tokens.accessToken]) {
      expect(logs).not.toContain(secret);
    }
  });
});
