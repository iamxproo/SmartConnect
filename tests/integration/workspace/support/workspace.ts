// Builds the REAL workspace service (same factory as its main.ts) against the disposable test database, with a FAKE
// organization service (an in-memory membership table behind an ephemeral http server) and tokens signed by a key
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
import { createWorkspaceApp } from '../../../../smartconnect-backend/services/workspace/src/app.factory.js';
import { loadConfig } from '../../../../smartconnect-backend/services/workspace/src/config.js';
import { createPrismaClient } from '../../../../smartconnect-backend/services/workspace/src/database/client.js';
import { appUrl } from '../../../support/database.js';

class SilentLogger implements LoggerService {
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

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const KID = `test-${randomUUID()}`;
const privateJwk: JWK = { ...(privateKey.export({ format: 'jwk' }) as JWK), kid: KID, alg: 'EdDSA' };
const publicJwks = JSON.stringify({
  keys: [{ ...(publicKey.export({ format: 'jwk' }) as JWK), kid: KID, alg: 'EdDSA', use: 'sig' }],
});

const tokens = new Map<string, string>();
export async function tokenFor(userId: string): Promise<string> {
  const cached = tokens.get(userId);
  if (cached) return cached;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sid: randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'at+jwt' })
    .setSubject(userId)
    .setIssuer(DEFAULT_ACCESS_TOKEN_ISSUER)
    .setAudience(DEFAULT_ACCESS_TOKEN_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importJWK(privateJwk, 'EdDSA'));
  tokens.set(userId, token);
  return token;
}

const subjectOf = (authorization: string | undefined): string | undefined => {
  const payload = authorization?.split(' ')[1]?.split('.')[1];
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string }).sub : undefined;
};

/** The organization service as the workspace service sees it: `/me` and `/members?userId=` over HTTP. */
export class FakeOrganizationService {
  private readonly members = new Map<string, Map<string, { permissions: string[]; joinedAt: string }>>();
  readonly requests: { url: string; authorization: string | undefined }[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeOrganizationService> {
    const holder: { fake?: FakeOrganizationService } = {};
    const server = createServer((req, res) => {
      const fake = holder.fake!;
      fake.requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
      const url = new URL(req.url ?? '/', 'http://fake');
      const me = /^\/api\/v1\/orgs\/([^/]+)\/me$/.exec(url.pathname);
      const list = /^\/api\/v1\/orgs\/([^/]+)\/members$/.exec(url.pathname);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const caller = subjectOf(req.headers.authorization);
      if (me) {
        const member = caller ? fake.members.get(me[1]!)?.get(caller) : undefined;
        if (!member) return send(404, { code: 'not_found' });
        return send(200, {
          memberId: randomUUID(),
          organizationId: me[1],
          role: { id: randomUUID(), key: 'member', name: 'Member', permissions: member.permissions },
          title: null,
          joinedAt: member.joinedAt,
        });
      }
      if (list) {
        const orgMembers = fake.members.get(list[1]!);
        if (!caller || !orgMembers?.has(caller)) return send(404, { code: 'not_found' });
        const userId = url.searchParams.get('userId');
        return send(200, { data: userId && orgMembers.has(userId) ? [{ id: randomUUID(), userId }] : [] });
      }
      return send(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeOrganizationService(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    holder.fake = fake;
    return fake;
  }

  /**
   * A membership keeps the time it began, like the real service. Default: a minute ago, so host/database clock skew
   * cannot make workspace memberships created afterwards look older than it. Pass `joinedAt` to model a re-invite.
   */
  addMember(orgId: string, userId: string, permissions: string[] = [], joinedAt?: Date): void {
    if (!this.members.has(orgId)) this.members.set(orgId, new Map());
    const existing = this.members.get(orgId)!.get(userId);
    this.members.get(orgId)!.set(userId, {
      permissions,
      joinedAt: joinedAt?.toISOString() ?? existing?.joinedAt ?? new Date(Date.now() - 60_000).toISOString(),
    });
  }

  revoke(orgId: string, userId: string): void {
    this.members.get(orgId)?.delete(userId);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

export interface TestWorkspace {
  app: NestExpressApplication;
  server: Server;
  org: FakeOrganizationService;
  logger: SilentLogger;
  close(): Promise<void>;
}

export async function startWorkspace(options: { organizationServiceUrl?: string } = {}): Promise<TestWorkspace> {
  const org = await FakeOrganizationService.start();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl('workspace'),
    AUTH_JWT_PUBLIC_JWKS: publicJwks,
    ORGANIZATION_SERVICE_URL: options.organizationServiceUrl ?? org.url,
  });
  const prisma = createPrismaClient({ connectionString: config.databaseUrl, maxConnections: 10 });
  const logger = new SilentLogger();
  const app = await createWorkspaceApp({ config, logger, prisma });
  await app.init();
  return {
    app,
    server: app.getHttpServer(),
    org,
    logger,
    close: async () => {
      await app.close(); // also disconnects Prisma
      await org.close();
    },
  };
}

export const problemOf = (res: Response) => res.body as ProblemDetails;

export const newId = () => randomUUID();

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** One simulated person in one organization. */
export class Actor {
  constructor(
    private readonly ws: TestWorkspace,
    readonly orgId: string,
    readonly userId: string,
  ) {}

  /** The same person addressing another organization's path (cross-tenant probes). */
  inOrg(orgId: string): Actor {
    return new Actor(this.ws, orgId, this.userId);
  }

  async call(method: HttpMethod, path: string, body?: object): Promise<Response> {
    const req = request(this.ws.server)[method](`/api/v1/orgs/${this.orgId}${path}`);
    req.set('Authorization', `Bearer ${await tokenFor(this.userId)}`);
    return body === undefined ? req : req.send(body);
  }

  get = (path: string) => this.call('get', path);
  post = (path: string, body?: object) => this.call('post', path, body);
  put = (path: string, body?: object) => this.call('put', path, body);
  patch = (path: string, body?: object) => this.call('patch', path, body);
  delete = (path: string) => this.call('delete', path);

  async createWorkspace(overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
    const slug = `ws-${randomUUID().slice(0, 8)}`;
    const res = await this.post('/workspaces', { name: 'Team', slug, visibility: 'open', ...overrides });
    if (res.status !== 201) throw new Error(`createWorkspace failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { id: (res.body as { id: string }).id, slug };
  }

  async createChannel(workspaceId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const name = `ch-${randomUUID().slice(0, 8)}`;
    const res = await this.post(`/workspaces/${workspaceId}/channels`, { name, type: 'public', ...overrides });
    if (res.status !== 201) throw new Error(`createChannel failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { id: (res.body as { id: string }).id };
  }
}

/** A fresh organization with named members (so tests never share rows). */
export function newOrganization(ws: TestWorkspace, creators: string[] = ['owner']) {
  const orgId = randomUUID();
  const people: Record<string, Actor> = {};
  const add = (name: string, permissions: string[] = []): Actor => {
    const actor = new Actor(ws, orgId, randomUUID());
    ws.org.addMember(orgId, actor.userId, permissions);
    people[name] = actor;
    return actor;
  };
  for (const name of creators) add(name, ['workspaces.create']);
  return { orgId, add, people };
}
