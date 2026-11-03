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

const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((c) => c.name).sort();

/** An open workspace with an admin ("owner"), a plain member ("member") and a second member ("peer"). */
async function setup() {
  const org = newOrganization(ws);
  const owner = org.people.owner!;
  const member = org.add('member');
  const peer = org.add('peer');
  const workspace = await owner.createWorkspace({ visibility: 'open' });
  await member.post(`/workspaces/${workspace.id}/join`);
  await peer.post(`/workspaces/${workspace.id}/join`);
  const base = `/workspaces/${workspace.id}/channels`;
  return { ...org, owner, member, peer, workspace, base };
}

describe('creating channels', () => {
  it('makes the creator channel admin and requires an explicit type', async () => {
    const { member, base } = await setup();
    const res = await member.post(base, { name: 'Random-Chat', topic: 'fun', description: 'd', type: 'public' });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/orgs/${member.orgId}${base}/${res.body.id}`);
    expect(res.body).toMatchObject({
      name: 'random-chat', // lowercased
      topic: 'fun',
      description: 'd',
      type: 'public',
      isDefault: false,
      isMember: true,
      myRole: 'admin',
      archivedAt: null,
    });

    const noType = await member.post(base, { name: 'no-type' });
    expect(noType.status).toBe(422);
    expect(problemOf(noType).errors).toContainEqual(expect.objectContaining({ field: 'type', code: 'required' }));
    expect((await member.post(base, { name: 'bad name!', type: 'public' })).status).toBe(422);
    expect((await member.post(base, { name: 'x', type: 'public', isDefault: true })).status).toBe(422);
  });

  it('answers 409 channel_name_taken, also for private duplicates and concurrent creates', async () => {
    const { owner, member, base } = await setup();
    expect((await owner.post(base, { name: 'dup', type: 'private' })).status).toBe(201);
    const dup = await member.post(base, { name: 'DUP', type: 'public' });
    expect(dup.status).toBe(409);
    expect(problemOf(dup).code).toBe('channel_name_taken');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => member.post(base, { name: 'race', type: 'public' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const res of results.filter((r) => r.status !== 201)) expect(problemOf(res).code).toBe('channel_name_taken');
  });

  it('lets only workspace members create channels', async () => {
    const { add, base, workspace } = await setup();
    const outsider = add('outsider');
    expect((await outsider.post(base, { name: 'x', type: 'public' })).status).toBe(404);
    expect((await outsider.get(`/workspaces/${workspace.id}/channels`)).status).toBe(404);
  });
});

describe('private channel secrecy', () => {
  it('is invisible to workspace members who are not in it, including workspace admins, on every route', async () => {
    const { member, peer, owner, base } = await setup();
    const secret = (await member.post(base, { name: 'secret', type: 'private' })).body as { id: string };
    await member.put(`${base}/${secret.id}/members/${peer.userId}`, {});
    const ch = `${base}/${secret.id}`;

    // owner is workspace admin (and general's admin) but not in `secret`
    expect(names(await owner.get(base))).toEqual(['general']);
    expect(names(await member.get(base))).toEqual(['general', 'secret']);
    expect(names(await peer.get(base))).toEqual(['general', 'secret']);

    const responses = [
      await owner.get(ch),
      await owner.post(`${ch}/join`),
      await owner.post(`${ch}/leave`),
      await owner.get(`${ch}/members`),
      await owner.put(`${ch}/members/${owner.userId}`, { role: 'admin' }),
      await owner.put(`${ch}/members/${peer.userId}`, { role: 'admin' }),
      await owner.delete(`${ch}/members/${peer.userId}`),
      await owner.delete(`${ch}/members/${member.userId}`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('not_found');
    }
    // nothing changed
    expect((await member.get(`${ch}/members`)).body.data).toHaveLength(2);
  });

  it('does not reveal a private channel by guessing its id under another workspace or organization', async () => {
    const { member, base, owner, workspace } = await setup();
    const secret = (await member.post(base, { name: 'hidden', type: 'private' })).body as { id: string };
    const otherWorkspace = await owner.createWorkspace({ visibility: 'open' });
    const wrongWorkspace = await owner.get(`/workspaces/${otherWorkspace.id}/channels/${secret.id}`);
    expect(wrongWorkspace.status).toBe(404);

    const foreignOrg = newOrganization(ws).people.owner!;
    const foreignWorkspace = await foreignOrg.createWorkspace();
    expect((await foreignOrg.get(`/workspaces/${foreignWorkspace.id}/channels/${secret.id}`)).status).toBe(404);
    expect((await foreignOrg.get(`/workspaces/${workspace.id}/channels/${secret.id}`)).status).toBe(404);
  });
});

describe('joining and leaving channels', () => {
  it('joins public channels idempotently and leaves them', async () => {
    const { owner, member, peer, base } = await setup();
    const pub = (await owner.post(base, { name: 'lounge', type: 'public' })).body as { id: string };
    expect((await member.get(`${base}/${pub.id}`)).body).toMatchObject({ isMember: false, myRole: null });
    const joins = await Promise.all([member.post(`${base}/${pub.id}/join`), member.post(`${base}/${pub.id}/join`)]);
    for (const res of joins) expect(res.body).toMatchObject({ isMember: true, myRole: 'member' });
    expect((await owner.get(`${base}/${pub.id}/members`)).body.data).toHaveLength(2);
    expect((await peer.get(`${base}/${pub.id}/members`)).body.data).toHaveLength(2); // visible to any ws member

    expect((await member.post(`${base}/${pub.id}/leave`)).status).toBe(204);
    expect((await member.post(`${base}/${pub.id}/leave`)).status).toBe(204);
    expect((await owner.get(`${base}/${pub.id}/members`)).body.data).toHaveLength(1);
  });

  it('refuses to let the last admin of a private channel leave while other members remain', async () => {
    const { member, peer, base } = await setup();
    const secret = (await member.post(base, { name: 'inner', type: 'private' })).body as { id: string };
    const ch = `${base}/${secret.id}`;
    await member.put(`${ch}/members/${peer.userId}`, {});

    const leave = await member.post(`${ch}/leave`);
    expect(leave.status).toBe(409);
    expect(problemOf(leave).code).toBe('last_admin');
    const removeSelf = await member.delete(`${ch}/members/${member.userId}`);
    expect(removeSelf.status).toBe(409);
    expect((await member.put(`${ch}/members/${member.userId}`, { role: 'member' })).status).toBe(409);

    await member.put(`${ch}/members/${peer.userId}`, { role: 'admin' });
    expect((await member.post(`${ch}/leave`)).status).toBe(204);
    expect((await member.get(ch)).status).toBe(404); // and it is gone for them
    expect((await peer.delete(`${ch}/members/${peer.userId}`)).status).toBe(204); // sole member may leave
  });
});

describe('channel members', () => {
  it('requires the target to be a workspace member, and a channel admin for private channels', async () => {
    const { member, peer, add, base } = await setup();
    const outsider = add('outsider');
    const secret = (await member.post(base, { name: 'club', type: 'private' })).body as { id: string };
    const ch = `${base}/${secret.id}`;

    const notInWorkspace = await member.put(`${ch}/members/${outsider.userId}`, {});
    expect(notInWorkspace.status).toBe(422);
    expect(problemOf(notInWorkspace).code).toBe('user_not_in_workspace');
    const stranger = newOrganization(ws).people.owner!;
    expect((await member.put(`${ch}/members/${stranger.userId}`, {})).status).toBe(422);

    expect((await member.put(`${ch}/members/${peer.userId}`, {})).body).toMatchObject({
      userId: peer.userId,
      role: 'member',
    });
  });

  it('lets private-channel members who are not admins do nothing but leave', async () => {
    const { member, peer, owner, base } = await setup();
    const secret = (await member.post(base, { name: 'club', type: 'private' })).body as { id: string };
    const ch = `${base}/${secret.id}`;
    await member.put(`${ch}/members/${peer.userId}`, {});

    expect((await peer.put(`${ch}/members/${owner.userId}`, {})).status).toBe(403);
    expect((await peer.put(`${ch}/members/${peer.userId}`, { role: 'admin' })).status).toBe(403);
    expect((await peer.delete(`${ch}/members/${member.userId}`)).status).toBe(403);
    expect((await peer.get(`${ch}/members`)).body.data).toHaveLength(2);
    expect((await member.delete(`${ch}/members/${peer.userId}`)).status).toBe(204);
    expect((await member.delete(`${ch}/members/${peer.userId}`)).status).toBe(204); // idempotent
  });

  it('lets any workspace member add others to a public channel, but only admins grant roles', async () => {
    const { owner, member, peer, base } = await setup();
    const pub = (await owner.post(base, { name: 'town-hall', type: 'public' })).body as { id: string };
    const ch = `${base}/${pub.id}`;
    // the body is optional: no body at all means role "member"
    expect((await member.put(`${ch}/members/${peer.userId}`)).body.role).toBe('member');
    expect((await member.put(`${ch}/members/${member.userId}`, { role: 'admin' })).status).toBe(403);
    expect((await peer.put(`${ch}/members/${peer.userId}`, { role: 'admin' })).status).toBe(403);
    expect((await peer.delete(`${ch}/members/${owner.userId}`)).status).toBe(403);
    expect((await owner.put(`${ch}/members/${peer.userId}`, { role: 'admin' })).body.role).toBe('admin');
  });

  it('keeps a private channel administered when a workspace admin removes its only admin', async () => {
    const { owner, member, peer, workspace, base } = await setup();
    const secret = (await member.post(base, { name: 'vault', type: 'private' })).body as { id: string };
    const ch = `${base}/${secret.id}`;
    await member.put(`${ch}/members/${peer.userId}`, {});

    // no 409 here: it would tell the workspace admin that the user administers a private channel
    expect((await owner.delete(`/workspaces/${workspace.id}/members/${member.userId}`)).status).toBe(204);
    const members = (await peer.get(`${ch}/members`)).body.data as { userId: string; role: string }[];
    expect(members).toEqual([expect.objectContaining({ userId: peer.userId, role: 'admin' })]);
    expect((await owner.get(ch)).status).toBe(404);
  });

  it('blocks a user from leaving the workspace while sole admin of a private channel with other members', async () => {
    const { member, peer, workspace, base } = await setup();
    const secret = (await member.post(base, { name: 'vault', type: 'private' })).body as { id: string };
    await member.put(`${base}/${secret.id}/members/${peer.userId}`, {});
    const leave = await member.post(`/workspaces/${workspace.id}/leave`);
    expect(leave.status).toBe(409);
    expect(problemOf(leave).code).toBe('last_admin');
  });

  it('removes channel memberships with the workspace membership', async () => {
    const { owner, member, workspace, base } = await setup();
    const pub = (await owner.post(base, { name: 'news', type: 'public' })).body as { id: string };
    await member.post(`${base}/${pub.id}/join`);
    await member.post(`/workspaces/${workspace.id}/leave`);
    const members = (await owner.get(`${base}/${pub.id}/members`)).body.data as { userId: string }[];
    expect(members.map((m) => m.userId)).toEqual([owner.userId]);
  });
});

describe('workspace guests', () => {
  it('see only channels they belong to and cannot create or join channels', async () => {
    const { owner, member, base, workspace } = await setup();
    const pub = (await owner.post(base, { name: 'open-air', type: 'public' })).body as { id: string };
    const secret = (await owner.post(base, { name: 'invite-only', type: 'private' })).body as { id: string };
    await owner.put(`/workspaces/${workspace.id}/members/${member.userId}`, { role: 'guest' });
    // demotion to guest keeps existing memberships (general); the guest has none of the others
    expect(names(await member.get(base))).toEqual(['general']);
    expect((await member.get(`${base}/${pub.id}`)).status).toBe(404);
    expect((await member.post(`${base}/${pub.id}/join`)).status).toBe(404);
    expect((await member.post(base, { name: 'guest-made', type: 'public' })).status).toBe(403);

    await owner.put(`${base}/${secret.id}/members/${member.userId}`, {});
    expect(names(await member.get(base))).toEqual(['general', 'invite-only']);
  });
});

describe('pagination', () => {
  it('pages channels and channel members with a keyset cursor', async () => {
    const { owner, member, peer, base } = await setup();
    for (const name of ['c1', 'c2']) await owner.post(base, { name, type: 'public' });
    const first = await owner.get(`${base}?limit=2`);
    expect(first.body.data).toHaveLength(2);
    const second = await owner.get(`${base}?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const list = (await owner.get(base)).body.data as { id: string; name: string }[];
    const general = list.find((c) => c.name === 'general')!;
    const page = await owner.get(`${base}/${general.id}/members?limit=2`);
    expect(page.body.data).toHaveLength(2);
    const rest = await owner.get(`${base}/${general.id}/members?limit=2&cursor=${page.body.nextCursor}`);
    expect(rest.body.data).toHaveLength(1);
    expect([...page.body.data, ...rest.body.data].map((m: { userId: string }) => m.userId).sort()).toEqual(
      [owner.userId, member.userId, peer.userId].sort(),
    );
  });
});

describe('GET /orgs/{o}/channels (visible channels across workspaces)', () => {
  type Row = { id: string; name: string; workspaceId: string; workspaceName: string; type: string; isMember: boolean };
  const rows = (res: { body: { data: Row[] } }) => res.body.data;

  it('lists public channels of the caller’s workspaces and their private ones, never anyone else’s', async () => {
    const { owner, member, peer, workspace, base } = await setup();
    const secret = (await member.post(base, { name: 'secret-plan', type: 'private' })).body as { id: string };
    await owner.post(base, { name: 'town-hall', type: 'public' });

    // a private workspace the member is not in, with a public channel
    const hidden = await owner.createWorkspace({ visibility: 'private', name: 'Hidden' });
    await owner.createChannel(hidden.id, { name: 'hidden-pub' });
    // an open workspace the peer never joined
    const unjoined = await owner.createWorkspace({ visibility: 'open', name: 'Unjoined' });
    await owner.createChannel(unjoined.id, { name: 'unjoined-pub' });

    const mine = await member.get('/channels?limit=100');
    expect(mine.status).toBe(200);
    expect(
      rows(mine)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['general', 'secret-plan', 'town-hall']);
    const found = rows(mine).find((c) => c.name === 'secret-plan')!;
    expect(found).toEqual({
      id: secret.id,
      workspaceId: workspace.id,
      workspaceName: 'Team',
      name: 'secret-plan',
      type: 'private',
      isMember: true,
      archivedAt: null,
    });
    expect(rows(mine).find((c) => c.name === 'town-hall')!.isMember).toBe(false);

    // the private channel is invisible to a non-member, the workspace owner/admin included
    for (const who of [owner, peer]) {
      const list = await who.get('/channels?limit=100');
      expect(rows(list).map((c) => c.name)).not.toContain('secret-plan');
      expect((await who.get('/channels?q=secret')).body.data).toEqual([]);
    }
    // a workspace owner sees the workspaces' public channels only where they are a member
    expect(rows(await owner.get('/channels?limit=100')).map((c) => c.workspaceName)).toContain('Hidden');
    expect(rows(await peer.get('/channels?limit=100')).map((c) => c.name)).not.toContain('hidden-pub');
    expect(rows(await peer.get('/channels?limit=100')).map((c) => c.name)).not.toContain('unjoined-pub');
  });

  it('does not reveal private channels through search results, counts or paging', async () => {
    const { owner, member, base } = await setup();
    await member.post(base, { name: 'zz-secret-one', type: 'private' });
    await member.post(base, { name: 'zz-secret-two', type: 'private' });
    await member.post(base, { name: 'zz-public', type: 'public' });
    const res = await owner.get('/channels?q=zz-&limit=1');
    expect(rows(res).map((c) => c.name)).toEqual(['zz-public']);
    expect(res.body.nextCursor).toBeNull();
    const empty = await owner.get('/channels?q=zz-secret');
    expect(empty.body).toEqual({ data: [], nextCursor: null });
  });

  it('shows guests only the channels they belong to', async () => {
    const { owner, member, base, workspace } = await setup();
    await owner.post(base, { name: 'open-air', type: 'public' });
    const secret = (await owner.post(base, { name: 'invite-only', type: 'private' })).body as { id: string };
    await owner.put(`/workspaces/${workspace.id}/members/${member.userId}`, { role: 'guest' });
    expect(rows(await member.get('/channels')).map((c) => c.name)).toEqual(['general']);
    expect(rows(await member.get('/channels?q=open')).length).toBe(0);
    await owner.put(`${base}/${secret.id}/members/${member.userId}`, {});
    expect(
      rows(await member.get('/channels'))
        .map((c) => c.name)
        .sort(),
    ).toEqual(['general', 'invite-only']);
  });

  it('stops listing channels of a workspace the caller left', async () => {
    const { member, base, workspace } = await setup();
    await member.post(base, { name: 'old-secret', type: 'private' });
    await member.post(`/workspaces/${workspace.id}/leave`);
    expect(rows(await member.get('/channels?limit=100')).map((c) => c.name)).not.toContain('old-secret');
  });

  it('pages without duplicates or gaps across workspaces', async () => {
    const { owner, member, base } = await setup();
    const second = await owner.createWorkspace({ visibility: 'open', name: 'Second' });
    await member.post(`/workspaces/${second.id}/join`);
    for (let i = 0; i < 5; i += 1) await owner.post(base, { name: `p${i}`, type: i % 2 ? 'private' : 'public' });
    for (let i = 0; i < 4; i += 1) await owner.createChannel(second.id, { name: `s${i}` });
    const all = rows(await member.get('/channels?limit=100')).map((c) => c.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const res: { body: { data: Row[]; nextCursor: string | null } } = await member.get(
        `/channels?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.body.data.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.data.map((c) => c.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect((await member.get('/channels?limit=0')).status).toBe(422);
    expect((await member.get('/channels?limit=101')).status).toBe(422);
    expect((await member.get('/channels?cursor=nope!')).status).toBe(422);
  });

  it('matches names case-insensitively and treats % _ and \\ literally; q is 1-100 characters', async () => {
    const { owner, base } = await setup();
    await owner.post(base, { name: 'a_b', type: 'public' });
    await owner.post(base, { name: 'axb', type: 'public' });
    await owner.post(base, { name: 'Release-Notes', type: 'public' });
    const names = async (q: string) => rows(await owner.get(`/channels?q=${encodeURIComponent(q)}`)).map((c) => c.name);
    expect(await names('RELEASE')).toEqual(['release-notes']);
    expect(await names('a_b')).toEqual(['a_b']);
    expect(await names('%')).toEqual([]);
    expect(await names('a%b')).toEqual([]);
    expect(await names('\\')).toEqual([]);
    expect((await owner.get('/channels?q=')).status).toBe(422);
    expect((await owner.get(`/channels?q=${'x'.repeat(101)}`)).status).toBe(422);
    expect((await owner.get(`/channels?q=${'x'.repeat(100)}`)).status).toBe(200);
    expect((await owner.get('/channels?bogus=1')).status).toBe(422);
  });

  it('answers 404 for another organization and for non-members of the organization', async () => {
    const { owner } = await setup();
    const other = newOrganization(ws);
    expect((await owner.inOrg(other.orgId).get('/channels')).status).toBe(404);
    expect((await other.people.owner!.inOrg(owner.orgId).get('/channels')).status).toBe(404);
    const stranger = other.people.owner!;
    expect((await stranger.get('/channels')).status).toBe(200);
    expect(rows(await stranger.get('/channels'))).toEqual([]);
  });
});
