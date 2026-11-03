// Direct and group conversations against the REAL messaging service and test database, with a FAKE organization
// service (membership table behind an ephemeral http server). The realtime publisher is spied on: its events are the
// exact objects that would be serialized to Redis after commit.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request, { type Response } from 'supertest';
import { vi } from 'vitest';
import {
  RealtimePublisher,
  type ConversationChanged,
} from '../../../../smartconnect-backend/services/messaging/src/events/realtime-publisher.js';
import { startMessaging, tokenFor, type HttpMethod, type TestMessaging } from './messaging.js';

const subjectOf = (authorization: string | undefined): string | undefined => {
  const payload = authorization?.split(' ')[1]?.split('.')[1];
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string }).sub : undefined;
};

/** The organization service as messaging sees it: `/me` and `/members?userId=…&userId=…`. */
export class FakeOrganizationService {
  private readonly members = new Map<string, Map<string, string>>();
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
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const caller = subjectOf(req.headers.authorization);
      const me = /^\/api\/v1\/orgs\/([^/]+)\/me$/.exec(url.pathname);
      const list = /^\/api\/v1\/orgs\/([^/]+)\/members$/.exec(url.pathname);
      const orgId = (me ?? list)?.[1];
      const orgMembers = orgId ? fake.members.get(orgId) : undefined;
      if (!caller || !orgId || !orgMembers?.has(caller)) return send(404, { code: 'not_found' });
      if (me)
        return send(200, {
          organizationId: orgId,
          role: { id: randomUUID(), key: 'member', name: 'Member', permissions: [] },
          joinedAt: orgMembers.get(caller),
        });
      const ids = url.searchParams.getAll('userId');
      return send(200, {
        data: ids
          .filter((id) => orgMembers.has(id))
          .map((userId) => ({ id: randomUUID(), userId, joinedAt: orgMembers.get(userId) })),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeOrganizationService(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    holder.fake = fake;
    return fake;
  }

  /** Default `joinedAt`: a minute ago, so clock skew cannot make later conversation rows look older. */
  addMember(orgId: string, userId: string, joinedAt = new Date(Date.now() - 60_000)): void {
    if (!this.members.has(orgId)) this.members.set(orgId, new Map());
    this.members.get(orgId)!.set(userId, joinedAt.toISOString());
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

/** One person addressing one organization's conversation routes. */
export class Member {
  constructor(
    private readonly svc: TestMessaging,
    readonly orgId: string,
    readonly userId: string,
  ) {}

  /** The same person on another organization's path (cross-tenant probes). */
  inOrg(orgId: string): Member {
    return new Member(this.svc, orgId, this.userId);
  }

  async call(method: HttpMethod | 'put', suffix: string, body?: object): Promise<Response> {
    const req = request(this.svc.server)[method](`/api/v1/orgs/${this.orgId}/conversations${suffix}`);
    req.set('Authorization', `Bearer ${await tokenFor(this.userId)}`);
    return body === undefined ? req : req.send(body);
  }

  get = (suffix = '') => this.call('get', suffix);
  post = (suffix: string, body?: object) => this.call('post', suffix, body);
  put = (suffix: string, body?: object) => this.call('put', suffix, body);
  patch = (suffix: string, body?: object) => this.call('patch', suffix, body);
  delete = (suffix: string) => this.call('delete', suffix);

  openDirect = (other: Member | string) =>
    this.post('/direct', { userId: typeof other === 'string' ? other : other.userId });
  say = (conversationId: string, body: string, clientMessageId?: string) =>
    this.post(`/${conversationId}/messages`, { body, ...(clientMessageId && { clientMessageId }) });

  /** Creates a group and returns its id; the caller is the admin. */
  async group(others: Member[], title?: string): Promise<string> {
    const res = await this.post('/groups', { ...(title && { title }), userIds: others.map((o) => o.userId) });
    if (res.status !== 201) throw new Error(`group create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }
}

export interface World {
  svc: TestMessaging;
  org: FakeOrganizationService;
  /** Realtime events as published after commit (the objects serialized to Redis). */
  events: ConversationChanged[];
  /** A fresh organization id. */
  newOrg(): string;
  /** A new active member of the organization. */
  member(orgId: string): Member;
  close(): Promise<void>;
}

export async function startWorld(organizationServiceUrl?: string, env: Record<string, string> = {}): Promise<World> {
  const org = await FakeOrganizationService.start();
  const svc = await startMessaging({ env: { ORGANIZATION_SERVICE_URL: organizationServiceUrl ?? org.url, ...env } });
  const events: ConversationChanged[] = [];
  vi.spyOn(svc.app.get(RealtimePublisher), 'publishConversationChanged').mockImplementation((event) => {
    events.push(event);
  });
  return {
    svc,
    org,
    events,
    newOrg: () => randomUUID(),
    member: (orgId) => {
      const member = new Member(svc, orgId, randomUUID());
      org.addMember(orgId, member.userId);
      return member;
    },
    close: async () => {
      await svc.close();
      await org.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
