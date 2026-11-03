// The whole backend through the API gateway: gateway → identity / organization / workspace, all REAL services on the
// disposable test database, each on its own ephemeral port. Covers onboarding (founder → invited, verified employees)
// and the authorization boundaries the product rules require.
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from '../../../smartconnect-backend/api-gateway/src/app.factory.js';
import { loadConfig as loadGatewayConfig } from '../../../smartconnect-backend/api-gateway/src/config/config.js';
import { MemoryRateLimitStore } from '../../../smartconnect-backend/api-gateway/src/rate-limit/stores.js';
import { createOrganizationApp } from '../../../smartconnect-backend/services/organization/src/app.factory.js';
import { loadConfig as loadOrgConfig } from '../../../smartconnect-backend/services/organization/src/config.js';
import { createPrismaClient as orgPrisma } from '../../../smartconnect-backend/services/organization/src/database/client.js';
import { InvitationDevMailbox } from '../../../smartconnect-backend/services/organization/src/notifications/invitation-notifier.js';
import { createWorkspaceApp } from '../../../smartconnect-backend/services/workspace/src/app.factory.js';
import { loadConfig as loadWorkspaceConfig } from '../../../smartconnect-backend/services/workspace/src/config.js';
import { createPrismaClient as workspacePrisma } from '../../../smartconnect-backend/services/workspace/src/database/client.js';
import { appUrl } from '../../support/database.js';
import {
  CapturingLogger,
  PASSWORD,
  startIdentity,
  uniqueEmail,
  urlOf,
  type TestIdentity,
} from '../identity/support/identity.js';

let ip = 0;
/** Each call comes from a distinct client address (the tests act as the edge proxy), so IP buckets don't interfere. */
const from = () => ({ 'X-Forwarded-For': `198.18.0.${++ip % 250}` });

describe('SmartConnect platform through the gateway', () => {
  let identity: TestIdentity;
  let organization: NestExpressApplication;
  let workspace: NestExpressApplication;
  let gateway: NestExpressApplication;
  let api: Server;
  let invitations: InvitationDevMailbox;
  const founderEmail = uniqueEmail('founder');

  const listen = async (app: NestExpressApplication) => {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    return `http://127.0.0.1:${address.port}`;
  };

  beforeAll(async () => {
    identity = await startIdentity({ listen: true });
    const jwks = identity.publicJwks;
    invitations = new InvitationDevMailbox();
    const orgConfig = loadOrgConfig({
      NODE_ENV: 'test',
      DATABASE_URL: appUrl('organization'),
      AUTH_JWT_PUBLIC_JWKS: jwks,
      IDENTITY_SERVICE_URL: urlOf(identity),
      ORGANIZATION_CREATOR_EMAILS: founderEmail,
    });
    organization = await createOrganizationApp({
      config: orgConfig,
      logger: new CapturingLogger(),
      prisma: orgPrisma({ connectionString: orgConfig.databaseUrl, maxConnections: 6 }),
      notifier: invitations,
    });
    const organizationUrl = await listen(organization);
    const wsConfig = loadWorkspaceConfig({
      NODE_ENV: 'test',
      DATABASE_URL: appUrl('workspace'),
      AUTH_JWT_PUBLIC_JWKS: jwks,
      ORGANIZATION_SERVICE_URL: organizationUrl,
    });
    workspace = await createWorkspaceApp({
      config: wsConfig,
      logger: new CapturingLogger(),
      prisma: workspacePrisma({ connectionString: wsConfig.databaseUrl, maxConnections: 6 }),
    });
    const workspaceUrl = await listen(workspace);
    gateway = await createGateway({
      config: loadGatewayConfig({
        NODE_ENV: 'test',
        AUTH_JWT_PUBLIC_JWKS: jwks,
        IDENTITY_SERVICE_URL: urlOf(identity),
        ORGANIZATION_SERVICE_URL: organizationUrl,
        WORKSPACE_SERVICE_URL: workspaceUrl,
        TRUST_PROXY_HOPS: '1',
      }),
      logger: new CapturingLogger(),
      rateLimitStore: new MemoryRateLimitStore(),
    });
    await gateway.init();
    api = gateway.getHttpServer();
  });
  afterAll(async () => {
    await gateway.close();
    await workspace.close();
    await organization.close();
    await identity.close();
  });

  interface Person {
    email: string;
    userId: string;
    auth: { Authorization: string };
  }

  /** Registration, email verification and login — all through the gateway, like the web app does it. */
  async function signUp(email = uniqueEmail('employee')): Promise<Person> {
    await request(api)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email, password: PASSWORD, displayName: email.split('@')[0] })
      .expect(202);
    const verification = identity.mailbox.list(email).find((m) => m.kind === 'email_verification');
    if (verification?.kind !== 'email_verification') throw new Error('no verification email');
    await request(api).post('/api/v1/auth/email/verify').set(from()).send({ token: verification.token }).expect(204);
    const login = await request(api)
      .post('/api/v1/auth/login')
      .set(from())
      .send({ email, password: PASSWORD, tokenDelivery: 'body' })
      .expect(200);
    const auth = { Authorization: `Bearer ${(login.body as { accessToken: string }).accessToken}` };
    const me = await request(api).get('/api/v1/auth/me').set(auth).expect(200);
    expect(me.body).toMatchObject({ email, emailVerified: true });
    return { email, userId: (me.body as { id: string }).id, auth };
  }

  async function join(admin: Person, orgId: string, person: Person, roleKey = 'member') {
    const roles = (await request(api).get(`/api/v1/orgs/${orgId}/roles`).set(admin.auth).expect(200)).body as {
      data: { id: string; key: string }[];
    };
    await request(api)
      .post(`/api/v1/orgs/${orgId}/invitations`)
      .set(admin.auth)
      .send({ email: person.email, roleId: roles.data.find((r) => r.key === roleKey)!.id })
      .expect(201);
    const token = invitations.list(person.email)[0]!.token;
    const preview = await request(api).post('/api/v1/invitations/preview').set(from()).send({ token }).expect(200);
    expect((preview.body as { emailHint: string }).emailHint).toBe(`${person.email[0]}***@example.com`);
    await request(api).post('/api/v1/invitations/accept').set(person.auth).send({ token }).expect(200);
  }

  let founder: Person;
  let alice: Person;
  let bob: Person;
  let orgId: string;
  let openWs: string;
  let privateWs: string;

  it('onboards a company: the authorized administrator creates it, employees join by email invitation', async () => {
    founder = await signUp(founderEmail);
    const intruder = await signUp();
    await request(api)
      .post('/api/v1/orgs')
      .set(intruder.auth)
      .send({ name: 'Personal', slug: `p-${Date.now()}` })
      .expect(403);

    const org = await request(api)
      .post('/api/v1/orgs')
      .set(founder.auth)
      .send({ name: 'Acme', slug: `acme-${Date.now()}` })
      .expect(201);
    orgId = (org.body as { id: string }).id;
    alice = await signUp();
    bob = await signUp();
    await join(founder, orgId, alice);
    await join(founder, orgId, bob);

    const mine = (await request(api).get('/api/v1/orgs').set(alice.auth).expect(200)).body as {
      data: { id: string }[];
    };
    expect(mine.data.map((o) => o.id)).toEqual([orgId]);
    expect(((await request(api).get('/api/v1/orgs').set(intruder.auth)).body as { data: unknown[] }).data).toEqual([]);
  });

  it('organization membership does not open private workspaces; open ones are joinable', async () => {
    openWs = (
      (
        await request(api)
          .post(`/api/v1/orgs/${orgId}/workspaces`)
          .set(founder.auth)
          .send({ name: 'All hands', slug: `all-${Date.now()}`, visibility: 'open' })
          .expect(201)
      ).body as { id: string }
    ).id;
    privateWs = (
      (
        await request(api)
          .post(`/api/v1/orgs/${orgId}/workspaces`)
          .set(founder.auth)
          .send({ name: 'Board', slug: `board-${Date.now()}`, visibility: 'private' })
          .expect(201)
      ).body as { id: string }
    ).id;
    await request(api)
      .post(`/api/v1/orgs/${orgId}/workspaces`)
      .set(alice.auth)
      .send({ name: 'Mine', slug: `mine-${Date.now()}`, visibility: 'open' })
      .expect(403);

    const visible = (await request(api).get(`/api/v1/orgs/${orgId}/workspaces`).set(alice.auth).expect(200)).body as {
      data: { id: string }[];
    };
    expect(visible.data.map((w) => w.id)).toEqual([openWs]);
    for (const path of ['', '/members', '/channels']) {
      await request(api).get(`/api/v1/orgs/${orgId}/workspaces/${privateWs}${path}`).set(alice.auth).expect(404);
    }
    await request(api).post(`/api/v1/orgs/${orgId}/workspaces/${privateWs}/join`).set(alice.auth).send().expect(404);
    await request(api).post(`/api/v1/orgs/${orgId}/workspaces/${openWs}/join`).set(alice.auth).send().expect(200);
    await request(api).post(`/api/v1/orgs/${orgId}/workspaces/${openWs}/join`).set(bob.auth).send().expect(200);
  });

  it("workspace membership does not open private channels: Bob cannot reach Alice's private channel by id", async () => {
    const channel = await request(api)
      .post(`/api/v1/orgs/${orgId}/workspaces/${openWs}/channels`)
      .set(alice.auth)
      .send({ name: 'secret-project', type: 'private' })
      .expect(201);
    const channelId = (channel.body as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}/workspaces/${openWs}/channels`;

    const bobsList = (await request(api).get(base).set(bob.auth).expect(200)).body as { data: { id: string }[] };
    expect(bobsList.data.map((c) => c.id)).not.toContain(channelId);
    await request(api).get(`${base}/${channelId}`).set(bob.auth).expect(404);
    await request(api).get(`${base}/${channelId}/members`).set(bob.auth).expect(404);
    await request(api).post(`${base}/${channelId}/join`).set(bob.auth).send().expect(404);
    // Not even the organization owner / workspace admin sees it without being a channel member.
    await request(api).get(`${base}/${channelId}`).set(founder.auth).expect(404);
    await request(api).get(`${base}/${channelId}`).set(alice.auth).expect(200);
  });

  it('keeps companies apart: ids of one organization are invisible from another', async () => {
    const other = (
      (
        await request(api)
          .post('/api/v1/orgs')
          .set(founder.auth)
          .send({ name: 'Other', slug: `other-${Date.now()}` })
          .expect(201)
      ).body as { id: string }
    ).id;
    const carol = await signUp();
    await join(founder, other, carol, 'admin');
    await request(api).get(`/api/v1/orgs/${orgId}`).set(carol.auth).expect(404);
    await request(api).get(`/api/v1/orgs/${orgId}/workspaces`).set(carol.auth).expect(404);
    // Org A's workspace id under Carol's own organization's path.
    await request(api).get(`/api/v1/orgs/${other}/workspaces/${openWs}`).set(carol.auth).expect(404);
    await request(api).get(`/api/v1/orgs/${other}/workspaces/${openWs}/channels`).set(carol.auth).expect(404);
  });

  it('private teams stay private through the gateway', async () => {
    const team = await request(api)
      .post(`/api/v1/orgs/${orgId}/teams`)
      .set(founder.auth)
      .send({ name: `team-a-${Date.now()}`, visibility: 'private' })
      .expect(201);
    const teamId = (team.body as { id: string }).id;
    await request(api)
      .put(`/api/v1/orgs/${orgId}/teams/${teamId}/members/${alice.userId}`)
      .set(founder.auth)
      .send({ role: 'member' })
      .expect(200);
    await request(api).get(`/api/v1/orgs/${orgId}/teams/${teamId}`).set(alice.auth).expect(200);
    await request(api).get(`/api/v1/orgs/${orgId}/teams/${teamId}/members`).set(bob.auth).expect(404);
    const bobsTeams = (await request(api).get(`/api/v1/orgs/${orgId}/teams`).set(bob.auth).expect(200)).body as {
      data: { id: string }[];
    };
    expect(bobsTeams.data.map((t) => t.id)).not.toContain(teamId);
  });

  it('removing someone from the organization ends their workspace access immediately', async () => {
    const members = (
      await request(api).get(`/api/v1/orgs/${orgId}/members?userId=${bob.userId}`).set(founder.auth).expect(200)
    ).body as {
      data: { id: string }[];
    };
    await request(api).delete(`/api/v1/orgs/${orgId}/members/${members.data[0]!.id}`).set(founder.auth).expect(204);
    await request(api).get(`/api/v1/orgs/${orgId}/workspaces/${openWs}`).set(bob.auth).expect(404);
    await request(api).get(`/api/v1/orgs/${orgId}/workspaces/${openWs}/channels`).set(bob.auth).expect(404);
    await request(api).get(`/api/v1/orgs/${orgId}`).set(bob.auth).expect(404);
  });
});
