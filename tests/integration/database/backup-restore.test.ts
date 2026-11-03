// Backup → restore drill on the disposable test instance, using the real scripts operators run.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, SERVICES } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { adminUrl, appUrl, query, sqlError, withClient, withDatabase } from '../../support/database.js';

const BACKUP = path.join(REPO_ROOT, 'infrastructure/backup/backup.sh');
const RESTORE = path.join(REPO_ROOT, 'infrastructure/backup/restore.sh');
const restoredDb = `restore_drill_${Date.now()}`;
const tenant = randomUUID();
const outRoot = mkdtempSync(path.join(os.tmpdir(), 'smartconnect-backup-'));
let backupDir = '';

const run = (script: string, args: string[]) =>
  spawnSync('bash', [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

/** Everything that must survive a restore: tables + owners, exact row counts, RLS, policies, functions, grants. */
async function fingerprint(url: string) {
  const [row] = await query(
    url,
    `
    select
      (select json_agg(x order by x) from (select schemaname || '.' || tablename || ':' || tableowner as x from pg_tables where schemaname = any($1)) t) as tables,
      (select json_object_agg(schemaname || '.' || tablename,
              (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', schemaname, tablename), false, true, '')))[1]::text::int)
       from pg_tables where schemaname = any($1)) as row_counts,
      (select json_agg(x order by x) from (select n.nspname || '.' || c.relname as x from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                           where c.relrowsecurity and n.nspname = any($1)) t) as rls,
      (select json_agg(x order by x) from (select schemaname || '.' || tablename || '.' || policyname || ':' || coalesce(qual, '') || '|' || coalesce(with_check, '') as x
                                           from pg_policies where schemaname = any($1)) t) as policies,
      (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || ':' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef as x
                                           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1)) t) as functions,
      (select json_agg(x order by x) from (select grantee || ':' || table_schema || '.' || table_name || ':' || privilege_type as x
                                           from information_schema.role_table_grants where grantee like 'sc\\_%' and table_schema = any($1)) t) as grants,
      (select json_agg(x order by x) from (select r.rolname || ':' || array_to_string(s.setconfig, ',') as x from pg_db_role_setting s
                                           join pg_roles r on r.oid = s.setrole
                                           where s.setdatabase = (select oid from pg_database where datname = current_database())) t) as role_settings`,
    [SERVICES],
  );
  return row;
}

beforeAll(async () => {
  // Tenant data written the way services write it: runtime role + tenant context.
  await withClient(appUrl('workspace'), async (c) => {
    await c.query('BEGIN');
    await c.query("select set_config('app.current_organization_id', $1, true)", [tenant]);
    await c.query(
      `insert into workspace.workspaces (id, organization_id, name, slug, created_by_user_id, updated_at)
                   values (gen_random_uuid(), $1, 'Backup drill', $2, gen_random_uuid(), now())`,
      [tenant, `drill-${tenant.slice(0, 8)}`],
    );
    await c.query('COMMIT');
  });
});

afterAll(async () => {
  await query(adminUrl('postgres'), `drop database if exists ${restoredDb} with (force)`);
  rmSync(outRoot, { recursive: true, force: true });
});

describe('backup and restore drill', () => {
  it('backup.sh writes a verified, checksummed, owner-only archive without password hashes', () => {
    const res = run(BACKUP, ['test', outRoot]);
    expect(res.status, res.stderr).toBe(0);
    backupDir = res.stdout.trim().split('\n').pop()!;
    for (const file of ['database.dump', 'globals.sql', 'SHA256SUMS', 'manifest.txt']) {
      expect(statSync(path.join(backupDir, file)).mode & 0o777, file).toBe(0o600);
    }
    expect(readFileSync(path.join(backupDir, 'manifest.txt'), 'utf8')).toMatch(/toc_entries=[1-9]\d*/);
    expect(readFileSync(path.join(backupDir, 'globals.sql'), 'utf8')).not.toMatch(/SCRAM-SHA-256\$|PASSWORD '/);
  });

  it('restore.sh rebuilds an identical database: schema, ownership, data, RLS, policies, functions, grants, role settings', async () => {
    const res = run(RESTORE, [backupDir, restoredDb, 'test']);
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(await fingerprint(adminUrl(restoredDb))).toEqual(await fingerprint(adminUrl()));
  });

  it('the restored database still enforces least privilege and tenant isolation', async () => {
    const restoredApp = withDatabase(appUrl('workspace'), restoredDb);
    expect(await query(restoredApp, 'select count(*)::int as n from workspace.workspaces')).toEqual([{ n: 0 }]);
    const visible = await withClient(restoredApp, async (c) => {
      await c.query('BEGIN');
      await c.query("select set_config('app.current_organization_id', $1, true)", [tenant]);
      const { rows } = await c.query<{ name: string }>('select name from workspace.workspaces');
      await c.query('ROLLBACK');
      return rows;
    });
    expect(visible).toEqual([{ name: 'Backup drill' }]);
    expect(await sqlError(restoredApp, 'create table workspace.probe (id int)')).toMatch(
      /permission denied for schema/,
    );
  });

  it('refuses to overwrite an existing database or a tampered backup', () => {
    expect(run(RESTORE, [backupDir, restoredDb, 'test']).stderr).toMatch(/already exists/);
    expect(run(RESTORE, [backupDir, 'smartconnect_test', 'test']).stderr).toMatch(/refusing/);
    const tampered = mkdtempSync(path.join(outRoot, 'tampered-'));
    spawnSync('cp', [
      '-p',
      ...['database.dump', 'globals.sql', 'SHA256SUMS'].map((f) => path.join(backupDir, f)),
      tampered,
    ]);
    spawnSync('sh', ['-c', `printf x >> "${path.join(tampered, 'globals.sql')}"`]);
    expect(run(RESTORE, [tampered, `${restoredDb}_x`, 'test']).stderr).toMatch(/checksum verification failed/);
  });

  it('a restore that fails part-way drops the incomplete database', async () => {
    // A truncated archive with matching checksums: passes verification, fails inside pg_restore.
    const broken = mkdtempSync(path.join(outRoot, 'broken-'));
    const dump = readFileSync(path.join(backupDir, 'database.dump'));
    writeFileSync(path.join(broken, 'database.dump'), dump.subarray(0, Math.floor(dump.length / 2)));
    spawnSync('cp', [path.join(backupDir, 'globals.sql'), broken]);
    spawnSync('sh', ['-c', 'shasum -a 256 database.dump globals.sql > SHA256SUMS'], { cwd: broken });
    const target = `${restoredDb}_broken`;
    const res = run(RESTORE, [broken, target, 'test']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/dropping incomplete database/);
    expect(
      await query(adminUrl('postgres'), 'select count(*)::int as n from pg_database where datname = $1', [target]),
    ).toEqual([{ n: 0 }]);
  });
});
