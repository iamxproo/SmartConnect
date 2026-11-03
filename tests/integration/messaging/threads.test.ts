// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, makePlace, startCollab, type Collab, type Place } from './support/collab.js';
import { db } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((m) => m.id);

describe.each(['channel', 'group'] as const)('threads in a %s', (kind) => {
  let p: Place;
  beforeAll(async () => {
    p = await makePlace(w, kind);
  });

  async function rootWithReplies(n: number) {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const replies = [];
    for (let i = 0; i < n; i++) {
      const res = await (i % 2 ? p.bob : p.alice).post(p.path(), { body: `reply ${i}`, threadRootId: root.id });
      expect(res.status).toBe(201);
      replies.push(res.body);
    }
    return { root, replies };
  }

  it('posts a reply that stays out of the timeline and summarizes the thread on the root', async () => {
    const { root, replies } = await rootWithReplies(3);
    expect(replies[0]).toMatchObject({ threadRootId: root.id, body: 'reply 0', thread: null });
    const timeline = await p.alice.get(p.path());
    expect(ids(timeline)).toContain(root.id);
    expect(ids(timeline)).not.toContain(replies[0].id);
    const listedRoot = timeline.body.data.find((m: { id: string }) => m.id === root.id);
    expect(listedRoot.thread).toEqual({
      replyCount: 3,
      lastReplyAt: replies[2].createdAt,
      participantUserIds: [p.alice.userId, p.bob.userId],
    });
    expect(listedRoot.threadRootId).toBeNull();
  });

  it('lists replies oldest first with a cursor, for anyone who can read the root', async () => {
    const { root, replies } = await rootWithReplies(5);
    const first = await p.bob.get(p.path(`/${root.id}/replies?limit=2`));
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual(replies.slice(0, 2).map((r) => r.id));
    const second = await p.bob.get(p.path(`/${root.id}/replies?limit=2&cursor=${first.body.nextCursor}`));
    expect(ids(second)).toEqual(replies.slice(2, 4).map((r) => r.id));
    const third = await p.bob.get(p.path(`/${root.id}/replies?limit=2&cursor=${second.body.nextCursor}`));
    expect(ids(third)).toEqual([replies[4].id]);
    expect(third.body.nextCursor).toBeNull();
    expect((await p.alice.get(p.path(`/${root.id}/replies?cursor=garbage`))).status).toBe(422);
    expect((await p.alice.get(p.path(`/${root.id}/replies?limit=0`))).status).toBe(422);
  });

  it('refuses a reply to a reply (422), and a reply route for a reply is 404', async () => {
    const { replies } = await rootWithReplies(1);
    const res = await p.alice.post(p.path(), { body: 'nested', threadRootId: replies[0].id });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'threadRootId', code: 'reply_to_reply' });
    expect((await p.alice.get(p.path(`/${replies[0].id}/replies`))).status).toBe(404);
  });

  it('404s a root that does not exist, belongs to another place, or is malformed; 422 for a non-uuid', async () => {
    const marker = randomUUID();
    const other = await makePlace(w, kind);
    const foreign = (await other.alice.post(other.path(), { body: 'elsewhere' })).body;
    expect((await p.alice.post(p.path(), { body: marker, threadRootId: randomUUID() })).status).toBe(404);
    expect((await p.alice.post(p.path(), { body: marker, threadRootId: foreign.id })).status).toBe(404);
    expect((await p.alice.get(p.path(`/${foreign.id}/replies`))).status).toBe(404);
    expect((await p.alice.post(p.path(), { body: marker, threadRootId: 'nope' })).status).toBe(422);
    expect(await db.count('SELECT count(*) AS n FROM messaging.messages WHERE body = $1', [marker])).toBe(0);
  });

  it('shuts out people without access and does not let a reply be read by a stranger', async () => {
    const { root } = await rootWithReplies(1);
    expect((await p.outsider.get(p.path(`/${root.id}/replies`))).status).toBe(404);
    expect((await p.outsider.post(p.path(), { body: 'x', threadRootId: root.id })).status).toBe(404);
  });

  it('refuses replies to a deleted root (409), hides its replies and its thread summary', async () => {
    const { root } = await rootWithReplies(1);
    expect((await p.alice.delete(p.path(`/${root.id}`))).status).toBe(204);
    const res = await p.alice.post(p.path(), { body: 'late', threadRootId: root.id });
    expect(res.status).toBe(409);
    expect((await p.bob.get(p.path(`/${root.id}/replies`))).status).toBe(404);
    const timeline = await p.bob.get(p.path());
    expect(timeline.body.data.find((m: { id: string }) => m.id === root.id)).toMatchObject({
      deletedAt: expect.any(String),
      thread: null,
    });
  });

  it('replays a clientMessageId without counting the reply twice', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const body = { body: 'once', threadRootId: root.id, clientMessageId: 'retry-1' };
    const first = await p.bob.post(p.path(), body);
    const again = await p.bob.post(p.path(), body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
    const rows = await db.rows<{ reply_count: number }>(
      'SELECT reply_count FROM messaging.message_threads WHERE root_message_id = $1',
      [root.id],
    );
    expect(rows[0]!.reply_count).toBe(1);
  });

  it('keeps reply_count exact under concurrent replies', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? p.alice : p.bob).post(p.path(), { body: `c${i}`, threadRootId: root.id }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const [row] = await db.rows<{ reply_count: number; participants: string[] }>(
      'SELECT reply_count, participant_user_ids AS participants FROM messaging.message_threads WHERE root_message_id = $1',
      [root.id],
    );
    expect(row!.reply_count).toBe(12);
    expect([...row!.participants].sort()).toEqual([p.alice.userId, p.bob.userId].sort());
    const listed = await p.alice.get(p.path(`/${root.id}/replies?limit=100`));
    expect(listed.body.data).toHaveLength(12);
  });

  it('lets a sender edit and delete a reply, and an admin moderate it', async () => {
    const { replies } = await rootWithReplies(2);
    const mine = replies[0];
    const edited = await p.alice.patch(p.path(`/${mine.id}`), { body: 'edited reply' });
    expect(edited.body).toMatchObject({ body: 'edited reply', threadRootId: mine.threadRootId });
    expect((await p.bob.patch(p.path(`/${mine.id}`), { body: 'hijack' })).status).toBe(403);
    expect((await p.alice.delete(p.path(`/${mine.id}`))).status).toBe(204);
    const listed = await p.bob.get(p.path(`/${mine.threadRootId}/replies`));
    expect(listed.body.data[0]).toMatchObject({ id: mine.id, body: null });
  });

  it('keeps replies out of unread counts', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    await p.bob.post(p.path(), { body: 'reply', threadRootId: root.id });
    if (kind === 'channel') {
      const read = await p.bob.post(p.path('/read'), { messageId: root.id });
      expect(read.status).toBe(204);
      expect(
        (await p.alice.post(p.path('/read'), { messageId: (await p.alice.get(p.path())).body.data[0].id })).status,
      ).toBe(204);
      expect((await p.alice.get(p.path())).body.unreadCount).toBe(0);
      expect((await p.alice.post(p.path('/read'), { messageId: randomUUID() })).status).toBe(404);
    }
  });
});

describe('thread events', () => {
  it('announces a channel reply as created, and its root as updated', async () => {
    const p = await makePlace(w, 'channel');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    w.channelEvents.length = 0;
    const reply = (await p.bob.post(p.path(), { body: 'hi', threadRootId: root.id })).body;
    expect(w.channelEvents.map((e) => [e.type, e.messageId])).toEqual([
      ['created', reply.id],
      ['updated', root.id],
    ]);
  });

  it('announces a conversation reply to every participant, its root as updated, without bumping the inbox order', async () => {
    const p = await makePlace(w, 'group');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const conversationId = p.path().split('/')[6]!;
    const [before] = await db.rows<{ last: Date }>(
      'SELECT last_message_at AS last FROM messaging.conversations WHERE id = $1',
      [conversationId],
    );
    w.events.length = 0;
    const reply = (await p.bob.post(p.path(), { body: 'hi', threadRootId: root.id })).body;
    expect(w.events.map((e) => [e.change, e.messageId])).toEqual([
      ['message.created', reply.id],
      ['message.updated', root.id],
    ]);
    expect(w.events[0]!.recipientUserIds).toHaveLength(3);
    const [after] = await db.rows<{ last: Date }>(
      'SELECT last_message_at AS last FROM messaging.conversations WHERE id = $1',
      [conversationId],
    );
    expect(after!.last.getTime()).toBe(before!.last.getTime());
  });
});

describe('history from join', () => {
  it('hides a thread of an older message from a late joiner, root and replies alike', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol, dave] = [w.member(orgId), w.member(orgId), w.member(orgId), w.member(orgId)];
    const id = await alice.group([bob, carol]);
    const base = `/api/v1/orgs/${orgId}/conversations/${id}/messages`;
    const root = (await alice.say(id, 'before dave')).body;
    await asPerson(w, bob).post(base, { body: 'old reply', threadRootId: root.id });
    expect((await alice.put(`/${id}/participants/${dave.userId}`, {})).status).toBe(201);
    const late = asPerson(w, dave);
    expect((await late.get(`${base}/${root.id}/replies`)).status).toBe(404);
    expect((await late.post(base, { body: 'x', threadRootId: root.id })).status).toBe(404);
    // The reply route through reactions and bookmarks is closed too.
    const replyId = (await asPerson(w, alice).get(`${base}/${root.id}/replies`)).body.data[0].id;
    expect((await late.put(`${base}/${replyId}/bookmark`)).status).toBe(404);
    // A fresh thread started after the join is visible.
    const fresh = (await alice.say(id, 'after dave')).body;
    expect((await late.post(base, { body: 'hello', threadRootId: fresh.id })).status).toBe(201);
    expect((await late.get(`${base}/${fresh.id}/replies`)).body.data).toHaveLength(1);
  });
});
