import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './support/fake-upstream.js';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';
import { signAccessToken } from './support/tokens.js';

describe('platform administration routes (ADR 0015)', () => {
  let identity: FakeUpstream;
  let organization: FakeUpstream;
  let gateway: TestGateway;
  let auth: { Authorization: string };
  beforeAll(async () => {
    identity = await startFakeUpstream();
    organization = await startFakeUpstream();
    gateway = await startGateway({
      env: { IDENTITY_SERVICE_URL: identity.url, ORGANIZATION_SERVICE_URL: organization.url },
    });
    auth = { Authorization: `Bearer ${await signAccessToken()}` };
  });
  afterAll(async () => {
    await gateway.app.close();
    await identity.close();
    await organization.close();
  });
  beforeEach(() => {
    identity.requests.length = 0;
    organization.requests.length = 0;
    identity.respondWith(jsonResponse(200, { ok: 'identity' }));
    organization.respondWith(jsonResponse(200, { ok: 'organization' }));
  });

  it.each([
    ['/api/v1/admin/accounts/summary', 'identity'],
    ['/api/v1/admin/organizations?limit=10', 'organization'],
  ])('GET %s → %s service, which decides who is a Super Admin', async (path, service) => {
    const res = await request(gateway.server).get(path).set(auth).expect(200);
    expect(res.body).toEqual({ ok: service });
    const upstream = service === 'identity' ? identity : organization;
    expect(upstream.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${path}`]);
    expect(upstream.requests[0]!.headers.authorization).toBe(auth.Authorization);
  });

  it('refuses anonymous callers at the edge', async () => {
    for (const path of ['/api/v1/admin/accounts/summary', '/api/v1/admin/organizations']) {
      const res = await request(gateway.server).get(path).expect(401);
      expect(problemOf(res).code).toBe('unauthenticated');
    }
    expect(identity.requests).toHaveLength(0);
    expect(organization.requests).toHaveLength(0);
  });

  it('forwards nothing else under /admin: no writes, no other paths', async () => {
    await request(gateway.server).post('/api/v1/admin/organizations').set(auth).send({}).expect(404);
    await request(gateway.server).delete('/api/v1/admin/accounts/summary').set(auth).expect(404);
    await request(gateway.server).get('/api/v1/admin/accounts').set(auth).expect(404);
    await request(gateway.server).get('/api/v1/admin/sessions').set(auth).expect(404);
    expect(identity.requests).toHaveLength(0);
    expect(organization.requests).toHaveLength(0);
  });
});
