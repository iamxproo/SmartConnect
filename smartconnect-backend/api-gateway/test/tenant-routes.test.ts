import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './support/fake-upstream.js';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';
import { signAccessToken } from './support/tokens.js';

const ORG = '019a4a00-0000-7000-8000-000000000001';

describe('routing to the organization and workspace services', () => {
  let organization: FakeUpstream;
  let workspace: FakeUpstream;
  let messaging: FakeUpstream;
  let gateway: TestGateway;
  let auth: { Authorization: string };
  beforeAll(async () => {
    organization = await startFakeUpstream();
    workspace = await startFakeUpstream();
    messaging = await startFakeUpstream();
    gateway = await startGateway({
      env: {
        ORGANIZATION_SERVICE_URL: organization.url,
        WORKSPACE_SERVICE_URL: workspace.url,
        MESSAGING_SERVICE_URL: messaging.url,
      },
    });
    auth = { Authorization: `Bearer ${await signAccessToken()}` };
  });
  afterAll(async () => {
    await gateway.app.close();
    await organization.close();
    await workspace.close();
    await messaging.close();
  });
  beforeEach(() => {
    organization.requests.length = 0;
    workspace.requests.length = 0;
    messaging.requests.length = 0;
    messaging.respondWith(jsonResponse(200, { ok: 'messaging' }));
    organization.respondWith(jsonResponse(200, { ok: 'organization' }));
    workspace.respondWith(jsonResponse(200, { ok: 'workspace' }));
  });

  it.each([
    ['GET', '/api/v1/orgs/{org}/workspaces', 'workspace'],
    ['POST', '/api/v1/orgs/{org}/workspaces', 'workspace'],
    ['GET', '/api/v1/orgs/{org}/workspaces/ws-1/channels', 'workspace'],
    ['GET', '/api/v1/orgs/{org}/channels?q=gen', 'workspace'],
    ['GET', '/api/v1/orgs/{org}/workspaces/ws-1/channels/ch-1/messages', 'messaging'],
    ['POST', '/api/v1/orgs/{org}/workspaces/ws-1/channels/ch-1/messages', 'messaging'],
    ['PATCH', '/api/v1/orgs/{org}/workspaces/ws-1/channels/ch-1/messages/m-1', 'messaging'],
    ['DELETE', '/api/v1/orgs/{org}/workspaces/ws-1/channels/ch-1/messages/m-1', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/conversations', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/saved-messages', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/attachments/f-1', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/activity', 'messaging'],
    ['POST', '/api/v1/orgs/{org}/activity/read', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/message-search?q=x', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/notification-preferences', 'messaging'],
    ['POST', '/api/v1/orgs/{org}/conversations/direct', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/conversations/c-1', 'messaging'],
    ['PUT', '/api/v1/orgs/{org}/conversations/c-1/participants/u-1', 'messaging'],
    ['POST', '/api/v1/orgs/{org}/conversations/c-1/messages', 'messaging'],
    ['DELETE', '/api/v1/orgs/{org}/conversations/c-1/messages/m-1', 'messaging'],
    ['GET', '/api/v1/orgs/{org}/workspaces/ws-1/channels/ch-1/members', 'workspace'],
    ['DELETE', '/api/v1/orgs/{org}/workspaces/ws-1/channels/ch-1/members/u-1', 'workspace'],
    ['GET', '/api/v1/orgs', 'organization'],
    ['POST', '/api/v1/orgs', 'organization'],
    ['GET', '/api/v1/orgs/{org}', 'organization'],
    ['PATCH', '/api/v1/orgs/{org}/members/m-1', 'organization'],
    ['GET', '/api/v1/orgs/{org}/teams/t-1/members', 'organization'],
    ['POST', '/api/v1/orgs/{org}/invitations', 'organization'],
    ['POST', '/api/v1/invitations/accept', 'organization'],
  ])('%s %s → %s service', async (method, template, service) => {
    const path = template.replace('{org}', ORG);
    const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const call = request(gateway.server)[verb](path).set(auth);
    const res = await (method === 'GET' || method === 'DELETE' ? call : call.send({}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: service });
    const upstream = { workspace, organization, messaging }[service as 'workspace' | 'organization' | 'messaging'];
    expect(upstream.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`${method} ${path}`]);
  });

  it('keeps every tenant route protected at the edge, except the invitation preview', async () => {
    for (const path of [`/api/v1/orgs`, `/api/v1/orgs/${ORG}/members`, `/api/v1/orgs/${ORG}/workspaces`]) {
      const res = await request(gateway.server).get(path).expect(401);
      expect(problemOf(res).code).toBe('unauthenticated');
    }
    await request(gateway.server).post('/api/v1/invitations/accept').send({ token: 'x' }).expect(401);
    expect(organization.requests).toHaveLength(0);
    expect(workspace.requests).toHaveLength(0);
    await request(gateway.server).get(`/api/v1/orgs/${ORG}/workspaces/w/channels/c/messages`).expect(401);
    await request(gateway.server).get(`/api/v1/orgs/${ORG}/conversations`).expect(401);
    await request(gateway.server).post(`/api/v1/orgs/${ORG}/conversations/c/messages`).send({}).expect(401);
    expect(messaging.requests).toHaveLength(0);

    await request(gateway.server).post('/api/v1/invitations/preview').send({ token: 'x' }).expect(200);
    expect(organization.requests.map((r) => r.url)).toEqual(['/api/v1/invitations/preview']);
  });

  it.each([
    ['message-search', ['/api/v1/orgs/{org}/message-search?q=x'], 60],
    [
      'activity and its unread count (one budget)',
      ['/api/v1/orgs/{org}/activity', '/api/v1/orgs/{org}/activity/unread-count'],
      120,
    ],
  ])('rate-limits %s per user, below the general tenant budget', async (_name, templates, limit) => {
    // A fresh gateway (and bucket store): earlier tests already spent part of this user's budget.
    const fresh = await startGateway({ env: { MESSAGING_SERVICE_URL: messaging.url } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < limit + 10; i++) {
        const path = templates[i % templates.length]!.replace('{org}', ORG);
        statuses.push((await request(fresh.server).get(path).set(auth)).status);
      }
      expect(statuses.slice(0, limit).every((status) => status === 200)).toBe(true);
      // The bucket refills slowly (limit per minute), so allow a request or two of slack before the refusals.
      expect(statuses.at(-1)).toBe(429);
      // Other messaging routes keep the general budget.
      expect((await request(fresh.server).get(`/api/v1/orgs/${ORG}/saved-messages`).set(auth)).status).toBe(200);
    } finally {
      await fresh.app.close();
    }
  });

  it('rate-limits organization creation per person, apart from the other organization routes', async () => {
    // A fresh gateway (and bucket store): earlier tests already created organizations as this user.
    const fresh = await startGateway({ env: { ORGANIZATION_SERVICE_URL: organization.url } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await request(fresh.server).post('/api/v1/orgs').set(auth).send({})).status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
      expect(organization.requests.filter((r) => r.method === 'POST' && r.url === '/api/v1/orgs')).toHaveLength(10);
      // Listing one's organizations keeps the general budget.
      expect((await request(fresh.server).get('/api/v1/orgs').set(auth)).status).toBe(200);
    } finally {
      await fresh.app.close();
    }
  });

  it('rate-limits invitation previews per client address', async () => {
    // A fresh gateway (and bucket store): earlier tests already spent part of this address's budget.
    const fresh = await startGateway({ env: { ORGANIZATION_SERVICE_URL: organization.url } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        statuses.push((await request(fresh.server).post('/api/v1/invitations/preview').send({ token: 'x' })).status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
    } finally {
      await fresh.app.close();
    }
  });
});
