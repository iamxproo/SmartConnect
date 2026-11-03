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
  type Org,
  type Platform,
  type User,
} from './support/platform.js';

interface Team {
  id: string;
  visibility: string;
  myRole: string | null;
  memberCount: number;
}

describe('departments and teams', () => {
  let platform: Platform;
  let founder: User;
  let admin: User;
  let alice: User;
  let bob: User;
  let org: Org;
  let base: string;
  beforeAll(async () => {
    platform = await startPlatform();
    founder = await createUser(platform, platform.founderEmail);
    org = await createOrg(platform, founder);
    base = `/api/v1/orgs/${org.id}`;
    admin = await createUser(platform);
    alice = await createUser(platform);
    bob = await createUser(platform);
    await addMember(platform, founder, org, admin, 'admin');
    await addMember(platform, founder, org, alice);
    await addMember(platform, founder, org, bob);
  });
  afterAll(() => platform.close());

  it('departments: every member reads, only departments.manage writes; nesting without cycles', async () => {
    const eng = await request(platform.server)
      .post(`${base}/departments`)
      .set(admin.auth)
      .send({ name: 'Engineering' })
      .expect(201);
    const engId = (eng.body as { id: string }).id;
    const platformDept = await request(platform.server)
      .post(`${base}/departments`)
      .set(admin.auth)
      .send({ name: 'Platform', parentId: engId })
      .expect(201);
    const platformId = (platformDept.body as { id: string }).id;
    await request(platform.server).post(`${base}/departments`).set(alice.auth).send({ name: 'Rogue' }).expect(403);
    const list = (await request(platform.server).get(`${base}/departments`).set(alice.auth).expect(200)).body as {
      data: { name: string; parentId: string | null }[];
    };
    expect(list.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Engineering', parentId: null }),
        expect.objectContaining({ name: 'Platform', parentId: engId }),
      ]),
    );
    const cycle = await request(platform.server)
      .patch(`${base}/departments/${engId}`)
      .set(admin.auth)
      .send({ parentId: platformId })
      .expect(422);
    expect(problemOf(cycle).errors).toContainEqual(
      expect.objectContaining({ field: 'parentId', code: 'department_cycle' }),
    );
    await request(platform.server)
      .patch(`${base}/departments/${engId}`)
      .set(admin.auth)
      .send({ parentId: engId })
      .expect(422);
    const dup = await request(platform.server)
      .post(`${base}/departments`)
      .set(admin.auth)
      .send({ name: 'Engineering' })
      .expect(409);
    expect(problemOf(dup).code).toBe('department_name_taken');
    const notEmpty = await request(platform.server).delete(`${base}/departments/${engId}`).set(admin.auth).expect(409);
    expect(problemOf(notEmpty).code).toBe('department_not_empty');
    await request(platform.server).delete(`${base}/departments/${platformId}`).set(admin.auth).expect(204);
    await request(platform.server).delete(`${base}/departments/${randomUUID()}`).set(admin.auth).expect(404);
  });

  async function createTeam(visibility: 'public' | 'private', name = `team-${randomUUID().slice(0, 8)}`) {
    const res = await request(platform.server)
      .post(`${base}/teams`)
      .set(admin.auth)
      .send({ name, visibility })
      .expect(201);
    return (res.body as Team).id;
  }

  it('private teams are invisible (404) to everyone but their members, owners and team managers included', async () => {
    const secret = await createTeam('private');
    const open = await createTeam('public');
    await request(platform.server)
      .put(`${base}/teams/${secret}/members/${alice.userId}`)
      .set(admin.auth)
      .send({ role: 'member' })
      .expect(200);

    const bobsView = (await request(platform.server).get(`${base}/teams`).set(bob.auth).expect(200)).body as {
      data: Team[];
    };
    expect(bobsView.data.map((t) => t.id)).toContain(open);
    expect(bobsView.data.map((t) => t.id)).not.toContain(secret);
    for (const path of ['', '/members']) {
      await request(platform.server).get(`${base}/teams/${secret}${path}`).set(bob.auth).expect(404);
    }
    await request(platform.server)
      .put(`${base}/teams/${secret}/members/${bob.userId}`)
      .set(bob.auth)
      .send({ role: 'member' })
      .expect(404);
    await request(platform.server).delete(`${base}/teams/${secret}/members/${alice.userId}`).set(bob.auth).expect(404);

    const alicesView = (await request(platform.server).get(`${base}/teams`).set(alice.auth).expect(200)).body as {
      data: Team[];
    };
    expect(alicesView.data.find((t) => t.id === secret)).toMatchObject({
      visibility: 'private',
      myRole: 'member',
      memberCount: 2, // the creator leads the team
    });
    const members = await request(platform.server).get(`${base}/teams/${secret}/members`).set(alice.auth).expect(200);
    expect((members.body as { data: unknown[] }).data).toEqual([
      expect.objectContaining({ userId: admin.userId, role: 'lead' }),
      expect.objectContaining({ userId: alice.userId, email: alice.email, role: 'member' }),
    ]);
    const adminsView = (await request(platform.server).get(`${base}/teams`).set(admin.auth).expect(200)).body as {
      data: Team[];
    };
    expect(adminsView.data.find((t) => t.id === secret)).toMatchObject({ myRole: 'lead' });

    // Management rights do not open private teams: the owner (`*`) is not a member of this one.
    const ownersView = (await request(platform.server).get(`${base}/teams`).set(founder.auth).expect(200)).body as {
      data: Team[];
    };
    expect(ownersView.data.map((t) => t.id)).not.toContain(secret);
    for (const path of ['', '/members']) {
      await request(platform.server).get(`${base}/teams/${secret}${path}`).set(founder.auth).expect(404);
    }
    await request(platform.server)
      .put(`${base}/teams/${secret}/members/${founder.userId}`)
      .set(founder.auth)
      .send({ role: 'lead' })
      .expect(404);
    await request(platform.server)
      .patch(`${base}/teams/${secret}`)
      .set(founder.auth)
      .send({ visibility: 'public' })
      .expect(404);
    await request(platform.server).delete(`${base}/teams/${secret}`).set(founder.auth).expect(404);
  });

  it('team leads manage plain members but cannot appoint or remove leads; only managers create teams', async () => {
    const team = await createTeam('private');
    await request(platform.server)
      .put(`${base}/teams/${team}/members/${alice.userId}`)
      .set(admin.auth)
      .send({ role: 'lead' })
      .expect(200);
    await request(platform.server)
      .put(`${base}/teams/${team}/members/${bob.userId}`)
      .set(alice.auth)
      .send({ role: 'member' })
      .expect(200);
    await request(platform.server)
      .put(`${base}/teams/${team}/members/${bob.userId}`)
      .set(alice.auth)
      .send({ role: 'lead' })
      .expect(403);
    await request(platform.server)
      .put(`${base}/teams/${team}/members/${admin.userId}`)
      .set(bob.auth)
      .send({ role: 'member' })
      .expect(403);
    await request(platform.server).delete(`${base}/teams/${team}/members/${alice.userId}`).set(bob.auth).expect(403);
    await request(platform.server).delete(`${base}/teams/${team}/members/${bob.userId}`).set(alice.auth).expect(204);
    await request(platform.server)
      .post(`${base}/teams`)
      .set(alice.auth)
      .send({ name: 'x', visibility: 'public' })
      .expect(403);
    await request(platform.server).post(`${base}/teams`).set(admin.auth).send({ name: 'no-visibility' }).expect(422);
  });

  it('only organization members can join teams; leaving the organization removes team memberships', async () => {
    const team = await createTeam('public');
    const outsider = await createUser(platform);
    const notMember = await request(platform.server)
      .put(`${base}/teams/${team}/members/${outsider.userId}`)
      .set(admin.auth)
      .send({ role: 'member' })
      .expect(422);
    expect(problemOf(notMember).errors).toContainEqual(expect.objectContaining({ code: 'user_not_in_organization' }));

    const leaver = await createUser(platform);
    await addMember(platform, founder, org, leaver);
    await request(platform.server)
      .put(`${base}/teams/${team}/members/${leaver.userId}`)
      .set(admin.auth)
      .send({ role: 'member' })
      .expect(200);
    const memberId = (
      (await request(platform.server).get(`${base}/members?userId=${leaver.userId}`).set(admin.auth)).body as {
        data: { id: string }[];
      }
    ).data[0]!.id;
    await request(platform.server).delete(`${base}/members/${memberId}`).set(leaver.auth).expect(204);
    const members = (await request(platform.server).get(`${base}/teams/${team}/members`).set(admin.auth).expect(200))
      .body as {
      data: { userId: string }[];
    };
    expect(members.data.map((m) => m.userId)).not.toContain(leaver.userId);
  });

  it("keeps organizations apart: another organization's team and department ids resolve to nothing", async () => {
    const otherOrg = await createOrg(platform, founder);
    const otherTeam = (
      await request(platform.server)
        .post(`/api/v1/orgs/${otherOrg.id}/teams`)
        .set(founder.auth)
        .send({ name: 'other', visibility: 'public' })
        .expect(201)
    ).body as Team;
    // admin of `org` asks for the other organization's team under their own organization's path.
    await request(platform.server).get(`${base}/teams/${otherTeam.id}`).set(admin.auth).expect(404);
    await request(platform.server)
      .patch(`${base}/teams/${otherTeam.id}`)
      .set(admin.auth)
      .send({ name: 'pwned' })
      .expect(404);
    await request(platform.server).delete(`${base}/teams/${otherTeam.id}`).set(admin.auth).expect(404);
    await request(platform.server).get(`/api/v1/orgs/${otherOrg.id}/teams/${otherTeam.id}`).set(admin.auth).expect(404);
  });

  it('the new tables are protected by row-level security (no tenant context → no rows)', async () => {
    const rls = await query<{ relname: string; relrowsecurity: boolean }>(
      appUrl('organization'),
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'organization' and c.relname in ('departments', 'teams', 'team_members') order by c.relname`,
    );
    expect(rls).toEqual([
      { relname: 'departments', relrowsecurity: true },
      { relname: 'team_members', relrowsecurity: true },
      { relname: 'teams', relrowsecurity: true },
    ]);
    for (const table of ['departments', 'teams', 'team_members']) {
      expect(await query(appUrl('organization'), `select id from organization.${table} limit 1`)).toEqual([]);
    }
  });
});
