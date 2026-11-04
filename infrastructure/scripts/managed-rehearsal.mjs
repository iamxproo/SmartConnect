#!/usr/bin/env node
// Rehearses the MANAGED PostgreSQL bootstrap (Render-like; docs/runbooks/managed-postgres-bootstrap.md) on a
// disposable PostgreSQL 18 container (infrastructure/compose/postgres18-rehearsal.yml, 127.0.0.1:15434, tmpfs).
// Never the dev database, the test database or a real provider. `make db-rehearse-managed`.
//
// 1. Starts the container with a random superuser password held only by this process (a Compose secret), and as
//    that superuser reproduces the provider's profile: an administrator with LOGIN, CREATEROLE and CREATEDB and no
//    SUPERUSER, REPLICATION or BYPASSRLS, owning a fresh, empty database. pg_stat_statements is available, not
//    installed.
// 2. Runner: `db.mjs managed-bootstrap`, `db.mjs managed-migrate` (every service as its own migrator, then the
//    bootstrap again) and `managed-bootstrap` once more (idempotent, credentials reused), all as the administrator,
//    with the credentials file in a private temporary directory. The administrator's createrole_self_grant is
//    'set, inherit' here (a provider could set that); the bootstrap must not let it through. Then the catalog is
//    checked as the superuser, and faults are injected one at a time: the bootstrap must refuse each, changing nothing.
// 3. A fresh container: the database security suites (and, unless --security-only, the application integration
//    suites) with the administrator as the test admin (the suites' global setup bootstraps, migrates and
//    re-bootstraps as it) and the superuser for inspection and fault injection only.
// 4. Stops the container and removes the temporary directory, whatever happened. No password is ever printed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  REPO_ROOT,
  SERVICES,
  applyBootstrap,
  generatePassword,
  managedTarget,
  roleNames,
  scramSha256Verifier,
} from './lib/db-lib.mjs';

const COMPOSE_FILE = path.join(REPO_ROOT, 'infrastructure/compose/postgres18-rehearsal.yml');
const CONTAINER = 'smartconnect-postgres18-rehearsal';
const PORT = 15434;
const ROOT = 'rehearsal_root';
const ADMIN = 'render_admin';
const securityOnly = process.argv.includes('--security-only');

const rootPassword = generatePassword();
const adminPassword = generatePassword();
const workDir = mkdtempSync(path.join(tmpdir(), 'smartconnect-managed-rehearsal-'));
const results = [];

function run(command, args, { env = {}, cwd = REPO_ROOT, capture = false } = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
}

function compose(...args) {
  const res = run('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: { REHEARSAL_ROOT_PASSWORD: rootPassword },
  });
  if (res.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
}

/** SQL as the container's superuser over its local socket (inspection and the provider's own setup only). */
function asRoot(sql, database = 'postgres') {
  const res = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      CONTAINER,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-F',
      '\t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      ROOT,
      '-d',
      database,
    ],
    { input: sql, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`psql as ${ROOT} failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** A fresh container with the provider's profile: the administrator owns `database`, nothing else is set up. */
function freshInstance(database, { selfGrant } = {}) {
  compose('down', '--volumes', '--remove-orphans');
  compose('up', '-d', '--wait');
  asRoot(
    `CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD '${scramSha256Verifier(adminPassword)}';
     CREATE DATABASE ${database} OWNER ${ADMIN};
     ${selfGrant ? `ALTER ROLE ${ADMIN} SET createrole_self_grant = '${selfGrant}';` : ''}`,
  );
  const profile = asRoot(
    `select current_setting('server_version'), r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
            (select count(*) from pg_available_extensions where name = 'pg_stat_statements'),
            (select count(*) from pg_extension where extname = 'pg_stat_statements')
       from pg_roles r where r.rolname = '${ADMIN}'`,
    database,
  ).split('\t');
  console.log(
    `• PostgreSQL ${profile[0]}: ${ADMIN} SUPERUSER=${profile[1]} CREATEROLE=${profile[2]} CREATEDB=${profile[3]} ` +
      `BYPASSRLS=${profile[4]} REPLICATION=${profile[5]}; owns ${database}; createrole_self_grant=${selfGrant ?? '(default)'}; ` +
      `pg_stat_statements available=${profile[6]} installed=${profile[7]}`,
  );
  if (profile.slice(1, 6).join() !== 'f,t,t,f,f')
    throw new Error('the administrator does not have the provider profile');
}

function record(phase, ok, detail) {
  results.push({ phase, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${phase}: ${detail}`);
}

/** Catalog checks as the superuser, after the runner path (the suites in phase 3 check the same and more). */
function verifyCatalog(database) {
  const q = (sql) => asRoot(sql, database);
  const list = (sql) => {
    const out = q(sql);
    return out ? out.split('\n') : [];
  };
  const svcs = SERVICES.map((s) => `'${s}'`).join(',');

  const schemas = list(
    `select nspname || '=' || pg_get_userbyid(nspowner) from pg_namespace where nspname in (${svcs}) order by 1`,
  );
  const expectedSchemas = SERVICES.map((s) => `${s}=${roleNames(s).migrator}`).sort();
  record('schemas', schemas.join() === expectedSchemas.join(), `${schemas.length}/14, each owned by its migrator`);

  const roles = list(
    `select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin, rolconnlimit,
            left(rolpassword, 14) from pg_authid where rolname like 'sc\\_%' order by 1`,
  ).map((line) => line.split('\t'));
  const badRoles = roles.filter(
    ([name, ...a]) =>
      a.slice(0, 6).join() !== 'f,f,f,f,f,f' ||
      a[6] !== 't' ||
      a[7] !== (name.endsWith('_migrator') ? '5' : '25') ||
      a[8] !== 'SCRAM-SHA-256$',
  );
  record(
    'roles',
    roles.length === 28 && badRoles.length === 0,
    `${roles.length}/28 login-only, no inheritance, limits 5/25, SCRAM`,
  );

  const memberships = list(
    `select r.rolname, bool_or(am.admin_option), bool_or(am.inherit_option), bool_or(am.set_option)
       from pg_auth_members am join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member
      where m.rolname = '${ADMIN}' and r.rolname like 'sc\\_%' group by 1 order by 1`,
  ).map((line) => line.split('\t'));
  const badMemberships = memberships.filter(
    ([name, admin, inherit, set]) =>
      admin !== 't' || inherit !== 'f' || set !== (name.endsWith('_migrator') ? 't' : 'f'),
  );
  record(
    'administrator memberships',
    memberships.length === 28 && badMemberships.length === 0,
    'ADMIN on all 28, SET on the 14 migrators only, INHERIT on none',
  );
  const serviceMemberships = q(
    `select count(*) from pg_auth_members am join pg_roles m on m.oid = am.member where m.rolname like 'sc\\_%'`,
  );
  record('service role memberships', serviceMemberships === '0', 'service roles are members of no role');

  const runtimeGrants = list(
    `select t.schemaname || '.' || t.tablename || '=' ||
            coalesce((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants g
                      where g.table_schema = t.schemaname and g.table_name = t.tablename and g.grantee = 'sc_' || t.schemaname || '_app'), '')
       from pg_tables t where t.schemaname in (${svcs})`,
  );
  const badGrants = runtimeGrants.filter((line) => {
    const [table, privs] = line.split('=');
    const expected = table.endsWith('._prisma_migrations')
      ? ''
      : table === 'administration.audit_logs'
        ? 'INSERT,SELECT'
        : 'DELETE,INSERT,SELECT,UPDATE';
    return privs !== expected;
  });
  record(
    'runtime grants',
    badGrants.length === 0,
    `${runtimeGrants.length} tables: exactly DML; audit log insert/select; migration history none`,
  );

  const crossGrants = q(
    `select count(*) from information_schema.role_table_grants
      where grantee like 'sc\\_%' and grantee <> 'sc_' || table_schema || '_app' and grantee <> 'sc_' || table_schema || '_migrator'`,
  );
  record('cross-service grants', crossGrants === '0', 'no service role holds anything in another schema');

  const defaults = list(
    `select pg_get_userbyid(d.defaclrole) || ':' || coalesce(n.nspname, '*') || ':' || d.defaclobjtype::text || ':' || array_to_string(d.defaclacl, ' ')
       from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
      where pg_get_userbyid(d.defaclrole) like 'sc\\_%' order by 1`,
  );
  const badDefaults = SERVICES.filter((s) => {
    const { migrator, app } = roleNames(s);
    const has = (fragment) => defaults.some((line) => line.startsWith(`${migrator}:`) && line.includes(fragment));
    return !(
      has(`${migrator}:${s}:r:${app}=arwd/${migrator}`) &&
      has(`${migrator}:${s}:S:${app}=rU/${migrator}`) &&
      has(`${migrator}:${s}:f:${app}=X/${migrator}`) &&
      defaults.some(
        (line) => line.startsWith(`${migrator}:*:f:`) && !/(^|\s)=X\//.test(line.split(':').slice(3).join(':')),
      )
    );
  });
  record(
    'default privileges',
    badDefaults.length === 0,
    'per migrator: tables arwd, sequences rU, functions X to its runtime role; functions not to PUBLIC',
  );

  // The same selection as tenant-isolation.test.ts: tables with organization_id (outbox excluded) and organizations.
  const tenantTables = `from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in (${svcs}) and c.relkind = 'r' and c.relname <> 'outbox_events'
        and (exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
             or (n.nspname, c.relname) = ('organization', 'organizations'))`;
  const rlsTables = q(`select count(*) ${tenantTables}`);
  const rlsMissing = q(
    `select count(*) ${tenantTables} and not (c.relrowsecurity and exists (select 1 from pg_policy p where p.polrelid = c.oid))`,
  );
  record(
    'row-level security',
    rlsMissing === '0' && Number(rlsTables) >= 48,
    `${rlsTables} tenant tables, each with RLS and a policy`,
  );

  const publicExec = q(
    `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
            aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and n.nspname in (${svcs})`,
  );
  const definers = list(
    `select n.nspname || '|' || array_to_string(p.proacl, ' ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname in (${svcs}) order by 1`,
  );
  const badDefiners = definers.filter((line) => {
    const [schema, acl] = line.split('|');
    const grantees = acl
      .split(' ')
      .filter(Boolean)
      .map((item) => item.split('=')[0]);
    return grantees.some((g) => g !== `sc_${schema}_app` && g !== `sc_${schema}_migrator`);
  });
  record(
    'function permissions',
    publicExec === '0' && badDefiners.length === 0,
    `nothing executable by PUBLIC; ${definers.length} SECURITY DEFINER functions, own service only`,
  );

  const dbPublic = q(
    `select count(*) from aclexplode((select datacl from pg_database where datname = current_database())) a where a.grantee = 0`,
  );
  const schemaPublic = q(
    `select count(*) from pg_namespace n, aclexplode(n.nspacl) a where a.grantee = 0 and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  );
  record(
    'database hardening',
    dbPublic === '0' && schemaPublic === '0',
    'PUBLIC holds nothing on the database, its schemas or public',
  );

  const applied = list(
    `select n.nspname || '=' || (select count(*) from pg_class c where c.relnamespace = n.oid and c.relname = '_prisma_migrations')
       from pg_namespace n where n.nspname in (${svcs}) order by 1`,
  );
  const migrated = SERVICES.map((s) =>
    q(`select count(*) from ${s}._prisma_migrations where finished_at is not null and rolled_back_at is null`),
  );
  record(
    'migrations',
    applied.every((line) => line.endsWith('=1')) && migrated.every((n) => Number(n) > 0),
    `${migrated.reduce((a, n) => a + Number(n), 0)} applied migrations across 14 schemas`,
  );

  const maintenance = q(
    `select string_agg(datname || ':' || has_database_privilege('sc_identity_app', datname, 'CONNECT'), ' ' order by datname)
       from pg_database where datname in ('postgres', 'template1')`,
  );
  console.log(`• provider databases (not hardened in managed mode, by design): runtime role CONNECT ${maintenance}`);
  const pgss = q(`select count(*) from pg_extension where extname = 'pg_stat_statements'`);
  console.log(`• pg_stat_statements installed: ${pgss === '1' ? 'yes' : 'no (optional; superuser-only here)'}`);
}

/** Each fault makes the bootstrap refuse, as one transaction: a grant planted beforehand must survive the refusal. */
function refusals(database) {
  const target = managedTarget(adminUrl(database));
  const table = asRoot(`select tablename from pg_tables where schemaname = 'identity' order by 1 limit 1`, database);
  const planted = `has_table_privilege('sc_files_app', 'identity.${table}', 'SELECT')`;
  const cases = [
    {
      label: 'administrator inherits a migrator',
      inject: `GRANT sc_identity_migrator TO ${ADMIN} WITH INHERIT TRUE`,
      revert: `GRANT sc_identity_migrator TO ${ADMIN} WITH INHERIT FALSE`,
      expected: /inherits|SET ROLE/,
    },
    {
      label: 'administrator may SET ROLE to a runtime role',
      inject: `GRANT sc_messaging_app TO ${ADMIN} WITH SET TRUE`,
      revert: `GRANT sc_messaging_app TO ${ADMIN} WITH SET FALSE`,
      expected: /inherits|SET ROLE/,
    },
    {
      label: 'a service role holds BYPASSRLS',
      inject: 'ALTER ROLE sc_files_app BYPASSRLS',
      revert: 'ALTER ROLE sc_files_app NOBYPASSRLS',
      expected: /SUPERUSER, REPLICATION or BYPASSRLS/,
    },
    {
      label: 'a service role holds REPLICATION',
      inject: 'ALTER ROLE sc_tasks_migrator REPLICATION',
      revert: 'ALTER ROLE sc_tasks_migrator NOREPLICATION',
      expected: /SUPERUSER, REPLICATION or BYPASSRLS/,
    },
    {
      label: 'the administrator does not own the database',
      // It can still connect (otherwise the server, not the bootstrap, would refuse it).
      inject: `ALTER DATABASE ${database} OWNER TO ${ROOT}; GRANT CONNECT ON DATABASE ${database} TO ${ADMIN}`,
      revert: `ALTER DATABASE ${database} OWNER TO ${ADMIN}`,
      expected: /must own database/,
    },
    {
      label: 'the administrator lacks CREATEROLE',
      inject: `ALTER ROLE ${ADMIN} NOCREATEROLE`,
      revert: `ALTER ROLE ${ADMIN} CREATEROLE`,
      expected: /needs CREATEROLE/,
    },
  ];
  for (const c of cases) {
    asRoot(
      `GRANT USAGE ON SCHEMA identity TO sc_files_app; GRANT SELECT ON identity.${table} TO sc_files_app; ${c.inject};`,
      database,
    );
    let message = '';
    try {
      applyBootstrap(target);
    } catch (error) {
      message = error.message;
    }
    const untouched = asRoot(`select ${planted}`, database) === 't';
    asRoot(`${c.revert};`, database);
    // The server's error line (no credentials in it): which check refused, or what refused instead.
    const reason = /ERROR:\s*([^\n]*)/.exec(message)?.[1] ?? message.split('\n')[0];
    record(
      `refused: ${c.label}`,
      c.expected.test(message) && untouched,
      message
        ? `${untouched ? 'aborted before committing anything' : 'aborted, but changes were committed'} (${reason})`
        : 'NOT refused',
    );
  }
  applyBootstrap(target); // faults reverted: it runs again, and strips the planted grant
  record(
    'bootstrap after the faults are reverted',
    asRoot(`select ${planted}`, database) === 'f',
    'runs, planted grant stripped',
  );
}

const adminUrl = (database) =>
  `postgresql://${ADMIN}:${encodeURIComponent(adminPassword)}@127.0.0.1:${PORT}/${database}?sslmode=disable`;

function runner() {
  const database = 'smartconnect';
  freshInstance(database, { selfGrant: 'set, inherit' });
  const env = { MANAGED_DATABASE_URL: adminUrl(database) };
  const credentials = `--credentials-file=${path.join(workDir, 'managed-credentials.env')}`;
  const step = (label, args) => {
    const res = run(process.execPath, ['infrastructure/scripts/db.mjs', ...args, credentials], { env });
    record(label, res.status === 0, res.status === 0 ? 'ok' : `exit ${res.status}`);
    if (res.status !== 0) throw new Error(`${label} failed`);
  };
  step('managed-bootstrap', ['managed-bootstrap']);
  step('managed-migrate (each service as its own migrator, then bootstrap again)', ['managed-migrate']);
  step('managed-bootstrap again (idempotent, credentials reused)', ['managed-bootstrap']);
  verifyCatalog(database);
  refusals(database);
}

function suites() {
  const database = 'smartconnect_test';
  freshInstance(database);
  const env = {
    POSTGRES_TEST_HOST: '127.0.0.1',
    POSTGRES_TEST_PORT: String(PORT),
    POSTGRES_TEST_DB: database,
    POSTGRES_TEST_USER: ADMIN,
    POSTGRES_TEST_PASSWORD: adminPassword,
    POSTGRES_TEST_CONTAINER: CONTAINER,
    POSTGRES_TEST_INSPECT_USER: ROOT,
    POSTGRES_TEST_INSPECT_PASSWORD: rootPassword,
    SC_PSQL: 'tcp',
  };
  const vitest = (label, args) => {
    const res = run('npx', ['vitest', 'run', '--config', 'vitest.database.config.ts', ...args], {
      env,
      cwd: path.join(REPO_ROOT, 'tests'),
    });
    record(label, res.status === 0, res.status === 0 ? 'all passed' : 'failures (see the output above)');
  };
  vitest('database security suites', ['security/database', 'integration/database/migrations.test.ts']);
  if (!securityOnly)
    vitest('application integration suites on PostgreSQL 18', [
      'integration',
      '--exclude',
      'integration/database/infrastructure.test.ts',
      '--exclude',
      'integration/database/backup-restore.test.ts',
      '--exclude',
      'integration/database/migrations.test.ts',
    ]);
}

let failed = false;
try {
  runner();
  suites();
} catch (error) {
  failed = true;
  console.error(`✖ ${error.message}`);
} finally {
  try {
    compose('down', '--volumes', '--remove-orphans');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
console.log('\nManaged rehearsal summary:');
for (const r of results) console.log(`  ${r.ok ? '✔' : '✖'} ${r.phase}: ${r.detail}`);
process.exit(failed || results.some((r) => !r.ok) ? 1 : 0);
