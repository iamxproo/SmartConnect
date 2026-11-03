// Least-privilege model, verified against the live catalog AND by attempting forbidden operations.
// Runs on the disposable test instance. Every probe runs inside a rolled-back transaction.
import { describe, expect, it } from 'vitest';
import { SERVICES, applyBootstrap, loadTargets } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { adminUrl, appUrl, migratorUrl, query, sqlError, withDatabase, withPassword } from '../../support/database.js';

const other = (svc: string): string => SERVICES[(SERVICES.indexOf(svc) + 1) % SERVICES.length]!;

describe('role attributes', () => {
  it('service roles are plain LOGIN roles: no superuser, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS or inheritance', async () => {
    const rows = await query<{ rolname: string; rolconnlimit: number } & Record<string, unknown>>(
      adminUrl(),
      `
      select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin,
             rolconnlimit, left(rolpassword, 14) as scheme
      from pg_authid where rolname like 'sc\\_%' order by rolname`,
    );
    expect(rows).toHaveLength(SERVICES.length * 2);
    for (const r of rows) {
      expect(r, r.rolname).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: true,
        scheme: 'SCRAM-SHA-256$',
      });
      expect(r.rolconnlimit, r.rolname).toBe(r.rolname.endsWith('_migrator') ? 5 : 25);
    }
  });

  it('service roles are members of no other role', async () => {
    const rows = await query(
      adminUrl(),
      `select m.rolname from pg_auth_members am join pg_roles m on m.oid = am.member where m.rolname like 'sc\\_%'`,
    );
    expect(rows).toEqual([]);
  });

  it('only superusers can bypass row-level security', async () => {
    const rows = await query(adminUrl(), 'select rolname from pg_roles where rolbypassrls and not rolsuper');
    expect(rows).toEqual([]);
  });

  it('stores SCRAM-SHA-256 verifiers and rejects a wrong password', async () => {
    expect((await query(adminUrl(), 'show password_encryption'))[0]!.password_encryption).toBe('scram-sha-256');
    expect(await sqlError(withPassword(appUrl('identity'), 'wrong-password'), 'select 1')).toMatch(
      /password authentication failed/,
    );
  });
});

describe('database-level hardening', () => {
  it('PUBLIC holds no privileges on the database, its schemas or the public schema', async () => {
    const [row] = await query(
      adminUrl(),
      `
      select (select count(*) from aclexplode((select datacl from pg_database where datname = current_database())) a where a.grantee = 0) as db_public,
             (select count(*) from pg_namespace n, aclexplode(n.nspacl) a where a.grantee = 0 and n.nspname !~ '^pg_' and n.nspname <> 'information_schema') as schema_public`,
    );
    expect(row).toEqual({ db_public: '0', schema_public: '0' });
  });

  it('no service-schema function is executable by PUBLIC', async () => {
    const rows = await query(
      adminUrl(),
      `
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and n.nspname = any($1)`,
      [SERVICES],
    );
    expect(rows).toEqual([]);
  });

  it('the public schema holds no application tables', async () => {
    expect(await query(adminUrl(), "select tablename from pg_tables where schemaname = 'public'")).toEqual([]);
  });
});

describe('ownership', () => {
  it("every relation, function and type in a service schema is owned by that service's migrator", async () => {
    const rows = await query(
      adminUrl(),
      `
      select n.nspname, c.relname as obj, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1)
      union all select n.nspname, p.proname, pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1)
      union all select n.nspname, t.typname, pg_get_userbyid(t.typowner) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = any($1)`,
      [SERVICES],
    );
    expect(rows.length).toBeGreaterThan(300);
    const misowned = rows.filter((r) => r.owner !== `sc_${r.nspname}_migrator`);
    expect(misowned).toEqual([]);
  });
});

describe('runtime grants', () => {
  it('runtime roles hold exactly SELECT/INSERT/UPDATE/DELETE on their tables (audit log: SELECT/INSERT; migration history: nothing)', async () => {
    const rows = await query(
      adminUrl(),
      `
      select t.schemaname, t.tablename,
             coalesce((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants g
                       where g.table_schema = t.schemaname and g.table_name = t.tablename and g.grantee = 'sc_' || t.schemaname || '_app'), '') as privs
      from pg_tables t where t.schemaname = any($1)`,
      [SERVICES],
    );
    for (const r of rows) {
      const expected =
        r.tablename === '_prisma_migrations'
          ? ''
          : `${r.schemaname}.${r.tablename}` === 'administration.audit_logs'
            ? 'INSERT,SELECT'
            : 'DELETE,INSERT,SELECT,UPDATE';
      expect(r.privs, `${r.schemaname}.${r.tablename}`).toBe(expected);
    }
  });

  it('runtime roles hold no privileges in any other service schema', async () => {
    const rows = await query(
      adminUrl(),
      `
      select grantee, table_schema from information_schema.role_table_grants
      where grantee like 'sc\\_%\\_app' and table_schema = any($1) and grantee <> 'sc_' || table_schema || '_app'`,
      [SERVICES],
    );
    expect(rows).toEqual([]);
  });
});

describe.each(SERVICES)('%s runtime role (sc_<svc>_app)', (svc) => {
  const url = () => appUrl(svc);

  it('connects with its schema on the search_path and request-scoped timeouts', async () => {
    const [row] = await query(
      url(),
      `select current_user, current_setting('search_path') as sp,
      current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it`,
    );
    expect(row).toEqual({ current_user: `sc_${svc}_app`, sp: svc, st: '15s', it: '30s' });
  });

  it('can read and write its own (non-tenant) tables', async () => {
    expect(
      await sqlError(
        url(),
        `insert into ${svc}.processed_events (event_id, handler) values (gen_random_uuid(), 'probe');
                                  select count(*) from ${svc}.processed_events; delete from ${svc}.processed_events where handler = 'probe'`,
      ),
    ).toBeNull();
  });

  it.each([
    [
      'create a table in its own schema',
      (s: string) => `create table ${s}.probe (id int)`,
      /permission denied for schema/,
    ],
    ['create a schema', () => 'create schema probe', /permission denied for database/],
    [
      'create temporary tables',
      () => 'create temp table probe (id int)',
      /permission denied to create temporary tables/,
    ],
    ['use the public schema', () => 'create table public.probe (id int)', /permission denied for schema public/],
    [
      'read its migration history',
      (s: string) => `select * from ${s}._prisma_migrations`,
      /permission denied for table _prisma_migrations/,
    ],
    [
      'alter its tables',
      (s: string) => `alter table ${s}.outbox_events add column probe int`,
      /must be owner of table/,
    ],
    ['drop its tables', (s: string) => `drop table ${s}.processed_events`, /must be owner of table/],
    ['truncate its tables', (s: string) => `truncate ${s}.processed_events`, /permission denied for table/],
    [
      "read another service's schema",
      (s: string) => `select * from ${other(s)}.outbox_events`,
      /permission denied for schema/,
    ],
    ['assume another role', (s: string) => `set role sc_${s}_migrator`, /permission denied to set role/],
  ])('cannot %s', async (_label, sql, error) => {
    expect(await sqlError(url(), sql(svc))).toMatch(error);
  });

  it('cannot connect to the maintenance database', async () => {
    expect(await sqlError(withDatabase(url(), 'postgres'), 'select 1')).toMatch(
      /permission denied for database "postgres"|does not have CONNECT privilege/,
    );
  });
});

describe.each(SERVICES)('%s migrator role (sc_<svc>_migrator)', (svc) => {
  const url = () => migratorUrl(svc);

  it('can create objects in its own schema', async () => {
    expect(await sqlError(url(), `create table ${svc}.probe (id int)`)).toBeNull();
  });

  it('cannot create a database', async () => {
    expect(await sqlError(url(), 'create database probe', { transaction: false })).toMatch(
      /permission denied to create database/,
    );
  });

  it.each([
    [
      "create objects in another service's schema",
      (s: string) => `create table ${other(s)}.probe (id int)`,
      /permission denied for schema/,
    ],
    ['create a schema', () => 'create schema probe', /permission denied for database/],
    [
      'create temporary tables',
      () => 'create temp table probe (id int)',
      /permission denied to create temporary tables/,
    ],
    ['use the public schema', () => 'create table public.probe (id int)', /permission denied for schema public/],
    ['assume its runtime role', (s: string) => `set role sc_${s}_app`, /permission denied to set role/],
  ])('cannot %s', async (_label, sql, error) => {
    expect(await sqlError(url(), sql(svc))).toMatch(error);
  });
});

describe('bootstrap drift correction', () => {
  it('re-running the bootstrap strips manually added grants on existing objects and restores the intended set', async () => {
    // Simulate manual drift: extra privileges, cross-service access, PUBLIC execute, and a missing grant.
    await query(
      adminUrl(),
      `
      grant truncate, references, trigger on messaging.messages to sc_messaging_app;
      grant usage on schema messaging to sc_search_app;
      grant select on messaging.messages to sc_search_app;
      grant usage on schema notifications to sc_tasks_app;
      grant execute on function notifications.claim_notification_deliveries(integer, integer) to public, sc_tasks_app;
      grant select on administration._prisma_migrations to sc_administration_app;
      grant update, delete on administration.audit_logs to sc_administration_app;
      revoke insert on workspace.channels from sc_workspace_app;`,
    );
    applyBootstrap(loadTargets().test);
    const grants = await query(
      adminUrl(),
      `
      select grantee, table_schema || '.' || table_name as tbl, string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where (table_schema, table_name) in (('messaging', 'messages'), ('workspace', 'channels'), ('administration', '_prisma_migrations'), ('administration', 'audit_logs'))
        and grantee like 'sc\\_%\\_app'
      group by 1, 2 order by 2, 1`,
    );
    expect(grants).toEqual([
      { grantee: 'sc_administration_app', tbl: 'administration.audit_logs', privs: 'INSERT,SELECT' },
      { grantee: 'sc_messaging_app', tbl: 'messaging.messages', privs: 'DELETE,INSERT,SELECT,UPDATE' },
      { grantee: 'sc_workspace_app', tbl: 'workspace.channels', privs: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
    expect(await sqlError(appUrl('search'), 'select 1 from messaging.messages limit 1')).toMatch(
      /permission denied for schema messaging/,
    );
    expect(await sqlError(appUrl('tasks'), 'select * from notifications.claim_notification_deliveries(1, 5)')).toMatch(
      /permission denied for schema notifications/,
    );
    const [fn] = await query(
      adminUrl(),
      `select count(*)::int as public_exec from pg_proc p, aclexplode(p.proacl) a
                                           where p.proname = 'claim_notification_deliveries' and a.grantee = 0`,
    );
    expect(fn).toEqual({ public_exec: 0 });
  });

  it('PUBLIC cannot connect to template1', async () => {
    expect(await sqlError(withDatabase(appUrl('identity'), 'template1'), 'select 1')).toMatch(
      /permission denied for database "template1"|does not have CONNECT privilege/,
    );
  });
});

describe('administration.audit_logs is append-only', () => {
  const insertAudit = `
    select set_config('app.current_organization_id', '00000000-0000-7000-8000-000000000001', true);
    insert into administration.audit_logs (id, organization_id, event_id, occurred_at, source_service, actor_type, action, resource_type)
    values (gen_random_uuid(), '00000000-0000-7000-8000-000000000001', gen_random_uuid(), now(), 'test', 'system', 'probe.created', 'probe');`;

  it('the runtime role can insert and read but gets "permission denied" for UPDATE and DELETE', async () => {
    expect(await sqlError(appUrl('administration'), insertAudit)).toBeNull();
    expect(
      await sqlError(appUrl('administration'), "update administration.audit_logs set action = 'tampered'"),
    ).toMatch(/permission denied for table audit_logs/);
    expect(await sqlError(appUrl('administration'), 'delete from administration.audit_logs')).toMatch(
      /permission denied for table audit_logs/,
    );
  });

  it('even the schema owner cannot UPDATE or TRUNCATE (trigger); it may DELETE for retention purges', async () => {
    expect(
      await sqlError(
        migratorUrl('administration'),
        `${insertAudit} update administration.audit_logs set action = 'tampered'`,
      ),
    ).toMatch(/append-only: UPDATE denied/);
    expect(await sqlError(migratorUrl('administration'), 'truncate administration.audit_logs')).toMatch(
      /append-only: TRUNCATE denied/,
    );
    expect(
      await sqlError(migratorUrl('administration'), `${insertAudit} delete from administration.audit_logs`),
    ).toBeNull();
  });
});
