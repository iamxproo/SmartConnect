import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../smartconnect-backend/services/identity/src/crypto/tokens.js';
import {
  auth,
  db,
  login,
  problemOf,
  register,
  startIdentity,
  uniqueEmail,
  type TestIdentity,
} from './support/identity.js';

const VERIFY = '/api/v1/auth/email/verify';
const RESEND = '/api/v1/auth/email/verification';
const ME = '/api/v1/auth/me';

describe('email verification', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  function verificationToken(email: string): string {
    const [message] = identity.mailbox.list(email).filter((m) => m.kind === 'email_verification');
    if (message?.kind !== 'email_verification') throw new Error('no verification email');
    return message.token;
  }

  it('sends a verification link (token in the URL fragment) at registration and stores only its hash', async () => {
    const { email } = await register(identity.server);
    const [message] = identity.mailbox.list(email);
    expect(message).toMatchObject({ kind: 'email_verification', to: email });
    if (message?.kind !== 'email_verification') throw new Error('unexpected message');
    expect(message.link).toBe(`http://127.0.0.1:5173/verify-email#token=${message.token}`);
    const rows = await db<{ token_hash: string }>(
      `select t.token_hash from identity.verification_tokens t join identity.users u on u.id = t.user_id
        where u.email_normalized = $1 and t.purpose = 'email_verification'`,
      [email],
    );
    expect(rows).toEqual([{ token_hash: sha256Hex(message.token) }]);
    expect(identity.logger.dump()).not.toContain(message.token);
  });

  it('GET /auth/me reports the account; verifying flips emailVerified', async () => {
    const { email } = await register(identity.server, uniqueEmail('me'), undefined, 'Grace Hopper');
    const { accessToken } = await login(identity.server, email);
    const before = await request(identity.server).get(ME).set(auth(accessToken)).expect(200);
    expect(before.body).toEqual({
      id: expect.any(String) as string,
      email,
      emailVerified: false,
      displayName: 'Grace Hopper',
      // ADR 0015: no platform role, and the password is the account's own.
      platformRoles: [],
      passwordChangeRequired: false,
    });
    expect(before.headers['cache-control']).toBe('no-store');

    await request(identity.server)
      .post(VERIFY)
      .send({ token: verificationToken(email) })
      .expect(204);
    const after = await request(identity.server).get(ME).set(auth(accessToken)).expect(200);
    expect((after.body as { emailVerified: boolean }).emailVerified).toBe(true);
  });

  it('is single-use and rejects malformed, unknown and expired tokens', async () => {
    const { email } = await register(identity.server);
    const token = verificationToken(email);
    await request(identity.server).post(VERIFY).send({ token }).expect(204);
    const reused = await request(identity.server).post(VERIFY).send({ token }).expect(400);
    expect(problemOf(reused).code).toBe('invalid_verification_token');
    await request(identity.server).post(VERIFY).send({ token: 'abc' }).expect(400);

    const other = await register(identity.server);
    const expiring = verificationToken(other.email);
    await db("update identity.verification_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [
      sha256Hex(expiring),
    ]);
    await request(identity.server).post(VERIFY).send({ token: expiring }).expect(400);
  });

  it('resend issues a new link that replaces the old one, and does nothing once verified', async () => {
    const { email } = await register(identity.server);
    const { accessToken } = await login(identity.server, email);
    const first = verificationToken(email);
    await request(identity.server).post(RESEND).set(auth(accessToken)).send().expect(202);
    const second = verificationToken(email);
    expect(second).not.toBe(first);
    await request(identity.server).post(VERIFY).send({ token: first }).expect(400);
    await request(identity.server).post(VERIFY).send({ token: second }).expect(204);

    const count = identity.mailbox.list(email).length;
    await request(identity.server).post(RESEND).set(auth(accessToken)).send().expect(202);
    expect(identity.mailbox.list(email)).toHaveLength(count);
  });

  it('a completed password reset also verifies the address (the link reached the inbox)', async () => {
    const { email } = await register(identity.server);
    await request(identity.server).post('/api/v1/auth/password/forgot').send({ email }).expect(202);
    const [reset] = identity.mailbox.list(email).filter((m) => m.kind === 'password_reset');
    if (reset?.kind !== 'password_reset') throw new Error('no reset email');
    expect(reset.link).toBe(`http://127.0.0.1:5173/reset-password#token=${reset.token}`);
    await request(identity.server)
      .post('/api/v1/auth/password/reset')
      .send({ token: reset.token, newPassword: 'a brand new passphrase 2026' })
      .expect(204);
    const { accessToken } = await login(identity.server, email, 'a brand new passphrase 2026');
    expect(
      ((await request(identity.server).get(ME).set(auth(accessToken))).body as { emailVerified: boolean })
        .emailVerified,
    ).toBe(true);
  });

  it('/me refuses a suspended account, so other services refuse it too', async () => {
    const { email } = await register(identity.server);
    const { accessToken } = await login(identity.server, email);
    await db("update identity.users set status = 'suspended' where email_normalized = $1", [email]);
    const res = await request(identity.server).get(ME).set(auth(accessToken)).expect(401);
    expect(problemOf(res).code).toBe('session_revoked');
  });

  it('requires authentication for /me and resend', async () => {
    await request(identity.server).get(ME).expect(401);
    await request(identity.server).post(RESEND).send().expect(401);
  });
});
