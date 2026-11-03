// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// Authentication, organization membership and tenant isolation: every route must refuse callers who are not active
// members of the organization in the path, whatever the workspace or channel they name.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, query } from '../../support/database.js';
import {
  Actor,
  newId,
  newOrganization,
  problemOf,
  startWorkspace,
  tokenFor,
  type TestWorkspace,
} from './support/workspace.js';

let ws: TestWorkspace;
beforeAll(async () => {
  ws = await startWorkspace();
});
afterAll(async () => {
  await ws.close();
});

async function scenario() {
  const org = newOrganization(ws);
  const owner = org.people.owner!;
  const workspace = await owner.createWorkspace({ visibility: 'open' });
  const channel = (await owner.get(`/workspaces/${workspace.id}/channels`)).body.data[0] as { id: string };
  const secret = await owner.createChannel(workspace.id, { type: 'private' });
  return { ...org, owner, workspace, channel, secret };
}

/** Every route of the contract, with real ids. */
const routes = (w: string, c: string, u: string): [string, string, object?][] => [
  ['get', '/workspaces'],
  ['post', '/workspaces', { name: 'N', slug: 'n-slug', visibility: 'open' }],
  ['get', `/workspaces/${w}`],
  ['patch', `/workspaces/${w}`, { name: 'N' }],
  ['post', `/workspaces/${w}/join`],
  ['post', `/workspaces/${w}/leave`],
  ['get', `/workspaces/${w}/members`],
  ['put', `/workspaces/${w}/members/${u}`, { role: 'member' }],
  ['delete', `/workspaces/${w}/members/${u}`],
  ['get', `/workspaces/${w}/channels`],
  ['post', `/workspaces/${w}/channels`, { name: 'n', type: 'public' }],
  ['get', `/workspaces/${w}/channels/${c}`],
  ['post', `/workspaces/${w}/channels/${c}/join`],
  ['post', `/workspaces/${w}/channels/${c}/leave`],
  ['get', `/workspaces/${w}/channels/${c}/members`],
  ['put', `/workspaces/${w}/channels/${c}/members/${u}`, {}],
  ['delete', `/workspaces/${w}/channels/${c}/members/${u}`],
];

describe('authentication', () => {
  it('rejects missing, malformed and forged tokens on every route', async () => {
    const { workspace, channel, owner } = await scenario();
    for (const [method, path, body] of routes(workspace.id, channel.id, owner.userId)) {
      const url = `/api/v1/orgs/${owner.orgId}${path}`;
      const bare = await (request(ws.server) as unknown as Record<string, (u: string) => request.Test>)[method]!(url);
      expect(bare.status, `${method} ${path}`).toBe(401);
      const forged = await (request(ws.server) as unknown as Record<string, (u: string) => request.Test>)[method]!(url)
        .set('Authorization', 'Bearer aaa.bbb.ccc')
        .send(body);
      expect(forged.status, `${method} ${path}`).toBe(401);
    }
    expect(ws.org.requests.some((r) => r.authorization === 'Bearer aaa.bbb.ccc')).toBe(false);
  });

  it('keeps health probes public and unknown paths 404', async () => {
    expect((await request(ws.server).get('/health/live')).status).toBe(200);
    expect((await request(ws.server).get('/health/ready')).status).toBe(200);
    expect((await request(ws.server).get('/api/v1/nothing-here')).status).toBe(404);
  });
});

describe('organization membership', () => {
  it('answers 404 on every route to someone who is not a member of the organization', async () => {
    const { workspace, channel, orgId, owner } = await scenario();
    const intruder = new Actor(ws, orgId, newId()); // valid token, not in the organization
    for (const [method, path, body] of routes(workspace.id, channel.id, owner.userId)) {
      const res = await intruder.call(method as 'get', path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(problemOf(res).code).toBe('not_found');
    }
    // nothing was created or changed
    expect((await owner.get('/workspaces')).body.data).toHaveLength(1);
    expect((await owner.get(`/workspaces/${workspace.id}/members`)).body.data).toHaveLength(1);
  });

  it('forwards the caller own token to the organization service and never trusts the body for the tenant', async () => {
    const { owner, orgId } = await scenario();
    const other = newOrganization(ws).people.owner!;
    ws.org.requests.length = 0;
    await owner.get('/workspaces');
    expect(ws.org.requests).toEqual([
      { url: `/api/v1/orgs/${orgId}/me`, authorization: `Bearer ${await tokenFor(owner.userId)}` },
    ]);
    const res = await owner.post('/workspaces', {
      name: 'N',
      slug: 'tenant-in-body',
      visibility: 'open',
      organizationId: other.orgId,
    });
    expect(res.status).toBe(422);
  });

  it('loses access immediately when the organization service stops confirming membership', async () => {
    const { owner, workspace, channel, orgId, add } = await scenario();
    const member = add('member');
    await member.post(`/workspaces/${workspace.id}/join`);
    expect((await member.get(`/workspaces/${workspace.id}`)).status).toBe(200);

    ws.org.revoke(orgId, member.userId);
    for (const [method, path, body] of routes(workspace.id, channel.id, owner.userId)) {
      expect((await member.call(method as 'get', path, body)).status, `${method} ${path}`).toBe(404);
    }
    // Re-invited later (a NEW organization membership): the old workspace membership does not come back.
    ws.org.addMember(orgId, member.userId, [], new Date(Date.now() + 5_000));
    expect((await member.get(`/workspaces/${workspace.id}`)).body.myRole).toBeNull();
  });

  it('a re-invited person does not regain private workspaces or private channels from a previous membership', async () => {
    const { owner, workspace, orgId, add } = await scenario();
    const member = add('member');
    await member.post(`/workspaces/${workspace.id}/join`);
    const privateWs = (
      await owner.post('/workspaces', { name: 'P', slug: `p-${newId().slice(0, 8)}`, visibility: 'private' })
    ).body as { id: string };
    await owner.put(`/workspaces/${privateWs.id}/members/${member.userId}`, { role: 'member' });
    expect((await member.get(`/workspaces/${privateWs.id}`)).status).toBe(200);

    ws.org.revoke(orgId, member.userId);
    ws.org.addMember(orgId, member.userId, [], new Date(Date.now() + 5_000));
    expect((await member.get(`/workspaces/${privateWs.id}`)).status).toBe(404);
    const list = (await member.get('/workspaces')).body as { data: { id: string }[] };
    expect(list.data.map((w) => w.id)).not.toContain(privateWs.id);
  });

  it('answers 503, never allows, when the organization service is unreachable', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const down = await startWorkspace({ organizationServiceUrl: deadUrl });
    try {
      const actor = new Actor(down, newId(), newId());
      down.org.addMember(actor.orgId, actor.userId, ['*']);
      for (const [method, path, body] of [
        ['get', '/workspaces'],
        ['post', '/workspaces', { name: 'N', slug: 'n-slug', visibility: 'open' }],
      ] as [string, string, object?][]) {
        const res = await actor.call(method as 'get', path, body);
        expect(res.status).toBe(503);
        expect(problemOf(res).code).toBe('dependency_unavailable');
      }
    } finally {
      await down.close();
    }
  });

  it('answers 503 when the organization service returns something unusable', async () => {
    const odd = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ organizationId: 'someone-else', role: { permissions: ['*'] } }));
    });
    await new Promise<void>((resolve) => odd.listen(0, '127.0.0.1', resolve));
    const confused = await startWorkspace({
      organizationServiceUrl: `http://127.0.0.1:${(odd.address() as AddressInfo).port}`,
    });
    try {
      const res = await new Actor(confused, newId(), newId()).get('/workspaces');
      expect(res.status).toBe(503);
    } finally {
      await confused.close();
      odd.closeAllConnections();
      await new Promise<void>((resolve) => odd.close(() => resolve()));
    }
  });
});

describe('tenant isolation', () => {
  it('treats a workspace or channel of organization A requested under organization B as nonexistent', async () => {
    const a = await scenario();
    // a person who belongs to BOTH organizations, and to the workspace in A
    const both = a.add('both');
    await both.post(`/workspaces/${a.workspace.id}/join`);
    const orgB = newOrganization(ws);
    orgB.add('x'); // unrelated
    ws.org.addMember(orgB.orgId, both.userId, ['workspaces.create']);
    const inB = both.inOrg(orgB.orgId);

    expect((await both.get(`/workspaces/${a.workspace.id}`)).status).toBe(200);
    for (const [method, path, body] of routes(a.workspace.id, a.channel.id, a.owner.userId)) {
      if (path === '/workspaces' || (method === 'post' && path === '/workspaces')) continue;
      const res = await inB.call(method as 'get', path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await inB.get('/workspaces')).body.data).toEqual([]);
    expect((await inB.get(`/workspaces/${a.workspace.id}/channels/${a.secret.id}`)).status).toBe(404);
  });

  it('lets the database refuse tenant rows without a tenant context (row-level security)', async () => {
    await scenario();
    const rows = await query<{ n: string }>(
      appUrl('workspace'),
      'select count(*)::text as n from workspace.workspaces',
    );
    expect(rows[0]!.n).toBe('0');
  });
});

describe('logging', () => {
  it('never logs access tokens', async () => {
    const { owner } = await scenario();
    await owner.get('/workspaces');
    expect(ws.logger.lines.join('\n')).not.toContain(await tokenFor(owner.userId));
  });
});
