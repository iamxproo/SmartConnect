// Migration integrity on the disposable test instance (already migrated by global-setup).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SERVICES, runPrisma, serviceDir } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { adminUrl, appUrl, migratorUrl, query } from '../../support/database.js';

const migrationDirs = (svc: string) =>
  readdirSync(path.join(serviceDir(svc), 'prisma/migrations'))
    .filter((d) => /^\d{14}_/.test(d))
    .sort();

describe.each(SERVICES)('%s', (svc) => {
  it('records every migration as applied in its own schema, none failed or rolled back', async () => {
    const rows = await query<{ migration_name: string; finished: boolean; active: boolean }>(
      adminUrl(),
      `select migration_name, finished_at is not null as finished, rolled_back_at is null as active
                                          from ${svc}._prisma_migrations order by migration_name`,
    );
    expect(rows.map((r) => r.migration_name)).toEqual(migrationDirs(svc));
    expect(rows.every((r) => r.finished && r.active)).toBe(true);
  });

  it('re-running `prisma migrate deploy` is a no-op', () => {
    const res = runPrisma(svc, ['migrate', 'deploy'], {
      env: { MIGRATION_DATABASE_URL: migratorUrl(svc) },
      capture: true,
    });
    expect(res.stdout).toMatch(/No pending migrations to apply/);
  });

  it('`prisma migrate status` reports the database schema as up to date', () => {
    const res = runPrisma(svc, ['migrate', 'status'], {
      env: { MIGRATION_DATABASE_URL: migratorUrl(svc) },
      capture: true,
      allowFailure: true,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Database schema is up to date/);
  });

  it('runtime credentials cannot run migrations', () => {
    const res = runPrisma(svc, ['migrate', 'deploy'], {
      env: { MIGRATION_DATABASE_URL: appUrl(svc) },
      capture: true,
      allowFailure: true,
    });
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/permission denied/i);
  });
});

it('schema.prisma and the migrations have not drifted (replayed in a shadow database)', () => {
  const res = spawnSync(process.execPath, ['infrastructure/scripts/db.mjs', 'check-drift'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(res.status, res.stdout + res.stderr).toBe(0);
  expect(res.stdout.match(/migrations match schema\.prisma/g)).toHaveLength(SERVICES.length);
}, 240_000);
