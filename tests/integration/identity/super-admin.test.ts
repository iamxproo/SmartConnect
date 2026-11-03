// The development Super Admin (ADR 0015) through the REAL identity service on the test database: seeded by the same
// function `make admin-seed` runs, signed in through the ordinary login endpoint, and refused every administration
// route until the issued password is replaced. Test passwords only; the seed's real input comes from a hidden prompt.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../../smartconnect-backend/services/identity/src/database/client.js';
import { seedSuperAdmin } from '../../../smartconnect-backend/scripts/super-admin.js';
import { appUrl } from '../../support/database.js';
import {
  auth,
  db,
  login,
  PASSWORD,
  problemOf,
  register,
  startIdentity,
  uniqueEmail,
  type TestIdentity,
} from './support/identity.js';

const ISSUED = 'issued-initial-pw';
const OWN = 'my own long admin passphrase';

describe('development Super Admin', () => {
  let identity: TestIdentity;
  let prisma: ReturnType<typeof createPrismaClient>;
  const email = uniqueEmail('super-admin');
  const summary = (token: string) => request(identity.server).get('/api/v1/admin/accounts/summary').set(auth(token));
  const me = (token: string) => request(identity.server).get('/api/v1/auth/me').set(auth(token));

  beforeAll(async () => {
    identity = await startIdentity();
    prisma = createPrismaClient({ connectionString: appUrl('identity'), maxConnections: 2 });
    await seedSuperAdmin(prisma, ISSUED, { email });
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await identity.close();
  });

  it('stores the issued password only as an Argon2id hash, marked "change required"', async () => {
    const [row] = await db<{ secret: string; change_required: boolean; verified: boolean }>(
      `select c.secret, c.change_required, u.email_verified_at is not null as verified
         from identity.credentials c join identity.users u on u.id = c.user_id
        where u.email_normalized = $1 and c.type = 'password'`,
      [email],
    );
    expect(row!.secret.startsWith('$argon2id$')).toBe(true);
    expect(row!.secret).not.toContain(ISSUED);
    expect(row!.change_required).toBe(true);
    expect(row!.verified).toBe(true);
  });

  it('signs in through the ordinary login endpoint, and says the password must be changed', async () => {
    const { accessToken } = await login(identity.server, email, ISSUED);
    const res = await me(accessToken).expect(200);
    expect(res.body).toMatchObject({ email, platformRoles: ['super_admin'], passwordChangeRequired: true });
  });

  it('answers a wrong password exactly like an unknown account', async () => {
    for (const body of [
      { email, password: 'not-the-password' },
      { email: uniqueEmail('nobody'), password: ISSUED },
    ]) {
      const res = await request(identity.server).post('/api/v1/auth/login').send(body).expect(401);
      expect(problemOf(res).code).toBe('invalid_credentials');
    }
  });

  it('refuses all administration until the issued password is replaced by one meeting the normal policy', async () => {
    const { accessToken } = await login(identity.server, email, ISSUED);
    expect(problemOf(await summary(accessToken).expect(403)).code).toBe('password_change_required');

    const change = (currentPassword: string, newPassword: string) =>
      request(identity.server)
        .post('/api/v1/auth/password/change')
        .set(auth(accessToken))
        .send({ currentPassword, newPassword });
    // The usual 12-character minimum still applies, and the issued password cannot simply be re-entered.
    expect(problemOf(await change(ISSUED, 'short-pw').expect(422)).code).toBe('validation_failed');
    const same = await change(ISSUED, ISSUED).expect(422);
    expect(problemOf(same).errors).toEqual([
      expect.objectContaining({ field: 'newPassword', code: 'same_as_current' }),
    ]);
    await change(ISSUED, OWN).expect(204);

    expect((await me(accessToken).expect(200)).body).toMatchObject({ passwordChangeRequired: false });
    const res = await summary(accessToken).expect(200);
    expect(res.body).toEqual({
      total: expect.any(Number) as number,
      verified: expect.any(Number) as number,
      active: expect.any(Number) as number,
      suspended: expect.any(Number) as number,
      deactivated: expect.any(Number) as number,
      superAdmins: expect.any(Number) as number,
    });
    const totals = res.body as Record<string, number>;
    expect(totals.superAdmins).toBeGreaterThanOrEqual(1);
    expect(totals.verified).toBeLessThanOrEqual(totals.total!);
    expect(totals.active! + totals.suspended! + totals.deactivated!).toBe(totals.total);

    // The issued password is gone; the new one works.
    await request(identity.server).post('/api/v1/auth/login').send({ email, password: ISSUED }).expect(401);
    await login(identity.server, email, OWN);
  });

  it('keeps platform administration to Super Admins: other accounts get 403, anonymous callers 401', async () => {
    const { email: other } = await register(identity.server);
    await db('update identity.users set email_verified_at = now() where email_normalized = $1', [other]);
    const { accessToken } = await login(identity.server, other, PASSWORD);
    expect((await me(accessToken).expect(200)).body).toMatchObject({
      platformRoles: [],
      passwordChangeRequired: false,
    });
    expect(problemOf(await summary(accessToken).expect(403)).code).toBe('platform_admin_required');
    await request(identity.server).get('/api/v1/admin/accounts/summary').expect(401);
  });

  it('takes effect at once when the role is withdrawn or the account suspended (no role in the token)', async () => {
    const { accessToken } = await login(identity.server, email, OWN);
    await summary(accessToken).expect(200);
    const [{ id }] = (await db<{ id: string }>('select id from identity.users where email_normalized = $1', [
      email,
    ])) as [{ id: string }];

    await db('delete from identity.platform_role_assignments where user_id = $1', [id]);
    expect(problemOf(await summary(accessToken).expect(403)).code).toBe('platform_admin_required');
    await db("insert into identity.platform_role_assignments (user_id, role) values ($1, 'super_admin')", [id]);
    await summary(accessToken).expect(200);

    await db("update identity.users set status = 'suspended' where id = $1", [id]);
    try {
      await request(identity.server).get('/api/v1/admin/accounts/summary').set(auth(accessToken)).expect(403);
    } finally {
      await db("update identity.users set status = 'active' where id = $1", [id]);
    }
  });

  it('re-seeding resets the password, requires a change again and ends every session of the account', async () => {
    const { accessToken } = await login(identity.server, email, OWN);
    const again = await seedSuperAdmin(prisma, ISSUED, { email });
    expect(again.created).toBe(false);

    expect(problemOf(await me(accessToken).expect(401)).code).toBe('session_revoked');
    await request(identity.server).post('/api/v1/auth/login').send({ email, password: OWN }).expect(401);
    const fresh = await login(identity.server, email, ISSUED);
    expect((await me(fresh.accessToken).expect(200)).body).toMatchObject({ passwordChangeRequired: true });
    expect(problemOf(await summary(fresh.accessToken).expect(403)).code).toBe('password_change_required');
  });

  it('a password reset by email also replaces the issued password', async () => {
    const reset = uniqueEmail('super-admin-reset');
    await seedSuperAdmin(prisma, ISSUED, { email: reset });
    await request(identity.server).post('/api/v1/auth/password/forgot').send({ email: reset }).expect(202);
    const message = identity.mailbox.list(reset).find((m) => m.kind === 'password_reset');
    if (message?.kind !== 'password_reset') throw new Error('no reset email');
    await request(identity.server)
      .post('/api/v1/auth/password/reset')
      .send({ token: message.token, newPassword: OWN })
      .expect(204);
    const { accessToken } = await login(identity.server, reset, OWN);
    expect((await me(accessToken).expect(200)).body).toMatchObject({ passwordChangeRequired: false });
    await summary(accessToken).expect(200);
  });
});
