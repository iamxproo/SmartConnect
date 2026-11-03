import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, query } from '../../support/database.js';
import { problemOf, uniqueEmail } from '../identity/support/identity.js';
import {
  addMember,
  createOrg,
  createUser,
  invite,
  startPlatform,
  type Org,
  type Platform,
  type User,
} from './support/platform.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ACCEPT = '/api/v1/invitations/accept';
const PREVIEW = '/api/v1/invitations/preview';

describe('invitations', () => {
  let platform: Platform;
  let founder: User;
  let org: Org;
  beforeAll(async () => {
    platform = await startPlatform();
    founder = await createUser(platform, platform.founderEmail);
    org = await createOrg(platform, founder);
  });
  afterAll(() => platform.close());

  const invitationsOf = (orgId: string, viewer: User, status = 'pending') =>
    request(platform.server).get(`/api/v1/orgs/${orgId}/invitations?status=${status}`).set(viewer.auth);

  it('sends a single-use link to the invited address and stores only the token hash', async () => {
    const email = uniqueEmail('invitee');
    const token = await invite(platform, founder, org, email);
    const [message] = platform.mailbox.list(email);
    expect(message).toMatchObject({ kind: 'organization_invitation', to: email, roleName: 'Member' });
    expect(message!.link).toBe(`http://127.0.0.1:5173/invitations/accept#token=${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await query<{ token_hash: string }>(
      adminUrl(),
      'select token_hash from organization.organization_invitations where email_normalized = $1',
      [email],
    );
    expect(rows).toEqual([{ token_hash: sha256(token) }]);
    expect(platform.logger.dump()).not.toContain(token);
  });

  it('previews publicly with only a hint of the invited address', async () => {
    const email = uniqueEmail('preview');
    const token = await invite(platform, founder, org, email);
    const res = await request(platform.server).post(PREVIEW).send({ token }).expect(200);
    expect(res.body).toEqual({
      organization: { name: expect.any(String) as string, slug: expect.any(String) as string },
      role: { name: 'Member' },
      emailHint: `${email[0]}***@example.com`,
      expiresAt: expect.any(String) as string,
    });
    expect(JSON.stringify(res.body)).not.toContain(email);
    expect(
      problemOf(
        await request(platform.server)
          .post(PREVIEW)
          .send({ token: 'x'.repeat(43) })
          .expect(404),
      ).code,
    ).toBe('invitation_invalid');
  });

  it('accepts for the invited, verified account: membership with the invited role, then the token is spent', async () => {
    const invitee = await createUser(platform);
    const token = await invite(platform, founder, org, invitee.email.toUpperCase(), 'admin');
    const res = await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(200);
    expect(res.body).toMatchObject({ organizationId: org.id, membership: { role: { key: 'admin' } } });
    await request(platform.server).get(`/api/v1/orgs/${org.id}/me`).set(invitee.auth).expect(200);

    const replay = await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(404);
    expect(problemOf(replay).code).toBe('invitation_invalid');
    await request(platform.server).post(PREVIEW).send({ token }).expect(404);
    const accepted = (await invitationsOf(org.id, founder, 'accepted')).body as { data: { email: string }[] };
    expect(accepted.data.map((i) => i.email)).toContain(invitee.email);
  });

  it('refuses a different account (and leaves the invitation usable by the right one)', async () => {
    const invitee = await createUser(platform);
    const intruder = await createUser(platform);
    const token = await invite(platform, founder, org, invitee.email);
    const res = await request(platform.server).post(ACCEPT).set(intruder.auth).send({ token }).expect(403);
    expect(problemOf(res).code).toBe('invitation_email_mismatch');
    await request(platform.server).get(`/api/v1/orgs/${org.id}`).set(intruder.auth).expect(404);
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(200);
  });

  it('voids pending invitations whose inviter has since lost the right to invite', async () => {
    const admin = await createUser(platform);
    await addMember(platform, founder, org, admin, 'admin');
    const invitee = await createUser(platform);
    const token = await invite(platform, admin, org, invitee.email);
    const adminMember = (
      await request(platform.server).get(`/api/v1/orgs/${org.id}/members?userId=${admin.userId}`).set(founder.auth)
    ).body as { data: { id: string }[] };
    await request(platform.server)
      .patch(`/api/v1/orgs/${org.id}/members/${adminMember.data[0]!.id}`)
      .set(founder.auth)
      .send({ roleId: org.roles.member })
      .expect(200);
    const res = await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(404);
    expect(problemOf(res).code).toBe('invitation_invalid');
    await request(platform.server).get(`/api/v1/orgs/${org.id}`).set(invitee.auth).expect(404);
  });

  it('requires a verified email address', async () => {
    const unverified = await createUser(platform, uniqueEmail('unverified'), false);
    const token = await invite(platform, founder, org, unverified.email);
    const res = await request(platform.server).post(ACCEPT).set(unverified.auth).send({ token }).expect(403);
    expect(problemOf(res).code).toBe('email_not_verified');
  });

  it('requires authentication to accept', async () => {
    const token = await invite(platform, founder, org, uniqueEmail('anon'));
    await request(platform.server).post(ACCEPT).send({ token }).expect(401);
  });

  it('accepts exactly once under concurrent requests', async () => {
    const invitee = await createUser(platform);
    const token = await invite(platform, founder, org, invitee.email);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(platform.server).post(ACCEPT).set(invitee.auth).send({ token })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.every((r) => [200, 404, 409].includes(r.status))).toBe(true);
    const members = (
      await request(platform.server).get(`/api/v1/orgs/${org.id}/members?userId=${invitee.userId}`).set(founder.auth)
    ).body as { data: unknown[] };
    expect(members.data).toHaveLength(1);
  });

  it('expires', async () => {
    const invitee = await createUser(platform);
    const token = await invite(platform, founder, org, invitee.email);
    await query(
      adminUrl(),
      "update organization.organization_invitations set expires_at = now() - interval '1 second' where token_hash = $1",
      [sha256(token)],
    );
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(404);
    const expired = (await invitationsOf(org.id, founder, 'expired')).body as {
      data: { email: string; status: string }[];
    };
    expect(expired.data).toContainEqual(expect.objectContaining({ email: invitee.email, status: 'expired' }));
    // An expired invitation does not block a new one for the same address.
    const fresh = await invite(platform, founder, org, invitee.email);
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token: fresh }).expect(200);
  });

  it('can be revoked (idempotently) and then no longer accepted', async () => {
    const invitee = await createUser(platform);
    await invite(platform, founder, org, invitee.email);
    const token = platform.mailbox.list(invitee.email)[0]!.token;
    const list = (await invitationsOf(org.id, founder)).body as { data: { id: string; email: string }[] };
    const id = list.data.find((i) => i.email === invitee.email)!.id;
    await request(platform.server).delete(`/api/v1/orgs/${org.id}/invitations/${id}`).set(founder.auth).expect(204);
    await request(platform.server).delete(`/api/v1/orgs/${org.id}/invitations/${id}`).set(founder.auth).expect(204);
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token }).expect(404);
    await request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations/${id}/resend`)
      .set(founder.auth)
      .expect(409);
  });

  it('resend issues a new link and kills the old one', async () => {
    const invitee = await createUser(platform);
    const old = await invite(platform, founder, org, invitee.email);
    const id = ((await invitationsOf(org.id, founder)).body as { data: { id: string; email: string }[] }).data.find(
      (i) => i.email === invitee.email,
    )!.id;
    await request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations/${id}/resend`)
      .set(founder.auth)
      .expect(200);
    const fresh = platform.mailbox.list(invitee.email)[0]!.token;
    expect(fresh).not.toBe(old);
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token: old }).expect(404);
    await request(platform.server).post(ACCEPT).set(invitee.auth).send({ token: fresh }).expect(200);
  });

  it('rejects duplicates and existing members', async () => {
    const email = uniqueEmail('dup');
    await invite(platform, founder, org, email);
    const dup = await request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations`)
      .set(founder.auth)
      .send({ email: ` ${email.toUpperCase()} `, roleId: org.roles.member })
      .expect(409);
    expect(problemOf(dup).code).toBe('invitation_pending');
    const member = await request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations`)
      .set(founder.auth)
      .send({ email: founder.email, roleId: org.roles.member })
      .expect(409);
    expect(problemOf(member).code).toBe('already_member');
  });

  it('restricts invitation management to members.invite, and owner invitations to owners', async () => {
    const employee = await createUser(platform);
    const admin = await createUser(platform);
    await addMember(platform, founder, org, employee);
    await addMember(platform, founder, org, admin, 'admin');
    const body = { email: uniqueEmail('x'), roleId: org.roles.member };
    await request(platform.server).post(`/api/v1/orgs/${org.id}/invitations`).set(employee.auth).send(body).expect(403);
    await invitationsOf(org.id, employee).expect(403);
    const ownerInvite = await request(platform.server)
      .post(`/api/v1/orgs/${org.id}/invitations`)
      .set(admin.auth)
      .send({ email: uniqueEmail('y'), roleId: org.roles.owner })
      .expect(403);
    expect(problemOf(ownerInvite).code).toBe('owner_required');
    await request(platform.server).post(`/api/v1/orgs/${org.id}/invitations`).set(admin.auth).send(body).expect(201);
  });

  it("keeps organizations apart: another org's invitations are invisible and untouchable", async () => {
    const otherOrg = await createOrg(platform, founder);
    const otherAdmin = await createUser(platform);
    await addMember(platform, founder, otherOrg, otherAdmin, 'admin');
    await invite(platform, founder, org, uniqueEmail('secret'));
    const id = ((await invitationsOf(org.id, founder)).body as { data: { id: string }[] }).data[0]!.id;
    // otherAdmin is an admin of otherOrg only.
    await invitationsOf(org.id, otherAdmin).expect(404);
    await request(platform.server).delete(`/api/v1/orgs/${org.id}/invitations/${id}`).set(otherAdmin.auth).expect(404);
    // The id under the admin's own organization's path: RLS keeps it invisible.
    await request(platform.server)
      .delete(`/api/v1/orgs/${otherOrg.id}/invitations/${id}`)
      .set(otherAdmin.auth)
      .expect(404);
    await request(platform.server)
      .post(`/api/v1/orgs/${otherOrg.id}/invitations/${id}/resend`)
      .set(otherAdmin.auth)
      .expect(404);
  });
});
