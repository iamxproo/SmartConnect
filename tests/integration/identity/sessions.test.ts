import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, query, sqlError } from '../../support/database.js';
import { auth, db, login, problemOf, registerAndLogin, startIdentity, type TestIdentity } from './support/identity.js';

const SESSIONS = '/api/v1/auth/sessions';

interface SessionBody {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
}
interface SessionList {
  data: SessionBody[];
  nextCursor: string | null;
}

describe('session management', () => {
  let identity: TestIdentity;
  beforeAll(async () => {
    identity = await startIdentity();
  });
  afterAll(() => identity.close());

  it("lists the caller's active sessions, newest first, with metadata and never any token material", async () => {
    const phone = await registerAndLogin(identity.server);
    const laptop = await login(identity.server, phone.email, undefined, 'Laptop browser');

    const res = await request(identity.server).get(SESSIONS).set(auth(laptop.accessToken)).expect(200);
    const list = res.body as SessionList;
    expect(list.data.map((session) => session.id)).toEqual([laptop.sessionId, phone.sessionId]);
    expect(list.data.map((session) => session.current)).toEqual([true, false]);
    expect(list.data[0]).toMatchObject({ userAgent: 'Laptop browser' });
    expect(Object.keys(list.data[0]!).sort()).toEqual([
      'createdAt',
      'current',
      'expiresAt',
      'id',
      'ipAddress',
      'lastUsedAt',
      'userAgent',
    ]);
    expect(list.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(laptop.refreshToken);
  });

  it('paginates with an opaque cursor', async () => {
    const first = await registerAndLogin(identity.server);
    await login(identity.server, first.email);
    await login(identity.server, first.email);
    const page1 = (await request(identity.server).get(`${SESSIONS}?limit=2`).set(auth(first.accessToken)).expect(200))
      .body as SessionList;
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (
      await request(identity.server)
        .get(`${SESSIONS}?limit=2&cursor=${page1.nextCursor}`)
        .set(auth(first.accessToken))
        .expect(200)
    ).body as SessionList;
    expect(page2.data.map((session) => session.id)).toEqual([first.sessionId]);
    expect(page2.nextCursor).toBeNull();
  });

  it.each([
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['limit=abc', 'limit'],
    ['cursor=not*valid', 'cursor'],
    [`cursor=${Buffer.from('not-a-uuid').toString('base64url')}`, 'cursor'],
  ])('rejects ?%s with 422', async (queryString, field) => {
    const tokens = await registerAndLogin(identity.server);
    const res = await request(identity.server)
      .get(`${SESSIONS}?${queryString}`)
      .set(auth(tokens.accessToken))
      .expect(422);
    expect(problemOf(res).errors?.map((error) => error.field)).toContain(field);
  });

  it("revokes one of the caller's other sessions", async () => {
    const current = await registerAndLogin(identity.server);
    const other = await login(identity.server, current.email);
    await request(identity.server).delete(`${SESSIONS}/${other.sessionId}`).set(auth(current.accessToken)).expect(204);
    await request(identity.server).post('/api/v1/auth/refresh').send({ refreshToken: other.refreshToken }).expect(401);
    const list = (await request(identity.server).get(SESSIONS).set(auth(current.accessToken)).expect(200))
      .body as SessionList;
    expect(list.data.map((session) => session.id)).toEqual([current.sessionId]);
    const [row] = await db<{ revoked_reason: string }>('select revoked_reason from identity.sessions where id = $1', [
      other.sessionId,
    ]);
    expect(row!.revoked_reason).toBe('revoked_by_user');
  });

  it("answers 404 for another user's session and leaves it untouched (cross-user authorization)", async () => {
    const attacker = await registerAndLogin(identity.server);
    const victim = await registerAndLogin(identity.server);
    const res = await request(identity.server)
      .delete(`${SESSIONS}/${victim.sessionId}`)
      .set(auth(attacker.accessToken))
      .expect(404);
    expect(problemOf(res).code).toBe('not_found');
    const [row] = await db<{ revoked_at: Date | null }>('select revoked_at from identity.sessions where id = $1', [
      victim.sessionId,
    ]);
    expect(row!.revoked_at).toBeNull();
    await request(identity.server).post('/api/v1/auth/refresh').send({ refreshToken: victim.refreshToken }).expect(200);
  });

  it('answers 404 for unknown and malformed session ids', async () => {
    const tokens = await registerAndLogin(identity.server);
    await request(identity.server)
      .delete(`${SESSIONS}/019a4a00-0000-7000-8000-00000000dead`)
      .set(auth(tokens.accessToken))
      .expect(404);
    await request(identity.server).delete(`${SESSIONS}/not-a-uuid`).set(auth(tokens.accessToken)).expect(404);
  });

  it("only ever lists the caller's own sessions, whatever ids the request carries", async () => {
    const alice = await registerAndLogin(identity.server);
    const bob = await registerAndLogin(identity.server);
    const res = await request(identity.server)
      .get(`${SESSIONS}?userId=${bob.userId}`)
      .set(auth(alice.accessToken))
      .set('X-User-Id', bob.userId);
    // Unknown query parameters are rejected outright; the header is simply ignored.
    expect(res.status).toBe(422);
    const own = (await request(identity.server).get(SESSIONS).set(auth(alice.accessToken)).set('X-User-Id', bob.userId))
      .body as SessionList;
    expect(own.data.map((session) => session.id)).toEqual([alice.sessionId]);
  });

  it('revoke-others keeps the current session and ends the rest', async () => {
    const current = await registerAndLogin(identity.server);
    const others = await Promise.all([login(identity.server, current.email), login(identity.server, current.email)]);
    await request(identity.server).post(`${SESSIONS}/revoke-others`).set(auth(current.accessToken)).send().expect(204);
    for (const other of others) {
      await request(identity.server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: other.refreshToken })
        .expect(401);
    }
    await request(identity.server).get(SESSIONS).set(auth(current.accessToken)).expect(200);
    await request(identity.server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: current.refreshToken })
      .expect(200);
  });

  it('revoking the current session clears the cookie and ends the access token on identity routes', async () => {
    const tokens = await registerAndLogin(identity.server);
    const res = await request(identity.server)
      .delete(`${SESSIONS}/${tokens.sessionId}`)
      .set(auth(tokens.accessToken))
      .expect(204);
    expect(res.headers['set-cookie']).toEqual([
      '__Secure-sc_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict',
    ]);
    const after = await request(identity.server).get(SESSIONS).set(auth(tokens.accessToken)).expect(401);
    expect(problemOf(after).code).toBe('session_revoked');
  });

  it('requires an access token', async () => {
    await request(identity.server).get(SESSIONS).expect(401);
    await request(identity.server).get(SESSIONS).set('Authorization', 'Bearer x.y.z').expect(401);
  });
});

describe('identity data isolation', () => {
  it('identity tables are global by design: no RLS, per-user scoping in the service (tested above)', async () => {
    const rows = await query<{ relname: string; relrowsecurity: boolean }>(
      appUrl('identity'),
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'identity' and c.relkind = 'r' and c.relname in ('users', 'credentials', 'sessions', 'verification_tokens')
        order by c.relname`,
    );
    expect(rows).toEqual([
      { relname: 'credentials', relrowsecurity: false },
      { relname: 'sessions', relrowsecurity: false },
      { relname: 'users', relrowsecurity: false },
      { relname: 'verification_tokens', relrowsecurity: false },
    ]);
  });

  it("the identity runtime role cannot read another service's schema", async () => {
    expect(await sqlError(appUrl('identity'), 'select 1 from organization.organization_members limit 1')).toMatch(
      /permission denied/,
    );
  });

  it("other services' runtime roles cannot read sessions or credentials", async () => {
    for (const service of ['organization', 'workspace', 'messaging']) {
      expect(await sqlError(appUrl(service), 'select refresh_token_hash from identity.sessions limit 1')).toMatch(
        /permission denied/,
      );
      expect(await sqlError(appUrl(service), 'select secret from identity.credentials limit 1')).toMatch(
        /permission denied/,
      );
    }
  });
});
