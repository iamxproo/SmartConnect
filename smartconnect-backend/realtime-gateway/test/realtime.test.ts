import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  conversationEvent,
  eventually,
  generateKeyPair,
  messageEvent,
  newChannel,
  signToken,
  startGateway,
  type TestClient,
  type TestGateway,
} from './support/harness.js';

let gateway: TestGateway;
const clients: TestClient[] = [];
const open = async (...args: Parameters<typeof connect>) => {
  const client = await connect(...args);
  clients.push(client);
  return client;
};
const asUser = async (userId = randomUUID()) => ({
  userId,
  client: await open(gateway.url, { token: await signToken({ sub: userId }) }),
});

beforeAll(async () => {
  gateway = await startGateway({ REAUTHORIZE_INTERVAL_SECONDS: '1' });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
afterAll(async () => {
  await gateway.close();
});

describe('handshake', () => {
  it('refuses a missing token, a non-string token and garbage with "unauthenticated"', async () => {
    for (const token of [undefined, '', 42, { a: 1 }, 'not.a.jwt']) {
      await expect(connect(gateway.url, { token })).rejects.toMatchObject({ message: 'unauthenticated' });
    }
  });

  it('refuses an expired token and a token signed by another key', async () => {
    await expect(connect(gateway.url, { token: await signToken({ expiresIn: -60 }) })).rejects.toMatchObject({
      message: 'unauthenticated',
    });
    await expect(connect(gateway.url, { token: await signToken({ keys: generateKeyPair() }) })).rejects.toMatchObject({
      message: 'unauthenticated',
    });
  });

  it('refuses a disallowed browser Origin even with a valid token; allows listed and absent origins', async () => {
    const token = await signToken();
    await expect(connect(gateway.url, { token, origin: 'https://evil.example' })).rejects.toBeDefined();
    await expect(connect(gateway.url, { token, origin: 'null' })).rejects.toBeDefined();
    clients.push(await connect(gateway.url, { token, origin: 'http://localhost:5173' }));
    clients.push(await connect(gateway.url, { token }));
  });

  it('serves WebSocket only: HTTP long-polling is refused', async () => {
    const res = await request(gateway.url).get('/realtime/socket.io/?EIO=4&transport=polling');
    expect(res.status).toBe(400);
  });

  it('never logs the token', async () => {
    const token = await signToken();
    clients.push(await connect(gateway.url, { token }));
    expect(gateway.logger.lines.join('\n')).not.toContain(token);
  });

  it('disconnects the socket when its token expires', async () => {
    const client = await open(gateway.url, { token: await signToken({ expiresIn: 2 }) });
    const started = Date.now();
    await eventually(() => client.socket.disconnected, 6_000);
    expect(Date.now() - started).toBeGreaterThan(1_000);
  });
});

describe('subscribe and fan-out', () => {
  it('joins a visible channel (asked as the socket user) and delivers ids only', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    expect(await client.subscribe(c)).toEqual({ ok: true });

    const asked = gateway.workspace.requests.at(-1)!;
    expect(asked.url).toBe(`/api/v1/orgs/${c.organizationId}/workspaces/${c.workspaceId}/channels/${c.channelId}`);
    expect(asked.authorization).toMatch(/^Bearer ey/);

    const messageId = randomUUID();
    gateway.events.publish({ ...messageEvent(c, 'message.updated', messageId), body: 'SECRET', senderUserId: userId });
    await eventually(() => client.changes.length === 1);
    expect(client.changes[0]).toEqual({ type: 'updated', ...c, messageId });
    expect(JSON.stringify(client.changes)).not.toContain('SECRET');
  });

  it('maps created/updated/deleted', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    await client.subscribe(c);
    for (const type of ['message.created', 'message.updated', 'message.deleted'])
      gateway.events.publish(messageEvent(c, type));
    await eventually(() => client.changes.length === 3);
    expect((client.changes as { type: string }[]).map((e) => e.type)).toEqual(['created', 'updated', 'deleted']);
  });

  it('answers not_found for an invisible channel and delivers nothing for it', async () => {
    const { client } = await asUser();
    const c = newChannel();
    expect(await client.subscribe(c)).toEqual({ ok: false, code: 'not_found' });
    const visible = newChannel();
    gateway.workspace.show((await asUser()).userId, visible); // someone else's channel, irrelevant
    gateway.events.publish(messageEvent(c));
    // A later event to a channel this socket DOES have proves the first one was not queued for it.
    const other = await asUser();
    const own = newChannel();
    gateway.workspace.show(other.userId, own);
    await other.client.subscribe(own);
    gateway.events.publish(messageEvent(own));
    await eventually(() => other.client.changes.length === 1);
    expect(client.changes).toEqual([]);
  });

  it('treats a channel visible in another workspace (or under another user) as not found', async () => {
    const a = await asUser();
    const b = await asUser();
    const c = newChannel();
    gateway.workspace.show(a.userId, c);
    expect(await b.client.subscribe(c)).toEqual({ ok: false, code: 'not_found' });
    expect(await a.client.subscribe({ ...c, workspaceId: randomUUID() })).toEqual({ ok: false, code: 'not_found' });
  });

  it('never delivers events of channel B to a socket subscribed to A', async () => {
    const { userId, client } = await asUser();
    const a = newChannel();
    const b = newChannel();
    gateway.workspace.show(userId, a);
    gateway.workspace.show(userId, b);
    await client.subscribe(a);
    const reader = await asUser();
    gateway.workspace.show(reader.userId, b);
    await reader.client.subscribe(b);

    gateway.events.publish(messageEvent(b));
    gateway.events.publish(messageEvent(a));
    await eventually(() => client.changes.length === 1 && reader.client.changes.length === 1);
    expect(client.changes[0]).toMatchObject({ channelId: a.channelId });
    expect(reader.client.changes[0]).toMatchObject({ channelId: b.channelId });
  });

  it('rejects invalid payloads with "invalid" without asking the workspace service', async () => {
    const { client } = await asUser();
    const before = gateway.workspace.requests.length;
    const c = newChannel();
    for (const payload of [
      undefined,
      null,
      'x',
      [],
      {},
      { ...c, channelId: 'nope' },
      { ...c, channelId: 7 },
      { ...c, workspaceId: `${c.workspaceId}/../x` },
      { organizationId: c.organizationId, workspaceId: c.workspaceId },
    ]) {
      expect(await client.subscribe(payload)).toEqual({ ok: false, code: 'invalid' });
    }
    expect(gateway.workspace.requests.length).toBe(before);
  });

  it('does not crash on subscribe without an ack callback', async () => {
    const { client } = await asUser();
    client.socket.emit('subscribe', 'garbage');
    expect(await client.subscribe({})).toEqual({ ok: false, code: 'invalid' });
  });

  it('fails closed: a failing, unreachable or inconsistent workspace service means "unavailable"', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    for (const mode of ['error', 'hang-up', 'wrong-id'] as const) {
      gateway.workspace.break(userId, c, mode);
      expect(await client.subscribe(c)).toEqual({ ok: false, code: 'unavailable' });
    }
    gateway.workspace.break(userId, c, 'forbidden');
    expect(await client.subscribe(c)).toEqual({ ok: false, code: 'not_found' });
    gateway.events.publish(messageEvent(c));
    gateway.workspace.break(userId, c, undefined);
    expect(await client.subscribe(c)).toEqual({ ok: true });
    expect(client.changes).toEqual([]);
  });

  it('answers 401 from the workspace service with not_found and disconnects the socket', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    gateway.workspace.break(userId, c, 'unauthorized');
    expect(await client.subscribe(c)).toEqual({ ok: false, code: 'not_found' });
    await eventually(() => client.socket.disconnected);
  });

  it('stops delivering after unsubscribe', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    await client.subscribe(c);
    expect(await client.socket.emitWithAck('unsubscribe', { channelId: c.channelId })).toEqual({ ok: true });
    gateway.events.publish(messageEvent(c));
    const control = await asUser();
    gateway.workspace.show(control.userId, c);
    await control.client.subscribe(c);
    gateway.events.publish(messageEvent(c));
    await eventually(() => control.client.changes.length === 1);
    expect(client.changes).toEqual([]);
  });

  it('rate-limits subscribe attempts per socket (30 per minute), counting invalid ones', async () => {
    const { client } = await asUser();
    const results = [];
    for (let i = 0; i < 32; i++) results.push(await client.subscribe({}));
    expect(results.slice(0, 30).every((r) => (r as { code: string }).code === 'invalid')).toBe(true);
    expect(results.slice(30)).toEqual([
      { ok: false, code: 'unavailable' },
      { ok: false, code: 'unavailable' },
    ]);
    // Another socket is unaffected.
    expect(await (await asUser()).client.subscribe({})).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('malformed events', () => {
  it('are dropped (and logged by type only) while valid ones still flow', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    await client.subscribe(c);
    const valid = messageEvent(c);
    for (const bad of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...valid, service: 'identity' }),
      JSON.stringify({ ...valid, type: 'message.reacted' }),
      JSON.stringify({ ...valid, type: '__proto__' }),
      JSON.stringify({ ...valid, channelId: 'not-a-uuid' }),
      JSON.stringify({ ...valid, messageId: 5 }),
      JSON.stringify({ ...valid, organizationId: undefined }),
      JSON.stringify({ ...valid, padding: 'x'.repeat(9000) }),
    ])
      gateway.events.publish(bad);
    gateway.events.publish(valid);
    await eventually(() => client.changes.length === 1);
    expect(client.changes[0]).toMatchObject({ messageId: valid.messageId });
    expect(gateway.logger.lines.some((l) => l.includes('event_dropped'))).toBe(true);
  });
});

describe('re-authorization', () => {
  it('evicts a socket whose access was revoked: unsubscribed, no further events', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    const keep = newChannel();
    gateway.workspace.show(userId, c);
    gateway.workspace.show(userId, keep);
    await client.subscribe(c);
    await client.subscribe(keep);

    gateway.workspace.hide(userId, c);
    await eventually(() => client.unsubscribed.length === 1, 5_000);
    expect(client.unsubscribed).toEqual([{ channelId: c.channelId }]);

    gateway.events.publish(messageEvent(c));
    gateway.events.publish(messageEvent(keep));
    await eventually(() => client.changes.length === 1);
    expect(client.changes[0]).toMatchObject({ channelId: keep.channelId });
  });

  it('fails closed when the workspace service fails during a re-check', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    await client.subscribe(c);
    gateway.workspace.break(userId, c, 'error');
    await eventually(() => client.unsubscribed.length === 1, 5_000);
    gateway.events.publish(messageEvent(c));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.changes).toEqual([]);
  });

  it('disconnects the socket when the workspace service answers 401', async () => {
    const { userId, client } = await asUser();
    const c = newChannel();
    gateway.workspace.show(userId, c);
    await client.subscribe(c);
    gateway.workspace.break(userId, c, 'unauthorized');
    await eventually(() => client.socket.disconnected, 5_000);
  });
});

describe('conversation inbox (ADR 0011)', () => {
  const member = async (organizationId = randomUUID()) => {
    const user = await asUser();
    gateway.messaging.add(user.userId, organizationId);
    return { ...user, organizationId };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('joins only after the messaging service, asked as the user, confirms the inbox; delivers ids only', async () => {
    const { userId, client, organizationId } = await member();
    expect(await client.subscribeInbox({ organizationId: organizationId.toUpperCase() })).toEqual({ ok: true });
    const asked = gateway.messaging.requests.at(-1)!;
    expect(asked.url).toBe(`/api/v1/orgs/${organizationId}/conversations/inbox`);
    expect(asked.authorization).toMatch(/^Bearer ey/);

    const event = conversationEvent(organizationId, [userId], { body: 'SECRET', title: 'Board' });
    gateway.events.publish(event);
    await eventually(() => client.inbox.length === 1);
    expect(client.inbox[0]).toEqual({
      organizationId,
      conversationId: event.conversationId,
      change: 'message.created',
      messageId: event.messageId,
    });
    expect(JSON.stringify(client.inbox)).not.toContain('SECRET');
    expect(JSON.stringify(client.inbox)).not.toContain('Board');
  });

  it('delivers to the named recipients only: not to other members, not to the same user in another organization', async () => {
    const recipient = await member();
    const colleague = await member(recipient.organizationId);
    const elsewhere = await asUser(recipient.userId); // the recipient's other socket, watching another organization
    const otherOrg = randomUUID();
    gateway.messaging.add(recipient.userId, otherOrg);
    for (const [client, organizationId] of [
      [recipient.client, recipient.organizationId],
      [colleague.client, colleague.organizationId],
      [elsewhere.client, otherOrg],
    ] as const)
      expect(await client.subscribeInbox({ organizationId })).toEqual({ ok: true });

    gateway.events.publish(conversationEvent(recipient.organizationId, [recipient.userId]));
    await eventually(() => recipient.client.inbox.length === 1);
    // A later event to the colleague proves the first one was never queued for them.
    gateway.events.publish(conversationEvent(recipient.organizationId, [colleague.userId]));
    await eventually(() => colleague.client.inbox.length === 1);
    await settle();
    expect(recipient.client.inbox).toHaveLength(1);
    expect(elsewhere.client.inbox).toEqual([]);
  });

  it('never joins someone else’s inbox: the room comes from the token, not the payload', async () => {
    const victim = await member();
    const attacker = await member(victim.organizationId);
    expect(
      await attacker.client.subscribeInbox({ organizationId: victim.organizationId, userId: victim.userId }),
    ).toEqual({
      ok: true,
    });
    gateway.events.publish(conversationEvent(victim.organizationId, [victim.userId]));
    await settle();
    expect(attacker.client.inbox).toEqual([]);
  });

  it('answers not_found to non-members, invalid to garbage, and unavailable when the messaging service fails', async () => {
    const { userId, client } = await asUser();
    const organizationId = randomUUID();
    expect(await client.subscribeInbox({ organizationId })).toEqual({ ok: false, code: 'not_found' });
    for (const payload of [null, 'x', { organizationId: 'nope' }, {}]) {
      expect(await client.subscribeInbox(payload)).toEqual({ ok: false, code: 'invalid' });
    }
    gateway.messaging.add(userId, organizationId);
    for (const mode of ['error', 'wrong-id'] as const) {
      gateway.messaging.break(userId, organizationId, mode);
      expect(await client.subscribeInbox({ organizationId })).toEqual({ ok: false, code: 'unavailable' });
    }
    gateway.messaging.break(userId, organizationId, undefined);
    gateway.events.publish(conversationEvent(organizationId, [userId]));
    await settle();
    expect(client.inbox).toEqual([]);
  });

  it('drops malformed conversation events while valid ones still flow', async () => {
    const { userId, client, organizationId } = await member();
    await client.subscribeInbox({ organizationId });
    for (const overrides of [
      { change: 'conversation.created' },
      { change: 'conversation.updated' }, // must carry messageId: null
      { messageId: null },
      { recipientUserIds: [] },
      { recipientUserIds: 'everyone' },
      { recipientUserIds: [userId, 'not-a-uuid'] },
      { recipientUserIds: Array.from({ length: 101 }, () => randomUUID()).concat(userId) },
      { service: 'other' },
    ])
      gateway.events.publish(conversationEvent(organizationId, [userId], overrides));
    gateway.events.publish(
      conversationEvent(organizationId, [userId], { change: 'conversation.updated', messageId: null }),
    );
    await eventually(() => client.inbox.length === 1);
    await settle();
    expect(client.inbox).toEqual([expect.objectContaining({ change: 'conversation.updated', messageId: null })]);
  });

  it('stops delivering after inbox.unsubscribe', async () => {
    const { userId, client, organizationId } = await member();
    await client.subscribeInbox({ organizationId });
    expect(await client.socket.emitWithAck('inbox.unsubscribe', { organizationId })).toEqual({ ok: true });
    gateway.events.publish(conversationEvent(organizationId, [userId]));
    await settle();
    expect(client.inbox).toEqual([]);
  });

  it('evicts the inbox when the user leaves the organization: inbox.unsubscribed, no further events', async () => {
    const { userId, client, organizationId } = await member();
    const keep = await member();
    gateway.messaging.add(userId, keep.organizationId);
    await client.subscribeInbox({ organizationId });
    await client.subscribeInbox({ organizationId: keep.organizationId });

    gateway.messaging.remove(userId, organizationId);
    await eventually(() => client.inboxUnsubscribed.length === 1, 5_000);
    expect(client.inboxUnsubscribed).toEqual([{ organizationId }]);
    gateway.events.publish(conversationEvent(organizationId, [userId]));
    gateway.events.publish(conversationEvent(keep.organizationId, [userId]));
    await eventually(() => client.inbox.length === 1);
    expect(client.inbox[0]).toMatchObject({ organizationId: keep.organizationId });
  });

  it('fails closed on a failing re-check, and disconnects on 401', async () => {
    const failing = await member();
    await failing.client.subscribeInbox({ organizationId: failing.organizationId });
    gateway.messaging.break(failing.userId, failing.organizationId, 'error');
    await eventually(() => failing.client.inboxUnsubscribed.length === 1, 5_000);

    const expired = await member();
    await expired.client.subscribeInbox({ organizationId: expired.organizationId });
    gateway.messaging.break(expired.userId, expired.organizationId, 'unauthorized');
    await eventually(() => expired.client.socket.disconnected, 5_000);
  });
});

describe('health', () => {
  it('is live, and ready only while the event source is subscribed', async () => {
    expect((await request(gateway.url).get('/health/live')).status).toBe(200);
    expect((await request(gateway.url).get('/health/ready')).status).toBe(200);
    gateway.events.ready = false;
    expect((await request(gateway.url).get('/health/ready')).status).toBe(503);
    gateway.events.ready = true;
  });
});

// Last on purpose: a second app replaces Nest's process-wide static logger, which earlier tests assert on.
describe('channel cap', () => {
  it('limits the channels one socket can join (MAX_CHANNELS_PER_SOCKET)', async () => {
    const capped = await startGateway({ MAX_CHANNELS_PER_SOCKET: '2' });
    try {
      const userId = randomUUID();
      const client = await open(capped.url, { token: await signToken({ sub: userId }) });
      const channels = [newChannel(), newChannel(), newChannel()];
      for (const c of channels) capped.workspace.show(userId, c);
      expect(await client.subscribe(channels[0]!)).toEqual({ ok: true });
      expect(await client.subscribe(channels[1]!)).toEqual({ ok: true });
      expect(await client.subscribe(channels[2]!)).toEqual({ ok: false, code: 'unavailable' });
      // Re-subscribing to a joined channel is not a new room; an inbox is one.
      expect(await client.subscribe(channels[0]!)).toEqual({ ok: true });
      const organizationId = randomUUID();
      capped.messaging.add(userId, organizationId);
      expect(await client.subscribeInbox({ organizationId })).toEqual({ ok: false, code: 'unavailable' });
    } finally {
      await capped.close();
    }
  });

  it('limits the sockets one user can hold open (MAX_SOCKETS_PER_USER); others are unaffected', async () => {
    const capped = await startGateway({ MAX_SOCKETS_PER_USER: '2' });
    try {
      const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
      const token = await signToken({ sub: randomUUID() });
      const first = await open(capped.url, { token });
      const second = await open(capped.url, { token });
      const third = await open(capped.url, { token });
      await eventually(() => third.socket.disconnected);
      const otherUser = await open(capped.url, { token: await signToken() });
      await settle();
      expect([first, second, otherUser].map((c) => c.socket.connected)).toEqual([true, true, true]);

      // Closing a socket frees its slot.
      first.close();
      await settle();
      const again = await open(capped.url, { token });
      await settle();
      expect(again.socket.connected).toBe(true);
    } finally {
      await capped.close();
    }
  });
});
