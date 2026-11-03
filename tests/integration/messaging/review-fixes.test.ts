// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
// Wave 2 security-review fixes: replies whose thread root is deleted or precedes the caller's join are unreadable
// everywhere (activity, saved messages, attachment access); attachment access beyond the old budgets; reactions on
// deleted messages; forged cursors.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, Channel, makePlace, type Person } from './support/collab.js';
import { startCollabWithFiles, type FilesCollab } from './support/files.js';
import { db, problemOf } from './support/messaging.js';

let w: FilesCollab;
beforeAll(async () => {
  w = await startCollabWithFiles();
});
afterEach(() => {
  w.svc.workspace.listFailure = null;
});
afterAll(async () => {
  await w.close();
});

const tok = (p: Person) => `<@${p.userId}>`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const activity = (p: Person, qs = '') => p.get(`/api/v1/orgs/${p.orgId}/activity${qs}`);
const activityIds = async (p: Person, qs = '') =>
  ((await activity(p, qs)).body.data as { id: string }[]).map((i) => i.id);
const unread = async (p: Person) => (await p.get(`/api/v1/orgs/${p.orgId}/activity/unread-count`)).body.count as number;
const savedIds = async (p: Person) => ((await p.saved()).body.data as { id: string }[]).map((m) => m.id);
/** Makes `who` have joined the conversation of `messageId` exactly when that message was posted (after its root). */
const joinAt = (who: Person, messageId: string) =>
  db.rows(
    `UPDATE messaging.conversation_members SET joined_at = (SELECT created_at FROM messaging.messages WHERE id = $2)
     WHERE user_id = $1`,
    [who.userId, messageId],
  );

describe('activity and saved messages follow the thread rules (group)', () => {
  it('a mention in a reply of a deleted root is gone, from the list and the unread count', async () => {
    const p = await makePlace(w, 'group');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.alice.post(p.path(), { body: `hey ${tok(p.bob)}`, threadRootId: root.id })).body;
    expect(await activityIds(p.bob)).toEqual([`mention:${reply.id}`]);
    expect(await unread(p.bob)).toBe(1);
    expect((await p.alice.delete(p.path(`/${root.id}`))).status).toBe(204);
    expect(await activityIds(p.bob)).toEqual([]);
    expect(await unread(p.bob)).toBe(0);
  });

  it('a thread reply of a deleted root is gone, from the list and the unread count', async () => {
    const p = await makePlace(w, 'channel');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.bob.post(p.path(), { body: 'reply', threadRootId: root.id })).body;
    expect(await activityIds(p.alice)).toEqual([`thread_reply:${reply.id}`]);
    expect(await unread(p.alice)).toBe(1);
    await p.alice.delete(p.path(`/${root.id}`));
    expect(await activityIds(p.alice)).toEqual([]);
    expect(await unread(p.alice)).toBe(0);
  });

  it('a mention in a reply of a root from before my join is hidden; later roots are not', async () => {
    const p = await makePlace(w, 'group');
    const root = (await p.alice.post(p.path(), { body: 'old root' })).body;
    await sleep(5);
    const reply = (await p.alice.post(p.path(), { body: `hey ${tok(p.bob)}`, threadRootId: root.id })).body;
    const direct = (await p.alice.post(p.path(), { body: `top level ${tok(p.bob)}` })).body;
    expect(await unread(p.bob)).toBe(2);
    await joinAt(p.bob, reply.id);
    expect(await activityIds(p.bob)).toEqual([`mention:${direct.id}`]);
    expect(await activityIds(p.bob, '?filter=mentions')).toEqual([`mention:${direct.id}`]);
    expect(await unread(p.bob)).toBe(1);
  });

  it('a thread reply under a root from before my join is hidden', async () => {
    const p = await makePlace(w, 'group');
    const root = (await p.alice.post(p.path(), { body: 'old root' })).body;
    await sleep(5);
    const mine = (await p.bob.post(p.path(), { body: 'mine', threadRootId: root.id })).body;
    await p.alice.post(p.path(), { body: 'answer', threadRootId: root.id });
    expect(await unread(p.bob)).toBe(1);
    await joinAt(p.bob, mine.id);
    expect(await activityIds(p.bob)).toEqual([]);
    expect(await unread(p.bob)).toBe(0);
  });

  it('saved: a reply of a root from before my join is not listed', async () => {
    const p = await makePlace(w, 'group');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    await sleep(5);
    const reply = (await p.alice.post(p.path(), { body: 'reply', threadRootId: root.id })).body;
    const plain = (await p.alice.post(p.path(), { body: 'plain' })).body;
    for (const m of [reply, plain]) expect((await p.bob.put(p.path(`/${m.id}/bookmark`))).status).toBe(204);
    expect(await savedIds(p.bob)).toEqual([plain.id, reply.id]);
    await joinAt(p.bob, reply.id);
    expect(await savedIds(p.bob)).toEqual([plain.id]);
  });

  it('saved: a reply of a deleted root is not listed (group)', async () => {
    const p = await makePlace(w, 'group');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.alice.post(p.path(), { body: 'reply', threadRootId: root.id })).body;
    const plain = (await p.alice.post(p.path(), { body: 'plain' })).body;
    for (const m of [reply, plain]) expect((await p.bob.put(p.path(`/${m.id}/bookmark`))).status).toBe(204);
    expect(await savedIds(p.bob)).toEqual([plain.id, reply.id]);
    await p.alice.delete(p.path(`/${root.id}`));
    expect(await savedIds(p.bob)).toEqual([plain.id]);
  });

  it('saved: a reply of a deleted root in a channel is not listed', async () => {
    const p = await makePlace(w, 'channel');
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.alice.post(p.path(), { body: 'reply', threadRootId: root.id })).body;
    await p.bob.put(p.path(`/${reply.id}/bookmark`));
    expect(await savedIds(p.bob)).toEqual([reply.id]);
    await p.alice.delete(p.path(`/${root.id}`));
    expect(await savedIds(p.bob)).toEqual([]);
  });
});

describe('attachment access decided in one query', () => {
  const accessPath = (orgId: string, fileId: string) => `/api/v1/orgs/${orgId}/attachments/${fileId}`;

  it('a file posted in 25 channels is readable when only the first (oldest) one is visible, with one workspace call', async () => {
    const first = new Channel(w);
    const orgId = first.chan.orgId;
    const alice = first.person();
    const channels = [first];
    for (let i = 1; i < 25; i++) {
      const c = new Channel(w);
      Object.assign(c, { chan: c.chan.inOrg(orgId) });
      w.svc.workspace.show(c.chan, alice.userId, { isMember: true, myRole: 'member' });
      channels.push(c);
    }
    const f = w.files.add(orgId, alice.userId);
    for (const c of channels)
      expect((await alice.post(c.path(), { body: 'f', attachmentFileIds: [f] })).status).toBe(201);
    for (const c of channels.slice(1)) w.svc.workspace.hide(c.chan, alice.userId);

    const before = w.svc.workspace.requests.length;
    const res = await alice.get(accessPath(orgId, f));
    expect(res.status).toBe(200);
    expect(w.svc.workspace.requests.length - before).toBe(1);

    w.svc.workspace.hide(first.chan, alice.userId);
    expect((await alice.get(accessPath(orgId, f))).status).toBe(404);
    // The workspace service failing is a 503, never an implicit yes.
    w.svc.workspace.show(first.chan, alice.userId, { isMember: true, myRole: 'member' });
    w.svc.workspace.listFailure = 'error';
    expect((await alice.get(accessPath(orgId, f))).status).toBe(503);
  });

  it('a direct conversation: the two people see the file, others do not', async () => {
    const orgId = w.newOrg();
    const [alice, bob, eve] = [w.member(orgId), w.member(orgId), w.member(orgId)];
    const opened = await alice.openDirect(bob);
    const id = opened.body.id as string;
    const f = w.files.add(orgId, alice.userId);
    expect((await alice.post(`/${id}/messages`, { body: 'for you', attachmentFileIds: [f] })).status).toBe(201);
    expect((await asPerson(w, alice).get(accessPath(orgId, f))).status).toBe(200);
    expect((await asPerson(w, bob).get(accessPath(orgId, f))).status).toBe(200);
    expect((await asPerson(w, eve).get(accessPath(orgId, f))).status).toBe(404);
  });

  it('a file on a reply is readable only while its root is readable (deleted, or from before my join)', async () => {
    const p = await makePlace(w, 'group');
    const orgId = p.alice.orgId;
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    await sleep(5);
    const f = w.files.add(orgId, p.alice.userId);
    const reply = (await p.alice.post(p.path(), { body: 'r', threadRootId: root.id, attachmentFileIds: [f] })).body;
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(200);
    await joinAt(p.bob, reply.id);
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(404);
  });
});

describe('reactions and deleted messages', () => {
  it('a tombstone shows no reactions even if a reaction row survived the delete', async () => {
    const p = await makePlace(w, 'group');
    const m = (await p.alice.post(p.path(), { body: 'short lived' })).body;
    expect((await p.bob.put(p.path(`/${m.id}/reactions/${encodeURIComponent('👍')}`))).status).toBe(204);
    await p.alice.delete(p.path(`/${m.id}`));
    expect((await p.bob.put(p.path(`/${m.id}/reactions/${encodeURIComponent('❤️')}`))).status).toBe(409);
    // A reaction that slipped in around the delete (written directly here) is not shown.
    await db.rows(
      `INSERT INTO messaging.message_reactions (organization_id, message_id, user_id, emoji)
       VALUES ($1, $2, $3, '🎉')`,
      [p.alice.orgId, m.id, p.bob.userId],
    );
    const shown = (await p.bob.get(p.path())).body.data.find((x: { id: string }) => x.id === m.id);
    expect(shown).toMatchObject({ deletedAt: expect.any(String), reactions: [] });
  });
});

describe('forged cursors are 422, never 500', () => {
  // 15 digits: the largest millisecond value the cursor format can carry (year 33658).
  const forged = Buffer.from(`999999999999999.${randomUUID()}`).toString('base64url');

  it('on history, search, activity and saved messages', async () => {
    const p = await makePlace(w, 'channel');
    await p.alice.post(p.path(), { body: 'findme' });
    const org = p.alice.orgId;
    const responses = [
      await p.alice.get(p.path(`?cursor=${forged}`)),
      await p.alice.get(`/api/v1/orgs/${org}/message-search?q=findme&cursor=${forged}`),
      await p.alice.get(`/api/v1/orgs/${org}/activity?cursor=${forged}`),
      await p.alice.saved(`?cursor=${forged}`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('validation_failed');
    }
  });
});
