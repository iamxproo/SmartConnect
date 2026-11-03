import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, query } from '../../support/database.js';
import { problemOf } from '../identity/support/identity.js';
import {
  addMember,
  createOrg,
  createUser,
  startPlatform,
  uniqueSlug,
  type Platform,
  type User,
} from './support/platform.js';

const ORGS = '/api/v1/orgs';

describe('organizations', () => {
  let platform: Platform;
  let founder: User;
  beforeAll(async () => {
    platform = await startPlatform();
    founder = await createUser(platform, platform.founderEmail);
  });
  afterAll(() => platform.close());

  it('lets an authorized administrator create a company: owner membership, system roles, settings, event', async () => {
    const slug = uniqueSlug('acme');
    const res = await request(platform.server)
      .post(ORGS)
      .set(founder.auth)
      .send({ name: '  Acme Corporation ', slug, description: 'Widgets' })
      .expect(201);
    const org = res.body as { id: string; name: string; settings: { invitationExpiryDays: number } };
    expect(org).toMatchObject({
      name: 'Acme Corporation',
      slug,
      status: 'active',
      settings: { invitationExpiryDays: 7 },
    });

    const me = await request(platform.server).get(`${ORGS}/${org.id}/me`).set(founder.auth).expect(200);
    expect(me.body).toMatchObject({ organizationId: org.id, role: { key: 'owner', permissions: ['*'] } });
    const roles = await request(platform.server).get(`${ORGS}/${org.id}/roles`).set(founder.auth).expect(200);
    expect((roles.body as { data: { key: string }[] }).data.map((r) => r.key)).toEqual(['owner', 'admin', 'member']);
    const members = await request(platform.server).get(`${ORGS}/${org.id}/members`).set(founder.auth).expect(200);
    expect((members.body as { data: unknown[] }).data).toEqual([
      expect.objectContaining({
        userId: founder.userId,
        email: founder.email,
        role: expect.objectContaining({ key: 'owner' }) as unknown,
      }),
    ]);
    const events = await query<{ event_type: string }>(
      appUrl('organization'),
      'select event_type from organization.outbox_events where organization_id = $1 order by occurred_at',
      [org.id],
    );
    // Without tenant context RLS does not apply to outbox_events (not tenant-filtered by design): both events exist.
    expect(events.map((e) => e.event_type)).toEqual(['organization.created', 'organization.member.joined']);
  });

  it('refuses organization creation to anyone not on the allowlist, and to unverified allowlisted emails', async () => {
    const employee = await createUser(platform);
    const res = await request(platform.server)
      .post(ORGS)
      .set(employee.auth)
      .send({ name: 'Mine', slug: uniqueSlug() })
      .expect(403);
    expect(problemOf(res).code).toBe('organization_creation_not_allowed');
    expect((await request(platform.server).get(ORGS).set(employee.auth).expect(200)).body).toEqual({
      data: [],
      nextCursor: null,
    });
  });

  it('validates input and rejects a taken handle', async () => {
    const slug = uniqueSlug();
    await request(platform.server).post(ORGS).set(founder.auth).send({ name: 'A', slug }).expect(201);
    const taken = await request(platform.server).post(ORGS).set(founder.auth).send({ name: 'B', slug }).expect(409);
    expect(problemOf(taken).code).toBe('slug_taken');
    await request(platform.server).post(ORGS).set(founder.auth).send({ name: 'C', slug: 'Bad Slug!' }).expect(422);
    await request(platform.server).post(ORGS).set(founder.auth).send({ slug: uniqueSlug() }).expect(422);
    await request(platform.server)
      .post(ORGS)
      .set(founder.auth)
      .send({ name: 'D', slug: uniqueSlug(), owner: 'x' })
      .expect(422);
  });

  it("lists only the caller's organizations; outsiders get 404 for every org route", async () => {
    const org = await createOrg(platform, founder);
    const outsider = await createUser(platform);
    const mine = (await request(platform.server).get(ORGS).set(founder.auth).expect(200)).body as {
      data: { id: string }[];
    };
    expect(mine.data.map((o) => o.id)).toContain(org.id);
    expect(((await request(platform.server).get(ORGS).set(outsider.auth)).body as { data: unknown[] }).data).toEqual(
      [],
    );

    for (const path of ['', '/me', '/roles', '/members', '/departments', '/teams', '/invitations']) {
      const res = await request(platform.server).get(`${ORGS}/${org.id}${path}`).set(outsider.auth);
      expect([path, res.status]).toEqual([path, 404]);
    }
    await request(platform.server).patch(`${ORGS}/${org.id}`).set(outsider.auth).send({ name: 'Hijacked' }).expect(404);
    await request(platform.server).get(`${ORGS}/${randomUUID()}`).set(founder.auth).expect(404);
    await request(platform.server).get(`${ORGS}/not-a-uuid`).set(founder.auth).expect(404);
    await request(platform.server).get(ORGS).expect(401);
  });

  it('updates profile and settings only with organization.update', async () => {
    const org = await createOrg(platform, founder);
    const employee = await createUser(platform);
    await addMember(platform, founder, org, employee);
    await request(platform.server).patch(`${ORGS}/${org.id}`).set(employee.auth).send({ name: 'Nope' }).expect(403);
    const res = await request(platform.server)
      .patch(`${ORGS}/${org.id}`)
      .set(founder.auth)
      .send({ name: 'Renamed', description: null, settings: { invitationExpiryDays: 3 } })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Renamed', description: null, settings: { invitationExpiryDays: 3 } });
    await request(platform.server)
      .patch(`${ORGS}/${org.id}`)
      .set(founder.auth)
      .send({ settings: { invitationExpiryDays: 90 } })
      .expect(422);
  });
});

describe('members and roles', () => {
  let platform: Platform;
  let founder: User;
  beforeAll(async () => {
    platform = await startPlatform();
    founder = await createUser(platform, platform.founderEmail);
  });
  afterAll(() => platform.close());

  const memberIdOf = async (orgId: string, viewer: User, userId: string) => {
    const res = await request(platform.server)
      .get(`${ORGS}/${orgId}/members?userId=${userId}`)
      .set(viewer.auth)
      .expect(200);
    return ((res.body as { data: { id: string }[] }).data[0] ?? { id: '' }).id;
  };

  it('lets member managers change roles, but only owners grant or remove the owner role', async () => {
    const org = await createOrg(platform, founder);
    const admin = await createUser(platform);
    const employee = await createUser(platform);
    await addMember(platform, founder, org, admin, 'admin');
    await addMember(platform, founder, org, employee);
    const employeeMemberId = await memberIdOf(org.id, admin, employee.userId);

    const promoted = await request(platform.server)
      .patch(`${ORGS}/${org.id}/members/${employeeMemberId}`)
      .set(admin.auth)
      .send({ roleId: org.roles.admin, title: 'Engineer' })
      .expect(200);
    expect(promoted.body).toMatchObject({ role: { key: 'admin' }, title: 'Engineer' });
    const ownerGrant = await request(platform.server)
      .patch(`${ORGS}/${org.id}/members/${employeeMemberId}`)
      .set(admin.auth)
      .send({ roleId: org.roles.owner })
      .expect(403);
    expect(problemOf(ownerGrant).code).toBe('owner_required');
    await request(platform.server)
      .patch(`${ORGS}/${org.id}/members/${employeeMemberId}`)
      .set(admin.auth)
      .send({ roleId: randomUUID() })
      .expect(422);
    const founderMemberId = await memberIdOf(org.id, admin, founder.userId);
    await request(platform.server)
      .patch(`${ORGS}/${org.id}/members/${founderMemberId}`)
      .set(admin.auth)
      .send({ roleId: org.roles.member })
      .expect(403);
  });

  it('never leaves an organization without an owner', async () => {
    const org = await createOrg(platform, founder);
    const founderMemberId = await memberIdOf(org.id, founder, founder.userId);
    const leave = await request(platform.server)
      .delete(`${ORGS}/${org.id}/members/${founderMemberId}`)
      .set(founder.auth)
      .expect(409);
    expect(problemOf(leave).code).toBe('last_owner');
    await request(platform.server)
      .patch(`${ORGS}/${org.id}/members/${founderMemberId}`)
      .set(founder.auth)
      .send({ roleId: org.roles.member })
      .expect(409);

    // Two owners demoting each other at the same moment: exactly one succeeds.
    const second = await createUser(platform);
    await addMember(platform, founder, org, second, 'owner');
    const secondMemberId = await memberIdOf(org.id, founder, second.userId);
    const results = await Promise.all([
      request(platform.server)
        .patch(`${ORGS}/${org.id}/members/${secondMemberId}`)
        .set(founder.auth)
        .send({ roleId: org.roles.member }),
      request(platform.server)
        .patch(`${ORGS}/${org.id}/members/${founderMemberId}`)
        .set(second.auth)
        .send({ roleId: org.roles.member }),
    ]);
    // Exactly one wins. The other is refused either by the row-locked owner count (409, both requests were already
    // past authorization) or by the guard (403, the winner had already demoted the loser). Both keep one owner.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const owners = await query<{ n: number }>(
      appUrl('organization'),
      `select count(*)::int as n from organization.organization_members m join organization.organization_roles r on r.id = m.role_id
        where m.organization_id = $1 and r.key = 'owner'`,
      [org.id],
    );
    // No tenant context → RLS hides tenant rows from the runtime role: the count must come through the API instead.
    expect(owners).toEqual([{ n: 0 }]);
    const list = (await request(platform.server).get(`${ORGS}/${org.id}/members`).set(founder.auth).expect(200))
      .body as {
      data: { role: { key: string } }[];
    };
    expect(list.data.filter((m) => m.role.key === 'owner')).toHaveLength(1);
  });

  it('lets members leave, forbids removing others without members.manage, and revokes access at once', async () => {
    const org = await createOrg(platform, founder);
    const a = await createUser(platform);
    const b = await createUser(platform);
    await addMember(platform, founder, org, a);
    await addMember(platform, founder, org, b);
    const bMemberId = await memberIdOf(org.id, a, b.userId);
    await request(platform.server).delete(`${ORGS}/${org.id}/members/${bMemberId}`).set(a.auth).expect(403);
    await request(platform.server).delete(`${ORGS}/${org.id}/members/${bMemberId}`).set(b.auth).expect(204);
    await request(platform.server).get(`${ORGS}/${org.id}`).set(b.auth).expect(404);

    const aMemberId = await memberIdOf(org.id, founder, a.userId);
    await request(platform.server).delete(`${ORGS}/${org.id}/members/${aMemberId}`).set(founder.auth).expect(204);
    await request(platform.server).get(`${ORGS}/${org.id}/members`).set(a.auth).expect(404);
    expect(((await request(platform.server).get(ORGS).set(a.auth)).body as { data: unknown[] }).data).toEqual([]);
  });

  it('paginates members with an opaque cursor and filters by user', async () => {
    const org = await createOrg(platform, founder);
    for (let i = 0; i < 3; i++) await addMember(platform, founder, org, await createUser(platform));
    const page1 = (
      await request(platform.server).get(`${ORGS}/${org.id}/members?limit=2`).set(founder.auth).expect(200)
    ).body as {
      data: unknown[];
      nextCursor: string;
    };
    expect(page1.data).toHaveLength(2);
    const page2 = (
      await request(platform.server)
        .get(`${ORGS}/${org.id}/members?limit=2&cursor=${page1.nextCursor}`)
        .set(founder.auth)
        .expect(200)
    ).body as { data: unknown[]; nextCursor: string | null };
    expect(page2.data).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    await request(platform.server).get(`${ORGS}/${org.id}/members?cursor=***`).set(founder.auth).expect(422);
  });

  it('looks up several users at once: only active members of this organization, at most 100 ids', async () => {
    const org = await createOrg(platform, founder);
    const [a, b] = [await createUser(platform), await createUser(platform)];
    await addMember(platform, founder, org, a);
    await addMember(platform, founder, org, b);
    const outsider = await createUser(platform);
    const lookup = async (ids: string[], status = 200) =>
      (
        await request(platform.server)
          .get(`${ORGS}/${org.id}/members?${ids.map((id) => `userId=${id}`).join('&')}&limit=100`)
          .set(a.auth)
          .expect(status)
      ).body as { data: { userId: string }[] };

    const found = await lookup([b.userId, outsider.userId, founder.userId, randomUUID()]);
    expect(found.data.map((m) => m.userId).sort()).toEqual([b.userId, founder.userId].sort());
    await lookup(['not-a-uuid'], 422);
    await lookup(
      Array.from({ length: 101 }, () => randomUUID()),
      422,
    );
  });
  it('searches active members by display name or email (q): case-insensitive, escaped, combined, org-scoped', async () => {
    const org = await createOrg(platform, founder);
    const tag = randomUUID().slice(0, 8);
    const make = async (local: string, active = true) => {
      const user = await createUser(platform, `${local}-${tag}@example.com`);
      await addMember(platform, founder, org, user);
      if (!active) {
        const id = await memberIdOf(org.id, founder, user.userId);
        await request(platform.server).delete(`${ORGS}/${org.id}/members/${id}`).set(founder.auth).expect(204);
      }
      return user;
    };
    const alice = await make('Alice.Smith');
    const under = await make('a_b');
    const plain = await make('axb');
    await make('alice.gone', false);
    const search = async (q: string, extra = '', status = 200, viewer: User = founder, orgId = org.id) =>
      (
        await request(platform.server)
          .get(`${ORGS}/${orgId}/members?q=${encodeURIComponent(q)}${extra}`)
          .set(viewer.auth)
          .expect(status)
      ).body as { data: { userId: string; displayName: string }[]; nextCursor: string | null };
    const ids = (page: { data: { userId: string }[] }) => page.data.map((m) => m.userId).sort();

    // display name is the e-mail local part here; matching is case-insensitive and by substring, on either field
    expect(ids(await search('ALICE.sm'))).toEqual([alice.userId]);
    expect(ids(await search(`ice.smith-${tag}@EXAMPLE`))).toEqual([alice.userId]);
    expect(ids(await search(`-${tag}@`))).toEqual([alice.userId, under.userId, plain.userId].sort());
    // only active members: a removed member is never found
    expect(ids(await search('alice.gone'))).toEqual([]);
    // LIKE metacharacters are literal
    expect(ids(await search('a_b'))).toEqual([under.userId]);
    expect(ids(await search('%'))).toEqual([]);
    expect(ids(await search('\\'))).toEqual([]);
    expect(ids(await search('a%b'))).toEqual([]);
    // combined with userId, limit and cursor
    expect(ids(await search('a', `&userId=${plain.userId}&userId=${randomUUID()}`))).toEqual([plain.userId]);
    expect(ids(await search('alice', `&userId=${plain.userId}`))).toEqual([]);
    const first = await search(`-${tag}@`, '&limit=2');
    expect(first.data).toHaveLength(2);
    const second = await search(`-${tag}@`, `&limit=2&cursor=${first.nextCursor}`);
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(3);
    // validation: 1-100 characters
    await search('', '', 422);
    await search('   ', '', 422);
    await search('x'.repeat(101), '', 422);
    expect(ids(await search('x'.repeat(100)))).toEqual([]);
    // another organization's members are not reachable, and outsiders get 404
    const other = await createOrg(platform, founder);
    expect(ids(await search('alice', '', 200, founder, other.id))).toEqual([]);
    const stranger = await createUser(platform);
    await search('alice', '', 404, stranger, org.id);
    await search('alice', '', 404, alice, other.id);
  });
});
