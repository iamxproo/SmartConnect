// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, problemOf } from './support/messaging.js';
import { sleep, startWorld, type Member, type World } from './support/conversations.js';

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => {
  await w.close();
});

/** An organization with `n` members, [owner, ...others]. */
function team(n: number): Member[] {
  const orgId = w.newOrg();
  return Array.from({ length: n }, () => w.member(orgId));
}

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((m) => m.id);
const participantsOf = (conversationId: string) =>
  db.rows<{ user_id: string; role: string }>(
    'SELECT user_id, role::text AS role FROM messaging.conversation_members WHERE conversation_id = $1',
    [conversationId],
  );

describe('access', () => {
  it('requires organization membership, asked as the caller on every request', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const outsider = w.member(w.newOrg());
    const id = await alice.group([bob, w.member(alice.orgId)]);
    expect((await outsider.inOrg(alice.orgId).get()).status).toBe(404);
    expect((await outsider.inOrg(alice.orgId).get(`/${id}`)).status).toBe(404);
    expect((await outsider.inOrg(alice.orgId).openDirect(alice)).status).toBe(404);
    const before = w.org.requests.length;
    await alice.get(`/${id}`);
    await alice.get(`/${id}/messages`);
    const calls = w.org.requests.slice(before).filter((r) => r.url.endsWith('/me'));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.authorization?.startsWith('Bearer '))).toBe(true);
  });

  it('fails closed (503) when the organization service is unreachable, and never writes', async () => {
    const down = await startWorld('http://127.0.0.1:1');
    try {
      const orgId = down.newOrg();
      const alice = down.member(orgId);
      const bob = down.member(orgId);
      const res = await alice.openDirect(bob);
      expect(res.status).toBe(503);
      expect(
        await db.count('SELECT count(*) AS n FROM messaging.conversations WHERE organization_id = $1', [orgId]),
      ).toBe(0);
    } finally {
      await down.close();
    }
  });

  it('isolates organizations: an id from organization A through B is 404 on every route', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol], 'A only');
    const other = w.newOrg();
    w.org.addMember(other, alice.userId);
    const inB = alice.inOrg(other);
    for (const [method, path, body] of routes(id, randomUUID())) {
      const res = await inB.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await inB.get()).body).toEqual({ data: [], nextCursor: null });
  });

  it('answers 404 to a non-participant, the organization owner included, on every route', async () => {
    const [owner, alice, bob, carol] = team(4) as [Member, Member, Member, Member];
    w.org.addMember(owner.orgId, owner.userId);
    const id = await alice.group([bob, carol]);
    const posted = await alice.say(id, 'secret plans');
    for (const [method, path, body] of routes(id, posted.body.id)) {
      const res = await owner.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('secret plans');
    }
    expect((await owner.get()).body.data).toEqual([]);
    const dm = (await alice.openDirect(bob)).body.id;
    expect((await owner.get(`/${dm}`)).status).toBe(404);
    expect((await owner.say(dm, 'butting in')).status).toBe(404);
  });

  it('answers 404 to guessed, random and malformed ids, and to a channel conversation', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    for (const bad of [randomUUID(), 'not-a-uuid', '123']) {
      for (const [method, path, body] of routes(bad, bad)) {
        expect((await alice.call(method, path, body)).status, `${method} ${path}`).toBe(404);
      }
    }
    // A channel conversation, even with a participant row for the caller, is unreachable through these routes.
    const channelConversation = randomUUID();
    await db.rows(
      `INSERT INTO messaging.conversations (id, organization_id, kind, channel_id, updated_at) VALUES ($1, $2, 'channel', $3, now())`,
      [channelConversation, alice.orgId, randomUUID()],
    );
    await db.rows(
      `INSERT INTO messaging.conversation_members (id, organization_id, conversation_id, user_id) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), alice.orgId, channelConversation, alice.userId],
    );
    for (const [method, path, body] of routes(channelConversation, randomUUID())) {
      expect((await alice.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await alice.get()).body.data).toEqual([]);
    expect(bob.userId).toBeDefined();
  });
});

describe('removed participants', () => {
  it('a participant removed by an admin immediately gets 404', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await alice.say(id, 'before');
    expect((await bob.get(`/${id}/messages`)).status).toBe(200);
    expect((await alice.delete(`/${id}/participants/${bob.userId}`)).status).toBe(204);
    for (const [method, path, body] of routes(id, randomUUID())) {
      expect((await bob.call(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await bob.get()).body.data).toEqual([]);
  });

  it('a person removed from the organization immediately gets 404; re-invited, they do not regain old conversations', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const group = await alice.group([bob, carol]);
    const dm = (await alice.openDirect(bob)).body.id;
    await alice.say(dm, 'old DM message');
    await bob.post(`/${dm}/read`, { messageId: (await bob.get(`/${dm}/messages`)).body.data[0].id });
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.message_read_states WHERE user_id = $1', [bob.userId]),
    ).toBe(1);

    w.org.revoke(alice.orgId, bob.userId);
    expect((await bob.get(`/${group}`)).status).toBe(404);
    expect((await bob.get(`/${dm}/messages`)).status).toBe(404);

    await sleep(20);
    w.org.addMember(alice.orgId, bob.userId, new Date()); // re-invited: a new membership
    expect((await bob.get(`/${group}`)).status).toBe(404);
    expect((await bob.get(`/${dm}`)).status).toBe(404);
    expect((await bob.get()).body.data).toEqual([]);
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.conversation_members WHERE user_id = $1', [bob.userId]),
    ).toBe(0);
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.message_read_states WHERE user_id = $1', [bob.userId]),
    ).toBe(0);

    // Opening the DM again re-adds Bob, who sees only what is said from now on.
    await sleep(20);
    const reopened = await bob.openDirect(alice);
    expect(reopened.status).toBe(200);
    expect(reopened.body.id).toBe(dm);
    await sleep(20);
    await alice.say(dm, 'new DM message');
    const seen = (await bob.get(`/${dm}/messages`)).body.data.map((m: { body: string }) => m.body);
    expect(seen).toEqual(['new DM message']);
    expect((await alice.get(`/${dm}/messages`)).body.data).toHaveLength(2);
  });

  it('re-adds a pruned partner when the other person posts to the direct conversation', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const dm = (await alice.openDirect(bob)).body.id;
    await alice.say(dm, 'hello');
    w.org.revoke(alice.orgId, bob.userId);
    await sleep(20);
    w.org.addMember(alice.orgId, bob.userId, new Date());
    await bob.get(); // the request prunes Bob's old membership
    await sleep(20);
    expect((await alice.say(dm, 'welcome back')).status).toBe(201);
    expect((await bob.get(`/${dm}/messages`)).body.data.map((m: { body: string }) => m.body)).toEqual(['welcome back']);
  });
});

describe('leftovers of an earlier organization membership (removed and re-invited, no request made yet)', () => {
  /** Bob leaves the organization and is invited again; he has not called messaging since, so nothing pruned him. */
  const reinvite = async (orgId: string, who: Member) => {
    w.org.revoke(orgId, who.userId);
    await sleep(20);
    w.org.addMember(orgId, who.userId, new Date());
    await sleep(20);
  };

  it('an admin adding the person back starts them fresh (201), with no earlier history and no ghost role', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const group = await alice.group([bob, carol]);
    expect((await alice.put(`/${group}/participants/${bob.userId}`, { role: 'admin' })).status).toBe(200);
    await alice.say(group, 'said before the re-invitation');
    await reinvite(alice.orgId, bob);

    const added = await alice.put(`/${group}/participants/${bob.userId}`, {});
    expect(added.status).toBe(201);
    expect(added.body.role).toBe('member');
    await alice.say(group, 'said after');
    expect((await bob.get(`/${group}/messages`)).body.data.map((m: { body: string }) => m.body)).toEqual([
      'said after',
    ]);
    expect((await bob.get(`/${group}`)).status).toBe(200);
  });

  it('a direct message to the person starts them fresh instead of being lost to their later pruning', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const dm = (await alice.openDirect(bob)).body.id;
    await alice.say(dm, 'old');
    await reinvite(alice.orgId, bob);

    expect((await alice.say(dm, 'welcome back')).status).toBe(201);
    const seen = await bob.get(`/${dm}/messages`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.map((m: { body: string }) => m.body)).toEqual(['welcome back']);
  });

  it('the inbox check (asked by the realtime gateway) prunes them first, and refuses non-members', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    await alice.group([bob, carol]);
    await reinvite(alice.orgId, bob);
    const inbox = await bob.get('/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body).toEqual({ organizationId: alice.orgId });
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.conversation_members WHERE user_id = $1', [bob.userId]),
    ).toBe(0);
    expect((await w.member(w.newOrg()).inOrg(alice.orgId).get('/inbox')).status).toBe(404);
  });
});

describe('direct conversations', () => {
  it('finds or creates one conversation per pair (201 then 200, from either side)', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const first = await alice.openDirect(bob);
    expect(first.status).toBe(201);
    expect(first.headers.location).toBe(`/api/v1/orgs/${alice.orgId}/conversations/${first.body.id}`);
    expect(first.body).toMatchObject({
      kind: 'direct',
      title: null,
      createdByUserId: alice.userId,
      myRole: 'member',
      lastMessageAt: null,
      unreadCount: 0,
      lastReadMessageId: null,
    });
    expect(first.body.lastActivityAt).toBe(first.body.createdAt);
    expect(first.body.participants.map((p: { userId: string }) => p.userId).sort()).toEqual(
      [alice.userId, bob.userId].sort(),
    );
    expect(first.body.participants.every((p: { role: string }) => p.role === 'member')).toBe(true);
    const again = await bob.openDirect(alice);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await alice.openDirect(bob)).body.id).toBe(first.body.id);
  });

  it('produces one conversation for parallel requests for the same pair', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? alice.openDirect(bob) : bob.openDirect(alice))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const key = [alice.userId, bob.userId].sort().join(':');
    expect(await db.count('SELECT count(*) AS n FROM messaging.conversations WHERE direct_key = $1', [key])).toBe(1);
    expect(await participantsOf(results[0]!.body.id)).toHaveLength(2);
  });

  it('refuses a conversation with yourself, a non-member, malformed input, and other organizations', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const self = await alice.openDirect(alice);
    expect(self.status).toBe(422);
    expect(problemOf(self).code).toBe('cannot_message_self');
    const stranger = w.member(w.newOrg());
    const nonMember = await alice.openDirect(stranger);
    expect(nonMember.status).toBe(422);
    expect(problemOf(nonMember).code).toBe('user_not_in_organization');
    expect((await alice.openDirect(randomUUID())).status).toBe(422);
    expect((await alice.post('/direct', { userId: 'nope' })).status).toBe(422);
    expect((await alice.post('/direct', { userId: bob.userId, extra: 1 })).status).toBe(422);
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.conversations WHERE organization_id = $1', [alice.orgId]),
    ).toBe(0);
  });

  it('answers 409 participant_inactive once the other person left the organization', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const dm = (await alice.openDirect(bob)).body.id;
    expect((await alice.say(dm, 'still here')).status).toBe(201);
    w.org.revoke(alice.orgId, bob.userId);
    const res = await alice.say(dm, 'hello?');
    expect(res.status).toBe(409);
    expect(problemOf(res).code).toBe('participant_inactive');
    expect((await alice.get(`/${dm}/messages`)).body.data).toHaveLength(1);
    expect((await alice.openDirect(bob)).status).toBe(422);
  });

  it('has no participants or title to change', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const dm = (await alice.openDirect(bob)).body.id;
    const stranger = w.member(alice.orgId);
    for (const res of [
      await alice.patch(`/${dm}`, { title: 'x' }),
      await alice.put(`/${dm}/participants/${stranger.userId}`, {}),
      await alice.delete(`/${dm}/participants/${bob.userId}`),
      await alice.delete(`/${dm}/participants/${alice.userId}`),
    ]) {
      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('not_a_group');
    }
    expect(await participantsOf(dm)).toHaveLength(2);
  });
});

describe('groups', () => {
  it('creates a group: the creator is admin, the others members, the title optional', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const res = await alice.post('/groups', { title: 'Plan', userIds: [bob.userId, carol.userId] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'group', title: 'Plan', myRole: 'admin', createdByUserId: alice.userId });
    expect(res.body.participants.map((p: { userId: string; role: string }) => [p.userId, p.role])).toEqual([
      [alice.userId, 'admin'],
      [bob.userId, 'member'],
      [carol.userId, 'member'],
    ]);
    const untitled = await alice.post('/groups', { userIds: [bob.userId, carol.userId] });
    expect(untitled.body.title).toBeNull();
    expect((await bob.get(`/${res.body.id}`)).body.myRole).toBe('member');
  });

  it.each([
    ['one other only', (o: Member[]) => ({ userIds: [o[0]!.userId] })],
    ['no others', () => ({ userIds: [] })],
    ['duplicates', (o: Member[]) => ({ userIds: [o[0]!.userId, o[0]!.userId] })],
    ['yourself included', (o: Member[], me: Member) => ({ userIds: [o[0]!.userId, o[1]!.userId, me.userId] })],
    ['blank title', (o: Member[]) => ({ title: '   ', userIds: o.map((m) => m.userId) })],
    ['title too long', (o: Member[]) => ({ title: 'x'.repeat(121), userIds: o.map((m) => m.userId) })],
    ['non-uuid id', (o: Member[]) => ({ userIds: [o[0]!.userId, 'bob'] })],
    ['unknown field', (o: Member[]) => ({ userIds: o.map((m) => m.userId), kind: 'direct' })],
  ])('rejects invalid input with 422: %s', async (_name, build) => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const res = await alice.post('/groups', build([bob, carol], alice));
    expect(res.status).toBe(422);
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.conversations WHERE organization_id = $1', [alice.orgId]),
    ).toBe(0);
  });

  it('refuses a group with a user outside the organization, and 50 or more others', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const stranger = w.member(w.newOrg());
    const res = await alice.post('/groups', { userIds: [bob.userId, stranger.userId] });
    expect(res.status).toBe(422);
    expect(problemOf(res).code).toBe('user_not_in_organization');
    const many = Array.from({ length: 50 }, () => w.member(alice.orgId).userId);
    expect((await alice.post('/groups', { userIds: many })).status).toBe(422);
    const fortyNine = many.slice(0, 49);
    const ok = await alice.post('/groups', { userIds: fortyNine });
    expect(ok.status).toBe(201);
    expect(ok.body.participants).toHaveLength(50);
    expect(carol.userId).toBeDefined();
  });

  it('lets only admins add, remove, rename and change roles; members cannot', async () => {
    const [alice, bob, carol, dave] = team(4) as [Member, Member, Member, Member];
    const id = await alice.group([bob, carol]);
    const base = `/${id}/participants`;
    for (const res of [
      await bob.patch(`/${id}`, { title: 'mine' }),
      await bob.put(`${base}/${dave.userId}`, {}),
      await bob.put(`${base}/${carol.userId}`, { role: 'admin' }),
      await bob.delete(`${base}/${carol.userId}`),
    ]) {
      expect(res.status).toBe(403);
    }
    expect((await alice.get(`/${id}`)).body.title).toBeNull();
    expect(await participantsOf(id)).toHaveLength(3);

    const added = await alice.put(`${base}/${dave.userId}`, {});
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: dave.userId, role: 'member' });
    expect((await alice.put(`${base}/${dave.userId}`, {})).status).toBe(200);
    const promoted = await alice.put(`${base}/${bob.userId}`, { role: 'admin' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('admin');
    expect((await bob.patch(`/${id}`, { title: 'Bob renamed' })).body.title).toBe('Bob renamed');
    expect((await bob.patch(`/${id}`, { title: null })).body.title).toBeNull();
    expect((await bob.delete(`${base}/${carol.userId}`)).status).toBe(204);
    expect((await carol.get(`/${id}`)).status).toBe(404);
    expect((await alice.delete(`${base}/${carol.userId}`)).status).toBe(404); // not a participant any more
  });

  it('refuses adding someone outside the organization (422), and invalid roles', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol]);
    const stranger = w.member(w.newOrg());
    const res = await alice.put(`/${id}/participants/${stranger.userId}`, {});
    expect(res.status).toBe(422);
    expect(problemOf(res).code).toBe('user_not_in_organization');
    expect((await alice.put(`/${id}/participants/${bob.userId}`, { role: 'owner' })).status).toBe(422);
    expect(await participantsOf(id)).toHaveLength(3);
  });

  it('lets anyone leave; the longest-standing member becomes admin when the last admin leaves', async () => {
    const [alice, bob, carol, dave] = team(4) as [Member, Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await sleep(10);
    await alice.put(`/${id}/participants/${dave.userId}`, {});
    expect((await carol.delete(`/${id}/participants/${carol.userId}`)).status).toBe(204);
    expect((await carol.get(`/${id}`)).status).toBe(404);
    expect((await alice.delete(`/${id}/participants/${alice.userId}`)).status).toBe(204);
    const roles = Object.fromEntries((await participantsOf(id)).map((p) => [p.user_id, p.role]));
    expect(roles).toEqual({ [bob.userId]: 'admin', [dave.userId]: 'member' });
    expect((await bob.get(`/${id}`)).body.myRole).toBe('admin');
    // The remaining admin may also leave: Dave is promoted.
    expect((await bob.delete(`/${id}/participants/${bob.userId}`)).status).toBe(204);
    expect((await dave.get(`/${id}`)).body.myRole).toBe('admin');
  });

  it('refuses to demote the last admin (409 last_admin), but allows it when another admin exists', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol]);
    const refused = await alice.put(`/${id}/participants/${alice.userId}`, { role: 'member' });
    expect(refused.status).toBe(409);
    expect(problemOf(refused).code).toBe('last_admin');
    await alice.put(`/${id}/participants/${bob.userId}`, { role: 'admin' });
    expect((await alice.put(`/${id}/participants/${alice.userId}`, { role: 'member' })).status).toBe(200);
    const again = await bob.put(`/${id}/participants/${bob.userId}`, { role: 'member' });
    expect(again.status).toBe(409);
  });

  it('caps a group at 50 participants (409 conversation_full) and still allows role changes when full', async () => {
    const [alice, bob, carol, extra] = team(4) as [Member, Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await fill(id, alice.orgId, 47);
    expect(await participantsOf(id)).toHaveLength(50);
    const full = await alice.put(`/${id}/participants/${extra.userId}`, {});
    expect(full.status).toBe(409);
    expect(problemOf(full).code).toBe('conversation_full');
    expect((await alice.put(`/${id}/participants/${bob.userId}`, { role: 'admin' })).status).toBe(200);
    expect((await alice.delete(`/${id}/participants/${carol.userId}`)).status).toBe(204);
    expect((await alice.put(`/${id}/participants/${extra.userId}`, {})).status).toBe(201);
  });

  it('stays consistent when two admins remove each other concurrently', async () => {
    for (let round = 0; round < 3; round++) {
      const [alice, bob, carol] = team(3) as [Member, Member, Member];
      const id = await alice.group([bob, carol]);
      await alice.put(`/${id}/participants/${bob.userId}`, { role: 'admin' });
      const [a, b] = await Promise.all([
        alice.delete(`/${id}/participants/${bob.userId}`),
        bob.delete(`/${id}/participants/${alice.userId}`),
      ]);
      expect([a.status, b.status].sort()).toEqual([204, 404]);
      const left = await participantsOf(id);
      expect(left).toHaveLength(2);
      expect(left.some((p) => p.role === 'admin')).toBe(true);
      expect(left.some((p) => p.user_id === carol.userId)).toBe(true);
    }
  });

  it('stays consistent when concurrent adds race the cap', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await fill(id, alice.orgId, 47 - 2); // 48 participants
    const newcomers = Array.from({ length: 5 }, () => w.member(alice.orgId));
    const results = await Promise.all(newcomers.map((n) => alice.put(`/${id}/participants/${n.userId}`, {})));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409]);
    expect(await participantsOf(id)).toHaveLength(50);
  });

  it('stays consistent when the last admin leaves while another demotion races', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await alice.put(`/${id}/participants/${bob.userId}`, { role: 'admin' });
    await Promise.all([
      alice.put(`/${id}/participants/${bob.userId}`, { role: 'member' }),
      bob.put(`/${id}/participants/${alice.userId}`, { role: 'member' }),
    ]);
    const admins = (await participantsOf(id)).filter((p) => p.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  /** Adds `count` other participants straight into the database (they are not exercised themselves). */
  async function fill(conversationId: string, orgId: string, count: number): Promise<void> {
    await db.rows(
      `INSERT INTO messaging.conversation_members (id, organization_id, conversation_id, user_id, joined_at)
       SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), now() FROM generate_series(1, $3::int)`,
      [orgId, conversationId, count],
    );
  }
});

describe('messages', () => {
  it("lists newest first from the caller's join onward; an added participant sees no earlier history", async () => {
    const [alice, bob, carol, dave] = team(4) as [Member, Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await alice.say(id, 'one');
    await sleep(10);
    await bob.say(id, 'two');
    await sleep(10);
    expect((await alice.put(`/${id}/participants/${dave.userId}`, {})).status).toBe(201);
    await sleep(10);
    await carol.say(id, 'three');
    const bodies = async (m: Member) => (await m.get(`/${id}/messages`)).body.data.map((x: { body: string }) => x.body);
    expect(await bodies(alice)).toEqual(['three', 'two', 'one']);
    expect(await bodies(dave)).toEqual(['three']);
    // Older messages are neither editable, deletable nor readable for Dave, and do not count as unread.
    const old = (await alice.get(`/${id}/messages`)).body.data[2];
    expect((await dave.patch(`/${id}/messages/${old.id}`, { body: 'x' })).status).toBe(404);
    expect((await dave.delete(`/${id}/messages/${old.id}`)).status).toBe(404);
    expect((await dave.post(`/${id}/read`, { messageId: old.id })).status).toBe(404);
    expect((await dave.get(`/${id}`)).body.unreadCount).toBe(1);
    expect((await alice.get(`/${id}`)).body.unreadCount).toBe(2); // Bob's and Carol's, not her own
    expect(old.conversationId).toBe(id);
  });

  it('a removed and re-added participant does not see what was said while away', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const id = await alice.group([bob, carol]);
    await alice.say(id, 'before');
    await sleep(10);
    await alice.delete(`/${id}/participants/${bob.userId}`);
    await alice.say(id, 'while away');
    await sleep(10);
    await alice.put(`/${id}/participants/${bob.userId}`, {});
    await sleep(10);
    await alice.say(id, 'after');
    expect((await bob.get(`/${id}/messages`)).body.data.map((m: { body: string }) => m.body)).toEqual(['after']);
  });

  it('pages without duplicates or gaps when many messages share one createdAt', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const id = (await alice.openDirect(bob)).body.id;
    await db.rows(
      `INSERT INTO messaging.messages (id, organization_id, conversation_id, sender_user_id, body, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'm' || g, now() + interval '1 minute' FROM generate_series(1, 11) g`,
      [alice.orgId, id, alice.userId],
    );
    await db.rows(
      `INSERT INTO messaging.messages (id, organization_id, conversation_id, sender_user_id, body, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'late' || g, now() + interval '2 minutes' FROM generate_series(1, 2) g`,
      [alice.orgId, id, bob.userId],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await bob.get(`/${id}/messages?limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...ids(res));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    const expected = await db.rows<{ id: string }>(
      'SELECT id FROM messaging.messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC',
      [id],
    );
    expect(seen).toEqual(expected.map((r) => r.id));
  });

  it('validates list parameters', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const id = (await alice.openDirect(bob)).body.id;
    for (const qs of ['?limit=0', '?limit=101', '?cursor=%25%25', '?x=1']) {
      expect((await alice.get(`/${id}/messages${qs}`)).status, qs).toBe(422);
    }
    expect((await alice.get('?limit=0')).status).toBe(422);
  });

  it("posts idempotently per sender and moves the sender's read cursor", async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const id = (await alice.openDirect(bob)).body.id;
    const first = await alice.say(id, 'once', 'retry-1');
    expect(first.status).toBe(201);
    expect(first.headers.location).toBe(`/api/v1/orgs/${alice.orgId}/conversations/${id}/messages/${first.body.id}`);
    expect(first.body).toMatchObject({
      conversationId: id,
      senderUserId: alice.userId,
      type: 'standard',
      body: 'once',
      clientMessageId: 'retry-1',
      editedAt: null,
      deletedAt: null,
    });
    const again = await alice.say(id, 'once, retried', 'retry-1');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await bob.say(id, 'bob uses the same key', 'retry-1')).status).toBe(201);
    expect(await db.count('SELECT count(*) AS n FROM messaging.messages WHERE conversation_id = $1', [id])).toBe(2);
    expect(
      await db.count(
        "SELECT count(*) AS n FROM messaging.outbox_events WHERE event_type = 'messaging.message.created' AND aggregate_id = $1",
        [first.body.id],
      ),
    ).toBe(1);
    const mine = await alice.get(`/${id}`);
    expect(mine.body.lastReadMessageId).toBe(first.body.id);
    expect(mine.body.lastMessageAt).not.toBeNull();
  });

  it('rejects invalid bodies with 422 and writes nothing', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const id = (await alice.openDirect(bob)).body.id;
    for (const payload of [
      { body: '' },
      { body: '  ' },
      { body: 'a\u0000b' },
      { body: 5 },
      {},
      { body: 'x', sender: 'y' },
    ]) {
      expect((await alice.post(`/${id}/messages`, payload)).status).toBe(422);
    }
    expect(await db.count('SELECT count(*) AS n FROM messaging.messages WHERE conversation_id = $1', [id])).toBe(0);
  });

  it('lets only the sender edit; the sender or a group admin delete; direct conversations only the sender', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const group = await alice.group([bob, carol]);
    const bobs = (await bob.say(group, 'bob says')).body.id;
    expect((await alice.patch(`/${group}/messages/${bobs}`, { body: 'hijack' })).status).toBe(403);
    expect((await carol.delete(`/${group}/messages/${bobs}`)).status).toBe(403);
    const edited = await bob.patch(`/${group}/messages/${bobs}`, { body: 'bob edits' });
    expect(edited.status).toBe(200);
    expect(edited.body.body).toBe('bob edits');
    expect(edited.body.editedAt).not.toBeNull();
    expect((await alice.delete(`/${group}/messages/${bobs}`)).status).toBe(204); // admin moderation
    expect((await alice.delete(`/${group}/messages/${bobs}`)).status).toBe(204); // idempotent
    const gone = (await carol.get(`/${group}/messages`)).body.data[0];
    expect(gone).toMatchObject({ id: bobs, body: null });
    expect(gone.deletedAt).not.toBeNull();
    const afterDelete = await bob.patch(`/${group}/messages/${bobs}`, { body: 'too late' });
    expect(afterDelete.status).toBe(409);
    expect(problemOf(afterDelete).code).toBe('message_deleted');
    expect(await db.count("SELECT count(*) AS n FROM messaging.messages WHERE id = $1 AND body = ''", [bobs])).toBe(1);

    const dm = (await alice.openDirect(bob)).body.id;
    const mine = (await alice.say(dm, 'mine')).body.id;
    expect((await bob.delete(`/${dm}/messages/${mine}`)).status).toBe(403);
    expect((await bob.patch(`/${dm}/messages/${mine}`, { body: 'x' })).status).toBe(403);
    expect((await alice.delete(`/${dm}/messages/${mine}`)).status).toBe(204);
    // A message id from another conversation is just not found.
    const other = (await alice.say(group, 'elsewhere')).body.id;
    expect((await alice.patch(`/${dm}/messages/${other}`, { body: 'x' })).status).toBe(404);
    expect((await alice.delete(`/${dm}/messages/${other}`)).status).toBe(404);
  });

  it("moderation stops with admin rights: a demoted admin cannot delete others' messages", async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const group = await alice.group([bob, carol]);
    await alice.put(`/${group}/participants/${bob.userId}`, { role: 'admin' });
    const id = (await carol.say(group, 'hi')).body.id;
    await alice.put(`/${group}/participants/${bob.userId}`, { role: 'member' });
    expect((await bob.delete(`/${group}/messages/${id}`)).status).toBe(403);
  });
});

describe('read cursor and unread counts', () => {
  it("counts others' undeleted messages after the cursor, moves forward only, and caps at 100", async () => {
    const [alice, bob] = team(2) as [Member, Member];
    const id = (await alice.openDirect(bob)).body.id;
    const m: string[] = [];
    for (const text of ['1', '2', '3', '4']) {
      m.push((await alice.say(id, text)).body.id);
      await sleep(3);
    }
    const unread = async (who: Member) => (await who.get(`/${id}`)).body.unreadCount;
    expect(await unread(bob)).toBe(4);
    expect(await unread(alice)).toBe(0);

    expect((await bob.post(`/${id}/read`, { messageId: m[1] })).status).toBe(204);
    expect(await unread(bob)).toBe(2);
    expect((await bob.post(`/${id}/read`, { messageId: m[0] })).status).toBe(204); // backwards: ignored
    expect(await unread(bob)).toBe(2);
    expect((await bob.get(`/${id}`)).body.lastReadMessageId).toBe(m[1]);

    await alice.delete(`/${id}/messages/${m[3]}`); // deleted messages do not count
    expect(await unread(bob)).toBe(1);
    await sleep(3);
    await bob.say(id, 'reply'); // posting moves Bob's cursor to his own message
    expect(await unread(bob)).toBe(0);
    expect(await unread(alice)).toBe(1);
    expect((await bob.post(`/${id}/read`, { messageId: m[2] })).status).toBe(204);
    expect(await unread(bob)).toBe(0);

    for (const bad of [{}, { messageId: 'nope' }, { messageId: m[0], extra: 1 }]) {
      expect((await bob.post(`/${id}/read`, bad)).status).toBe(422);
    }
    expect((await bob.post(`/${id}/read`, { messageId: randomUUID() })).status).toBe(404);

    await db.rows(
      `INSERT INTO messaging.messages (id, organization_id, conversation_id, sender_user_id, body, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'bulk', now() + interval '1 minute' FROM generate_series(1, 120)`,
      [alice.orgId, id, alice.userId],
    );
    expect(await unread(bob)).toBe(100);
  });

  it('orders the list by last activity (newest first) with a cursor, and reports unread per conversation', async () => {
    const [alice, bob, carol, dave] = team(4) as [Member, Member, Member, Member];
    const withBob = (await alice.openDirect(bob)).body.id;
    await sleep(5);
    const withCarol = (await alice.openDirect(carol)).body.id;
    await sleep(5);
    const group = await alice.group([bob, carol, dave]);
    await sleep(5);
    await bob.say(withBob, 'ping');
    await sleep(5);
    const order = async (qs = '') => (await alice.get(qs)).body;
    const all = await order();
    expect(all.data.map((c: { id: string }) => c.id)).toEqual([withBob, group, withCarol]);
    expect(all.data[0].unreadCount).toBe(1);
    expect(all.data[0].lastActivityAt).toBe(all.data[0].lastMessageAt);
    expect(all.data[1].unreadCount).toBe(0);
    const page1 = await order('?limit=2');
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await order(`?limit=2&cursor=${page1.nextCursor}`);
    expect([...page1.data, ...page2.data].map((c: { id: string }) => c.id)).toEqual([withBob, group, withCarol]);
    expect(page2.nextCursor).toBeNull();
    // The list never includes other people's conversations.
    expect((await dave.get()).body.data.map((c: { id: string }) => c.id)).toEqual([group]);
  });
});

describe('events carry ids only', () => {
  const SECRET = 'top secret body 7f3a';
  const TITLE = 'secret title 19bc';

  it('writes id-only outbox rows and publishes id-only realtime events to the right recipients', async () => {
    const [alice, bob, carol, dave] = team(4) as [Member, Member, Member, Member];
    w.events.length = 0;
    const group = await alice.group([bob, carol], TITLE);
    const posted = (await bob.say(group, SECRET)).body.id;
    await bob.patch(`/${group}/messages/${posted}`, { body: `${SECRET} edited` });
    await carol.post(`/${group}/read`, { messageId: posted });
    await alice.put(`/${group}/participants/${dave.userId}`, {});
    await alice.patch(`/${group}`, { title: `${TITLE} 2` });
    await alice.delete(`/${group}/participants/${carol.userId}`);
    await alice.delete(`/${group}/messages/${posted}`);

    const everyone = (...m: Member[]) => m.map((x) => x.userId).sort();
    const summary = w.events.map((e) => [e.change, e.messageId, [...e.recipientUserIds].sort()] as const);
    expect(summary).toEqual([
      ['conversation.updated', null, everyone(alice, bob, carol)],
      ['message.created', posted, everyone(alice, bob, carol)],
      ['message.updated', posted, everyone(alice, bob, carol)],
      ['read', posted, everyone(carol)],
      ['conversation.updated', null, everyone(alice, bob, carol, dave)],
      ['conversation.updated', null, everyone(alice, bob, carol, dave)],
      ['conversation.updated', null, everyone(alice, bob, dave, carol)], // removed Carol still hears about it
      ['message.deleted', posted, everyone(alice, bob, dave)],
    ]);
    for (const event of w.events) {
      expect(Object.keys(event).sort()).toEqual([
        'change',
        'conversationId',
        'messageId',
        'organizationId',
        'recipientUserIds',
      ]);
      expect(event.conversationId).toBe(group);
      expect(event.organizationId).toBe(alice.orgId);
      const json = JSON.stringify(event);
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain(TITLE);
    }

    const rows = await db.rows<{
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      'SELECT event_type, aggregate_type, aggregate_id, payload FROM messaging.outbox_events WHERE organization_id = $1 ORDER BY occurred_at, id',
      [alice.orgId],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      'messaging.conversation.created',
      'messaging.message.created',
      'messaging.message.updated',
      'messaging.conversation.participant_added',
      'messaging.conversation.updated',
      'messaging.conversation.participant_removed',
      'messaging.message.deleted',
    ]);
    for (const row of rows) {
      const json = JSON.stringify(row.payload);
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain(TITLE);
      expect(row.payload).not.toHaveProperty('body');
      expect(row.payload).not.toHaveProperty('title');
      expect(row.payload).not.toHaveProperty('channelId');
      expect(row.payload).toMatchObject({ conversationId: group });
    }
    expect(rows[1]!.payload).toEqual({ messageId: posted, conversationId: group, actorUserId: bob.userId });
    expect(rows[5]!.payload).toEqual({ conversationId: group, actorUserId: alice.userId, userId: carol.userId });
    expect(rows[1]!.aggregate_type).toBe('message');
    expect(rows[0]!.aggregate_type).toBe('conversation');
  });

  it('announces nothing for idempotent replays, no-op reads and unchanged roles; direct opens announce once', async () => {
    const [alice, bob] = team(2) as [Member, Member];
    w.events.length = 0;
    const dm = (await alice.openDirect(bob)).body.id;
    await alice.openDirect(bob);
    expect(w.events.map((e) => e.change)).toEqual(['conversation.updated']);
    expect(w.events[0]!.recipientUserIds.sort()).toEqual([alice.userId, bob.userId].sort());
    const m = (await alice.say(dm, 'x', 'k')).body.id;
    await alice.say(dm, 'x', 'k');
    await bob.post(`/${dm}/read`, { messageId: m });
    await bob.post(`/${dm}/read`, { messageId: m });
    expect(w.events.map((e) => e.change)).toEqual(['conversation.updated', 'message.created', 'read']);
  });

  it('keeps bodies and titles out of the service logs', async () => {
    const [alice, bob, carol] = team(3) as [Member, Member, Member];
    const group = await alice.group([bob, carol], TITLE);
    await alice.say(group, SECRET);
    await bob.say(group, '');
    expect(w.svc.logger.lines.join('\n')).not.toContain(SECRET);
    expect(w.svc.logger.lines.join('\n')).not.toContain(TITLE);
  });
});

/** Every conversation route, addressed with a conversation id and a message id. */
function routes(id: string, messageId: string): ['get' | 'post' | 'put' | 'patch' | 'delete', string, object?][] {
  const user = randomUUID();
  return [
    ['get', `/${id}`],
    ['patch', `/${id}`, { title: 'x' }],
    ['put', `/${id}/participants/${user}`, {}],
    ['delete', `/${id}/participants/${user}`],
    ['post', `/${id}/read`, { messageId }],
    ['get', `/${id}/messages`],
    ['post', `/${id}/messages`, { body: 'hello' }],
    ['patch', `/${id}/messages/${messageId}`, { body: 'x' }],
    ['delete', `/${id}/messages/${messageId}`],
  ];
}
