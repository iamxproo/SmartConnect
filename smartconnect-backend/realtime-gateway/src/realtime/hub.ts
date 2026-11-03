// The Socket.IO server: authenticated sockets, id-only fan-out to two kinds of rooms, both authorized as the socket's
// own user and re-checked periodically:
// - channel rooms, by the workspace service (channel visibility);
// - conversation inbox rooms, one per (organization, user), by the messaging service (organization membership, after
//   it dropped conversation memberships left over from an earlier one). Messaging also names the recipients of each
//   conversation event from its participant list (ADR 0011).
// Stateless and database-free. Writes never happen over the socket (REST only); there is no typing or presence yet.
import type { Server as HttpServer } from 'node:http';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ACCESS_TOKEN_VERIFIER, AccessTokenVerifier, type Principal } from '@smartconnect/backend-kit';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';
import { REALTIME_CONFIG, type RealtimeConfig } from '../config.js';
import { EVENT_SOURCE } from '../events/tokens.js';
import type { EventSource } from '../events/event-source.js';
import { eventTypeOf, parseFanOutEvent, UUID } from '../events/message-event.js';
import { ChannelDirectory, type ChannelRef, type ChannelVisibility } from './channel-directory.js';
import { InboxDirectory } from './inbox-directory.js';

export const SOCKET_PATH = '/realtime/socket.io';
const SUBSCRIBES_PER_MINUTE = 30;
const REAUTHORIZE_CONCURRENCY = 20;
/** setTimeout cannot wait longer than a signed 32-bit number of milliseconds. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_PAYLOAD_BYTES = 4096;

type Subscription = { kind: 'channel'; ref: ChannelRef } | { kind: 'inbox'; organizationId: string };

interface SocketData {
  principal: Principal;
  authorization: string;
  /** Joined rooms with what they were authorized for, for re-checks. */
  rooms: Map<string, Subscription>;
  subscribeWindow: { startedAt: number; count: number };
  expiryTimer?: NodeJS.Timeout;
}

type RealtimeSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type Ack = (response: { ok: true } | { ok: false; code: 'not_found' | 'unavailable' | 'invalid' }) => void;

const channelRoom = (channelId: string) => `channel:${channelId}`;
const inboxRoom = (organizationId: string, userId: string) => `inbox:${organizationId}:${userId}`;
const reply = (ack: unknown, response: Parameters<Ack>[0]) => {
  if (typeof ack === 'function') (ack as Ack)(response);
};

function parseOrganization(payload: unknown): string | undefined {
  const organizationId = (payload as { organizationId?: unknown } | null)?.organizationId;
  return typeof organizationId === 'string' && UUID.test(organizationId) ? organizationId.toLowerCase() : undefined;
}

function parseSubscription(payload: unknown): ChannelRef | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const { organizationId, workspaceId, channelId } = payload as Record<string, unknown>;
  const ids = [organizationId, workspaceId, channelId];
  if (!ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) return undefined;
  return {
    organizationId: ids[0]!.toLowerCase(),
    workspaceId: ids[1]!.toLowerCase(),
    channelId: ids[2]!.toLowerCase(),
  };
}

@Injectable()
export class RealtimeHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private io: Server | undefined;
  private reauthorizeTimer: NodeJS.Timeout | undefined;
  private reauthorizing = false;
  private readonly socketsPerUser = new Map<string, number>();

  constructor(
    @Inject(REALTIME_CONFIG) private readonly config: RealtimeConfig,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifier,
    @Inject(ChannelDirectory) private readonly channels: ChannelDirectory,
    @Inject(InboxDirectory) private readonly inboxes: InboxDirectory,
    @Inject(EVENT_SOURCE) private readonly events: EventSource,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  onApplicationBootstrap(): void {
    const allowedOrigins = new Set(this.config.corsAllowedOrigins);
    const io = new Server(this.adapterHost.httpAdapter.getHttpServer() as HttpServer, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      serveClient: false,
      maxHttpBufferSize: MAX_PAYLOAD_BYTES,
      cors: { origin: this.config.corsAllowedOrigins },
      // Browsers always send Origin; clients without one are not browsers and still need a valid token.
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        callback(null, origin === undefined || allowedOrigins.has(origin));
      },
    });
    this.io = io;
    io.use((socket, next) => void this.authenticate(socket as RealtimeSocket, next));
    io.on('connection', (socket) => this.onConnection(socket as RealtimeSocket));

    // Not awaited: the subscriber keeps (re)connecting; /health/ready reports not ready until it is subscribed.
    this.events
      .start((raw) => this.fanOut(raw))
      .catch((error: unknown) => {
        this.logger.error({ event: 'event_source_failed', error: (error as Error).message });
      });
    this.reauthorizeTimer = setInterval(
      () => void this.reauthorizeAll(),
      this.config.reauthorizeIntervalSeconds * 1000,
    ).unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.reauthorizeTimer);
    await this.events.close();
    this.io?.disconnectSockets(true);
  }

  private async authenticate(socket: RealtimeSocket, next: (error?: Error) => void): Promise<void> {
    const token: unknown = socket.handshake.auth?.token;
    try {
      if (typeof token !== 'string' || token === '') throw new Error('no token');
      const principal = await this.verifier.verify(token);
      socket.data = {
        principal,
        authorization: `Bearer ${token}`,
        rooms: new Map(),
        subscribeWindow: { startedAt: 0, count: 0 },
      };
      next();
    } catch {
      // The reason (missing, malformed, expired, wrong key) is deliberately not revealed to the client.
      next(new Error('unauthenticated'));
    }
  }

  private onConnection(socket: RealtimeSocket): void {
    // Counted on connection and released on disconnect, so the count is exact even for concurrent handshakes.
    const { userId } = socket.data.principal;
    const open = (this.socketsPerUser.get(userId) ?? 0) + 1;
    this.socketsPerUser.set(userId, open);
    socket.on('disconnect', () => {
      clearTimeout(socket.data.expiryTimer);
      const left = (this.socketsPerUser.get(userId) ?? 1) - 1;
      if (left > 0) this.socketsPerUser.set(userId, left);
      else this.socketsPerUser.delete(userId);
    });
    if (open > this.config.maxSocketsPerUser) return void socket.disconnect(true);
    this.scheduleExpiry(socket);
    const subscribing =
      (parse: (payload: unknown) => [string, Subscription] | undefined) => (payload: unknown, ack: unknown) => {
        this.subscribe(socket, parse(payload), ack).catch((error: unknown) => {
          this.logger.error({ event: 'subscribe_failed', error: (error as Error).message });
          reply(ack, { ok: false, code: 'unavailable' });
        });
      };
    const leaving = (roomOf: (payload: unknown) => string | undefined) => (payload: unknown, ack: unknown) => {
      const room = roomOf(payload);
      if (room) {
        socket.data.rooms.delete(room);
        void socket.leave(room);
      }
      reply(ack, { ok: true });
    };
    socket.on(
      'subscribe',
      subscribing((payload) => {
        const ref = parseSubscription(payload);
        return ref && [channelRoom(ref.channelId), { kind: 'channel', ref }];
      }),
    );
    socket.on(
      'unsubscribe',
      leaving((payload) => {
        const channelId = (payload as { channelId?: unknown } | null)?.channelId;
        return typeof channelId === 'string' && UUID.test(channelId) ? channelRoom(channelId.toLowerCase()) : undefined;
      }),
    );
    // A socket may only ever join its OWN inbox: the room is derived from the authenticated user, never the payload.
    socket.on(
      'inbox.subscribe',
      subscribing((payload) => {
        const organizationId = parseOrganization(payload);
        return organizationId
          ? [inboxRoom(organizationId, userId.toLowerCase()), { kind: 'inbox', organizationId }]
          : undefined;
      }),
    );
    socket.on(
      'inbox.unsubscribe',
      leaving((payload) => {
        const organizationId = parseOrganization(payload);
        return organizationId ? inboxRoom(organizationId, userId.toLowerCase()) : undefined;
      }),
    );
  }

  /** The socket ends when its access token does; the client reconnects with a fresh one. */
  private scheduleExpiry(socket: RealtimeSocket): void {
    const remaining = socket.data.principal.expiresAt.getTime() - Date.now();
    if (remaining <= 0) return void socket.disconnect(true);
    socket.data.expiryTimer = setTimeout(() => this.scheduleExpiry(socket), Math.min(remaining, MAX_TIMER_MS));
  }

  private async subscribe(
    socket: RealtimeSocket,
    target: [string, Subscription] | undefined,
    ack: unknown,
  ): Promise<void> {
    if (this.rateLimited(socket)) return reply(ack, { ok: false, code: 'unavailable' });
    if (!target) return reply(ack, { ok: false, code: 'invalid' });
    const [room, subscription] = target;
    const full = () => !socket.data.rooms.has(room) && socket.data.rooms.size >= this.config.maxChannelsPerSocket;
    if (full()) return reply(ack, { ok: false, code: 'unavailable' });

    const result = await this.check(subscription, socket.data.authorization);
    if (socket.disconnected) return;
    switch (result) {
      case 'visible':
        // Again after the check: concurrent subscribes must not overshoot the cap.
        if (full()) return reply(ack, { ok: false, code: 'unavailable' });
        socket.data.rooms.set(room, subscription);
        await socket.join(room);
        return reply(ack, { ok: true });
      case 'not_found':
        return reply(ack, { ok: false, code: 'not_found' });
      case 'unauthenticated':
        reply(ack, { ok: false, code: 'not_found' });
        return void socket.disconnect(true);
      default:
        return reply(ack, { ok: false, code: 'unavailable' });
    }
  }

  /** Fixed one-minute window per socket, counting every attempt (valid or not): stops id-guessing floods. */
  private rateLimited(socket: RealtimeSocket): boolean {
    const window = socket.data.subscribeWindow;
    const now = Date.now();
    if (now - window.startedAt >= 60_000) {
      window.startedAt = now;
      window.count = 0;
    }
    window.count += 1;
    return window.count > SUBSCRIBES_PER_MINUTE;
  }

  private check(subscription: Subscription, authorization: string): Promise<ChannelVisibility> {
    return subscription.kind === 'channel'
      ? this.channels.visibility(subscription.ref, authorization)
      : this.inboxes.access(subscription.organizationId, authorization);
  }

  private fanOut(raw: string): void {
    const parsed = parseFanOutEvent(raw);
    if (!parsed) {
      this.logger.warn({ event: 'event_dropped', reason: 'malformed', type: eventTypeOf(raw) });
      return;
    }
    // Ids only. Clients fetch content through the REST API, which authorizes again.
    if (parsed.kind === 'channel') {
      this.io?.to(channelRoom(parsed.event.channelId)).emit('message.changed', parsed.event);
      return;
    }
    // Only the named recipients' inboxes in that organization (one emit per socket, even across rooms).
    const rooms = parsed.recipientUserIds.map((userId) => inboxRoom(parsed.event.organizationId, userId));
    this.io?.to(rooms).emit('conversation.changed', parsed.event);
  }

  /** Re-checks every joined room of every socket; a user who lost access (or whose check fails) is removed. */
  private async reauthorizeAll(): Promise<void> {
    const io = this.io;
    if (!io || this.reauthorizing) return;
    this.reauthorizing = true;
    try {
      const sockets = [...io.sockets.sockets.values()].filter((s) => (s as RealtimeSocket).data.rooms.size > 0);
      const queue = sockets as RealtimeSocket[];
      await Promise.all(
        Array.from({ length: Math.min(REAUTHORIZE_CONCURRENCY, queue.length) }, async () => {
          for (let socket = queue.shift(); socket; socket = queue.shift()) {
            // An unexpected error must neither stop the cycle early nor leave this socket unchecked: fail closed.
            await this.reauthorize(socket).catch((error: unknown) => {
              this.logger.error({ event: 'reauthorize_failed', error: (error as Error).message });
              socket.disconnect(true);
            });
          }
        }),
      );
    } catch (error) {
      this.logger.error({ event: 'reauthorize_failed', error: (error as Error).message });
    } finally {
      this.reauthorizing = false;
    }
  }

  private async reauthorize(socket: RealtimeSocket): Promise<void> {
    for (const [room, subscription] of [...socket.data.rooms]) {
      if (socket.disconnected) return;
      const result = await this.check(subscription, socket.data.authorization);
      if (socket.disconnected || !socket.data.rooms.has(room)) continue;
      if (result === 'visible') continue;
      if (result === 'unauthenticated') return void socket.disconnect(true);
      // not_found, or the deciding service failing: fail closed.
      socket.data.rooms.delete(room);
      await socket.leave(room);
      if (subscription.kind === 'channel') socket.emit('unsubscribed', { channelId: subscription.ref.channelId });
      else socket.emit('inbox.unsubscribed', { organizationId: subscription.organizationId });
    }
  }
}
