// Platform administration in the organization service (ADR 0015), with the REAL identity service deciding who is a
// Super Admin. The Super Admin sees every organization through a narrow definer function, yet gains no access to any
// organization's own routes; organization owners and admins get no platform access. Organization creation keeps its
// allowlist rule (ADR 0010).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../../smartconnect-backend/services/identity/src/database/client.js';
import { seedSuperAdmin } from '../../../smartconnect-backend/scripts/super-admin.js';
import { adminUrl, appUrl, query } from '../../support/database.js';
import { login, problemOf, uniqueEmail } from '../identity/support/identity.js';
import { createOrg, createUser, startPlatform, type Org, type Platform, type User } from './support/platform.js';

const ISSUED = 'issued-initial-pw';
const OWN = 'my own long admin passphrase';

describe('platform administration: organizations', () => {
  let platform: Platform;
  let founder: User;
  let org: Org;
  let secondOrg: Org;
  let adminToken: string;
  const adminEmail = uniqueEmail('super-admin');
  const list = (token: string, query: Record<string, string> = {}) =>
    request(platform.server).get('/api/v1/admin/organizations').query(query).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    platform = await startPlatform();
    founder = await createUser(platform, platform.founderEmail);
    org = await createOrg(platform, founder);
    secondOrg = await createOrg(platform, founder);

    const prisma = createPrismaClient({ connectionString: appUrl('identity'), maxConnections: 1 });
    try {
      await seedSuperAdmin(prisma, ISSUED, { email: adminEmail });
    } finally {
      await prisma.$disconnect();
    }
    adminToken = (await login(platform.identity.server, adminEmail, ISSUED)).accessToken;
  });
  afterAll(async () => {
    await platform.close();
  });

  it('is refused while the Super Admin still holds the issued password', async () => {
    expect(problemOf(await list(adminToken).expect(403)).code).toBe('password_change_required');
  });

  it("lists every organization, newest first, with member counts, once the password is the holder's own", async () => {
    await request(platform.identity.server)
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ currentPassword: ISSUED, newPassword: OWN })
      .expect(204);

    const res = await list(adminToken).expect(200);
    const body = res.body as {
      data: { id: string; slug: string; name: string; status: string; memberCount: number; createdAt: string }[];
      total: number;
      nextCursor: string | null;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const ids = body.data.map((o) => o.id);
    expect(ids.indexOf(secondOrg.id)).toBeLessThan(ids.indexOf(org.id));
    expect(body.data.find((o) => o.id === org.id)).toMatchObject({ status: 'active', memberCount: 1 });
    // Directory fields only: no settings, descriptions, members' identities or invitations.
    expect(Object.keys(body.data[0]!).sort()).toEqual(['createdAt', 'id', 'memberCount', 'name', 'slug', 'status']);
  });

  it('pages with an opaque cursor and rejects a forged one', async () => {
    const first = (await list(adminToken, { limit: '1' }).expect(200)).body as {
      data: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await list(adminToken, { limit: '1', cursor: first.nextCursor! }).expect(200)).body as {
      data: { id: string }[];
    };
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
    expect(problemOf(await list(adminToken, { cursor: 'not-a-cursor' }).expect(422)).code).toBe('validation_failed');
  });

  it('gives an organization owner (organization admin) no platform access', async () => {
    expect(problemOf(await list(founder.accessToken).expect(403)).code).toBe('platform_admin_required');
    const member = await createUser(platform);
    expect(problemOf(await list(member.accessToken).expect(403)).code).toBe('platform_admin_required');
    await request(platform.server).get('/api/v1/admin/organizations').expect(401);
  });

  it("gives the Super Admin no access to an organization's own routes, and no organization-creation right", async () => {
    const asAdmin = { Authorization: `Bearer ${adminToken}` };
    await request(platform.server).get(`/api/v1/orgs/${org.id}`).set(asAdmin).expect(404);
    await request(platform.server).get(`/api/v1/orgs/${org.id}/members`).set(asAdmin).expect(404);
    expect((await request(platform.server).get('/api/v1/orgs').set(asAdmin).expect(200)).body).toMatchObject({
      data: [],
    });
    const create = await request(platform.server)
      .post('/api/v1/orgs')
      .set(asAdmin)
      .send({ name: 'Admin Org', slug: `admin-${Date.now().toString(36)}` })
      .expect(403);
    expect(problemOf(create).code).toBe('organization_creation_not_allowed');
  });

  it('the cross-tenant functions are narrow SECURITY DEFINER functions only the organization service may run', async () => {
    const rows = await query<{ name: string; definer: boolean; config: string[] | null; public_exec: boolean }>(
      adminUrl(),
      `select p.proname as name, p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'organization' and p.proname like 'platform_organization_%' order by 1`,
    );
    expect(rows).toEqual([
      {
        name: 'platform_organization_count',
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
        public_exec: false,
      },
      {
        name: 'platform_organization_ids',
        definer: true,
        config: ['search_path=pg_catalog, pg_temp'],
        public_exec: false,
      },
    ]);
    // Another service's runtime role cannot call them.
    const denied = await query(appUrl('workspace'), 'select organization.platform_organization_count()').catch(
      (error: { code?: string }) => error.code,
    );
    expect(denied).toBe('42501');
  });
});
