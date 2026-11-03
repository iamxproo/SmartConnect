// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, query } from '../../support/database.js';
import { Channel, makePlace, startCollab, type Collab, type Person, type Place } from './support/collab.js';
import { problemOf } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterEach(() => {
  w.svc.workspace.listFailure = null;
});
afterAll(async () => {
  await w.close();
});

const tok = (p: Person) => `<@${p.userId}>`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = (p: Person, suffix = '') => `/api/v1/orgs/${p.orgId}/activity${suffix}`;
const items = async (p: Person, qs = '') => {
  const res = await p.get(url(p, qs));
  expect(res.status).toBe(200);
  return res.body.data as {
    id: string;
    kind: string;
    unread: boolean;
    message: { id: string; senderUserId: string; excerpt: string; createdAt: string; threadRootId: string | null };
    location: object;
  }[];
};
const messageIds = async (p: Person, qs = '') => (await items(p, qs)).map((i) => i.message.id);
const count = async (p: Person) => (await p.get(url(p, '/unread-count'))).body.count as number;

/** A channel with alice, bob, carol (members) and dave (in the organization, not in the channel's visibility). */
function channelWorld() {
  const channel = new Channel(w);
  const [alice, bob, carol] = [channel.person(), channel.person(), channel.person()] as [Person, Person, Person];
  const dave = channel.person();
  return { channel, alice, bob, carol, dave, path: channel.path };
}

describe('activity items', () => {
  it('lists mentions with shape, unread flag and a plain-text excerpt that keeps mention tokens', async () => {
    const { alice, bob, path, channel } = channelWorld();
    const posted = (await bob.post(path(), { body: `**hey** ${tok(alice)}\n\nplease  \`look\` at this` })).body;
    const [item] = await items(alice);
    expect(item).toEqual({
      id: `mention:${posted.id}`,
      kind: 'mention',
      message: {
        id: posted.id,
        senderUserId: bob.userId,
        excerpt: `hey ${tok(alice)} please look at this`,
        createdAt: posted.createdAt,
        threadRootId: null,
      },
      location: { kind: 'channel', workspaceId: channel.chan.wsId, channelId: channel.chan.chId },
      unread: true,
    });
    expect(await items(bob)).toEqual([]);
  });

  it('cuts long excerpts at 200 characters without splitting a mention token', async () => {
    const { alice, bob, path } = channelWorld();
    await bob.post(path(), { body: `${tok(alice)} ${'x'.repeat(165)}${tok(bob)}` });
    const [item] = await items(alice);
    expect(item!.message.excerpt.length).toBeLessThanOrEqual(200);
    expect(item!.message.excerpt).not.toMatch(/<@[0-9a-f-]{0,35}…?$/);
    expect(item!.message.excerpt.endsWith('…')).toBe(true);
  });

  it("never lists the caller's own messages, even when they mention themselves", async () => {
    const { alice, path } = channelWorld();
    await alice.post(path(), { body: `note to self ${tok(alice)}` });
    expect(await items(alice)).toEqual([]);
    expect(await count(alice)).toBe(0);
  });

  it('lists thread replies for the root author, repliers and people mentioned in the thread, once per message', async () => {
    const { alice, bob, carol, dave, path } = channelWorld();
    const root = (await alice.post(path(), { body: 'root' })).body;
    const r1 = (await bob.post(path(), { body: 'r1', threadRootId: root.id })).body;
    // root author: sees bob's reply; bob (replier) and carol (not in the thread) do not see their own / any yet
    expect(await messageIds(alice)).toEqual([r1.id]);
    expect(await messageIds(carol)).toEqual([]);
    const r2 = (await carol.post(path(), { body: `r2 ${tok(dave)}`, threadRootId: root.id })).body;
    expect(new Set(await messageIds(alice))).toEqual(new Set([r1.id, r2.id]));
    expect(await messageIds(bob)).toEqual([r2.id]);
    const forDave = await items(dave);
    // mentioned in the thread, dave takes part in it: earlier and later replies are his activity too
    expect(forDave.map((i) => [i.kind, i.message.id])).toEqual([
      ['mention', r2.id],
      ['thread_reply', r1.id],
    ]);
    expect(forDave[0]!.message.threadRootId).toBe(root.id);
    const r3 = (await bob.post(path(), { body: 'r3', threadRootId: root.id })).body;
    expect((await items(dave)).map((i) => [i.kind, i.message.id])).toEqual([
      ['thread_reply', r3.id],
      ['mention', r2.id],
      ['thread_reply', r1.id],
    ]);
    // a reply mentioning alice is ONE item for her, a mention
    const r4 = (await carol.post(path(), { body: `r4 ${tok(alice)}`, threadRootId: root.id })).body;
    const forAlice = (await items(alice)).filter((i) => i.message.id === r4.id);
    expect(forAlice.map((i) => i.kind)).toEqual(['mention']);
    // filters
    expect((await items(alice, '?filter=mentions')).every((i) => i.kind === 'mention')).toBe(true);
    expect((await items(alice, '?filter=threads')).every((i) => i.kind === 'thread_reply')).toBe(true);
  });

  it('pages newest first with a cursor', async () => {
    const { alice, bob, path } = channelWorld();
    const posted: string[] = [];
    for (let i = 0; i < 5; i++) posted.push((await bob.post(path(), { body: `${i} ${tok(alice)}` })).body.id);
    const first = await alice.get(url(alice, '?limit=2'));
    expect(first.body.data.map((i: { message: { id: string } }) => i.message.id)).toEqual([posted[4], posted[3]]);
    const second = await alice.get(url(alice, `?limit=2&cursor=${first.body.nextCursor}`));
    expect(second.body.data.map((i: { message: { id: string } }) => i.message.id)).toEqual([posted[2], posted[1]]);
    const third = await alice.get(url(alice, `?limit=2&cursor=${second.body.nextCursor}`));
    expect(third.body.data.map((i: { message: { id: string } }) => i.message.id)).toEqual([posted[0]]);
    expect(third.body.nextCursor).toBeNull();
    expect((await alice.get(url(alice, '?cursor=garbage'))).status).toBe(422);
    expect((await alice.get(url(alice, '?filter=nope'))).status).toBe(422);
  });
});

describe('visibility is decided again on every read', () => {
  it('hides, uncounts and refuses to mark mentions in a channel the caller cannot see (any more)', async () => {
    const { channel, alice, bob, path } = channelWorld();
    const m = (await bob.post(path(), { body: `secret ${tok(alice)}` })).body;
    expect(await count(alice)).toBe(1);
    channel.hide(alice);
    expect(await items(alice)).toEqual([]);
    expect(await count(alice)).toBe(0);
    expect((await alice.post(url(alice, '/read'), { itemIds: [`mention:${m.id}`] })).status).toBe(204);
    const reads = await query<{ n: string }>(
      adminUrl(),
      'SELECT count(*) AS n FROM messaging.activity_item_reads WHERE message_id = $1',
      [m.id],
    );
    expect(reads[0]!.n).toBe('0');
    // access comes back: the item is still unread
    w.svc.workspace.show(channel.chan, alice.userId, { isMember: true, myRole: 'member' });
    expect((await items(alice)).map((i) => [i.message.id, i.unread])).toEqual([[m.id, true]]);
  });

  it('never lists a private channel the caller was never in', async () => {
    const { channel, alice, bob, path } = channelWorld();
    channel.hide(alice);
    await bob.post(path(), { body: `${tok(alice)} hi` });
    expect(await items(alice)).toEqual([]);
  });

  describe.each(['group'] as const)('in a %s conversation', (kind) => {
    let p: Place;
    beforeAll(async () => {
      p = await makePlace(w, kind);
    });

    it('drops items after removal and before the join date', async () => {
      const m = (await p.alice.post(p.path(), { body: `hi ${tok(p.bob)}` })).body;
      const forBob = await items(p.bob);
      expect(forBob[0]).toMatchObject({
        id: `mention:${m.id}`,
        location: { kind: 'group', conversationId: p.path().split('/')[6] },
      });
      // joined later than the message: history from join hides it
      await query(
        adminUrl(),
        "UPDATE messaging.conversation_members SET joined_at = now() + interval '1 hour' WHERE user_id = $1",
        [p.bob.userId],
      );
      expect(await items(p.bob)).toEqual([]);
      expect(await count(p.bob)).toBe(0);
      await query(
        adminUrl(),
        "UPDATE messaging.conversation_members SET joined_at = now() - interval '30 seconds' WHERE user_id = $1",
        [p.bob.userId],
      );
      expect(await messageIds(p.bob)).toContain(m.id);
      await p.revoke(p.bob);
      expect(await items(p.bob)).toEqual([]);
      expect(await count(p.bob)).toBe(0);
    });
  });

  it('leaves deleted messages out', async () => {
    const { alice, bob, path } = channelWorld();
    const m = (await bob.post(path(), { body: `${tok(alice)} oops` })).body;
    const root = (await alice.post(path(), { body: 'root' })).body;
    const reply = (await bob.post(path(), { body: 'reply', threadRootId: root.id })).body;
    expect(await count(alice)).toBe(2);
    await bob.delete(path(`/${m.id}`));
    await bob.delete(path(`/${reply.id}`));
    expect(await items(alice)).toEqual([]);
    expect(await count(alice)).toBe(0);
  });

  it('answers 503 when the workspace service fails and 404 for other organizations', async () => {
    const { alice, bob, path } = channelWorld();
    await bob.post(path(), { body: tok(alice) });
    w.svc.workspace.listFailure = 'error';
    expect((await alice.get(url(alice))).status).toBe(503);
    expect((await alice.get(url(alice, '/unread-count'))).status).toBe(503);
    expect((await alice.post(url(alice, '/read'), { itemIds: [`mention:${randomUUID()}`] })).status).toBe(503);
    w.svc.workspace.listFailure = 'garbage';
    expect((await alice.get(url(alice))).status).toBe(503);
    w.svc.workspace.listFailure = null;
    const elsewhere = `/api/v1/orgs/${randomUUID()}/activity`;
    for (const suffix of ['', '/unread-count']) expect((await alice.get(elsewhere + suffix)).status).toBe(404);
    expect((await alice.post(`${elsewhere}/read-all`)).status).toBe(404);
    const res = await alice.post(url(alice, '/read'), { itemIds: ['bogus'] });
    expect(res.status).toBe(422);
    expect(problemOf(res).code).toBe('validation_failed');
  });
});

describe('read state', () => {
  it('marks items read one by one, ignores foreign and unknown ids, and filters unread', async () => {
    const { alice, bob, carol, path } = channelWorld();
    const a = (await carol.post(path(), { body: `1 ${tok(alice)} ${tok(bob)}` })).body;
    const b = (await carol.post(path(), { body: `2 ${tok(alice)}` })).body;
    expect(await count(alice)).toBe(2);
    expect(await count(bob)).toBe(1);
    // bob's item id is not alice's activity: nothing changes for either; wrong kind and unknown ids too
    const res = await alice.post(url(alice, '/read'), {
      itemIds: [`mention:${randomUUID()}`, `thread_reply:${a.id}`, `mention:${a.id}`],
    });
    expect(res.status).toBe(204);
    expect(await count(alice)).toBe(1);
    expect((await items(alice, '?filter=unread')).map((i) => i.message.id)).toEqual([b.id]);
    expect((await items(alice)).find((i) => i.message.id === a.id)!.unread).toBe(false);
    // bob cannot mark alice's second item (it is not his), and his own stays unread
    await bob.post(url(bob, '/read'), { itemIds: [`mention:${b.id}`] });
    expect(await count(alice)).toBe(1);
    expect(await count(bob)).toBe(1);
    expect((await alice.post(url(alice, '/read'), { itemIds: [] })).status).toBe(422);
    expect((await alice.post(url(alice, '/read'), { itemIds: Array(101).fill(`mention:${a.id}`) })).status).toBe(422);
  });

  it('read-all marks everything so far read, and later items are unread again', async () => {
    const { alice, bob, path } = channelWorld();
    const old = (await bob.post(path(), { body: tok(alice) })).body;
    await alice.post(url(alice, '/read'), { itemIds: [`mention:${old.id}`] });
    await sleep(20);
    expect((await alice.post(url(alice, '/read-all'))).status).toBe(204);
    const rows = await query<{ n: string }>(
      adminUrl(),
      'SELECT count(*) AS n FROM messaging.activity_item_reads WHERE user_id = $1',
      [alice.userId],
    );
    expect(rows[0]!.n).toBe('0');
    expect(await count(alice)).toBe(0);
    expect((await items(alice))[0]!.unread).toBe(false);
    await sleep(20);
    const fresh = (await bob.post(path(), { body: tok(alice) })).body;
    expect((await items(alice, '?filter=unread')).map((i) => i.message.id)).toEqual([fresh.id]);
    expect(await count(alice)).toBe(1);
    expect((await alice.post(url(alice, '/read-all'))).status).toBe(204); // idempotent
    expect(await count(alice)).toBe(0);
  });

  it('caps the unread count at 100', async () => {
    const { channel, alice, bob } = channelWorld();
    await bob.post(channel.path(), { body: `seed ${tok(alice)}` });
    const [conv] = await query<{ id: string }>(
      adminUrl(),
      'SELECT id FROM messaging.conversations WHERE channel_id = $1',
      [channel.chan.chId],
    );
    await query(
      adminUrl(),
      `WITH m AS (
         INSERT INTO messaging.messages (id, organization_id, conversation_id, sender_user_id, body)
         SELECT gen_random_uuid(), $1, $2, $3, 'bulk' FROM generate_series(1, 120) RETURNING id)
       INSERT INTO messaging.message_mentions (id, organization_id, message_id, conversation_id, kind, mentioned_user_id)
       SELECT gen_random_uuid(), $1, id, $2, 'user', $4 FROM m`,
      [channel.chan.orgId, conv!.id, bob.userId, alice.userId],
    );
    expect(await count(alice)).toBe(100);
    expect((await alice.get(url(alice, '?limit=100'))).body.data).toHaveLength(100);
    await alice.post(url(alice, '/read-all'));
    expect(await count(alice)).toBe(0);
  });
});
