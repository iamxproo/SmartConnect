// Builds the REAL messaging service (same factory as its main.ts) against the disposable test database, with a FAKE
// workspace service (an in-memory visibility table behind an ephemeral http server) and tokens signed by a key
// generated in memory. Nothing touches the dev database.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DEFAULT_ACCESS_TOKEN_AUDIENCE,
  DEFAULT_ACCESS_TOKEN_ISSUER,
  type ProblemDetails,
} from '@smartconnect/backend-kit';
import { importJWK, SignJWT, type JWK } from 'jose';
import request, { type Response } from 'supertest';
import { createMessagingApp } from '../../../../smartconnect-backend/services/messaging/src/app.factory.js';
import { loadConfig } from '../../../../smartconnect-backend/services/messaging/src/config.js';
import { createPrismaClient } from '../../../../smartconnect-backend/services/messaging/src/database/client.js';
import { adminUrl, appUrl, query } from '../../../support/database.js';

class RecordingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(message: unknown) {
    this.lines.push(JSON.stringify(message));
  }
  log = (m: unknown) => this.push(m);
  error = (m: unknown) => this.push(m);
  warn = (m: unknown) => this.push(m);
  debug = (m: unknown) => this.push(m);
  verbose = (m: unknown) => this.push(m);
  fatal = (m: unknown) => this.push(m);
}

function newSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kid = `test-${randomUUID()}`;
  const privateJwk: JWK = { ...(privateKey.export({ format: 'jwk' }) as JWK), kid, alg: 'EdDSA' };
  const publicJwks = JSON.stringify({
    keys: [{ ...(publicKey.export({ format: 'jwk' }) as JWK), kid, alg: 'EdDSA', use: 'sig' }],
  });
  const sign = async (userId: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'at+jwt' })
      .setSubject(userId)
      .setIssuer(DEFAULT_ACCESS_TOKEN_ISSUER)
      .setAudience(DEFAULT_ACCESS_TOKEN_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(await importJWK(privateJwk, 'EdDSA'));
  };
  return { publicJwks, sign };
}

const trusted = newSigner();
/** Public keys of the signer behind tokenFor(), for other services under test that must trust the same tokens. */
export const trustedPublicJwks = trusted.publicJwks;
const tokens = new Map<string, string>();
export async function tokenFor(userId: string): Promise<string> {
  const cached = tokens.get(userId);
  if (cached) return cached;
  const token = await trusted.sign(userId);
  tokens.set(userId, token);
  return token;
}
/** A well-formed token signed by a key the service does not trust. */
export const forgedTokenFor = (userId: string) => newSigner().sign(userId);

const subjectOf = (authorization: string | undefined): string | undefined => {
  const payload = authorization?.split(' ')[1]?.split('.')[1];
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string }).sub : undefined;
};

export interface Visibility {
  isMember: boolean;
  myRole: 'admin' | 'member' | null;
  archivedAt?: string | null;
}

/** The workspace service as the messaging service sees it: `GET …/channels/{id}` answers per (org, channel, user). */
export class FakeWorkspaceService {
  private readonly visible = new Map<string, Visibility & { workspaceId: string }>();
  private readonly broken = new Map<string, 'wrong-id' | 'garbage' | 'error' | 'forbidden' | 'unauthorized'>();
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
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const caller = subjectOf(req.headers.authorization);
      const listing = /^\/api\/v1\/orgs\/([^/]+)\/channels(?:\?(.*))?$/.exec(req.url ?? '');
      if (listing && caller) return fake.sendList(listing[1]!, caller, new URLSearchParams(listing[2]), send);
      const match = /^\/api\/v1\/orgs\/([^/]+)\/workspaces\/([^/]+)\/channels\/([^/]+)$/.exec(req.url ?? '');
      if (!match || !caller) return send(404, { code: 'not_found' });
      const [, orgId, workspaceId, channelId] = match as unknown as [string, string, string, string];
      const key = fake.key(orgId, channelId, caller);
      const mode = fake.broken.get(key);
      if (mode === 'error') return send(500, { code: 'internal' });
      if (mode === 'forbidden') return send(403, { code: 'forbidden' });
      if (mode === 'unauthorized') return send(401, { code: 'invalid_token' });
      if (mode === 'garbage') return send(200, 'not json at all');
      const entry = fake.visible.get(key);
      if (!entry || entry.workspaceId !== workspaceId) return send(404, { code: 'not_found' });
      return send(200, {
        id: mode === 'wrong-id' ? randomUUID() : channelId,
        workspaceId,
        name: 'general',
        type: 'public',
        isDefault: false,
        isMember: entry.isMember,
        myRole: entry.myRole,
        archivedAt: entry.archivedAt ?? null,
        createdAt: new Date().toISOString(),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeWorkspaceService(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    holder.fake = fake;
    return fake;
  }

  private key = (orgId: string, channelId: string, userId: string) => `${orgId}|${channelId}|${userId}`;

  /** `GET /orgs/{o}/channels` (the caller's visible channels, paged by offset cursor); `listFailure` breaks it. */
  listFailure: 'error' | 'garbage' | null = null;
  /** Cap on the page size, to exercise paging with few channels. */
  listPageSize = 100;

  private sendList(
    orgId: string,
    caller: string,
    params: URLSearchParams,
    send: (status: number, body: unknown) => void,
  ): void {
    if (this.listFailure === 'error') return send(500, { code: 'internal' });
    if (this.listFailure === 'garbage') return send(200, 'not json at all');
    const mine = [...this.visible]
      .map(([key, entry]) => ({ key: key.split('|') as [string, string, string], entry }))
      .filter(({ key }) => key[0] === orgId && key[2] === caller)
      .sort((a, b) => a.key[1].localeCompare(b.key[1]));
    const size = Math.min(Number(params.get('limit') ?? 50), this.listPageSize);
    const start = Number(Buffer.from(params.get('cursor') ?? '', 'base64url').toString() || 0);
    const page = mine.slice(start, start + size);
    send(200, {
      data: page.map(({ key, entry }) => ({
        id: key[1],
        workspaceId: entry.workspaceId,
        workspaceName: 'Workspace',
        name: 'general',
        type: 'public',
        isMember: entry.isMember,
        archivedAt: entry.archivedAt ?? null,
      })),
      nextCursor: start + size < mine.length ? Buffer.from(String(start + size)).toString('base64url') : null,
    });
  }

  show(c: Chan, userId: string, visibility: Visibility): void {
    this.visible.set(this.key(c.orgId, c.chId, userId), { ...visibility, workspaceId: c.wsId });
  }

  hide(c: Chan, userId: string): void {
    this.visible.delete(this.key(c.orgId, c.chId, userId));
  }

  break(c: Chan, userId: string, mode: 'wrong-id' | 'garbage' | 'error' | 'forbidden' | 'unauthorized'): void {
    this.broken.set(this.key(c.orgId, c.chId, userId), mode);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

export interface TestMessaging {
  app: NestExpressApplication;
  server: Server;
  workspace: FakeWorkspaceService;
  logger: RecordingLogger;
  close(): Promise<void>;
}

export async function startMessaging(
  options: { workspaceServiceUrl?: string; env?: Record<string, string> } = {},
): Promise<TestMessaging> {
  const workspace = await FakeWorkspaceService.start();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl('messaging'),
    AUTH_JWT_PUBLIC_JWKS: trusted.publicJwks,
    WORKSPACE_SERVICE_URL: options.workspaceServiceUrl ?? workspace.url,
    ...options.env,
  });
  const prisma = createPrismaClient({ connectionString: config.databaseUrl, maxConnections: 10 });
  const logger = new RecordingLogger();
  const app = await createMessagingApp({ config, logger, prisma });
  await app.init();
  return {
    app,
    server: app.getHttpServer(),
    workspace,
    logger,
    close: async () => {
      await app.close(); // also disconnects Prisma
      await workspace.close();
    },
  };
}

export const problemOf = (res: Response) => res.body as ProblemDetails;

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** One channel (in one workspace of one organization) addressed through the public path. */
export class Chan {
  constructor(
    readonly orgId: string = randomUUID(),
    readonly wsId: string = randomUUID(),
    readonly chId: string = randomUUID(),
  ) {}

  /** Same channel id and workspace under another organization's path (cross-tenant probe). */
  inOrg(orgId: string): Chan {
    return new Chan(orgId, this.wsId, this.chId);
  }

  path = (suffix = '') => `/api/v1/orgs/${this.orgId}/workspaces/${this.wsId}/channels/${this.chId}/messages${suffix}`;
}

export class Person {
  constructor(
    private readonly svc: TestMessaging,
    readonly userId: string = randomUUID(),
  ) {}

  async call(method: HttpMethod, chan: Chan, suffix: string, body?: object): Promise<Response> {
    const req = request(this.svc.server)[method](chan.path(suffix));
    req.set('Authorization', `Bearer ${await tokenFor(this.userId)}`);
    return body === undefined ? req : req.send(body);
  }

  list = (chan: Chan, qs = '') => this.call('get', chan, qs);
  post = (chan: Chan, body: object) => this.call('post', chan, '', body);
  edit = (chan: Chan, id: string, body: object) => this.call('patch', chan, `/${id}`, body);
  remove = (chan: Chan, id: string) => this.call('delete', chan, `/${id}`);
}

/** A channel where `members` can post and `admins` can post and moderate. */
export function scenario(svc: TestMessaging, { archivedAt = null as string | null } = {}) {
  const chan = new Chan();
  const grant = (v: Visibility): Person => {
    const person = new Person(svc);
    svc.workspace.show(chan, person.userId, { archivedAt, ...v });
    return person;
  };
  return {
    chan,
    member: () => grant({ isMember: true, myRole: 'member' }),
    admin: () => grant({ isMember: true, myRole: 'admin' }),
    reader: () => grant({ isMember: false, myRole: null }),
    outsider: () => new Person(svc),
  };
}

export const db = {
  rows: <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => query<R>(adminUrl(), sql, params),
  count: async (sql: string, params: unknown[] = []) =>
    Number((await query<{ n: string }>(adminUrl(), sql, params))[0]!.n),
  messageCount: (chan: Chan) =>
    db.count(
      `SELECT count(*) AS n FROM messaging.messages m JOIN messaging.conversations c ON c.id = m.conversation_id
       WHERE c.channel_id = $1`,
      [chan.chId],
    ),
  conversationCount: (chan: Chan) =>
    db.count('SELECT count(*) AS n FROM messaging.conversations WHERE channel_id = $1', [chan.chId]),
};
