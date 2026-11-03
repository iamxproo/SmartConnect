// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newOrganization, problemOf, startWorkspace, type TestWorkspace } from './support/workspace.js';

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await startWorkspace();
});
afterAll(async () => {
  await ws.close();
});

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((row) => row.id);

describe('creating workspaces', () => {
  it('makes the creator admin and creates the default public channel `general` with the creator as its admin', async () => {
    const { people } = newOrganization(ws);
    const owner = people.owner!;
    const res = await owner.post('/workspaces', {
      name: 'Engineering',
      slug: 'engineering',
      description: 'Builders',
      visibility: 'private',
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/orgs/${owner.orgId}/workspaces/${res.body.id}`);
    expect(res.body).toMatchObject({
      organizationId: owner.orgId,
      name: 'Engineering',
      slug: 'engineering',
      description: 'Builders',
      visibility: 'private',
      myRole: 'admin',
      archivedAt: null,
    });

    const channels = await owner.get(`/workspaces/${res.body.id}/channels`);
    expect(channels.body.data).toHaveLength(1);
    expect(channels.body.data[0]).toMatchObject({
      name: 'general',
      type: 'public',
      isDefault: true,
      isMember: true,
      myRole: 'admin',
    });
    const members = await owner.get(`/workspaces/${res.body.id}/members`);
    expect(members.body.data).toEqual([{ userId: owner.userId, role: 'admin', joinedAt: expect.any(String) }]);
  });

  it('requires the workspaces.create permission ("*" also qualifies)', async () => {
    const { add } = newOrganization(ws, []);
    const plain = add('plain');
    const star = add('star', ['*']);
    const other = add('other', ['teams.manage']);
    const body = { name: 'X', slug: 'x-team', visibility: 'open' };
    for (const person of [plain, other]) {
      const res = await person.post('/workspaces', body);
      expect(res.status).toBe(403);
      expect(problemOf(res).code).toBe('forbidden');
    }
    expect((await star.post('/workspaces', body)).status).toBe(201);
  });

  it('has no silent defaults: visibility is required, unknown fields and bad slugs are rejected', async () => {
    const { people } = newOrganization(ws);
    const owner = people.owner!;
    const missing = await owner.post('/workspaces', { name: 'X', slug: 'x' });
    expect(missing.status).toBe(422);
    expect(problemOf(missing).errors).toContainEqual(
      expect.objectContaining({ field: 'visibility', code: 'required' }),
    );
    expect((await owner.post('/workspaces', { name: 'X', slug: 'x', visibility: 'secret' })).status).toBe(422);
    expect((await owner.post('/workspaces', { name: 'X', slug: 'Bad Slug', visibility: 'open' })).status).toBe(422);
    expect((await owner.post('/workspaces', { name: '', slug: 'x', visibility: 'open' })).status).toBe(422);
    expect(
      (await owner.post('/workspaces', { name: 'X', slug: 'x', visibility: 'open', organizationId: owner.orgId }))
        .status,
    ).toBe(422);
    expect((await owner.get('/workspaces')).body.data).toEqual([]);
  });

  it('answers 409 slug_taken for a duplicate slug within the organization, but not across organizations', async () => {
    const a = newOrganization(ws).people.owner!;
    const b = newOrganization(ws).people.owner!;
    const body = { name: 'Dup', slug: 'same-slug', visibility: 'open' };
    expect((await a.post('/workspaces', body)).status).toBe(201);
    const dup = await a.post('/workspaces', body);
    expect(dup.status).toBe(409);
    expect(problemOf(dup).code).toBe('slug_taken');
    expect((await b.post('/workspaces', body)).status).toBe(201);
  });

  it('turns concurrent duplicate creates into one 201 and clean 409s', async () => {
    const owner = newOrganization(ws).people.owner!;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => owner.post('/workspaces', { name: 'Race', slug: 'race', visibility: 'open' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const others = results.filter((r) => r.status !== 201);
    expect(others).toHaveLength(7);
    for (const res of others) expect(problemOf(res).code).toBe('slug_taken');
    expect((await owner.get('/workspaces')).body.data).toHaveLength(1);
  });
});

describe('visibility', () => {
  it('lists open workspaces and the private ones the caller belongs to, and hides all other private ones', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const outsider = add('outsider');
    const open = await owner.createWorkspace({ visibility: 'open' });
    const secret = await owner.createWorkspace({ visibility: 'private' });

    expect(ids(await owner.get('/workspaces'))).toEqual([open.id, secret.id]);
    expect(ids(await outsider.get('/workspaces'))).toEqual([open.id]);
    const seen = (await outsider.get('/workspaces')).body.data[0];
    expect(seen.myRole).toBeNull();
  });

  it('answers 404 for a private workspace to non-members on every route (even though the id is valid)', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const outsider = add('outsider', ['*']); // powerful organization role, still no access
    const secret = await owner.createWorkspace({ visibility: 'private' });
    const base = `/workspaces/${secret.id}`;
    const channel = (await owner.get(`${base}/channels`)).body.data[0];

    const responses = [
      await outsider.get(base),
      await outsider.patch(base, { name: 'Mine now' }),
      await outsider.post(`${base}/join`),
      await outsider.post(`${base}/leave`),
      await outsider.get(`${base}/members`),
      await outsider.put(`${base}/members/${outsider.userId}`, { role: 'admin' }),
      await outsider.delete(`${base}/members/${owner.userId}`),
      await outsider.get(`${base}/channels`),
      await outsider.post(`${base}/channels`, { name: 'sneaky', type: 'public' }),
      await outsider.get(`${base}/channels/${channel.id}`),
      await outsider.post(`${base}/channels/${channel.id}/join`),
      await outsider.get(`${base}/channels/${channel.id}/members`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('not_found');
    }
    // the same answer as for an id that does not exist at all
    const nothing = await outsider.get('/workspaces/019a4a00-0000-7000-8000-00000000dead');
    expect(problemOf(nothing)).toMatchObject({ status: 404, code: 'not_found', title: problemOf(responses[0]!).title });
    expect((await owner.get(`${base}/members`)).body.data).toHaveLength(1);
  });

  it('treats malformed ids as 404', async () => {
    const { people } = newOrganization(ws);
    expect((await people.owner!.get('/workspaces/not-a-uuid')).status).toBe(404);
  });

  it('lets any organization member see an open workspace, but only members list its members', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const visitor = add('visitor');
    const open = await owner.createWorkspace({ visibility: 'open' });
    const res = await visitor.get(`/workspaces/${open.id}`);
    expect(res.status).toBe(200);
    expect(res.body.myRole).toBeNull();
    expect((await visitor.get(`/workspaces/${open.id}/members`)).status).toBe(403);
    // channels of an open workspace do not exist for non-members
    expect((await visitor.get(`/workspaces/${open.id}/channels`)).status).toBe(404);
  });

  it('paginates lists with an opaque cursor', async () => {
    const { people } = newOrganization(ws);
    const owner = people.owner!;
    const created = [];
    for (let i = 0; i < 3; i++) created.push((await owner.createWorkspace()).id);
    const first = await owner.get('/workspaces?limit=2');
    expect(ids(first)).toEqual(created.slice(0, 2));
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await owner.get(`/workspaces?limit=2&cursor=${first.body.nextCursor}`);
    expect(ids(second)).toEqual(created.slice(2));
    expect(second.body.nextCursor).toBeNull();
    expect((await owner.get('/workspaces?cursor=garbage')).status).toBe(422);
    expect((await owner.get('/workspaces?limit=1000')).status).toBe(422);
  });
});

describe('updating, joining and leaving', () => {
  it('lets only workspace admins update, and a private workspace disappears for non-members', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const other = add('other');
    const open = await owner.createWorkspace({ visibility: 'open', description: 'old' });
    await other.post(`/workspaces/${open.id}/join`);

    expect((await other.patch(`/workspaces/${open.id}`, { name: 'Hijack' })).status).toBe(403);
    const bystander = add('bystander');
    expect((await bystander.patch(`/workspaces/${open.id}`, { name: 'Hijack' })).status).toBe(403);

    const res = await owner.patch(`/workspaces/${open.id}`, {
      name: 'Renamed',
      description: null,
      visibility: 'private',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', description: null, visibility: 'private', myRole: 'admin' });
    expect((await bystander.get(`/workspaces/${open.id}`)).status).toBe(404);
    expect((await other.get(`/workspaces/${open.id}`)).status).toBe(200);
    expect((await owner.patch(`/workspaces/${open.id}`, { slug: 'new' })).status).toBe(422);
  });

  it('joins an open workspace together with its default channels, idempotently and race-free', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const joiner = add('joiner');
    const open = await owner.createWorkspace({ visibility: 'open' });
    const extraDefault = await owner.createChannel(open.id, { type: 'public' });
    const privateOne = await owner.createChannel(open.id, { type: 'private' });

    const results = await Promise.all(Array.from({ length: 5 }, () => joiner.post(`/workspaces/${open.id}/join`)));
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.myRole).toBe('member');
    }
    const channels = (await joiner.get(`/workspaces/${open.id}/channels`)).body.data as {
      id: string;
      name: string;
      isMember: boolean;
    }[];
    expect(channels.find((c) => c.name === 'general')!.isMember).toBe(true);
    expect(channels.find((c) => c.id === extraDefault.id)!.isMember).toBe(false); // only isDefault channels
    expect(channels.find((c) => c.id === privateOne.id)).toBeUndefined();
    const members = (await owner.get(`/workspaces/${open.id}/members`)).body.data as { userId: string }[];
    expect(members.filter((m) => m.userId === joiner.userId)).toHaveLength(1);

    // a member who left a default channel is not re-added by joining again
    const general = channels.find((c) => c.name === 'general')!;
    await joiner.post(`/workspaces/${open.id}/channels/${general.id}/leave`);
    await joiner.post(`/workspaces/${open.id}/join`);
    expect((await joiner.get(`/workspaces/${open.id}/channels/${general.id}`)).body.isMember).toBe(false);
  });

  it('lets a member leave (dropping channel memberships), and protects the last admin', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const member = add('member');
    const open = await owner.createWorkspace({ visibility: 'open' });
    await member.post(`/workspaces/${open.id}/join`);

    const lastAdmin = await owner.post(`/workspaces/${open.id}/leave`);
    expect(lastAdmin.status).toBe(409);
    expect(problemOf(lastAdmin).code).toBe('last_admin');

    expect((await member.post(`/workspaces/${open.id}/leave`)).status).toBe(204);
    expect((await member.get(`/workspaces/${open.id}`)).body.myRole).toBeNull();
    expect((await member.get(`/workspaces/${open.id}/channels`)).status).toBe(404);
    expect((await member.post(`/workspaces/${open.id}/leave`)).status).toBe(204); // idempotent

    await owner.put(`/workspaces/${open.id}/members/${member.userId}`, { role: 'admin' });
    expect((await owner.post(`/workspaces/${open.id}/leave`)).status).toBe(204);
  });

  it('never leaves a workspace without an admin when two admins leave at once', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const second = add('second');
    const open = await owner.createWorkspace({ visibility: 'open' });
    await owner.put(`/workspaces/${open.id}/members/${second.userId}`, { role: 'admin' });
    const results = await Promise.all([
      owner.post(`/workspaces/${open.id}/leave`),
      second.post(`/workspaces/${open.id}/leave`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
  });
});

describe('workspace members', () => {
  it('adds only organization members, only by workspace admins, and joins them to default channels', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const invitee = add('invitee');
    const member = add('member');
    const stranger = newOrganization(ws).people.owner!; // member of a DIFFERENT organization
    const secret = await owner.createWorkspace({ visibility: 'private' });
    const base = `/workspaces/${secret.id}/members`;

    const notInOrg = await owner.put(`${base}/${stranger.userId}`, { role: 'member' });
    expect(notInOrg.status).toBe(422);
    expect(problemOf(notInOrg).code).toBe('user_not_in_organization');
    expect((await owner.get(`${base}`)).body.data).toHaveLength(1);

    const added = await owner.put(`${base}/${invitee.userId}`, { role: 'member' });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ userId: invitee.userId, role: 'member' });
    expect((await invitee.get(`/workspaces/${secret.id}`)).status).toBe(200);
    const general = (await invitee.get(`/workspaces/${secret.id}/channels`)).body.data[0];
    expect(general).toMatchObject({ name: 'general', isMember: true, myRole: 'member' });

    // non-admins cannot add anyone, and a private workspace member cannot tell admin-only from missing
    expect((await invitee.put(`${base}/${member.userId}`, { role: 'member' })).status).toBe(403);
    expect((await member.put(`${base}/${member.userId}`, { role: 'admin' })).status).toBe(404);
    expect((await owner.put(`${base}/${member.userId}`, { role: 'owner' })).status).toBe(422);
    expect((await owner.put(`${base}/${member.userId}`, {})).status).toBe(422);
  });

  it('changes roles, protects the last admin from demotion and removal, and removes idempotently', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const other = add('other');
    const open = await owner.createWorkspace({ visibility: 'open' });
    const base = `/workspaces/${open.id}/members`;
    await other.post(`/workspaces/${open.id}/join`);

    const demote = await owner.put(`${base}/${owner.userId}`, { role: 'member' });
    expect(demote.status).toBe(409);
    expect(problemOf(demote).code).toBe('last_admin');
    const removeSelf = await owner.delete(`${base}/${owner.userId}`);
    expect(removeSelf.status).toBe(409);
    expect(problemOf(removeSelf).code).toBe('last_admin');

    expect((await owner.put(`${base}/${other.userId}`, { role: 'guest' })).body.role).toBe('guest');
    expect((await other.delete(`${base}/${owner.userId}`)).status).toBe(403);
    expect((await owner.put(`${base}/${other.userId}`, { role: 'admin' })).body.role).toBe('admin');
    expect((await owner.put(`${base}/${owner.userId}`, { role: 'member' })).status).toBe(200);
    expect((await other.delete(`${base}/${owner.userId}`)).status).toBe(204);
    expect((await other.delete(`${base}/${owner.userId}`)).status).toBe(204); // idempotent
    expect((await other.delete(`${base}/${other.userId}`)).status).toBe(409); // now the last admin
  });

  it('paginates the member list with a keyset cursor', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const open = await owner.createWorkspace({ visibility: 'open' });
    for (const name of ['a', 'b']) await add(name).post(`/workspaces/${open.id}/join`);
    const first = await owner.get(`/workspaces/${open.id}/members?limit=2`);
    expect(first.body.data).toHaveLength(2);
    const second = await owner.get(`/workspaces/${open.id}/members?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.data, ...second.body.data].map((m: { userId: string }) => m.userId);
    expect(new Set(all).size).toBe(3);
  });
});

describe('searching workspaces (q)', () => {
  it('matches names within what the caller can already see, case-insensitively and with literal wildcards', async () => {
    const { people, add } = newOrganization(ws);
    const owner = people.owner!;
    const member = add('member');
    const open = await owner.createWorkspace({ name: 'Marketing_Team', visibility: 'open' });
    await owner.createWorkspace({ name: 'MarketingXTeam', visibility: 'open' });
    const secret = await owner.createWorkspace({ name: 'Marketing Secret', visibility: 'private' });
    const names = async (who: typeof owner, q: string) =>
      ((await who.get(`/workspaces?q=${encodeURIComponent(q)}`)).body.data as { name: string }[])
        .map((w) => w.name)
        .sort();

    expect(await names(member, 'marketing')).toEqual(['MarketingXTeam', 'Marketing_Team']);
    expect(await names(owner, 'MARKETING')).toEqual(['Marketing Secret', 'MarketingXTeam', 'Marketing_Team']);
    expect(await names(member, 'secret')).toEqual([]); // private workspace: absent, not "forbidden"
    expect(await names(member, 'g_t')).toEqual(['Marketing_Team']); // `_` is not a wildcard
    expect(await names(member, 'ng_Te')).toEqual(['Marketing_Team']);
    expect(await names(member, '%')).toEqual([]);
    expect(await names(member, '\\')).toEqual([]);

    await owner.put(`/workspaces/${secret.id}/members/${member.userId}`, { role: 'member' });
    expect(await names(member, 'secret')).toEqual(['Marketing Secret']);

    // combines with the cursor
    const first = await owner.get('/workspaces?q=marketing&limit=2');
    expect(first.body.data).toHaveLength(2);
    const second = await owner.get(`/workspaces?q=marketing&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(open.id).toBeDefined();

    expect((await owner.get('/workspaces?q=')).status).toBe(422);
    expect((await owner.get(`/workspaces?q=${'x'.repeat(101)}`)).status).toBe(422);
  });
});
