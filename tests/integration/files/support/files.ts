// Builds the REAL files service (same factory as its main.ts) against the disposable test database and a temporary
// storage directory, with FAKE organization and messaging services (in-memory, behind ephemeral http servers) and
// tokens signed by a key generated in memory. Nothing touches the dev database or the real storage directory.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DEFAULT_ACCESS_TOKEN_AUDIENCE,
  DEFAULT_ACCESS_TOKEN_ISSUER,
  type ProblemDetails,
} from '@smartconnect/backend-kit';
import { importJWK, SignJWT, type JWK } from 'jose';
import request, { type Response } from 'supertest';
import { createFilesApp } from '../../../../smartconnect-backend/services/files/src/app.factory.js';
import { loadConfig } from '../../../../smartconnect-backend/services/files/src/config.js';
import type { FileStorage } from '../../../../smartconnect-backend/services/files/src/storage/file-storage.js';
import { createPrismaClient } from '../../../../smartconnect-backend/services/files/src/database/client.js';
import { appUrl } from '../../../support/database.js';

class RecordingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(message: unknown) {
    this.lines.push(typeof message === 'string' ? message : JSON.stringify(message));
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

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<[Server, string]> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** The organization service as the files service sees it: `/me` over HTTP. */
export class FakeOrganizationService {
  private readonly members = new Map<string, Set<string>>();
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeOrganizationService> {
    const holder: { fake?: FakeOrganizationService } = {};
    const [server, url] = await listen((req, res) => {
      const me = /^\/api\/v1\/orgs\/([^/]+)\/me$/.exec(req.url ?? '');
      const caller = subjectOf(req.headers.authorization);
      if (!me || !caller || !holder.fake!.members.get(me[1]!)?.has(caller)) return sendJson(res, 404, {});
      sendJson(res, 200, {
        memberId: randomUUID(),
        organizationId: me[1],
        role: { id: randomUUID(), key: 'member', name: 'Member', permissions: [] },
        title: null,
        joinedAt: new Date(Date.now() - 60_000).toISOString(),
      });
    });
    holder.fake = new FakeOrganizationService(server, url);
    return holder.fake;
  }

  addMember(orgId: string, userId: string): void {
    if (!this.members.has(orgId)) this.members.set(orgId, new Set());
    this.members.get(orgId)!.add(userId);
  }
  revoke(orgId: string, userId: string): void {
    this.members.get(orgId)?.delete(userId);
  }
  close = () => closeServer(this.server);
}

/**
 * Messaging's Wave 2 contract: `GET /api/v1/orgs/{o}/attachments/{fileId}` as the caller. 200 = the caller can see a
 * message that attaches the file; 404 = not. `failWith` makes every answer that status instead (500 = broken).
 */
export class FakeMessagingService {
  private readonly allowed = new Set<string>();
  failWith: number | undefined;
  readonly requests: { url: string; authorization: string | undefined }[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeMessagingService> {
    const holder: { fake?: FakeMessagingService } = {};
    const [server, url] = await listen((req, res) => {
      const fake = holder.fake!;
      fake.requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
      if (fake.failWith !== undefined) return sendJson(res, fake.failWith, {});
      const match = /^\/api\/v1\/orgs\/([^/]+)\/attachments\/([^/]+)$/.exec(req.url ?? '');
      const caller = subjectOf(req.headers.authorization);
      if (match && caller && fake.allowed.has(`${match[1]}/${match[2]}/${caller}`))
        return sendJson(res, 200, { fileId: match[2] });
      sendJson(res, 404, {});
    });
    holder.fake = new FakeMessagingService(server, url);
    return holder.fake;
  }

  /** `userId` can see a message in `orgId` that attaches `fileId`. */
  allow(orgId: string, fileId: string, userId: string): void {
    this.allowed.add(`${orgId}/${fileId}/${userId}`);
  }
  revokeAll(): void {
    this.allowed.clear();
    this.failWith = undefined;
    this.requests.length = 0;
  }
  close = () => closeServer(this.server);
}

export interface TestFiles {
  app: NestExpressApplication;
  server: Server;
  org: FakeOrganizationService;
  messaging: FakeMessagingService;
  logger: RecordingLogger;
  storageDir: string;
  close(): Promise<void>;
}

export async function startFiles(
  env: Record<string, string> = {},
  /** Wraps the real storage (e.g. to observe or fail promote); gets the storage directory. */
  makeStorage?: (storageDir: string) => FileStorage,
): Promise<TestFiles> {
  const org = await FakeOrganizationService.start();
  const messaging = await FakeMessagingService.start();
  const storageDir = await mkdtemp(path.join(tmpdir(), 'files-it-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl('files'),
    AUTH_JWT_PUBLIC_JWKS: publicJwks,
    ORGANIZATION_SERVICE_URL: org.url,
    MESSAGING_SERVICE_URL: messaging.url,
    FILES_STORAGE_DIR: storageDir,
    ...env,
  });
  const prisma = createPrismaClient({ connectionString: config.databaseUrl, maxConnections: 10 });
  const logger = new RecordingLogger();
  const app = await createFilesApp({ config, logger, prisma, storage: makeStorage?.(storageDir) });
  await app.init();
  return {
    app,
    server: app.getHttpServer(),
    org,
    messaging,
    logger,
    storageDir,
    close: async () => {
      await app.close(); // also disconnects Prisma
      await org.close();
      await messaging.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

export const problemOf = (res: Response) => res.body as ProblemDetails;

type Method = 'get' | 'post' | 'put' | 'delete';

/** One simulated person in one organization. */
export class Person {
  constructor(
    private readonly files: TestFiles,
    readonly orgId: string,
    readonly userId: string,
  ) {}

  /** The same person addressing another organization's path (cross-tenant probes). */
  inOrg(orgId: string): Person {
    return new Person(this.files, orgId, this.userId);
  }

  async call(method: Method, path: string, body?: object | Buffer, contentType?: string): Promise<Response> {
    const req = request(this.files.server)[method](`/api/v1/orgs/${this.orgId}${path}`);
    req.set('Authorization', `Bearer ${await tokenFor(this.userId)}`);
    if (contentType) req.set('Content-Type', contentType);
    return body === undefined ? req : req.send(body);
  }

  get = (path: string) => this.call('get', path);
  post = (path: string, body?: object) => this.call('post', path, body);
  delete = (path: string) => this.call('delete', path);
  /** Raw bytes to …/content; binary responses are buffered by supertest. */
  upload = (id: string, bytes: Buffer, contentType = 'application/octet-stream') =>
    this.call('put', `/files/${id}/content`, bytes, contentType);
  download = async (id: string): Promise<Response> => {
    const req = request(this.files.server).get(`/api/v1/orgs/${this.orgId}/files/${id}/content`);
    return req
      .set('Authorization', `Bearer ${await tokenFor(this.userId)}`)
      .buffer(true)
      .parse(binaryParser);
  };

  /** Declares and uploads a file; returns the final metadata. */
  async create(name: string, bytes: Buffer): Promise<{ id: string; name: string; mimeType: string; status: string }> {
    const created = await this.post('/files', { name, sizeBytes: bytes.length });
    if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.body)}`);
    const id = (created.body as { id: string }).id;
    const uploaded = await this.upload(id, bytes);
    if (uploaded.status !== 200) throw new Error(`upload failed: ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
    return uploaded.body as { id: string; name: string; mimeType: string; status: string };
  }
}

function binaryParser(res: Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on('data', (chunk: Buffer) => chunks.push(chunk));
  (res as unknown as NodeJS.ReadableStream).on('end', () => callback(null, Buffer.concat(chunks)));
}

/** A fresh organization with named members (so tests never share rows). */
export function newOrganization(files: TestFiles, names: string[] = ['alice', 'bob']) {
  const orgId = randomUUID();
  const people: Record<string, Person> = {};
  for (const name of names) {
    const person = new Person(files, orgId, randomUUID());
    files.org.addMember(orgId, person.userId);
    people[name] = person;
  }
  return { orgId, people };
}

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-the-rest-of-a-tiny-image'),
]);

/** A fresh organization with exactly two members. */
export function twoPeople(files: TestFiles) {
  const { orgId, people } = newOrganization(files, ['alice', 'bob']);
  return { orgId, alice: people.alice!, bob: people.bob! };
}
