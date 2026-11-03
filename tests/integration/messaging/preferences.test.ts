// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, query } from '../../support/database.js';
import { Channel, makePlace, startCollab, type Collab, type Person } from './support/collab.js';
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
const activity = async (p: Person) =>
  ((await p.get(`/api/v1/orgs/${p.orgId}/activity`)).body.data as { kind: string; message: { id: string } }[]).map(
    (i) => [i.kind, i.message.id],
  );
const levels = async (p: Person) => (await p.get(`/api/v1/orgs/${p.orgId}/notification-preferences`)).body;
const convPrefs = (orgId: string, id: string) => `/api/v1/orgs/${orgId}/conversations/${id}/preferences`;

describe('channel levels', () => {
  const setup = () => {
    const channel = new Channel(w);
    const [alice, bob] = [channel.person(), channel.person()] as [Person, Person];
    return { channel, alice, bob, set: (p: Person, level: string) => p.put(channel.path('/preferences'), { level }) };
  };

  it('none hides mentions and replies, mentions hides only thread replies, all brings them back', async () => {
    const { channel, alice, bob, set } = setup();
    const root = (await alice.post(channel.path(), { body: 'root' })).body;
    const mention = (await bob.post(channel.path(), { body: tok(alice) })).body;
    const reply = (await bob.post(channel.path(), { body: 'reply', threadRootId: root.id })).body;
    expect(new Set((await activity(alice)).map(([, id]) => id))).toEqual(new Set([mention.id, reply.id]));

    expect((await set(alice, 'mentions')).status).toBe(204);
    expect(await activity(alice)).toEqual([['mention', mention.id]]);
    expect((await alice.get(`/api/v1/orgs/${alice.orgId}/activity/unread-count`)).body.count).toBe(1);

    expect((await set(alice, 'none')).status).toBe(204);
    expect(await activity(alice)).toEqual([]);
    expect((await alice.get(`/api/v1/orgs/${alice.orgId}/activity/unread-count`)).body.count).toBe(0);
    expect(await activity(bob)).toEqual([]); // levels are personal

    expect((await set(alice, 'all')).status).toBe(204);
    expect(await activity(alice)).toHaveLength(2);
  });

  it('creates the channel conversation lazily, reads levels back, and `all` deletes the row', async () => {
    const { channel, alice, set } = setup();
    const rows = () =>
      query<{ n: string }>(
        adminUrl(),
        'SELECT count(*) AS n FROM messaging.conversation_preferences p JOIN messaging.conversations c ON c.id = p.conversation_id WHERE c.channel_id = $1',
        [channel.chan.chId],
      );
    const conversations = async () =>
      (
        await query<{ n: string }>(
          adminUrl(),
          'SELECT count(*) AS n FROM messaging.conversations WHERE channel_id = $1',
          [channel.chan.chId],
        )
      )[0]!.n;
    expect(await conversations()).toBe('0');
    expect((await set(alice, 'all')).status).toBe(204); // nothing to create for `all`
    expect(await conversations()).toBe('0');
    expect((await set(alice, 'none')).status).toBe(204);
    expect((await set(alice, 'mentions')).status).toBe(204);
    expect(await conversations()).toBe('1');
    expect((await rows())[0]!.n).toBe('1');
    expect(await levels(alice)).toEqual({
      data: [
        {
          location: { kind: 'channel', workspaceId: channel.chan.wsId, channelId: channel.chan.chId },
          level: 'mentions',
        },
      ],
    });
    await set(alice, 'all');
    expect((await rows())[0]!.n).toBe('0');
    expect(await levels(alice)).toEqual({ data: [] });
  });

  it('is only for people who see the channel, and validates the level', async () => {
    const { channel, alice, set } = setup();
    const outsider = new Channel(w).person(); // sees another channel only
    expect((await outsider.put(channel.path('/preferences'), { level: 'none' })).status).toBe(404);
    const reader = channel.person('reader');
    expect((await set(reader, 'none')).status).toBe(204); // a reader may mute what they can see
    for (const level of ['loud', '', undefined, 3])
      expect((await alice.put(channel.path('/preferences'), { level })).status).toBe(422);
    expect(problemOf(await alice.put(channel.path('/preferences'), {})).code).toBe('validation_failed');
    const other = `/api/v1/orgs/${randomUUID()}/workspaces/${channel.chan.wsId}/channels/${channel.chan.chId}/messages/preferences`;
    expect((await alice.put(other, { level: 'none' })).status).toBe(404);
  });

  it('lists levels only for channels the caller can still see', async () => {
    const { channel, alice, set } = setup();
    await set(alice, 'none');
    expect((await levels(alice)).data).toHaveLength(1);
    channel.hide(alice);
    expect(await levels(alice)).toEqual({ data: [] });
    w.svc.workspace.listFailure = 'error';
    expect((await alice.get(`/api/v1/orgs/${alice.orgId}/notification-preferences`)).status).toBe(503);
  });
});

describe('conversation levels', () => {
  it("apply to participants only, hide that conversation's activity and list as muted", async () => {
    const p = await makePlace(w, 'group');
    const [orgId, , , , conversationId] = [p.alice.orgId, 0, 0, 0, p.path().split('/')[6]!];
    const m = (await p.alice.post(p.path(), { body: tok(p.bob) })).body;
    expect(await activity(p.bob)).toEqual([['mention', m.id]]);

    expect((await p.outsider.put(convPrefs(orgId, conversationId), { level: 'none' })).status).toBe(404);
    expect((await p.bob.put(convPrefs(orgId, randomUUID()), { level: 'none' })).status).toBe(404);
    expect((await p.bob.put(convPrefs(orgId, 'not-a-uuid'), { level: 'none' })).status).toBe(404);
    expect((await p.bob.put(convPrefs(randomUUID(), conversationId), { level: 'none' })).status).toBe(404);
    expect((await p.bob.put(convPrefs(orgId, conversationId), { level: 'x' })).status).toBe(422);

    expect((await p.bob.put(convPrefs(orgId, conversationId), { level: 'none' })).status).toBe(204);
    expect(await activity(p.bob)).toEqual([]);
    expect(await levels(p.bob)).toEqual({ data: [{ location: { kind: 'group', conversationId }, level: 'none' }] });
    expect(await levels(p.outsider)).toEqual({ data: [] });

    // leaving the conversation drops the level from the list
    await p.revoke(p.bob);
    expect(await levels(p.bob)).toEqual({ data: [] });
  });

  it('refuses a channel conversation id on the conversation route', async () => {
    const channel = new Channel(w);
    const alice = channel.person();
    await alice.post(channel.path(), { body: 'first' });
    const [conv] = await query<{ id: string }>(
      adminUrl(),
      'SELECT id FROM messaging.conversations WHERE channel_id = $1',
      [channel.chan.chId],
    );
    expect((await alice.put(convPrefs(alice.orgId, conv!.id), { level: 'none' })).status).toBe(404);
  });
});
