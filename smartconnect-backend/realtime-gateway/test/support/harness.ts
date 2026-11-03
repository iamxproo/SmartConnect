// Test harness: the real gateway (same factory as main.ts) with an injected in-memory event source and FAKE workspace
// and messaging services behind ephemeral http servers. No Redis, no fixed ports.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DEFAULT_ACCESS_TOKEN_AUDIENCE, DEFAULT_ACCESS_TOKEN_ISSUER } from '@smartconnect/backend-kit';
import { importJWK, SignJWT, type JWK } from 'jose';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createRealtimeGateway } from '../../src/app.factory.js';
import { loadConfig } from '../../src/config.js';
import type { EventSource } from '../../src/events/event-source.js';

export interface KeyPair {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

export function generateKeyPair(kid = `test-${randomUUID()}`): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privateJwk: { ...(privateKey.export({ format: 'jwk' }) as JWK), kid, alg: 'EdDSA' },
    publicJwk: { ...(publicKey.export({ format: 'jwk' }) as JWK), kid, alg: 'EdDSA', use: 'sig' },
  };
}

export const trustedKeys = generateKeyPair();
export const trustedJwks = JSON.stringify({ keys: [trustedKeys.publicJwk] });

export async function signToken(options: { sub?: string; keys?: KeyPair; expiresIn?: number } = {}): Promise<string> {
  const keys = options.keys ?? trustedKeys;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA', kid: keys.kid, typ: 'at+jwt' })
    .setSubject(options.sub ?? randomUUID())
    .setIssuer(DEFAULT_ACCESS_TOKEN_ISSUER)
    .setAudience(DEFAULT_ACCESS_TOKEN_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 900))
    .sign(await importJWK(keys.privateJwk, 'EdDSA'));
}

export const subjectOf = (authorization: string | undefined): string | undefined => {
  const payload = authorization?.split(' ')[1]?.split('.')[1];
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string }).sub : undefined;
};

export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push = (message: unknown) => void this.lines.push(JSON.stringify(message));
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
  fatal = this.push;
}

export class InMemoryEventSource implements EventSource {
  private handler: ((raw: string) => void) | undefined;
  ready = true;
  start(onMessage: (raw: string) => void): Promise<void> {
    this.handler = onMessage;
    return Promise.resolve();
  }
  isReady = () => this.ready;
  close = () => Promise.resolve();
  publish(event: unknown): void {
    this.handler?.(typeof event === 'string' ? event : JSON.stringify(event));
  }
}

export interface ChannelIds {
  organizationId: string;
  workspaceId: string;
  channelId: string;
}
export const newChannel = (): ChannelIds => ({
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  channelId: randomUUID(),
});

type Mode = 'wrong-id' | 'error' | 'unauthorized' | 'forbidden' | 'hang-up';

/** `GET …/channels/{id}` as the workspace service answers it: per (channel, calling user). */
export class FakeWorkspaceService {
  private readonly visible = new Set<string>();
  private readonly modes = new Map<string, Mode>();
  readonly requests: { url: string; authorization: string | undefined }[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeWorkspaceService> {
    const holder: { fake?: FakeWorkspaceService } = {};
    const server = createServer((req, res) => {
      const fake = holder.fake!;
      fake.requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const match = /^\/api\/v1\/orgs\/([^/]+)\/workspaces\/([^/]+)\/channels\/([^/]+)$/.exec(req.url ?? '');
      const caller = subjectOf(req.headers.authorization);
      if (!match || !caller) return send(404, {});
      const [, , workspaceId, channelId] = match as unknown as [string, string, string, string];
      const key = `${caller}|${channelId}`;
      const mode = fake.modes.get(key);
      if (mode === 'hang-up') return void req.socket.destroy();
      if (mode === 'error') return send(500, {});
      if (mode === 'unauthorized') return send(401, {});
      if (mode === 'forbidden') return send(403, {});
      if (!fake.visible.has(`${key}|${workspaceId}`)) return send(404, {});
      return send(200, { id: mode === 'wrong-id' ? randomUUID() : channelId, workspaceId, name: 'general' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeWorkspaceService(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    holder.fake = fake;
    return fake;
  }

  show(userId: string, c: ChannelIds): void {
    this.visible.add(`${userId}|${c.channelId}|${c.workspaceId}`);
  }
  hide(userId: string, c: ChannelIds): void {
    this.visible.delete(`${userId}|${c.channelId}|${c.workspaceId}`);
  }
  break(userId: string, c: ChannelIds, mode: Mode | undefined): void {
    if (mode) this.modes.set(`${userId}|${c.channelId}`, mode);
    else this.modes.delete(`${userId}|${c.channelId}`);
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

type InboxMode = 'wrong-id' | 'error' | 'unauthorized';

/** `GET /orgs/{id}/conversations/inbox` as the messaging service answers it: per (organization, calling user). */
export class FakeMessagingService {
  private readonly members = new Set<string>();
  private readonly modes = new Map<string, InboxMode>();
  readonly requests: { url: string; authorization: string | undefined }[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeMessagingService> {
    const holder: { fake?: FakeMessagingService } = {};
    const server = createServer((req, res) => {
      const fake = holder.fake!;
      fake.requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const match = /^\/api\/v1\/orgs\/([^/]+)\/conversations\/inbox$/.exec(req.url ?? '');
      const caller = subjectOf(req.headers.authorization);
      if (!match || !caller) return send(404, {});
      const key = `${caller}|${match[1]}`;
      const mode = fake.modes.get(key);
      if (mode === 'error') return send(500, {});
      if (mode === 'unauthorized') return send(401, {});
      if (!fake.members.has(key)) return send(404, {});
      return send(200, { organizationId: mode === 'wrong-id' ? randomUUID() : match[1] });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeMessagingService(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    holder.fake = fake;
    return fake;
  }

  add(userId: string, organizationId: string): void {
    this.members.add(`${userId}|${organizationId}`);
  }
  remove(userId: string, organizationId: string): void {
    this.members.delete(`${userId}|${organizationId}`);
  }
  break(userId: string, organizationId: string, mode: InboxMode | undefined): void {
    if (mode) this.modes.set(`${userId}|${organizationId}`, mode);
    else this.modes.delete(`${userId}|${organizationId}`);
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

export interface TestGateway {
  app: NestExpressApplication;
  url: string;
  events: InMemoryEventSource;
  workspace: FakeWorkspaceService;
  messaging: FakeMessagingService;
  logger: CapturingLogger;
  close(): Promise<void>;
}

export async function startGateway(env: Record<string, string> = {}): Promise<TestGateway> {
  const workspace = await FakeWorkspaceService.start();
  const messaging = await FakeMessagingService.start();
  const events = new InMemoryEventSource();
  const logger = new CapturingLogger();
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_JWT_PUBLIC_JWKS: trustedJwks,
    WORKSPACE_SERVICE_URL: workspace.url,
    MESSAGING_SERVICE_URL: messaging.url,
    REDIS_URL: 'redis://127.0.0.1:1', // never used: the event source is injected
    ...env,
  });
  const app = await createRealtimeGateway({ config, logger, eventSource: events });
  await app.listen(0, '127.0.0.1');
  return {
    app,
    url: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`,
    events,
    workspace,
    messaging,
    logger,
    close: async () => {
      await app.close();
      await workspace.close();
      await messaging.close();
    },
  };
}

export interface TestClient {
  socket: Socket;
  /** `message.changed` payloads received so far. */
  changes: unknown[];
  unsubscribed: unknown[];
  /** `conversation.changed` payloads and `inbox.unsubscribed` notices received so far. */
  inbox: unknown[];
  inboxUnsubscribed: unknown[];
  subscribe(c: unknown): Promise<unknown>;
  subscribeInbox(payload: unknown): Promise<unknown>;
  close(): void;
}

/** Connects (resolves once connected) or rejects with the `connect_error` message. */
export function connect(url: string, options: { token?: unknown; origin?: string } = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = connectClient(url, {
      path: '/realtime/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: options.token === undefined ? {} : { token: options.token },
      extraHeaders: options.origin ? { Origin: options.origin } : undefined,
    });
    const client: TestClient = {
      socket,
      changes: [],
      unsubscribed: [],
      inbox: [],
      inboxUnsubscribed: [],
      subscribe: (c) => socket.emitWithAck('subscribe', c),
      subscribeInbox: (payload) => socket.emitWithAck('inbox.subscribe', payload),
      close: () => void socket.close(),
    };
    socket.on('message.changed', (e: unknown) => client.changes.push(e));
    socket.on('unsubscribed', (e: unknown) => client.unsubscribed.push(e));
    socket.on('conversation.changed', (e: unknown) => client.inbox.push(e));
    socket.on('inbox.unsubscribed', (e: unknown) => client.inboxUnsubscribed.push(e));
    socket.on('connect', () => resolve(client));
    socket.on('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

/** Polls until `predicate` holds (the tests have no fixed sleeps for positive assertions). */
export async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const messageEvent = (c: ChannelIds, type = 'message.created', messageId = randomUUID()) => ({
  service: 'messaging',
  type,
  ...c,
  messageId,
});

export const conversationEvent = (
  organizationId: string,
  recipientUserIds: string[],
  overrides: Record<string, unknown> = {},
) => ({
  service: 'messaging',
  type: 'conversation.changed',
  change: 'message.created',
  organizationId,
  conversationId: randomUUID(),
  messageId: randomUUID(),
  recipientUserIds,
  ...overrides,
});
