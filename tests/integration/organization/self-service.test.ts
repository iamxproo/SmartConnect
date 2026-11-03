// Self-service organization onboarding (ADR 0017) with the REAL identity and organization services on the test
// database: who may create an organization in "open" and "allowlist" mode, the ownership cap under concurrency,
// repeated requests, input rules, and the employee-invitation lifecycle a new owner relies on, including where each
// invitation's email stands (sent, failed, queued, disabled).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailOutcome } from '@smartconnect/backend-kit';
import { createPrismaClient } from '../../../smartconnect-backend/services/identity/src/database/client.js';
import {
  DisabledInvitationNotifier,
  type InvitationMessage,
  type InvitationNotifier,
} from '../../../smartconnect-backend/services/organization/src/notifications/invitation-notifier.js';
import type { CapturingLogger } from '../identity/support/identity.js';
import { seedSuperAdmin } from '../../../smartconnect-backend/scripts/super-admin.js';
import { adminUrl, appUrl, query } from '../../support/database.js';
import { login, problemOf, uniqueEmail } from '../identity/support/identity.js';
import { createUser, startPlatform, uniqueSlug, type Platform, type User } from './support/platform.js';

const ORGS = '/api/v1/orgs';

interface Invitation {
  id: string;
  email: string;
  status: string;
  acceptedAt: string | null;
  delivery: string;
  role: { key: string };
}

const create = (platform: Platform, who: User, body: Record<string, unknown>) =>
  request(platform.server).post(ORGS).set(who.auth).send(body);
const eligibility = async (platform: Platform, who: User) =>
  (await request(platform.server).get(`${ORGS}/creation-eligibility`).set(who.auth).expect(200)).body as {
    allowed: boolean;
    reason: string | null;
  };
const roleIds = async (platform: Platform, who: User, orgId: string) =>
  Object.fromEntries(
    (
      (await request(platform.server).get(`${ORGS}/${orgId}/roles`).set(who.auth).expect(200)).body as {
        data: { key: string; id: string }[];
      }
    ).data.map((role) => [role.key, role.id]),
  );
const invitations = async (platform: Platform, who: User, orgId: string) =>
  (
    (await request(platform.server).get(`${ORGS}/${orgId}/invitations?status=all`).set(who.auth).expect(200)).body as {
      data: Invitation[];
    }
  ).data;
const verifyEmail = async (platform: Platform, email: string) => {
  const [message] = platform.identity.mailbox.list(email).filter((m) => m.kind === 'email_verification');
  if (message?.kind !== 'email_verification') throw new Error('no verification email');
  await request(platform.identity.server).post('/api/v1/auth/email/verify').send({ token: message.token }).expect(204);
};

describe('self-service organization creation (ORGANIZATION_CREATION=open)', () => {
  let platform: Platform;
  beforeAll(async () => {
    platform = await startPlatform({ env: { ORGANIZATION_CREATION: 'open', ORGANIZATION_MAX_OWNED_PER_USER: '2' } });
  });
  afterAll(() => platform.close());

  it('lets any verified account create an organization and become its only owner, with no platform role', async () => {
    const ada = await createUser(platform);
    expect(await eligibility(platform, ada)).toEqual({ allowed: true, reason: null });
    const slug = uniqueSlug('ada');
    const res = await create(platform, ada, { name: 'Ada Labs', slug }).expect(201);
    const org = res.body as { id: string; slug: string; name: string };
    expect(org).toMatchObject({ slug, name: 'Ada Labs' });

    const me = await request(platform.server).get(`${ORGS}/${org.id}/me`).set(ada.auth).expect(200);
    expect(me.body).toMatchObject({ role: { key: 'owner', permissions: ['*'] } });
    const members = (await request(platform.server).get(`${ORGS}/${org.id}/members`).set(ada.auth).expect(200))
      .body as { data: { userId: string; role: { key: string } }[] };
    expect(members.data).toEqual([
      expect.objectContaining({ userId: ada.userId, role: expect.objectContaining({ key: 'owner' }) as unknown }),
    ]);
    expect(Object.keys(await roleIds(platform, ada, org.id))).toEqual(['owner', 'admin', 'member']);

    // Owning an organization is no platform role.
    const account = (await request(platform.identity.server).get('/api/v1/auth/me').set(ada.auth).expect(200)).body as {
      platformRoles: string[];
    };
    expect(account.platformRoles).toEqual([]);
    const admin = await request(platform.server).get('/api/v1/admin/organizations').set(ada.auth).expect(403);
    expect(problemOf(admin).code).toBe('platform_admin_required');
  });

  it('refuses an unverified account, and says why before anything is tried', async () => {
    const unverified = await createUser(platform, uniqueEmail('unverified'), false);
    expect(await eligibility(platform, unverified)).toEqual({ allowed: false, reason: 'email_not_verified' });
    const res = await create(platform, unverified, { name: 'Too Early', slug: uniqueSlug() }).expect(403);
    expect(problemOf(res).code).toBe('email_not_verified');
    expect((await request(platform.server).get(ORGS).set(unverified.auth).expect(200)).body).toEqual({
      data: [],
      nextCursor: null,
    });
  });

  it('caps how many organizations one person owns, also under concurrent requests; allowlisted creators are exempt', async () => {
    const busy = await createUser(platform);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => create(platform, busy, { name: `Busy ${i}`, slug: uniqueSlug('busy') })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 403, 403]);
    for (const refused of results.filter((r) => r.status === 403))
      expect(problemOf(refused).code).toBe('organization_limit_reached');
    expect(await eligibility(platform, busy)).toEqual({ allowed: false, reason: 'limit_reached' });
    const owned = (await request(platform.server).get(ORGS).set(busy.auth).expect(200)).body as { data: unknown[] };
    expect(owned.data).toHaveLength(2);

    const founder = await createUser(platform, platform.founderEmail);
    for (let i = 0; i < 3; i++)
      await create(platform, founder, { name: `Founded ${i}`, slug: uniqueSlug('f') }).expect(201);
    expect(await eligibility(platform, founder)).toEqual({ allowed: true, reason: null });
  });

  it('gives a repeated request the organization it created, never a second one or a conflict', async () => {
    const grace = await createUser(platform);
    const body = { name: 'Grace Works', slug: uniqueSlug('grace') };
    // A double submit: both arrive at once.
    const [first, second] = await Promise.all([create(platform, grace, body), create(platform, grace, body)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect((first.body as { id: string }).id).toBe((second.body as { id: string }).id);
    // A retry after a lost response.
    const retry = await create(platform, grace, body).expect(200);
    expect((retry.body as { id: string }).id).toBe((first.body as { id: string }).id);
    const mine = (await request(platform.server).get(ORGS).set(grace.auth).expect(200)).body as {
      data: { slug: string }[];
    };
    expect(mine.data.filter((org) => org.slug === body.slug)).toHaveLength(1);

    // The same handle for a different organization, or by someone else, is still a conflict.
    expect(problemOf(await create(platform, grace, { ...body, name: 'Other' }).expect(409)).code).toBe('slug_taken');
    const other = await createUser(platform);
    expect(problemOf(await create(platform, other, body).expect(409)).code).toBe('slug_taken');
  });

  it('validates names and handles, and accepts no fields beyond name, slug and description', async () => {
    const linus = await createUser(platform);
    const refused = async (body: Record<string, unknown>) =>
      problemOf(await create(platform, linus, body).expect(422)).errors?.map((e) => e.field);
    expect(await refused({ name: '   ', slug: uniqueSlug() })).toContain('name');
    expect(await refused({ name: '!!!', slug: uniqueSlug() })).toContain('name');
    expect(await refused({ name: 'Acme‮ moc.liamg', slug: uniqueSlug() })).toContain('name');
    expect(await refused({ name: 'Acme', slug: 'Not A Slug' })).toContain('slug');
    expect(await refused({ name: 'Acme', slug: '019a4a00-0000-7000-8000-000000000001' })).toContain('slug');
    // Role escalation through the body: unknown properties are refused, never applied.
    for (const extra of [{ role: 'owner' }, { platformRoles: ['super_admin'] }, { createdByUserId: linus.userId }])
      expect(await refused({ name: 'Acme', slug: uniqueSlug(), ...extra })).toEqual(
        expect.arrayContaining([Object.keys(extra)[0]]),
      );
    expect((await request(platform.server).get(ORGS).set(linus.auth).expect(200)).body).toMatchObject({ data: [] });
  });

  it('never lets a platform Super Admin create an organization, even when creation is open', async () => {
    const adminEmail = uniqueEmail('super-admin');
    const prisma = createPrismaClient({ connectionString: appUrl('identity'), maxConnections: 1 });
    try {
      await seedSuperAdmin(prisma, 'issued-initial-pw', { email: adminEmail });
    } finally {
      await prisma.$disconnect();
    }
    const { accessToken } = await login(platform.identity.server, adminEmail, 'issued-initial-pw');
    const admin = { email: adminEmail, userId: '', accessToken, auth: { Authorization: `Bearer ${accessToken}` } };
    expect(await eligibility(platform, admin)).toEqual({ allowed: false, reason: 'not_allowed' });
    const res = await create(platform, admin, { name: 'Admin Org', slug: uniqueSlug('admin') }).expect(403);
    expect(problemOf(res).code).toBe('organization_creation_not_allowed');
  });
});

describe('allowlist mode (the default outside production) keeps the original rule', () => {
  let platform: Platform;
  beforeAll(async () => {
    platform = await startPlatform();
  });
  afterAll(() => platform.close());

  it('lets only listed, verified addresses create, and tells everyone else why', async () => {
    const employee = await createUser(platform);
    expect(await eligibility(platform, employee)).toEqual({ allowed: false, reason: 'not_allowed' });
    expect(problemOf(await create(platform, employee, { name: 'Mine', slug: uniqueSlug() }).expect(403)).code).toBe(
      'organization_creation_not_allowed',
    );

    const founder = await createUser(platform, platform.founderEmail, false);
    expect(await eligibility(platform, founder)).toEqual({ allowed: false, reason: 'email_not_verified' });
    expect(problemOf(await create(platform, founder, { name: 'Early', slug: uniqueSlug() }).expect(403)).code).toBe(
      'email_not_verified',
    );
    await verifyEmail(platform, founder.email);
    expect(await eligibility(platform, founder)).toEqual({ allowed: true, reason: null });
    await create(platform, founder, { name: 'Now', slug: uniqueSlug() }).expect(201);
  });
});

describe('employee invitations from a self-service owner', () => {
  let platform: Platform;
  let owner: User;
  let orgId: string;
  let roles: Record<string, string>;
  beforeAll(async () => {
    platform = await startPlatform({ env: { ORGANIZATION_CREATION: 'open' } });
    owner = await createUser(platform);
    orgId = (
      (await create(platform, owner, { name: 'Initech', slug: uniqueSlug('initech') }).expect(201)).body as {
        id: string;
      }
    ).id;
    roles = await roleIds(platform, owner, orgId);
  });
  afterAll(() => platform.close());

  const invite = (email: string, role = 'member') =>
    request(platform.server).post(`${ORGS}/${orgId}/invitations`).set(owner.auth).send({ email, roleId: roles[role] });
  const tokenFor = (email: string) => platform.mailbox.list(email)[0]!.token;
  const accept = (who: User, token: string) =>
    request(platform.server).post('/api/v1/invitations/accept').set(who.auth).send({ token });

  it('lets only the verified, invited account join, once, with the invited role', async () => {
    const employeeEmail = uniqueEmail('employee');
    const sent = (await invite(employeeEmail).expect(201)).body as Invitation;
    expect(sent).toMatchObject({ email: employeeEmail, status: 'pending', acceptedAt: null, delivery: 'sent' });
    const token = tokenFor(employeeEmail);

    // Typing someone's address grants nothing: a different, verified account is refused.
    const stranger = await createUser(platform);
    expect(problemOf(await accept(stranger, token).expect(403)).code).toBe('invitation_email_mismatch');
    // The invited address, not yet verified, is refused until it is.
    const employee = await createUser(platform, employeeEmail, false);
    expect(problemOf(await accept(employee, token).expect(403)).code).toBe('email_not_verified');
    expect(problemOf(await accept(employee, 'x'.repeat(43)).expect(404)).code).toBe('invitation_invalid');
    await verifyEmail(platform, employeeEmail);
    const joined = await accept(employee, token).expect(200);
    expect(joined.body).toMatchObject({ organizationId: orgId, membership: { role: { key: 'member' } } });
    expect(problemOf(await accept(employee, token).expect(404)).code).toBe('invitation_invalid'); // spent

    const listed = (await invitations(platform, owner, orgId)).find((i) => i.id === sent.id)!;
    expect(listed).toMatchObject({ status: 'accepted', acceptedAt: expect.any(String) as unknown });

    // A member cannot invite, change roles, or remove the owner.
    const ownerMember = (
      (await request(platform.server).get(`${ORGS}/${orgId}/members`).set(employee.auth).expect(200)).body as {
        data: { id: string; userId: string }[];
      }
    ).data.find((m) => m.userId === owner.userId)!;
    await request(platform.server)
      .post(`${ORGS}/${orgId}/invitations`)
      .set(employee.auth)
      .send({ email: uniqueEmail(), roleId: roles.member })
      .expect(403);
    await request(platform.server)
      .patch(`${ORGS}/${orgId}/members/${ownerMember.id}`)
      .set(employee.auth)
      .send({ roleId: roles.member })
      .expect(403);
    await request(platform.server).delete(`${ORGS}/${orgId}/members/${ownerMember.id}`).set(employee.auth).expect(403);
  });

  it('refuses duplicates and existing members, and lets only owners invite owners', async () => {
    const email = uniqueEmail('dup');
    await invite(email).expect(201);
    expect(problemOf(await invite(email).expect(409)).code).toBe('invitation_pending');
    expect(problemOf(await invite(owner.email).expect(409)).code).toBe('already_member');

    // An admin may invite members and admins, never owners.
    const adminEmail = uniqueEmail('admin');
    await invite(adminEmail, 'admin').expect(201);
    const admin = await createUser(platform, adminEmail);
    await accept(admin, tokenFor(adminEmail)).expect(200);
    const asAdmin = await request(platform.server)
      .post(`${ORGS}/${orgId}/invitations`)
      .set(admin.auth)
      .send({ email: uniqueEmail(), roleId: roles.owner })
      .expect(403);
    expect(problemOf(asAdmin).code).toBe('owner_required');
  });

  it('lists every invitation with status=all, and renews an expired one unless a newer one is pending or the person joined', async () => {
    const expire = (id: string) =>
      query(
        adminUrl(),
        `update organization.organization_invitations set expires_at = now() - interval '1 minute' where id = $1`,
        [id],
      );

    // A lapsed invitation (still "pending", past its expiry) is shown as expired and can be resent.
    const lapsedEmail = uniqueEmail('lapsed');
    const lapsed = (await invite(lapsedEmail).expect(201)).body as Invitation;
    await expire(lapsed.id);
    expect((await invitations(platform, owner, orgId)).find((i) => i.id === lapsed.id)?.status).toBe('expired');
    const renewed = await request(platform.server)
      .post(`${ORGS}/${orgId}/invitations/${lapsed.id}/resend`)
      .set(owner.auth)
      .expect(200);
    expect(renewed.body).toMatchObject({ status: 'pending', delivery: 'sent' });

    // An invitation marked expired because a newer one replaced it: renewed only once that newer one is gone.
    const email = uniqueEmail('again');
    const old = (await invite(email).expect(201)).body as Invitation;
    const oldToken = tokenFor(email);
    await expire(old.id);
    const newer = (await invite(email).expect(201)).body as Invitation; // marks the old one expired
    const resendOld = () =>
      request(platform.server).post(`${ORGS}/${orgId}/invitations/${old.id}/resend`).set(owner.auth);
    expect(problemOf(await resendOld().expect(409)).code).toBe('invitation_pending');
    await request(platform.server).delete(`${ORGS}/${orgId}/invitations/${newer.id}`).set(owner.auth).expect(204);
    expect((await resendOld().expect(200)).body).toMatchObject({ id: old.id, status: 'pending' });
    const person = await createUser(platform, email);
    expect(problemOf(await accept(person, oldToken).expect(404)).code).toBe('invitation_invalid'); // the old link is dead
    await accept(person, tokenFor(email)).expect(200);

    // Revoked stays revoked; an expired invitation of someone who has joined since is not renewed.
    expect(
      problemOf(
        await request(platform.server)
          .post(`${ORGS}/${orgId}/invitations/${newer.id}/resend`)
          .set(owner.auth)
          .expect(409),
      ).code,
    ).toBe('invitation_not_pending');
    const joinedEmail = uniqueEmail('joined');
    const first = (await invite(joinedEmail).expect(201)).body as Invitation;
    await expire(first.id);
    await invite(joinedEmail).expect(201);
    const joiner = await createUser(platform, joinedEmail);
    await accept(joiner, tokenFor(joinedEmail)).expect(200);
    expect(
      problemOf(
        await request(platform.server)
          .post(`${ORGS}/${orgId}/invitations/${first.id}/resend`)
          .set(owner.auth)
          .expect(409),
      ).code,
    ).toBe('already_member');

    const statuses = new Set((await invitations(platform, owner, orgId)).map((i) => i.status));
    expect([...statuses].sort()).toEqual(['accepted', 'expired', 'pending', 'revoked']);
  });
});

describe('where each invitation email stands', () => {
  /** Fails while `down`, without the address or link in what it throws to the logs. */
  class FlakyNotifier implements InvitationNotifier {
    down = true;
    send(): Promise<void> {
      if (this.down)
        return Promise.reject(
          Object.assign(new Error('connection refused'), { name: 'EmailDeliveryError', category: 'network' }),
        );
      return Promise.resolve();
    }
  }
  /** Queues like SMTP; the test settles each message. */
  class QueueingNotifier implements InvitationNotifier {
    readonly delivery = 'background';
    readonly queued: { message: InvitationMessage; settle: (outcome: MailOutcome) => void }[] = [];
    send(message: InvitationMessage, onSettled?: (outcome: MailOutcome) => void): Promise<void> {
      this.queued.push({ message, settle: onSettled ?? (() => undefined) });
      return Promise.resolve();
    }
  }

  async function setUp(notifier: InvitationNotifier | ((logger: CapturingLogger) => InvitationNotifier)) {
    const platform = await startPlatform({
      env: { ORGANIZATION_CREATION: 'open' },
      notifier: typeof notifier === 'function' ? notifier : () => notifier,
    });
    const owner = await createUser(platform);
    const orgId = (
      (await create(platform, owner, { name: 'Mailers', slug: uniqueSlug('mail') }).expect(201)).body as {
        id: string;
      }
    ).id;
    const memberRole = (await roleIds(platform, owner, orgId)).member!;
    const invite = async (email: string) =>
      (
        await request(platform.server)
          .post(`${ORGS}/${orgId}/invitations`)
          .set(owner.auth)
          .send({ email, roleId: memberRole })
          .expect(201)
      ).body as Invitation;
    const resend = async (id: string) =>
      (await request(platform.server).post(`${ORGS}/${orgId}/invitations/${id}/resend`).set(owner.auth).expect(200))
        .body as Invitation;
    const deliveryOf = async (id: string) =>
      (await invitations(platform, owner, orgId)).find((i) => i.id === id)?.delivery;
    return { platform, invite, resend, deliveryOf };
  }

  it('reports a failed email, logs no address or token, and a resend once mail works says sent', async () => {
    const notifier = new FlakyNotifier();
    const { platform, invite, resend, deliveryOf } = await setUp(notifier);
    try {
      const email = uniqueEmail('flaky');
      const invitation = await invite(email);
      expect(invitation.delivery).toBe('failed');
      expect(await deliveryOf(invitation.id)).toBe('failed');
      expect(platform.logger.events('invitation_notification_failed')).toEqual([
        expect.objectContaining({ kind: 'organization_invitation', error: 'EmailDeliveryError:network' }),
      ]);
      expect(JSON.stringify(platform.logger.records)).not.toContain(email);

      notifier.down = false;
      expect((await resend(invitation.id)).delivery).toBe('sent');
      expect(await deliveryOf(invitation.id)).toBe('sent');
    } finally {
      await platform.close();
    }
  });

  it('shows a queued email until it settles, and ignores a late outcome for a link a resend replaced', async () => {
    const notifier = new QueueingNotifier();
    const { platform, invite, resend, deliveryOf } = await setUp(notifier);
    try {
      const invitation = await invite(uniqueEmail('queued'));
      expect(invitation.delivery).toBe('queued');
      notifier.queued[0]!.settle('sent');
      expect(await deliveryOf(invitation.id)).toBe('sent');

      expect((await resend(invitation.id)).delivery).toBe('queued');
      notifier.queued[0]!.settle('failed'); // the replaced link's message
      expect(await deliveryOf(invitation.id)).toBe('queued');
      notifier.queued[1]!.settle('failed');
      expect(await deliveryOf(invitation.id)).toBe('failed');
      // The token travels only in the message, never in logs.
      for (const { message } of notifier.queued)
        expect(JSON.stringify(platform.logger.records)).not.toContain(message.token);
    } finally {
      await platform.close();
    }
  });

  it('says so when email delivery is turned off, instead of claiming the email was sent', async () => {
    const { platform, invite, deliveryOf } = await setUp((logger) => new DisabledInvitationNotifier(logger));
    try {
      const invitation = await invite(uniqueEmail('dropped'));
      expect(invitation.delivery).toBe('disabled');
      expect(await deliveryOf(invitation.id)).toBe('disabled');
    } finally {
      await platform.close();
    }
  });
});
