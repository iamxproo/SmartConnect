// End to end for direct and group conversations (ADR 0011): the REAL messaging service (test database) publishes
// post-commit `conversation.changed` events to REAL Redis; the REAL realtime gateway delivers them to the inbox rooms of
// the recipients messaging named, after messaging (over HTTP, with the fake organization service behind it) confirmed
// each socket's inbox.
// Isolation: a unique pub/sub channel per run, so nothing else in Redis is read, written or flushed.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { io as connectClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseEnvFile, REPO_ROOT } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { createRealtimeGateway } from '../../../smartconnect-backend/realtime-gateway/src/app.factory.js';
import { loadConfig } from '../../../smartconnect-backend/realtime-gateway/src/config.js';
import { FakeOrganizationService, Member } from '../messaging/support/conversations.js';
import { startMessaging, tokenFor, trustedPublicJwks, type TestMessaging } from '../messaging/support/messaging.js';

const env = { ...parseEnvFile(path.join(REPO_ROOT, '.env')), ...process.env } as Record<string, string | undefined>;
const password = env.REDIS_PASSWORD;
const redisUrl = `redis://:${encodeURIComponent(password ?? '')}@127.0.0.1:${env.REDIS_PORT ?? '6379'}/15`;
const eventsChannel = `test:events:${randomUUID()}`;

const quietLogger: LoggerService = {
  log: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  verbose: () => {},
};

interface InboxEvent {
  organizationId: string;
  conversationId: string;
  change: string;
  messageId: string | null;
}

class Inbox {
  readonly events: InboxEvent[] = [];
  private constructor(readonly socket: Socket) {
    socket.on('conversation.changed', (event: InboxEvent) => this.events.push(event));
  }
  static async open(url: string, member: Member): Promise<Inbox> {
    const socket = connectClient(url, {
      path: '/realtime/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: await tokenFor(member.userId) },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const inbox = new Inbox(socket);
    expect(await socket.emitWithAck('inbox.subscribe', { organizationId: member.orgId })).toEqual({ ok: true });
    return inbox;
  }
  messages = () => this.events.filter((e) => e.change.startsWith('message.')).map((e) => [e.change, e.messageId]);
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('conversation events: messaging -> Redis -> realtime gateway -> recipients’ inboxes', () => {
  let organization: FakeOrganizationService;
  let messaging: TestMessaging;
  let gateway: NestExpressApplication;
  let gatewayUrl: string;
  const inboxes: Inbox[] = [];
  const member = (orgId: string) => {
    const m = new Member(messaging, orgId, randomUUID());
    organization.addMember(orgId, m.userId);
    return m;
  };
  const open = async (m: Member) => {
    const inbox = await Inbox.open(gatewayUrl, m);
    inboxes.push(inbox);
    return inbox;
  };
  const idOf = (res: { body: unknown }) => (res.body as { id: string }).id;

  beforeAll(async () => {
    if (!password)
      throw new Error('REDIS_PASSWORD is not set in .env (see .env.example); start Redis with make infra-up');
    organization = await FakeOrganizationService.start();
    messaging = await startMessaging({
      env: { REDIS_URL: redisUrl, REALTIME_EVENTS_CHANNEL: eventsChannel, ORGANIZATION_SERVICE_URL: organization.url },
    });
    await messaging.app.listen(0, '127.0.0.1');
    const messagingUrl = `http://127.0.0.1:${(messaging.app.getHttpServer().address() as AddressInfo).port}`;
    gateway = await createRealtimeGateway({
      config: loadConfig({
        NODE_ENV: 'test',
        AUTH_JWT_PUBLIC_JWKS: trustedPublicJwks,
        WORKSPACE_SERVICE_URL: messaging.workspace.url,
        MESSAGING_SERVICE_URL: messagingUrl,
        REDIS_URL: redisUrl,
        REALTIME_EVENTS_CHANNEL: eventsChannel,
        REAUTHORIZE_INTERVAL_SECONDS: '1',
      }),
      logger: quietLogger,
    });
    await gateway.listen(0, '127.0.0.1');
    gatewayUrl = `http://127.0.0.1:${(gateway.getHttpServer().address() as AddressInfo).port}`;
    await eventually(async () => (await request(gatewayUrl).get('/health/ready')).status === (200 as never));
  });

  afterEach(() => {
    for (const inbox of inboxes.splice(0)) inbox.socket.close();
  });

  afterAll(async () => {
    await gateway?.close();
    await messaging?.close();
    await organization?.close();
  });

  // The messaging publisher connects in the background: post warm-up messages until one is delivered.
  it('is warmed up (publisher connected, subscriber subscribed)', async () => {
    const orgId = randomUUID();
    const [a, b] = [member(orgId), member(orgId)];
    const inbox = await open(a);
    const dm = idOf(await a.openDirect(b));
    const deadline = Date.now() + 15_000;
    while (inbox.messages().length === 0 && Date.now() < deadline) {
      await a.say(dm, 'warm-up');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(inbox.messages().length).toBeGreaterThan(0);
  });

  it('delivers a direct message’s changes, ids only, to its two participants and nobody else', async () => {
    const orgId = randomUUID();
    const [a, b, colleague] = [member(orgId), member(orgId), member(orgId)];
    const elsewhere = member(randomUUID());
    const inboxA = await open(a);
    const inboxB = await open(b);
    const inboxColleague = await open(colleague);
    const inboxElsewhere = await open(elsewhere);

    const dm = idOf(await a.openDirect(b));
    const secret = `top-secret-${randomUUID()}`;
    const posted = await a.say(dm, secret);
    expect(posted.status).toBe(201);
    const messageId = idOf(posted);
    expect((await a.patch(`/${dm}/messages/${messageId}`, { body: `${secret} edited` })).status).toBe(200);
    expect((await a.delete(`/${dm}/messages/${messageId}`)).status).toBe(204);

    for (const inbox of [inboxA, inboxB]) {
      await eventually(() => inbox.messages().length === 3);
      expect(inbox.messages()).toEqual([
        ['message.created', messageId],
        ['message.updated', messageId],
        ['message.deleted', messageId],
      ]);
      expect(inbox.events.every((e) => e.organizationId === orgId && e.conversationId === dm)).toBe(true);
      expect(Object.keys(inbox.events[0]!).sort()).toEqual(['change', 'conversationId', 'messageId', 'organizationId']);
      expect(JSON.stringify(inbox.events)).not.toContain('top-secret');
    }

    // A later event for the colleague proves nothing of the DM was ever queued for them.
    const control = idOf(await colleague.openDirect(b));
    await colleague.say(control, 'control');
    await eventually(() => inboxColleague.messages().length === 1);
    expect(inboxColleague.events.every((e) => e.conversationId === control)).toBe(true);
    expect(inboxElsewhere.events).toEqual([]);
  });

  it('stops delivering to a removed group participant at once, and tells them the group changed', async () => {
    const orgId = randomUUID();
    const [admin, stays, removed] = [member(orgId), member(orgId), member(orgId)];
    const group = await admin.group([stays, removed], 'Launch');
    const inboxStays = await open(stays);
    const inboxRemoved = await open(removed);

    expect((await admin.delete(`/${group}/participants/${removed.userId}`)).status).toBe(204);
    await eventually(() => inboxRemoved.events.some((e) => e.change === 'conversation.updated'));
    const after = idOf(await admin.say(group, 'after the removal'));
    await eventually(() => inboxStays.messages().some(([, id]) => id === after));
    await settle();
    expect(inboxRemoved.messages()).toEqual([]);
    expect((await removed.get(`/${group}/messages`)).status).toBe(404);
  });

  it('never delivers old conversations to a removed and re-invited person, even before they call REST', async () => {
    const orgId = randomUUID();
    const [admin, other, returning] = [member(orgId), member(orgId), member(orgId)];
    const group = await admin.group([other, returning], 'Before');
    await new Promise((resolve) => setTimeout(resolve, 20));
    organization.revoke(orgId, returning.userId);
    organization.addMember(orgId, returning.userId, new Date()); // re-invited: a new, later membership
    // Subscribing is the first thing the returning person does: the inbox check itself drops the old participation.
    const inbox = await open(returning);
    const after = idOf(await admin.say(group, 'said after the re-invitation'));
    const otherInbox = await open(other);
    await admin.say(group, 'control');
    await eventually(() => otherInbox.messages().length === 1);
    await settle();
    expect(inbox.events.filter((e) => e.conversationId === group && e.messageId === after)).toEqual([]);
    expect(inbox.messages()).toEqual([]);
    expect((await returning.get(`/${group}`)).status).toBe(404);
  });

  it('evicts the inbox of someone removed from the organization (re-check) and delivers nothing afterwards', async () => {
    const orgId = randomUUID();
    const [a, b] = [member(orgId), member(orgId)];
    const dm = idOf(await a.openDirect(b));
    const inboxB = await open(b);
    const evicted = new Promise<unknown>((resolve) => inboxB.socket.once('inbox.unsubscribed', resolve));
    organization.revoke(orgId, b.userId);
    expect(await evicted).toEqual({ organizationId: orgId });
    // Posting to a DM whose other person left the organization is refused, and nothing reaches the evicted socket.
    expect((await a.say(dm, 'are you there?')).status).toBe(409);
    await settle();
    expect(inboxB.messages()).toEqual([]);
  });
});
