// End to end: the REAL messaging service (test database) publishes post-commit events to REAL Redis; the REAL
// realtime gateway subscribes and delivers them to sockets that the (fake) workspace service lets see the channel.
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
import {
  scenario,
  startMessaging,
  tokenFor,
  trustedPublicJwks,
  type TestMessaging,
} from '../messaging/support/messaging.js';

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

interface Change {
  type: string;
  organizationId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
}

class Listener {
  readonly changes: Change[] = [];
  private constructor(readonly socket: Socket) {
    socket.on('message.changed', (change: Change) => this.changes.push(change));
  }
  static async connect(url: string, userId: string): Promise<Listener> {
    const socket = connectClient(url, {
      path: '/realtime/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: await tokenFor(userId) },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return new Listener(socket);
  }
  subscribe = (c: { orgId: string; wsId: string; chId: string }) =>
    this.socket.emitWithAck('subscribe', { organizationId: c.orgId, workspaceId: c.wsId, channelId: c.chId });
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('message events: messaging -> Redis -> realtime gateway -> sockets', () => {
  let messaging: TestMessaging;
  let gateway: NestExpressApplication;
  let gatewayUrl: string;
  const listeners: Listener[] = [];
  const listen = async (userId: string) => {
    const listener = await Listener.connect(gatewayUrl, userId);
    listeners.push(listener);
    return listener;
  };

  beforeAll(async () => {
    if (!password)
      throw new Error('REDIS_PASSWORD is not set in .env (see .env.example); start Redis with make infra-up');
    messaging = await startMessaging({ env: { REDIS_URL: redisUrl, REALTIME_EVENTS_CHANNEL: eventsChannel } });
    gateway = await createRealtimeGateway({
      config: loadConfig({
        NODE_ENV: 'test',
        AUTH_JWT_PUBLIC_JWKS: trustedPublicJwks,
        WORKSPACE_SERVICE_URL: messaging.workspace.url,
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
    for (const listener of listeners.splice(0)) listener.socket.close();
  });

  afterAll(async () => {
    await gateway?.close();
    await messaging?.close();
  });

  // The messaging publisher connects in the background: post warm-up messages until one is delivered.
  it('is warmed up (publisher connected, subscriber subscribed)', async () => {
    const s = scenario(messaging);
    const author = s.member();
    const warm = await listen(author.userId);
    expect(await warm.subscribe(s.chan)).toEqual({ ok: true });
    const deadline = Date.now() + 15_000;
    while (warm.changes.length === 0 && Date.now() < deadline) {
      await author.post(s.chan, { body: 'warm-up' });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(warm.changes.length).toBeGreaterThan(0);
  });

  it('delivers created/updated/deleted as ids only to subscribed sockets and nothing to others', async () => {
    const s = scenario(messaging);
    const author = s.member();
    const reader = s.reader();
    const outsider = s.outsider(); // no access to the channel at all
    const otherChannel = scenario(messaging);
    const bystander = otherChannel.member(); // can see a DIFFERENT channel only

    const authorSocket = await listen(author.userId);
    const readerSocket = await listen(reader.userId);
    const outsiderSocket = await listen(outsider.userId);
    const bystanderSocket = await listen(bystander.userId);
    const connectedButIdle = await listen(randomUUID());
    expect(await authorSocket.subscribe(s.chan)).toEqual({ ok: true });
    expect(await readerSocket.subscribe(s.chan)).toEqual({ ok: true });
    expect(await outsiderSocket.subscribe(s.chan)).toEqual({ ok: false, code: 'not_found' });
    expect(await bystanderSocket.subscribe(otherChannel.chan)).toEqual({ ok: true });
    expect(await bystanderSocket.subscribe(s.chan)).toEqual({ ok: false, code: 'not_found' });

    const secret = `top-secret-${randomUUID()}`;
    const posted = await author.post(s.chan, { body: secret });
    expect(posted.status).toBe(201);
    const messageId = (posted.body as { id: string }).id;
    const edited = await author.edit(s.chan, messageId, { body: `${secret} edited` });
    expect(edited.status).toBe(200);
    expect((await author.remove(s.chan, messageId)).status).toBe(204);

    const ids = { organizationId: s.chan.orgId, workspaceId: s.chan.wsId, channelId: s.chan.chId, messageId };
    for (const socket of [authorSocket, readerSocket]) {
      await eventually(() => socket.changes.length === 3);
      expect(socket.changes).toEqual([
        { type: 'created', ...ids },
        { type: 'updated', ...ids },
        { type: 'deleted', ...ids },
      ]);
      expect(JSON.stringify(socket.changes)).not.toContain('top-secret');
    }

    // A later event on the other channel proves the first channel's events were not queued for its sockets.
    const control = await otherChannel.member().post(otherChannel.chan, { body: 'control' });
    expect(control.status).toBe(201);
    await eventually(() => bystanderSocket.changes.length === 1);
    expect(bystanderSocket.changes[0]).toMatchObject({ type: 'created', channelId: otherChannel.chan.chId });
    expect(outsiderSocket.changes).toEqual([]);
    expect(connectedButIdle.changes).toEqual([]);
  });

  it('publishes nothing for an idempotent replay or a repeated delete', async () => {
    const s = scenario(messaging);
    const author = s.member();
    const socket = await listen(author.userId);
    expect(await socket.subscribe(s.chan)).toEqual({ ok: true });

    const clientMessageId = randomUUID();
    const first = await author.post(s.chan, { body: 'once', clientMessageId });
    const replay = await author.post(s.chan, { body: 'once', clientMessageId });
    expect([first.status, replay.status]).toEqual([201, 200]);
    const id = (first.body as { id: string }).id;
    expect((await author.remove(s.chan, id)).status).toBe(204);
    expect((await author.remove(s.chan, id)).status).toBe(204); // idempotent
    const control = await author.post(s.chan, { body: 'control' });

    await eventually(() => socket.changes.length >= 3);
    expect(socket.changes.map((c) => [c.type, c.messageId])).toEqual([
      ['created', id],
      ['deleted', id],
      ['created', (control.body as { id: string }).id],
    ]);
  });

  it('publishes nothing when the request fails (no event for a rejected post)', async () => {
    const s = scenario(messaging);
    const author = s.member();
    const reader = s.reader();
    const socket = await listen(author.userId);
    await socket.subscribe(s.chan);
    expect((await reader.post(s.chan, { body: 'not allowed' })).status).toBe(403);
    expect((await author.edit(s.chan, randomUUID(), { body: 'x' })).status).toBe(404);
    const control = await author.post(s.chan, { body: 'control' });
    await eventually(() => socket.changes.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.changes.map((c) => c.messageId)).toEqual([(control.body as { id: string }).id]);
  });

  it('stops delivering to a user who loses access to the channel', async () => {
    const s = scenario(messaging);
    const author = s.member();
    const reader = s.reader();
    const socket = await listen(reader.userId);
    expect(await socket.subscribe(s.chan)).toEqual({ ok: true });
    const evicted = new Promise<unknown>((resolve) => socket.socket.once('unsubscribed', resolve));
    messaging.workspace.hide(s.chan, reader.userId);
    expect(await evicted).toEqual({ channelId: s.chan.chId });
    await author.post(s.chan, { body: 'after eviction' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(socket.changes).toEqual([]);
  });
});
