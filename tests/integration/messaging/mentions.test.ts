// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, Channel, makePlace, startCollab, type Collab } from './support/collab.js';
import { db, problemOf } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

const token = (id: string) => `<@${id}>`;
const stored = async (messageId: string) =>
  (
    await db.rows<{ u: string }>(
      'SELECT mentioned_user_id AS u FROM messaging.message_mentions WHERE message_id = $1 AND kind = $2',
      [messageId, 'user'],
    )
  )
    .map((r) => r.u)
    .sort();

describe('mentions in channels', () => {
  it('stores each active organization member once and exposes them on the message', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    const bob = channel.person();
    const onlyInOrg = channel.person('reader'); // an organization member who is not in the channel may be mentioned
    const body = `hi ${token(bob.userId)} ${token(onlyInOrg.userId)} ${token(bob.userId.toUpperCase())} ${token(alice.userId)}`;
    const posted = await alice.post(channel.path(), { body });
    expect(posted.status).toBe(201);
    expect([...posted.body.mentionedUserIds].sort()).toEqual([alice.userId, bob.userId, onlyInOrg.userId].sort());
    expect(await stored(posted.body.id)).toEqual([alice.userId, bob.userId, onlyInOrg.userId].sort());
    const listed = await bob.get(channel.path());
    expect([...listed.body.data[0].mentionedUserIds].sort()).toEqual(
      [alice.userId, bob.userId, onlyInOrg.userId].sort(),
    );
  });

  it('asks the organization service as the caller, and only when the body mentions someone', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    const bob = channel.person();
    const before = w.org.requests.length;
    await alice.post(channel.path(), { body: 'no mentions here' });
    expect(w.org.requests.length).toBe(before);
    await alice.post(channel.path(), { body: `yo ${token(bob.userId)}` });
    const calls = w.org.requests.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/members?userId=${bob.userId}`);
    expect(calls[0]!.authorization).toMatch(/^Bearer /);
  });

  it('refuses someone who is not an active member, with nothing stored', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    const left = channel.person();
    w.org.revoke(channel.chan.orgId, left.userId);
    for (const who of [left.userId, randomUUID()]) {
      const res = await alice.post(channel.path(), { body: `hello ${token(who)} marker-${who}` });
      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0]).toMatchObject({ field: 'body', code: 'invalid_mention' });
    }
    expect(await db.messageCount(channel.chan)).toBe(0);
  });

  it('allows 50 mentions and refuses 51', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    const others = Array.from({ length: 51 }, () => channel.person());
    const mentioning = (n: number) =>
      others
        .slice(0, n)
        .map((o) => token(o.userId))
        .join(' ');
    expect((await alice.post(channel.path(), { body: mentioning(50) })).status).toBe(201);
    const over = await alice.post(channel.path(), { body: mentioning(51) });
    expect(over.status).toBe(422);
    expect(problemOf(over).errors?.[0]).toMatchObject({ code: 'too_many_mentions' });
  });

  it('re-syncs on edit: adds the new, drops the removed, and refuses an invalid edit without changing anything', async () => {
    const channel = new Channel(w);
    const [alice, bob, carol] = [channel.person(), channel.person(), channel.person()];
    const m = (await alice.post(channel.path(), { body: `${token(bob.userId)}` })).body;
    const edited = await alice.patch(channel.path(`/${m.id}`), { body: `now ${token(carol.userId)} only` });
    expect(edited.status).toBe(200);
    expect(edited.body.mentionedUserIds).toEqual([carol.userId]);
    expect(await stored(m.id)).toEqual([carol.userId]);

    const kept = await alice.patch(channel.path(`/${m.id}`), {
      body: `${token(carol.userId)} and ${token(bob.userId)}`,
    });
    expect([...kept.body.mentionedUserIds].sort()).toEqual([bob.userId, carol.userId].sort());

    const bad = await alice.patch(channel.path(`/${m.id}`), { body: `${token(randomUUID())}` });
    expect(bad.status).toBe(422);
    expect(await stored(m.id)).toEqual([bob.userId, carol.userId].sort());
    expect((await alice.get(channel.path())).body.data[0].body).toBe(`${token(carol.userId)} and ${token(bob.userId)}`);

    const cleared = await alice.patch(channel.path(`/${m.id}`), { body: 'nobody' });
    expect(cleared.body.mentionedUserIds).toEqual([]);
    expect(await stored(m.id)).toEqual([]);
  });

  it('erases mentions with the message and stores them for thread replies', async () => {
    const channel = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()];
    const root = (await alice.post(channel.path(), { body: 'root' })).body;
    const reply = (await bob.post(channel.path(), { body: token(alice.userId), threadRootId: root.id })).body;
    expect(reply.mentionedUserIds).toEqual([alice.userId]);
    expect((await alice.get(channel.path(`/${root.id}/replies`))).body.data[0].mentionedUserIds).toEqual([
      alice.userId,
    ]);
    await bob.delete(channel.path(`/${reply.id}`));
    expect(await stored(reply.id)).toEqual([]);
  });

  it('does not store mentions for an idempotent replay', async () => {
    const channel = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()];
    const body = { body: token(bob.userId), clientMessageId: 'once' };
    const first = await alice.post(channel.path(), body);
    const again = await alice.post(channel.path(), body);
    expect(again.status).toBe(200);
    expect(again.body.mentionedUserIds).toEqual([bob.userId]);
    expect(await stored(first.body.id)).toEqual([bob.userId]);
  });

  it('fails closed (503) when the mention lookup is refused', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    const bob = channel.person();
    w.org.revoke(channel.chan.orgId, alice.userId); // the caller itself is no longer a member: the lookup is refused
    const res = await alice.post(channel.path(), { body: token(bob.userId) });
    expect(res.status).toBe(503);
    expect(await db.messageCount(channel.chan)).toBe(0);
  });
});

describe.each(['group', 'direct'] as const)('mentions in a %s conversation', (kind) => {
  it('accepts participants only', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol, outsider] = [w.member(orgId), w.member(orgId), w.member(orgId), w.member(orgId)];
    const id = kind === 'group' ? await alice.group([bob, carol]) : ((await alice.openDirect(bob)).body.id as string);
    const base = `/api/v1/orgs/${orgId}/conversations/${id}/messages`;
    const me = asPerson(w, alice);
    const ok = await me.post(base, { body: `${token(bob.userId)} ${token(alice.userId)}` });
    expect(ok.status).toBe(201);
    expect([...ok.body.mentionedUserIds].sort()).toEqual([alice.userId, bob.userId].sort());
    const bad = await me.post(base, { body: `${token(outsider.userId)} is in the organization but not here` });
    expect(bad.status).toBe(422);
    expect(problemOf(bad).errors?.[0]).toMatchObject({ code: 'invalid_mention' });
    if (kind === 'group') {
      expect((await me.post(base, { body: token(carol.userId) })).status).toBe(201);
    } else {
      expect((await me.post(base, { body: token(carol.userId) })).status).toBe(422);
    }
    // Editing re-validates and re-syncs.
    const edited = await me.patch(`${base}/${ok.body.id}`, { body: `just ${token(bob.userId)}` });
    expect(edited.body.mentionedUserIds).toEqual([bob.userId]);
    expect((await me.patch(`${base}/${ok.body.id}`, { body: token(outsider.userId) })).status).toBe(422);
    expect(await stored(ok.body.id)).toEqual([bob.userId]);
  });
});

describe('mentions leak nothing', () => {
  it('a mention in a channel the reader cannot see stays behind the channel access', async () => {
    const p = await makePlace(w, 'channel');
    const posted = await p.alice.post(p.path(), { body: token(p.bob.userId) });
    expect((await p.outsider.get(p.path())).status).toBe(404);
    expect(JSON.stringify((await p.outsider.get(p.path())).body)).not.toContain(posted.body.id);
  });
});
