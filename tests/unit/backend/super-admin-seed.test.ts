// The development Super Admin seed (ADR 0015) must never run outside local development: these are its guards.
// No database is touched: every case is refused before a connection is made.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertDevelopmentSeed,
  INITIAL_PASSWORD_MIN_LENGTH,
  seedSuperAdmin,
  SUPER_ADMIN_EMAIL,
} from '../../../smartconnect-backend/scripts/super-admin.js';
import type { IdentityPrisma } from '../../../smartconnect-backend/services/identity/src/database/prisma.token.js';

const DEV = 'postgresql://sc_identity_app:x@127.0.0.1:15432/smartconnect?schema=identity';

describe('development Super Admin seed: where it may run', () => {
  it('accepts only local development', () => {
    expect(() => assertDevelopmentSeed({}, DEV, 15432)).not.toThrow();
    expect(() => assertDevelopmentSeed({ NODE_ENV: 'development' }, DEV, 15432)).not.toThrow();
  });

  it.each(['production', 'staging', 'test', 'prod', ''])('refuses NODE_ENV=%j', (nodeEnv) => {
    expect(() => assertDevelopmentSeed({ NODE_ENV: nodeEnv }, DEV, 15432)).toThrow(/development only/);
  });

  it.each([
    ['a remote host', 'postgresql://u:x@db.smartconnect.example:5432/smartconnect'],
    ['another local instance (the test database)', 'postgresql://u:x@127.0.0.1:15433/smartconnect'],
    ['another database', 'postgresql://u:x@127.0.0.1:15432/smartconnect_staging'],
    ['a host that only looks local', 'postgresql://u:x@127.0.0.1.example.com:15432/smartconnect'],
  ])('refuses %s', (_name, url) => {
    expect(() => assertDevelopmentSeed({ NODE_ENV: 'development' }, url, 15432)).toThrow(
      /outside the local development database/,
    );
  });

  it('uses a reserved, never-routable address for the account', () => {
    expect(SUPER_ADMIN_EMAIL).toMatch(/@[a-z0-9.-]+\.localhost$/);
  });

  it(`refuses an initial password under ${INITIAL_PASSWORD_MIN_LENGTH} characters before touching the database`, async () => {
    const unreachable = {} as IdentityPrisma; // any use would throw a TypeError instead
    await expect(seedSuperAdmin(unreachable, 'short')).rejects.toThrow(/at least 8 characters/);
  });
});

describe('make admin-seed', () => {
  const script = fileURLToPath(new URL('../../../infrastructure/scripts/admin-seed.sh', import.meta.url));

  it('refuses to run without an interactive terminal (the password is only ever typed at a hidden prompt)', () => {
    const run = spawnSync('bash', [script], { stdio: ['pipe', 'pipe', 'pipe'], input: 'piped-password\n' });
    expect(run.status).toBe(1);
    expect(run.stderr.toString()).toMatch(/interactive terminal/);
    expect(run.stdout.toString() + run.stderr.toString()).not.toContain('piped-password');
  });
});
