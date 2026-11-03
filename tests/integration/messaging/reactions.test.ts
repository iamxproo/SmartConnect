// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, Channel, makePlace, startCollab, type Collab, type Place } from './support/collab.js';
import { db, problemOf } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

const THUMBS = encodeURIComponent('👍');
const HEART = encodeURIComponent('❤️');
const reactionsOf = async (p: Place, who: 'alice' | 'bob', id: string) =>
  (await p[who].get(p.path())).body.data.find((m: { id: string }) => m.id === id).reactions;

describe.each(['channel', 'group'] as const)('reactions in a %s', (kind) => {
  let p: Place;
  beforeAll(async () => {
    p = await makePlace(w, kind);
  });

  it('adds idempotently, counts per emoji and tells each caller whether they reacted', async () => {
    const m = (await p.alice.post(p.path(), { body: 'react to me' })).body;
    expect(m.reactions).toEqual([]);
    expect((await p.alice.put(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(204);
    expect((await p.alice.put(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(204);
    expect((await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(204);
    expect((await p.bob.put(p.path(`/${m.id}/reactions/${HEART}`))).status).toBe(204);
    expect(await reactionsOf(p, 'alice', m.id)).toEqual([
      { emoji: '👍', count: 2, reacted: true },
      { emoji: '❤️', count: 1, reacted: false },
    ]);
    expect(await reactionsOf(p, 'bob', m.id)).toEqual([
      { emoji: '👍', count: 2, reacted: true },
      { emoji: '❤️', count: 1, reacted: true },
    ]);
  });

  it('removes idempotently and only the caller own reaction', async () => {
    const m = (await p.alice.post(p.path(), { body: 'toggle' })).body;
    await p.alice.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    expect((await p.bob.delete(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(204);
    expect((await p.bob.delete(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(204);
    expect(await reactionsOf(p, 'alice', m.id)).toEqual([{ emoji: '👍', count: 1, reacted: true }]);
    await p.alice.delete(p.path(`/${m.id}/reactions/${THUMBS}`));
    expect(await reactionsOf(p, 'alice', m.id)).toEqual([]);
  });

  it('rejects anything that is not one emoji of at most 64 bytes with 422', async () => {
    const m = (await p.alice.post(p.path(), { body: 'validate' })).body;
    const bad = ['a', ':thumbsup:', '👍👍', '1', '<b>', '%20', 'x'.repeat(70), '👨‍👩‍👧‍👦'.repeat(3)];
    for (const emoji of bad) {
      const res = await p.alice.put(p.path(`/${m.id}/reactions/${encodeURIComponent(emoji)}`));
      expect(res.status, emoji).toBe(422);
      expect(problemOf(res).errors?.[0]).toMatchObject({ field: 'emoji', code: 'invalid_emoji' });
      expect((await p.alice.delete(p.path(`/${m.id}/reactions/${encodeURIComponent(emoji)}`))).status).toBe(422);
    }
    // An invalid percent-encoding never reaches the database and is never a server error.
    const broken = await p.alice.put(p.path(`/${m.id}/reactions/%F0%9F%91`));
    expect(broken.status).toBeGreaterThanOrEqual(400);
    expect(broken.status).toBeLessThan(500);
    expect(await db.count('SELECT count(*) AS n FROM messaging.message_reactions WHERE message_id = $1', [m.id])).toBe(
      0,
    );
  });

  it('is closed to strangers, to other places and to unknown messages', async () => {
    const m = (await p.alice.post(p.path(), { body: 'private' })).body;
    expect((await p.outsider.put(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(404);
    expect((await p.outsider.delete(p.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(404);
    expect((await p.alice.put(p.path(`/${randomUUID()}/reactions/${THUMBS}`))).status).toBe(404);
    const other = await makePlace(w, kind);
    expect((await other.alice.put(other.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(404);
    expect(await db.count('SELECT count(*) AS n FROM messaging.message_reactions WHERE message_id = $1', [m.id])).toBe(
      0,
    );
  });

  it('refuses a deleted message (409) and erases the reactions it had', async () => {
    const m = (await p.alice.post(p.path(), { body: 'gone soon' })).body;
    await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    await p.alice.delete(p.path(`/${m.id}`));
    expect(await db.count('SELECT count(*) AS n FROM messaging.message_reactions WHERE message_id = $1', [m.id])).toBe(
      0,
    );
    expect((await p.bob.put(p.path(`/${m.id}/reactions/${HEART}`))).status).toBe(409);
    expect((await p.bob.delete(p.path(`/${m.id}/reactions/${HEART}`))).status).toBe(409);
  });

  it('reacts to thread replies, and keeps concurrent identical reactions at one', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.bob.post(p.path(), { body: 'reply', threadRootId: root.id })).body;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => p.alice.put(p.path(`/${reply.id}/reactions/${THUMBS}`))),
    );
    expect(results.every((r) => r.status === 204)).toBe(true);
    const listed = await p.alice.get(p.path(`/${root.id}/replies`));
    expect(listed.body.data[0].reactions).toEqual([{ emoji: '👍', count: 1, reacted: true }]);
  });

  it('allows at most 20 different emoji on one message', async () => {
    const m = (await p.alice.post(p.path(), { body: 'crowded' })).body;
    const emoji = (i: number) => encodeURIComponent(String.fromCodePoint(0x1f600 + i));
    for (let i = 0; i < 20; i++) expect((await p.alice.put(p.path(`/${m.id}/reactions/${emoji(i)}`))).status).toBe(204);
    expect((await p.alice.put(p.path(`/${m.id}/reactions/${emoji(20)}`))).status).toBe(409);
    expect((await p.bob.put(p.path(`/${m.id}/reactions/${emoji(0)}`))).status).toBe(204);
  });

  it('shows aggregated reactions across a whole page', async () => {
    const q = await makePlace(w, kind);
    const posted = [];
    for (let i = 0; i < 5; i++) posted.push((await q.alice.post(q.path(), { body: `m${i}` })).body);
    for (const m of posted.slice(0, 4)) await q.bob.put(q.path(`/${m.id}/reactions/${THUMBS}`));
    const page = await q.alice.get(q.path());
    const counts = page.body.data.map((m: { reactions: unknown[] }) => m.reactions.length).reverse();
    expect(counts).toEqual([1, 1, 1, 1, 0]);
  });
});

describe('channel reactions: who may react', () => {
  it('lets only posters add a reaction, readers may take theirs back, an archived channel is read only', async () => {
    const channel = new Channel(w);
    const member = channel.person();
    const reader = channel.person('reader');
    const m = (await member.post(channel.path(), { body: 'hello' })).body;
    const forbidden = await reader.put(channel.path(`/${m.id}/reactions/${THUMBS}`));
    expect(forbidden.status).toBe(403);
    expect(problemOf(forbidden).code).toBe('not_a_channel_member');
    await member.put(channel.path(`/${m.id}/reactions/${THUMBS}`));
    expect((await reader.get(channel.path())).body.data[0].reactions).toEqual([
      { emoji: '👍', count: 1, reacted: false },
    ]);

    w.svc.workspace.show(channel.chan, member.userId, {
      isMember: true,
      myRole: 'member',
      archivedAt: new Date().toISOString(),
    });
    const archived = await member.put(channel.path(`/${m.id}/reactions/${HEART}`));
    expect(archived.status).toBe(409);
    expect(problemOf(archived).code).toBe('channel_archived');
    expect((await member.delete(channel.path(`/${m.id}/reactions/${THUMBS}`))).status).toBe(204);

    channel.hide(reader);
    expect((await reader.get(channel.path())).status).toBe(404);
  });
});

describe('reaction events', () => {
  it('announces a changed channel message once, and nothing for an idempotent repeat', async () => {
    const p = await makePlace(w, 'channel');
    const m = (await p.alice.post(p.path(), { body: 'events' })).body;
    w.channelEvents.length = 0;
    await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    expect(w.channelEvents.map((e) => [e.type, e.messageId])).toEqual([['updated', m.id]]);
    await p.bob.delete(p.path(`/${m.id}/reactions/${THUMBS}`));
    await p.bob.delete(p.path(`/${m.id}/reactions/${THUMBS}`));
    expect(w.channelEvents).toHaveLength(2);
  });

  it('announces a changed conversation message to every participant', async () => {
    const p = await makePlace(w, 'group');
    const m = (await p.alice.post(p.path(), { body: 'events' })).body;
    w.events.length = 0;
    await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    await p.bob.put(p.path(`/${m.id}/reactions/${THUMBS}`));
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ change: 'message.updated', messageId: m.id });
    expect(w.events[0]!.recipientUserIds).toHaveLength(3);
  });
});

describe('history from join', () => {
  it('keeps a late joiner from reacting to, or seeing reactions on, older messages', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol, dave] = [w.member(orgId), w.member(orgId), w.member(orgId), w.member(orgId)];
    const id = await alice.group([bob, carol]);
    const base = `/api/v1/orgs/${orgId}/conversations/${id}/messages`;
    const old = (await alice.say(id, 'before dave')).body;
    await alice.put(`/${id}/participants/${dave.userId}`, {});
    const late = asPerson(w, dave);
    expect((await late.put(`${base}/${old.id}/reactions/${THUMBS}`)).status).toBe(404);
    expect((await late.get(base)).body.data).toEqual([]);
    const fresh = (await alice.say(id, 'after dave')).body;
    expect((await late.put(`${base}/${fresh.id}/reactions/${THUMBS}`)).status).toBe(204);
  });
});
