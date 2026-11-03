// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, Channel, startCollab, type Collab } from './support/collab.js';
import { db } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

describe('channel read state', () => {
  it('counts what others posted after my cursor, and posting moves my own cursor', async () => {
    const channel = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()];
    const first = (await alice.post(channel.path(), { body: 'one' })).body;
    const second = (await alice.post(channel.path(), { body: 'two' })).body;
    const bobsView = await bob.get(channel.path());
    expect(bobsView.body).toMatchObject({ unreadCount: 2, lastReadMessageId: null });
    // Alice sent them, so her cursor is on her last post.
    expect((await alice.get(channel.path())).body).toMatchObject({ unreadCount: 0, lastReadMessageId: second.id });

    expect((await bob.post(channel.path('/read'), { messageId: first.id })).status).toBe(204);
    expect((await bob.get(channel.path())).body).toMatchObject({ unreadCount: 1, lastReadMessageId: first.id });

    const reply = (await bob.post(channel.path(), { body: 'three' })).body;
    expect((await bob.get(channel.path())).body).toMatchObject({ unreadCount: 0, lastReadMessageId: reply.id });
    expect((await alice.get(channel.path())).body).toMatchObject({ unreadCount: 1, lastReadMessageId: second.id });
  });

  it('moves forward only, idempotently', async () => {
    const channel = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()];
    const ids = [];
    for (const body of ['a', 'b', 'c']) ids.push((await alice.post(channel.path(), { body })).body.id);
    expect((await bob.post(channel.path('/read'), { messageId: ids[1] })).status).toBe(204);
    expect((await bob.post(channel.path('/read'), { messageId: ids[1] })).status).toBe(204);
    expect((await bob.post(channel.path('/read'), { messageId: ids[0] })).status).toBe(204);
    expect((await bob.get(channel.path())).body).toMatchObject({ unreadCount: 1, lastReadMessageId: ids[1] });
    await bob.post(channel.path('/read'), { messageId: ids[2] });
    expect((await bob.get(channel.path())).body).toMatchObject({ unreadCount: 0, lastReadMessageId: ids[2] });
  });

  it('does not count deleted messages, and keeps each reader separate', async () => {
    const channel = new Channel(w);
    const [alice, bob, carol] = [channel.person(), channel.person(), channel.person('reader')];
    const gone = (await alice.post(channel.path(), { body: 'gone' })).body;
    await alice.post(channel.path(), { body: 'kept' });
    await alice.delete(channel.path(`/${gone.id}`));
    expect((await bob.get(channel.path())).body.unreadCount).toBe(1);
    // A reader (not a member) may keep a cursor too.
    expect(
      (await carol.post(channel.path('/read'), { messageId: (await carol.get(channel.path())).body.data[0].id }))
        .status,
    ).toBe(204);
    expect((await carol.get(channel.path())).body.unreadCount).toBe(0);
    expect((await bob.get(channel.path())).body.unreadCount).toBe(1);
  });

  it('validates the message and the access', async () => {
    const channel = new Channel(w);
    const other = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()];
    const theirs = other.person();
    const m = (await alice.post(channel.path(), { body: 'x' })).body;
    const foreign = (await theirs.post(other.path(), { body: 'y' })).body;
    expect((await bob.post(channel.path('/read'), { messageId: randomUUID() })).status).toBe(404);
    expect((await bob.post(channel.path('/read'), { messageId: foreign.id })).status).toBe(404);
    expect((await bob.post(channel.path('/read'), { messageId: 'nope' })).status).toBe(422);
    expect((await bob.post(channel.path('/read'), {})).status).toBe(422);
    expect((await theirs.post(channel.path('/read'), { messageId: m.id })).status).toBe(404);
    channel.hide(bob);
    expect((await bob.post(channel.path('/read'), { messageId: m.id })).status).toBe(404);
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.message_read_states WHERE user_id = $1', [bob.userId]),
    ).toBe(0);
  });

  it('lists an untouched channel as fully read for everyone', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    expect((await alice.get(channel.path())).body).toEqual({
      data: [],
      nextCursor: null,
      unreadCount: 0,
      lastReadMessageId: null,
    });
  });
});

describe('conversation read state in the message list', () => {
  it('carries the same unreadCount and lastReadMessageId as the conversation', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol] = [w.member(orgId), w.member(orgId), w.member(orgId)];
    const id = await alice.group([bob, carol]);
    const base = `/api/v1/orgs/${orgId}/conversations/${id}/messages`;
    const first = (await alice.say(id, 'one')).body;
    await alice.say(id, 'two');
    const him = asPerson(w, bob);
    expect((await him.get(base)).body).toMatchObject({ unreadCount: 2, lastReadMessageId: null });
    await bob.post(`/${id}/read`, { messageId: first.id });
    expect((await him.get(base)).body).toMatchObject({ unreadCount: 1, lastReadMessageId: first.id });
    expect((await bob.get(`/${id}`)).body.unreadCount).toBe(1);
  });
});
