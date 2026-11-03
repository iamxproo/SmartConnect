// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Channel, makePlace, startCollab, type Collab, type Place } from './support/collab.js';
import { Chan, db, problemOf } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

const emoji = (i: number) => String.fromCodePoint(0x1f600 + i);
const react = (p: Place, who: 'alice' | 'bob', messageId: string, e: string) =>
  p[who].put(p.path(`/${messageId}/reactions/${encodeURIComponent(e)}`));
const distinctEmoji = (messageId: string) =>
  db.count('SELECT count(DISTINCT emoji) AS n FROM messaging.message_reactions WHERE message_id = $1', [messageId]);

describe.each(['channel', 'group'] as const)('reaction cap under concurrency in a %s', (kind) => {
  it('never lets concurrent first reactions push a message past 20 different emoji', async () => {
    const p = await makePlace(w, kind);
    const m = (await p.alice.post(p.path(), { body: 'crowded' })).body;
    // 15 different emoji are already there.
    for (let i = 0; i < 15; i++) expect((await react(p, 'alice', m.id, emoji(i))).status).toBe(204);

    const attempts = await Promise.all(
      Array.from({ length: 14 }, (_, i) => react(p, i % 2 ? 'bob' : 'alice', m.id, emoji(15 + i))),
    );
    const statuses = attempts.map((r) => r.status);
    expect(statuses.filter((s) => s === 204)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(attempts.filter((r) => r.status === 409).every((r) => problemOf(r).code === 'too_many_reactions')).toBe(
      true,
    );
    expect(await distinctEmoji(m.id)).toBe(20);

    // An emoji that is already there still takes more reactions at the cap; idempotent adds stay 204.
    expect((await react(p, 'bob', m.id, emoji(0))).status).toBe(204);
    expect((await react(p, 'bob', m.id, emoji(0))).status).toBe(204);
    expect(await distinctEmoji(m.id)).toBe(20);
  });
});

describe('saved messages', () => {
  function conversationOf(p: Place): string {
    return /conversations\/([^/]+)\/messages/.exec(p.path())![1]!;
  }

  it('caps saved messages at 500 per person (409 too_many_bookmarks), even under concurrency', async () => {
    const p = await makePlace(w, 'group');
    const orgId = p.alice.orgId;
    const conversationId = conversationOf(p);
    await db.rows(
      `INSERT INTO messaging.messages (id, organization_id, conversation_id, sender_user_id, body, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'bulk ' || g, clock_timestamp()
       FROM generate_series(1, 495) g`,
      [orgId, conversationId, p.alice.userId],
    );
    await db.rows(
      `INSERT INTO messaging.message_bookmarks (organization_id, user_id, message_id)
       SELECT organization_id, $3, id FROM messaging.messages WHERE conversation_id = $2 AND organization_id = $1`,
      [orgId, conversationId, p.bob.userId],
    );
    const fresh = [];
    for (let i = 0; i < 8; i++) fresh.push((await p.alice.post(p.path(), { body: `fresh ${i}` })).body);

    const saves = await Promise.all(fresh.map((m) => p.bob.put(p.path(`/${m.id}/bookmark`))));
    expect(saves.filter((r) => r.status === 204)).toHaveLength(5);
    const refused = saves.filter((r) => r.status === 409);
    expect(refused).toHaveLength(3);
    expect(problemOf(refused[0]!).code).toBe('too_many_bookmarks');
    const count = () =>
      db.count('SELECT count(*) AS n FROM messaging.message_bookmarks WHERE user_id = $1 AND organization_id = $2', [
        p.bob.userId,
        orgId,
      ]);
    expect(await count()).toBe(500);

    // Saving again what is already saved is idempotent; removing one makes room; others are unaffected.
    const saved = fresh.find((_, i) => saves[i]!.status === 204)!;
    const rejected = fresh.find((_, i) => saves[i]!.status === 409)!;
    expect((await p.bob.put(p.path(`/${saved.id}/bookmark`))).status).toBe(204);
    expect((await p.bob.delete(p.path(`/${saved.id}/bookmark`))).status).toBe(204);
    expect((await p.bob.put(p.path(`/${rejected.id}/bookmark`))).status).toBe(204);
    expect((await p.bob.delete(p.path(`/${rejected.id}/bookmark`))).status).toBe(204);
    expect((await p.alice.put(p.path(`/${rejected.id}/bookmark`))).status).toBe(204);
    expect(await count()).toBe(499);
  });

  it('asks the workspace service about at most 20 channels per request and continues through the cursor', async () => {
    const base = new Channel(w);
    const orgId = base.chan.orgId;
    const alice = base.person();
    const channels = Array.from({ length: 25 }, () => new Chan(orgId));
    const saved: string[] = [];
    for (const chan of channels) {
      w.svc.workspace.show(chan, alice.userId, { isMember: true, myRole: 'member' });
      const m = (await alice.post(chan.path(), { body: `in ${chan.chId}` })).body;
      await alice.put(chan.path(`/${m.id}/bookmark`));
      saved.unshift(m.id); // most recently saved first
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const before = w.svc.workspace.requests.length;
      const res = await alice.saved(`?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(w.svc.workspace.requests.length - before).toBeLessThanOrEqual(20);
      seen.push(...res.body.data.map((m: { id: string }) => m.id));
      cursor = res.body.nextCursor;
      pages++;
      if (pages === 1) {
        // A partial page: fewer than asked for, but a cursor to carry on.
        expect(res.body.data).toHaveLength(20);
        expect(cursor).not.toBeNull();
      }
    } while (cursor && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toEqual(saved);
  });
});

describe.each(['channel', 'group'] as const)('thread summaries after deletes in a %s', (kind) => {
  let p: Place;
  beforeAll(async () => {
    p = await makePlace(w, kind);
  });
  const rootOf = async (id: string) => (await p.alice.get(p.path())).body.data.find((m: { id: string }) => m.id === id);
  const stored = async (id: string) =>
    (
      await db.rows<{ reply_count: number }>(
        'SELECT reply_count FROM messaging.message_threads WHERE root_message_id = $1',
        [id],
      )
    )[0]!.reply_count;

  it('counts only live replies: deleting a reply takes it off the count, once', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const replies: { id: string }[] = [];
    for (let i = 0; i < 4; i++)
      replies.push((await p.bob.post(p.path(), { body: `r${i}`, threadRootId: root.id })).body);
    expect((await rootOf(root.id)).thread.replyCount).toBe(4);

    expect((await p.bob.delete(p.path(`/${replies[0]!.id}`))).status).toBe(204);
    expect((await p.bob.delete(p.path(`/${replies[0]!.id}`))).status).toBe(204); // idempotent: not counted twice
    expect(await stored(root.id)).toBe(3);
    expect((await rootOf(root.id)).thread.replyCount).toBe(3);

    // Concurrent deletes of different replies lose no decrement.
    await Promise.all([1, 2].map((i) => p.bob.delete(p.path(`/${replies[i]!.id}`))));
    expect(await stored(root.id)).toBe(1);

    // The last one gone: no thread summary at all.
    await p.bob.delete(p.path(`/${replies[3]!.id}`));
    expect(await stored(root.id)).toBe(0);
    expect((await rootOf(root.id)).thread).toBeNull();
    // A new reply starts counting again.
    await p.bob.post(p.path(), { body: 'again', threadRootId: root.id });
    expect((await rootOf(root.id)).thread.replyCount).toBe(1);
  });

  it('hides the summary and the replies of a deleted root', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.bob.post(p.path(), { body: 'kept?', threadRootId: root.id })).body;
    await p.alice.delete(p.path(`/${root.id}`));
    expect((await rootOf(root.id)).thread).toBeNull();
    const res = await p.bob.get(p.path(`/${root.id}/replies`));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('kept?');
    expect(reply.id).toBeDefined();
  });
});
