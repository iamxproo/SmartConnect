// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, problemOf, scenario, startMessaging, type TestMessaging } from './support/messaging.js';

let svc: TestMessaging;
beforeAll(async () => {
  svc = await startMessaging();
});
afterAll(async () => {
  await svc.close();
});

describe('posting and reading', () => {
  it('creates the conversation lazily; an untouched channel lists empty', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const empty = await alice.list(chan);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ data: [], nextCursor: null, unreadCount: 0, lastReadMessageId: null });
    expect(await db.conversationCount(chan)).toBe(0);

    const posted = await alice.post(chan, { body: 'hello **world**' });
    expect(posted.status).toBe(201);
    expect(posted.headers.location).toBe(chan.path(`/${posted.body.id}`));
    expect(posted.body).toMatchObject({
      channelId: chan.chId,
      senderUserId: alice.userId,
      type: 'standard',
      body: 'hello **world**',
      clientMessageId: null,
      editedAt: null,
      deletedAt: null,
    });
    expect(await db.conversationCount(chan)).toBe(1);
    const [conversation] = await db.rows<{ kind: string; workspace_id: string; organization_id: string; last: Date }>(
      'SELECT kind, workspace_id, organization_id, last_message_at AS last FROM messaging.conversations WHERE channel_id = $1',
      [chan.chId],
    );
    expect(conversation).toMatchObject({ kind: 'channel', workspace_id: chan.wsId, organization_id: chan.orgId });
    expect(conversation!.last.toISOString()).toBe(posted.body.createdAt);

    const listed = await alice.list(chan);
    expect(listed.body.data.map((m: { id: string }) => m.id)).toEqual([posted.body.id]);
  });

  it('sends the caller token to the workspace service on every request', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const before = svc.workspace.requests.length;
    await alice.list(chan);
    await alice.post(chan, { body: 'x' });
    const calls = svc.workspace.requests.slice(before);
    expect(calls).toHaveLength(2);
    expect(
      calls.every((c) => c.url === `/api/v1/orgs/${chan.orgId}/workspaces/${chan.wsId}/channels/${chan.chId}`),
    ).toBe(true);
    expect(new Set(calls.map((c) => c.authorization)).size).toBe(1);
  });

  it('lets a visible non-member read public history but not post', async () => {
    const { chan, member, reader } = scenario(svc);
    const alice = member();
    const bob = reader();
    await alice.post(chan, { body: 'history' });
    const list = await bob.list(chan);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const post = await bob.post(chan, { body: 'let me in' });
    expect(post.status).toBe(403);
    expect(problemOf(post).code).toBe('not_a_channel_member');
    expect(await db.messageCount(chan)).toBe(1);
  });

  it('refuses posts to an archived channel (409) but still serves history', async () => {
    const { chan, member } = scenario(svc, { archivedAt: new Date().toISOString() });
    const alice = member();
    const res = await alice.post(chan, { body: 'too late' });
    expect(res.status).toBe(409);
    expect(problemOf(res).code).toBe('channel_archived');
    expect(await db.messageCount(chan)).toBe(0);
    expect((await alice.list(chan)).status).toBe(200);
  });

  it.each([
    ['empty', { body: '' }],
    ['blank', { body: ' \n\t ' }],
    ['too long', { body: 'x'.repeat(40_001) }],
    ['NUL character', { body: 'a\u0000b' }],
    ['not a string', { body: 5 }],
    ['missing', {}],
    ['unknown field', { body: 'hi', senderUserId: randomUUID() }],
    ['organization smuggled in', { body: 'hi', organizationId: randomUUID() }],
    ['bad clientMessageId', { body: 'hi', clientMessageId: 'has space' }],
    ['clientMessageId too long', { body: 'hi', clientMessageId: 'a'.repeat(65) }],
  ])('rejects invalid input with 422: %s', async (_name, payload) => {
    const { chan, member } = scenario(svc);
    const res = await member().post(chan, payload);
    expect(res.status).toBe(422);
    expect(problemOf(res).code).toBe('validation_failed');
    expect(await db.messageCount(chan)).toBe(0);
  });

  it('accepts a body of exactly 40 000 characters', async () => {
    const { chan, member } = scenario(svc);
    const res = await member().post(chan, { body: 'y'.repeat(40_000) });
    expect(res.status).toBe(201);
    expect(res.body.body).toHaveLength(40_000);
  });

  it('validates list parameters', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    for (const qs of ['?limit=0', '?limit=101', '?limit=abc', '?cursor=%25%25', '?cursor=bm90LWEtY3Vyc29y', '?x=1']) {
      expect((await alice.list(chan, qs)).status, qs).toBe(422);
    }
  });
});

describe('idempotency', () => {
  it('returns the original message (200) for a repeated clientMessageId, without a duplicate row', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const first = await alice.post(chan, { body: 'once', clientMessageId: 'retry-1' });
    expect(first.status).toBe(201);
    const again = await alice.post(chan, { body: 'once, retried', clientMessageId: 'retry-1' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await db.messageCount(chan)).toBe(1);
    expect(
      await db.count(
        "SELECT count(*) AS n FROM messaging.outbox_events WHERE event_type = 'messaging.message.created' AND aggregate_id = $1",
        [first.body.id],
      ),
    ).toBe(1);
  });

  it('scopes the key per sender and per channel', async () => {
    const one = scenario(svc);
    const two = scenario(svc);
    const alice = one.member();
    const bob = one.member();
    const carol = two.member();
    expect((await alice.post(one.chan, { body: 'a', clientMessageId: 'k' })).status).toBe(201);
    expect((await bob.post(one.chan, { body: 'b', clientMessageId: 'k' })).status).toBe(201);
    svc.workspace.show(two.chan, alice.userId, { isMember: true, myRole: 'member' });
    expect((await alice.post(two.chan, { body: 'c', clientMessageId: 'k' })).status).toBe(201);
    expect((await carol.post(two.chan, { body: 'd', clientMessageId: 'k' })).status).toBe(201);
  });

  it('survives concurrent replays: one row, one 201, the rest 200 with the same message', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => alice.post(chan, { body: 'race', clientMessageId: 'race-key' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.messageCount(chan)).toBe(1);
  });

  it('creates exactly one conversation for concurrent first posts', async () => {
    const { chan, member } = scenario(svc);
    const people = Array.from({ length: 8 }, () => member());
    const results = await Promise.all(people.map((p, i) => p.post(chan, { body: `first ${i}` })));
    expect(results.map((r) => r.status)).toEqual(Array<number>(8).fill(201));
    expect(await db.conversationCount(chan)).toBe(1);
    expect(await db.messageCount(chan)).toBe(8);
  });
});

describe('pagination', () => {
  it('pages newest first with a stable cursor, including identical timestamps', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const first = await alice.post(chan, { body: 'seed' });
    expect(first.status).toBe(201);
    const conversationId = (
      await db.rows<{ conversation_id: string }>('SELECT conversation_id FROM messaging.messages WHERE id = $1', [
        first.body.id,
      ])
    )[0]!.conversation_id;
    // Seven more rows sharing ONE timestamp (a burst within a millisecond), ids in arbitrary order.
    const ts = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 7; i++) {
      await db.rows(
        `INSERT INTO messaging.messages (id, organization_id, conversation_id, sender_user_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), chan.orgId, conversationId, alice.userId, `burst ${i}`, ts],
      );
    }
    const expected = (
      await db.rows<{ id: string }>(
        'SELECT id FROM messaging.messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC',
        [conversationId],
      )
    ).map((r) => r.id);
    expect(expected).toHaveLength(8);
    expect(expected[7]).toBe(first.body.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await alice.list(chan, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((m: { id: string }) => m.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);

    const exact = await alice.list(chan, '?limit=8');
    expect(exact.body.nextCursor).toBeNull();
    expect(exact.body.data).toHaveLength(8);
  });

  it('does not repeat or skip rows when new messages arrive between pages', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    for (let i = 0; i < 5; i++) await alice.post(chan, { body: `m${i}` });
    const page1 = await alice.list(chan, '?limit=2');
    await alice.post(chan, { body: 'newer than the cursor' });
    const page2 = await alice.list(chan, `?limit=2&cursor=${page1.body.nextCursor}`);
    const bodies = [...page1.body.data, ...page2.body.data].map((m: { body: string }) => m.body);
    expect(bodies).toEqual(['m4', 'm3', 'm2', 'm1']);
  });
});

describe('editing and deleting', () => {
  it('lets only the sender edit, and marks editedAt', async () => {
    const { chan, member, admin } = scenario(svc);
    const alice = member();
    const bob = member();
    const boss = admin();
    const msg = (await alice.post(chan, { body: 'draft' })).body;
    const edited = await alice.edit(chan, msg.id, { body: 'final' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: msg.id, body: 'final' });
    expect(edited.body.editedAt).not.toBeNull();
    for (const other of [bob, boss]) {
      const res = await other.edit(chan, msg.id, { body: 'hijack' });
      expect(res.status).toBe(403);
    }
    expect((await alice.list(chan)).body.data[0].body).toBe('final');
    expect((await alice.edit(chan, msg.id, { body: '  ' })).status).toBe(422);
    expect((await alice.edit(chan, msg.id, { body: 'x', senderUserId: bob.userId })).status).toBe(422);
  });

  it('erases the body on delete, is idempotent, and blocks later edits (409)', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const msg = (await alice.post(chan, { body: 'secret plan' })).body;
    expect((await alice.remove(chan, msg.id)).status).toBe(204);
    expect((await alice.remove(chan, msg.id)).status).toBe(204);

    const [row] = await db.rows<{ body: string; deleted_at: Date | null }>(
      'SELECT body, deleted_at FROM messaging.messages WHERE id = $1',
      [msg.id],
    );
    expect(row!.body).toBe('');
    expect(row!.deleted_at).not.toBeNull();
    expect(
      await db.count(
        "SELECT count(*) AS n FROM messaging.outbox_events WHERE event_type = 'messaging.message.deleted' AND aggregate_id = $1",
        [msg.id],
      ),
    ).toBe(1);

    const listed = (await alice.list(chan)).body.data[0];
    expect(listed.body).toBeNull();
    expect(listed.deletedAt).not.toBeNull();
    const edit = await alice.edit(chan, msg.id, { body: 'resurrect' });
    expect(edit.status).toBe(409);
    expect(problemOf(edit).code).toBe('message_deleted');
    expect(
      (await db.rows<{ body: string }>('SELECT body FROM messaging.messages WHERE id = $1', [msg.id]))[0]!.body,
    ).toBe('');
  });

  it('lets a channel admin delete others messages, but not a plain member', async () => {
    const { chan, member, admin } = scenario(svc);
    const alice = member();
    const bob = member();
    const boss = admin();
    const msg = (await alice.post(chan, { body: 'moderate me' })).body;
    const denied = await bob.remove(chan, msg.id);
    expect(denied.status).toBe(403);
    expect((await alice.list(chan)).body.data[0].body).toBe('moderate me');
    expect((await boss.remove(chan, msg.id)).status).toBe(204);
    expect((await alice.list(chan)).body.data[0].body).toBeNull();
  });

  it('writes content-free outbox events', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const msg = (await alice.post(chan, { body: 'private words' })).body;
    await alice.edit(chan, msg.id, { body: 'other private words' });
    await alice.remove(chan, msg.id);
    const events = await db.rows<{ event_type: string; payload: Record<string, string>; organization_id: string }>(
      'SELECT event_type, payload, organization_id FROM messaging.outbox_events WHERE aggregate_id = $1 ORDER BY id',
      [msg.id],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'messaging.message.created',
      'messaging.message.updated',
      'messaging.message.deleted',
    ]);
    expect(events.every((e) => e.organization_id === chan.orgId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('words');
    expect(events[0]!.payload).toMatchObject({ messageId: msg.id, channelId: chan.chId, workspaceId: chan.wsId });
  });
});
