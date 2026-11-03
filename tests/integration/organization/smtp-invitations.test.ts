// Organization with the REAL SmtpInvitationNotifier and BackgroundMailer over a capturing fake transport: the email's
// link token accepts the invitation once, resend replaces it, hostile names stay inert, and the logs stay clean.
import { BackgroundMailer } from '@smartconnect/backend-kit';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpInvitationNotifier } from '../../../smartconnect-backend/services/organization/src/notifications/invitation-notifier.js';
import { CapturingTransport, htmlLinkOf, tokenOf } from '../identity/support/capturing-transport.js';
import { problemOf, uniqueEmail } from '../identity/support/identity.js';
import {
  createOrg,
  createUser,
  startPlatform,
  uniqueSlug,
  type Org,
  type Platform,
  type User,
} from './support/platform.js';

const ACCEPT = '/api/v1/invitations/accept';

describe('organization invitations over SMTP (fake transport)', () => {
  const transport = new CapturingTransport();
  let platform: Platform;
  let founder: User;
  let org: Org;
  beforeAll(async () => {
    platform = await startPlatform({
      notifier: (logger) => new SmtpInvitationNotifier(new BackgroundMailer(transport, logger, { baseDelayMs: 10 })),
    });
    founder = await createUser(platform, platform.founderEmail);
    org = await createOrg(platform, founder);
  });
  afterAll(() => platform.close());

  const invite = (email: string) =>
    request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations`)
      .set(founder.auth)
      .send({ email, roleId: org.roles.member })
      .expect(201);

  it('emails a link whose token accepts the invitation once, for the invited account', async () => {
    const invitee = await createUser(platform);
    await invite(invitee.email);
    const [mail] = await transport.waitFor(invitee.email);
    expect(mail!.subject).toMatch(/ invited you to Org org-.* on SmartConnect$/);
    expect(mail!.html + mail!.text).toContain('Role: Member');
    const token = tokenOf(mail!);
    expect(htmlLinkOf(mail!)).toBe(`http://127.0.0.1:5173/invitations/accept#token=${token}`);

    const res = await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(200);
    expect(res.body).toMatchObject({ organizationId: org.id });
    const replay = await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(404);
    expect(problemOf(replay).code).toBe('invitation_invalid');
  });

  it('resend emails a new working token and the old one dies', async () => {
    const invitee = await createUser(platform);
    await invite(invitee.email);
    const [first] = await transport.waitFor(invitee.email);
    const list = await request(platform.server)
      .get(`/api/v1/orgs/${org.id}/invitations?status=pending`)
      .set(founder.auth);
    const id = (list.body as { data: { id: string; email: string }[] }).data.find((i) => i.email === invitee.email)!.id;
    await request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations/${id}/resend`)
      .set(founder.auth)
      .expect(200);
    const [, second] = await transport.waitFor(invitee.email, 2);
    const [oldToken, newToken] = [tokenOf(first!), tokenOf(second!)];
    expect(newToken).not.toBe(oldToken);

    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token: oldToken }).expect(404);
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token: newToken }).expect(200);
  });

  it('keeps a hostile organization name inert in the email', async () => {
    const hostileName = `<script>alert(1)</script> "Evil" & Co https://evil.example`;
    const created = await request(platform.server)
      .post('/api/v1/orgs')
      .set(founder.auth)
      .send({ name: hostileName, slug: uniqueSlug('hostile') })
      .expect(201);
    const hostileId = (created.body as { id: string }).id;
    const roles = await request(platform.server).get(`/api/v1/orgs/${hostileId}/roles`).set(founder.auth).expect(200);
    const member = (roles.body as { data: { key: string; id: string }[] }).data.find((r) => r.key === 'member')!.id;
    const invitee = await createUser(platform);
    await request(platform.server)
      .post(`/api/v1/orgs/${hostileId}/invitations`)
      .set(founder.auth)
      .send({ email: invitee.email, roleId: member })
      .expect(201);
    const [mail] = await transport.waitFor(invitee.email);
    expect(mail!.html).not.toContain('<script');
    expect(mail!.html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt; &quot;Evil&quot; &amp; Co https://evil.example',
    );
    expect(mail!.html.match(/href="/g)).toHaveLength(1);
    expect(mail!.subject).not.toMatch(/[\r\n]/);
  });

  it('logs no tokens, links or recipients', () => {
    const dump = platform.logger.dump();
    expect(platform.logger.events('email_sent').length).toBeGreaterThanOrEqual(3);
    for (const message of transport.sent) {
      expect(dump).not.toContain(message.to);
      expect(dump).not.toContain(message.subject);
      expect(dump).not.toContain(tokenOf(message));
    }
    expect(dump).not.toContain('#token=');
  });

  it('never changes the HTTP outcome when the mail server fails', async () => {
    transport.failWith = new Error('boom invitee@example.com');
    const email = uniqueEmail('failing');
    try {
      await invite(email);
      for (let i = 0; i < 100 && platform.logger.events('email_delivery_failed').length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      transport.failWith = undefined;
    }
    expect(platform.logger.events('email_delivery_failed')).toContainEqual(
      expect.objectContaining({ kind: 'organization_invitation', category: 'unexpected_response', attempts: 1 }),
    );
    expect(platform.logger.dump()).not.toContain(email);
    expect(platform.logger.dump()).not.toContain('boom');
  });
});
