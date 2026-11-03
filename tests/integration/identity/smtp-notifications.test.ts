// Identity with the REAL SmtpAccountNotifier and BackgroundMailer over a capturing fake transport: the emails carry
// working one-time links, the request never waits for the mail server, and the logs stay clean.
import { BackgroundMailer, EmailDeliveryError } from '@smartconnect/backend-kit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpAccountNotifier } from '../../../smartconnect-backend/services/identity/src/notifications/account-notifier.js';
import { CapturingTransport, htmlLinkOf, tokenOf } from './support/capturing-transport.js';
import {
  auth,
  login,
  PASSWORD,
  problemOf,
  register,
  startIdentity,
  uniqueEmail,
  type TestIdentity,
} from './support/identity.js';

const VERIFY = '/api/v1/auth/email/verify';
const FORGOT = '/api/v1/auth/password/forgot';
const RESET = '/api/v1/auth/password/reset';
const ME = '/api/v1/auth/me';
const NEW_PASSWORD = 'a brand new passphrase 2026';

describe('identity account emails over SMTP (fake transport)', () => {
  const transport = new CapturingTransport();
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity({
      notifier: (logger) =>
        new SmtpAccountNotifier(
          new BackgroundMailer(transport, logger, { baseDelayMs: 10, maxDelayMs: 20 }),
          'http://127.0.0.1:5173',
        ),
    });
  });
  afterAll(() => identity.close());

  it('registration emails a verification link whose token verifies the address, once', async () => {
    const { email } = await register(identity.server);
    const [mail] = await transport.waitFor(email);
    expect(mail).toMatchObject({ to: email, subject: 'Verify your SmartConnect email address' });
    const token = tokenOf(mail!);
    expect(htmlLinkOf(mail!)).toBe(`http://127.0.0.1:5173/verify-email#token=${token}`);

    const { accessToken } = await login(identity.server, email);
    await request(identity.server).post(VERIFY).send({ token }).expect(204);
    const me = await request(identity.server).get(ME).set(auth(accessToken)).expect(200);
    expect((me.body as { emailVerified: boolean }).emailVerified).toBe(true);

    const reused = await request(identity.server).post(VERIFY).send({ token }).expect(400);
    expect(problemOf(reused).code).toBe('invalid_verification_token');
  });

  it('forgot password emails a reset token that resets the password once, then a "changed" notice', async () => {
    const { email } = await register(identity.server);
    await transport.waitFor(email, 1); // the verification email
    await request(identity.server).post(FORGOT).send({ email }).expect(202);
    const [, reset] = await transport.waitFor(email, 2);
    expect(reset!.subject).toBe('Reset your SmartConnect password');
    const token = tokenOf(reset!);
    expect(htmlLinkOf(reset!)).toBe(`http://127.0.0.1:5173/reset-password#token=${token}`);

    await request(identity.server).post(RESET).send({ token, newPassword: NEW_PASSWORD }).expect(204);
    await request(identity.server).post(RESET).send({ token, newPassword: 'another passphrase 2026' }).expect(400);
    await login(identity.server, email, NEW_PASSWORD);
    await request(identity.server)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD, tokenDelivery: 'body' })
      .expect(401);

    const [, , changed] = await transport.waitFor(email, 3);
    expect(changed!.subject).toBe('Your SmartConnect password was changed');
    expect(changed!.html + changed!.text).not.toContain('token=');
  });

  it('registering an address that already has an account emails the owner, without a token link', async () => {
    const { email } = await register(identity.server);
    await transport.waitFor(email, 1);
    await register(identity.server, email);
    const [, attempt] = await transport.waitFor(email, 2);
    expect(attempt!.subject).toBe('Someone tried to create a SmartConnect account with your email');
    expect(attempt!.html + attempt!.text).not.toContain('token=');
  });

  it('answers forgot-password in the same short time however slow the mail server is', async () => {
    const { email } = await register(identity.server);
    await transport.waitFor(email, 1);
    transport.delayMs = 2000;
    try {
      for (const address of [email, uniqueEmail('nobody')]) {
        const started = Date.now();
        await request(identity.server).post(FORGOT).send({ email: address }).expect(202);
        expect(Date.now() - started).toBeLessThan(500);
      }
      expect(transport.to(email)).toHaveLength(1); // the reset email is still waiting on the slow server
    } finally {
      transport.delayMs = 0;
    }
    await transport.waitFor(email, 2, 6000);
  });

  it('a failing mail server never changes the HTTP outcome, and the failure is logged without personal data', async () => {
    transport.failWith = new EmailDeliveryError('rejected', false, 550, 'EENVELOPE');
    const email = uniqueEmail('rejected');
    try {
      await register(identity.server, email);
      for (let i = 0; i < 100 && identity.logger.events('email_delivery_failed').length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      transport.failWith = undefined;
    }
    expect(identity.logger.events('email_delivery_failed')).toContainEqual({
      event: 'email_delivery_failed',
      kind: 'email_verification',
      category: 'rejected',
      status: 550,
      providerCode: 'EENVELOPE',
      attempts: 1,
    });
  });

  it('logs no tokens, links or recipients', () => {
    const dump = identity.logger.dump();
    expect(identity.logger.events('email_sent').length).toBeGreaterThan(3);
    for (const message of transport.sent) {
      expect(dump).not.toContain(message.to);
      expect(dump).not.toContain(message.subject);
      if (message.text.includes('#token=')) expect(dump).not.toContain(tokenOf(message));
    }
    expect(dump).not.toContain('#token=');
  });
});

describe('shutdown', () => {
  it('sends queued mail before the service closes (the notifier is a Nest shutdown hook)', async () => {
    const slow = new CapturingTransport();
    slow.delayMs = 300;
    const identity = await startIdentity({
      notifier: (logger) => new SmtpAccountNotifier(new BackgroundMailer(slow, logger), 'http://127.0.0.1:5173'),
    });
    const { email } = await register(identity.server);
    expect(slow.sent).toHaveLength(0);
    await identity.close();
    expect(slow.to(email)).toHaveLength(1);
    expect(slow.closed).toBe(true);
  });
});
