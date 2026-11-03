// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, makePlace, startCollab, type Collab, type Place } from './support/collab.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((m) => m.id);

/** n top-level messages from alice, oldest first. */
async function post(p: Place, n: number): Promise<{ id: string; body: string }[]> {
  const out = [];
  for (let i = 1; i <= n; i++) out.push((await p.alice.post(p.path(), { body: `m${i}` })).body);
  return out;
}

describe.each(['channel', 'group'] as const)('message context in a %s', (kind) => {
  let p: Place;
  beforeAll(async () => {
    p = await makePlace(w, kind);
  });

  it('returns older messages, the target and newer messages, oldest first', async () => {
    const q = await makePlace(w, kind);
    const m = await post(q, 7);
    const res = await q.bob.get(q.path(`/${m[3]!.id}/context?before=2&after=2`));
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([m[1]!.id, m[2]!.id, m[3]!.id, m[4]!.id, m[5]!.id]);
    expect(res.body).toMatchObject({ targetId: m[3]!.id, isReply: false, replyId: null });
    expect(res.body.data[2]).toMatchObject({ body: 'm4', attachments: [], reactions: [], bookmarked: false });
  });

  it('defaults to 10 each way, stops at either end of the history, and honours 0', async () => {
    const q = await makePlace(w, kind);
    const m = await post(q, 4);
    expect(ids(await q.alice.get(q.path(`/${m[1]!.id}/context`)))).toEqual(m.map((x) => x.id));
    expect(ids(await q.alice.get(q.path(`/${m[0]!.id}/context?before=5&after=1`)))).toEqual([m[0]!.id, m[1]!.id]);
    expect(ids(await q.alice.get(q.path(`/${m[3]!.id}/context?before=0&after=0`)))).toEqual([m[3]!.id]);
    const many = await post(q, 30);
    const middle = await q.alice.get(q.path(`/${many[15]!.id}/context?before=25&after=25`));
    expect(middle.body.data).toHaveLength(34);
    expect(middle.body.data.filter((x: { id: string }) => x.id === many[15]!.id)).toHaveLength(1);
  });

  it('refuses sizes outside 0 to 25 (422) and unknown, foreign or malformed messages (404)', async () => {
    const m = (await p.alice.post(p.path(), { body: 'x' })).body;
    for (const qs of ['before=26', 'after=26', 'before=-1', 'after=x', 'before=1.5'])
      expect((await p.alice.get(p.path(`/${m.id}/context?${qs}`))).status, qs).toBe(422);
    expect((await p.alice.get(p.path(`/${randomUUID()}/context`))).status).toBe(404);
    expect((await p.alice.get(p.path('/not-a-uuid/context'))).status).toBe(404);
    const other = await makePlace(w, kind);
    expect((await other.alice.get(other.path(`/${m.id}/context`))).status).toBe(404);
    expect((await p.outsider.get(p.path(`/${m.id}/context`))).status).toBe(404);
    // Same access as history: someone who lost access loses the context too.
    await p.revoke(p.bob);
    expect((await p.bob.get(p.path(`/${m.id}/context`))).status).toBe(404);
  });

  it('leaves thread replies out of the neighbours and gives a reply its root context with a flag', async () => {
    const q = await makePlace(w, kind);
    const [a, b, c] = await post(q, 3);
    const reply = (await q.bob.post(q.path(), { body: 'in thread', threadRootId: b!.id })).body;
    const neighbours = await q.alice.get(q.path(`/${a!.id}/context`));
    expect(ids(neighbours)).toEqual([a!.id, b!.id, c!.id]);
    expect(neighbours.body.data[1].thread).toMatchObject({ replyCount: 1 });

    const viaReply = await q.alice.get(q.path(`/${reply.id}/context?before=1&after=1`));
    expect(viaReply.status).toBe(200);
    expect(ids(viaReply)).toEqual([a!.id, b!.id, c!.id]);
    expect(viaReply.body).toMatchObject({ targetId: b!.id, isReply: true, replyId: reply.id });
  });

  it('shows a deleted message as a placeholder, and hides the context of a reply under a deleted root', async () => {
    const q = await makePlace(w, kind);
    const [a, b] = await post(q, 2);
    const reply = (await q.bob.post(q.path(), { body: 'r', threadRootId: a!.id })).body;
    await q.alice.delete(q.path(`/${b!.id}`));
    const res = await q.bob.get(q.path(`/${b!.id}/context`));
    expect(res.status).toBe(200);
    expect(res.body.data.find((x: { id: string }) => x.id === b!.id)).toMatchObject({
      body: null,
      deletedAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('"m2"');
    expect((await q.bob.get(q.path(`/${reply.id}/context`))).status).toBe(200);
    await q.alice.delete(q.path(`/${a!.id}`));
    expect((await q.bob.get(q.path(`/${reply.id}/context`))).status).toBe(404);
  });

  it('carries attachments and the caller own flags', async () => {
    const q = await makePlace(w, kind);
    const m = await post(q, 2);
    await q.bob.put(q.path(`/${m[1]!.id}/bookmark`));
    const res = await q.bob.get(q.path(`/${m[0]!.id}/context`));
    expect(res.body.data[1]).toMatchObject({ id: m[1]!.id, bookmarked: true });
    expect((await q.alice.get(q.path(`/${m[0]!.id}/context`))).body.data[1].bookmarked).toBe(false);
  });
});

describe('history from join', () => {
  it('a conversation context never reaches before the caller joined, and a message before it is 404', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol, dave] = [1, 2, 3, 4].map(() => w.member(orgId)) as [
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
    ];
    const id = await alice.group([bob, carol]);
    const path = (suffix = '') => `/api/v1/orgs/${orgId}/conversations/${id}/messages${suffix}`;
    const me = asPerson(w, alice);
    const early = [
      (await me.post(path(), { body: 'early 1' })).body,
      (await me.post(path(), { body: 'early 2' })).body,
    ];
    const earlyReply = (await me.post(path(), { body: 'early reply', threadRootId: early[0].id })).body;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await alice.put(`/${id}/participants/${dave.userId}`, {})).status).toBeLessThan(300);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const late = [(await me.post(path(), { body: 'late 1' })).body, (await me.post(path(), { body: 'late 2' })).body];

    const him = asPerson(w, dave);
    const res = await him.get(path(`/${late[0].id}/context?before=25&after=25`));
    expect(ids(res)).toEqual([late[0].id, late[1].id]);
    expect(JSON.stringify(res.body)).not.toContain('early');
    expect((await him.get(path(`/${early[1].id}/context`))).status).toBe(404);
    expect((await him.get(path(`/${earlyReply.id}/context`))).status).toBe(404);
    // Bob was there from the start.
    expect(ids(await asPerson(w, bob).get(path(`/${late[0].id}/context?before=25`)))).toEqual([
      early[0].id,
      early[1].id,
      late[0].id,
      late[1].id,
    ]);
  });
});
