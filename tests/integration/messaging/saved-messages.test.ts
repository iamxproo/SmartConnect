// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, Channel, makePlace, startCollab, type Collab, type Place } from './support/collab.js';
import { problemOf } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((m) => m.id);

describe.each(['channel', 'group'] as const)('saving messages in a %s', (kind) => {
  let p: Place;
  beforeAll(async () => {
    p = await makePlace(w, kind);
  });

  it('saves and unsaves idempotently, privately, and flags it on the message', async () => {
    const m = (await p.alice.post(p.path(), { body: 'keep me' })).body;
    expect(m.bookmarked).toBe(false);
    expect((await p.bob.put(p.path(`/${m.id}/bookmark`))).status).toBe(204);
    expect((await p.bob.put(p.path(`/${m.id}/bookmark`))).status).toBe(204);
    const seen = async (who: 'alice' | 'bob') =>
      (await p[who].get(p.path())).body.data.find((x: { id: string }) => x.id === m.id).bookmarked;
    expect(await seen('bob')).toBe(true);
    expect(await seen('alice')).toBe(false);
    expect(ids(await p.alice.saved())).not.toContain(m.id);
    expect((await p.bob.delete(p.path(`/${m.id}/bookmark`))).status).toBe(204);
    expect((await p.bob.delete(p.path(`/${m.id}/bookmark`))).status).toBe(204);
    expect(await seen('bob')).toBe(false);
  });

  it('is closed to strangers, unknown messages and other places', async () => {
    const m = (await p.alice.post(p.path(), { body: 'private' })).body;
    expect((await p.outsider.put(p.path(`/${m.id}/bookmark`))).status).toBe(404);
    expect((await p.outsider.delete(p.path(`/${m.id}/bookmark`))).status).toBe(404);
    expect((await p.bob.put(p.path(`/${randomUUID()}/bookmark`))).status).toBe(404);
    const other = await makePlace(w, kind);
    expect((await other.alice.put(other.path(`/${m.id}/bookmark`))).status).toBe(404);
  });

  it('refuses to save a deleted message (409) but lets its bookmark go; the list drops it', async () => {
    const m = (await p.alice.post(p.path(), { body: 'short lived' })).body;
    await p.bob.put(p.path(`/${m.id}/bookmark`));
    await p.alice.delete(p.path(`/${m.id}`));
    expect(ids(await p.bob.saved())).not.toContain(m.id);
    expect((await p.bob.put(p.path(`/${m.id}/bookmark`))).status).toBe(409);
    expect((await p.bob.delete(p.path(`/${m.id}/bookmark`))).status).toBe(204);
  });

  it('lists what I saved, most recently saved first, with where it lives and its reactions and thread', async () => {
    const q = await makePlace(w, kind);
    const posted = [];
    for (const body of ['one', 'two', 'three']) posted.push((await q.alice.post(q.path(), { body })).body);
    await q.bob.put(q.path(`/${posted[0].id}/bookmark`));
    await q.bob.put(q.path(`/${posted[2].id}/bookmark`));
    await q.bob.put(q.path(`/${posted[1].id}/bookmark`));
    await q.alice.put(q.path(`/${posted[2].id}/reactions/${encodeURIComponent('👍')}`));
    await q.bob.post(q.path(), { body: 'in thread', threadRootId: posted[2].id });

    const listed = await q.bob.saved();
    expect(listed.status).toBe(200);
    expect(ids(listed)).toEqual([posted[1].id, posted[2].id, posted[0].id]);
    expect(listed.body.nextCursor).toBeNull();
    const item = listed.body.data[1];
    expect(item).toMatchObject({
      body: 'three',
      bookmarked: true,
      kind: kind === 'channel' ? 'channel' : 'group',
      reactions: [{ emoji: '👍', count: 1, reacted: false }],
      thread: { replyCount: 1 },
    });
    expect(item.savedAt).toEqual(expect.any(String));
    if (kind === 'channel')
      expect(item).toMatchObject({ channelId: expect.any(String), workspaceId: expect.any(String) });
    else expect(item).toMatchObject({ channelId: null, workspaceId: null });

    const first = await q.bob.saved('?limit=2');
    expect(ids(first)).toEqual([posted[1].id, posted[2].id]);
    const rest = await q.bob.saved(`?limit=2&cursor=${first.body.nextCursor}`);
    expect(ids(rest)).toEqual([posted[0].id]);
    expect(rest.body.nextCursor).toBeNull();
    expect((await q.bob.saved('?cursor=garbage')).status).toBe(422);
  });

  it('saves a thread reply', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const reply = (await p.bob.post(p.path(), { body: 'saved reply', threadRootId: root.id })).body;
    expect((await p.alice.put(p.path(`/${reply.id}/bookmark`))).status).toBe(204);
    expect((await p.alice.saved()).body.data[0]).toMatchObject({ id: reply.id, threadRootId: root.id });
  });
});

describe('visibility is re-checked when the list is read', () => {
  it('leaves out a channel the caller lost access to, without its content, and brings it back with access', async () => {
    const channel = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()];
    const m = (await alice.post(channel.path(), { body: 'confidential roadmap' })).body;
    await bob.put(channel.path(`/${m.id}/bookmark`));
    expect(ids(await bob.saved())).toEqual([m.id]);

    w.svc.workspace.hide(channel.chan, bob.userId);
    const hidden = await bob.saved();
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ data: [], nextCursor: null });
    expect(JSON.stringify(hidden.body)).not.toContain('confidential');

    w.svc.workspace.show(channel.chan, bob.userId, { isMember: false, myRole: null });
    expect(ids(await bob.saved())).toEqual([m.id]);
  });

  it('asks the workspace service as the caller, once per distinct channel per request', async () => {
    const [one, two] = [new Channel(w), new Channel(w)];
    const orgId = one.chan.orgId;
    // The same organization for both channels, as a real organization would have.
    const twoInOrg = Object.assign(two, { chan: two.chan.inOrg(orgId) });
    const alice = one.person();
    w.svc.workspace.show(twoInOrg.chan, alice.userId, { isMember: true, myRole: 'member' });
    for (let i = 0; i < 3; i++) {
      const m = (await alice.post(one.path(), { body: `a${i}` })).body;
      await alice.put(one.path(`/${m.id}/bookmark`));
    }
    for (let i = 0; i < 2; i++) {
      const m = (await alice.post(twoInOrg.path(), { body: `b${i}` })).body;
      await alice.put(twoInOrg.path(`/${m.id}/bookmark`));
    }
    const before = w.svc.workspace.requests.length;
    const res = await alice.saved();
    expect(res.body.data).toHaveLength(5);
    const calls = w.svc.workspace.requests.slice(before);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.url)).size).toBe(2);
    expect(calls.every((c) => c.authorization?.startsWith('Bearer '))).toBe(true);
  });

  it('fills a page from what is visible when hidden messages are interleaved', async () => {
    const [open, closed] = [new Channel(w), new Channel(w)];
    const orgId = open.chan.orgId;
    const secret = Object.assign(closed, { chan: closed.chan.inOrg(orgId) });
    const alice = open.person();
    const owner = secret.person();
    w.svc.workspace.show(secret.chan, alice.userId, { isMember: true, myRole: 'member' });
    const visible = [];
    for (let i = 0; i < 4; i++) {
      const mine = (await alice.post(open.path(), { body: `open ${i}` })).body;
      const theirs = (await owner.post(secret.path(), { body: `secret ${i}` })).body;
      await alice.put(open.path(`/${mine.id}/bookmark`));
      await alice.put(secret.path(`/${theirs.id}/bookmark`));
      visible.push(mine.id);
    }
    w.svc.workspace.hide(secret.chan, alice.userId);
    const first = await alice.saved('?limit=3');
    expect(ids(first)).toEqual(visible.slice().reverse().slice(0, 3));
    expect(first.body.nextCursor).not.toBeNull();
    const second = await alice.saved(`?limit=3&cursor=${first.body.nextCursor}`);
    expect(ids(second)).toEqual([visible[0]]);
    expect(second.body.nextCursor).toBeNull();
    expect(JSON.stringify([first.body, second.body])).not.toContain('secret');
  });

  it('fails closed when the workspace service cannot answer, and on other organizations', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    const m = (await alice.post(channel.path(), { body: 'x' })).body;
    await alice.put(channel.path(`/${m.id}/bookmark`));
    w.svc.workspace.break(channel.chan, alice.userId, 'error');
    const res = await alice.saved();
    expect(res.status).toBe(503);
    expect(res.body.data).toBeUndefined();
    expect(problemOf(res).code).toBe('dependency_unavailable');

    const stranger = asPerson(w, w.member(w.newOrg()));
    expect((await stranger.call('get', `/api/v1/orgs/${channel.chan.orgId}/saved-messages`)).status).toBe(404);
  });

  it('leaves out a conversation the caller was removed from, even after being added again', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol] = [w.member(orgId), w.member(orgId), w.member(orgId)];
    const id = await alice.group([bob, carol]);
    const base = `/api/v1/orgs/${orgId}/conversations/${id}/messages`;
    const m = (await alice.say(id, 'group secret')).body;
    const him = asPerson(w, bob);
    await him.put(`${base}/${m.id}/bookmark`);
    expect(ids(await him.saved())).toEqual([m.id]);

    await alice.delete(`/${id}/participants/${bob.userId}`);
    const gone = await him.saved();
    expect(gone.body).toEqual({ data: [], nextCursor: null });
    expect(JSON.stringify(gone.body)).not.toContain('group secret');

    // Back in the group, history starts at the new join: the old message stays hidden.
    await alice.put(`/${id}/participants/${bob.userId}`, {});
    expect(ids(await him.saved())).toEqual([]);
  });

  it('keeps each person bookmarks to themselves', async () => {
    const p = await makePlace(w, 'group');
    const m = (await p.alice.post(p.path(), { body: 'shared' })).body;
    await p.alice.put(p.path(`/${m.id}/bookmark`));
    expect(ids(await p.alice.saved())).toEqual([m.id]);
    expect(ids(await p.bob.saved())).toEqual([]);
  });
});

describe('bookmark events', () => {
  it('reaches only the caller on a conversation, and the channel path on a channel', async () => {
    const g = await makePlace(w, 'group');
    const m = (await g.alice.post(g.path(), { body: 'e' })).body;
    w.events.length = 0;
    await g.bob.put(g.path(`/${m.id}/bookmark`));
    await g.bob.put(g.path(`/${m.id}/bookmark`));
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ change: 'message.updated', messageId: m.id, recipientUserIds: [g.bob.userId] });

    const c = await makePlace(w, 'channel');
    const cm = (await c.alice.post(c.path(), { body: 'e' })).body;
    w.channelEvents.length = 0;
    await c.bob.put(c.path(`/${cm.id}/bookmark`));
    await c.bob.put(c.path(`/${cm.id}/bookmark`));
    await c.bob.delete(c.path(`/${cm.id}/bookmark`));
    expect(w.channelEvents.map((e) => [e.type, e.messageId])).toEqual([
      ['updated', cm.id],
      ['updated', cm.id],
    ]);
  });
});
