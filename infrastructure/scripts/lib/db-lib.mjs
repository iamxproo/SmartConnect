// Shared helpers for SmartConnect database tooling (db.mjs CLI and the database test suite).
// Zero npm dependencies: uses only Node built-ins plus `docker`/`psql` and the Prisma CLI.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'smartconnect-backend');
export const BOOTSTRAP_SQL = path.join(REPO_ROOT, 'infrastructure/compose/postgres/init/010_bootstrap.sql');
// The monorepo installs once at the root (npm workspaces), so the Prisma CLI is hoisted there.
export const PRISMA_BIN = path.join(REPO_ROOT, 'node_modules/.bin/prisma');

/** Service-owned schemas. Must match the `services` array in 010_bootstrap.sql (enforced by tests). */
export const SERVICES = Object.freeze([
  'identity',
  'organization',
  'workspace',
  'messaging',
  'presence',
  'meetings',
  'files',
  'notifications',
  'search',
  'documents',
  'tasks',
  'workflows',
  'integrations',
  'administration',
]);

export const serviceDir = (svc) => path.join(BACKEND_DIR, 'services', svc);
export const roleNames = (svc) => ({ migrator: `sc_${svc}_migrator`, app: `sc_${svc}_app` });

export function assertService(svc) {
  if (!SERVICES.includes(svc)) throw new Error(`unknown service "${svc}" (expected one of: ${SERVICES.join(', ')})`);
}

/**
 * Minimal KEY=VALUE parser (no interpolation). Returns {} when the file is missing.
 * @param {string} file
 * @returns {Record<string, string | undefined>}
 */
export function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Connection targets. Process environment wins over the repository-root .env (CI friendliness). */
export function loadTargets() {
  const env = { ...parseEnvFile(path.join(REPO_ROOT, '.env')), ...process.env };
  return {
    dev: {
      name: 'dev',
      container: 'smartconnect-postgres',
      adminUser: env.POSTGRES_USER,
      adminPassword: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
      host: env.POSTGRES_HOST ?? '127.0.0.1',
      port: Number(env.POSTGRES_PORT ?? 15432),
    },
    test: {
      name: 'test',
      container: 'smartconnect-postgres-test',
      adminUser: env.POSTGRES_TEST_USER ?? 'smartconnect_test_admin',
      adminPassword: env.POSTGRES_TEST_PASSWORD,
      database: env.POSTGRES_TEST_DB ?? 'smartconnect_test',
      host: env.POSTGRES_TEST_HOST ?? '127.0.0.1',
      port: Number(env.POSTGRES_TEST_PORT ?? 15433),
    },
  };
}

/**
 * Runs SQL as the target's admin role and returns stdout (unaligned, tuples only).
 * SQL is passed on stdin, never argv. Default transport is `docker exec` (unix socket inside
 * the container); set SC_PSQL=tcp to use a host `psql` over TCP instead (CI).
 */
export function runSql(
  target,
  sql,
  { database = target.database, user = target.adminUser, password = target.adminPassword } = {},
) {
  const flags = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database];
  const viaTcp = process.env.SC_PSQL === 'tcp' || user !== target.adminUser;
  const res = viaTcp
    ? spawnSync('psql', ['-h', target.host, '-p', String(target.port), ...flags], {
        input: sql,
        encoding: 'utf8',
        env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' },
      })
    : spawnSync('docker', ['exec', '-i', target.container, 'psql', ...flags], { input: sql, encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`psql failed (${target.name}, ${user}@${database}): ${res.stderr.trim()}`);
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout.trim();
}

export function applyBootstrap(target) {
  runSql(target, readFileSync(BOOTSTRAP_SQL, 'utf8'));
}

/** 40 URL-safe characters (240 bits of entropy). */
export const generatePassword = () => randomBytes(30).toString('base64url');

/**
 * RFC 5802 / RFC 7677 SCRAM-SHA-256 verifier in PostgreSQL's storage format.
 * Sending the verifier instead of the plaintext keeps passwords out of server logs and
 * pg_stat_activity. Restricted to printable ASCII, for which SASLprep is the identity.
 */
export function scramSha256Verifier(password, iterations = 4096) {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('password must be printable ASCII');
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Sets passwords for the given roles atomically. `credentials` = { roleName: plaintextPassword }. */
export function setRolePasswords(target, credentials) {
  const statements = Object.entries(credentials).map(([role, password]) => {
    if (!/^sc_[a-z]+_(app|migrator)$/.test(role))
      throw new Error(`refusing to set password for unexpected role ${role}`);
    return `ALTER ROLE "${role}" PASSWORD '${scramSha256Verifier(password)}';`;
  });
  runSql(target, ['BEGIN;', ...statements, 'COMMIT;'].join('\n'));
}

export function connectionUrl({ user, password, host, port, database, schema }) {
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
  return schema ? `${url}?schema=${encodeURIComponent(schema)}` : url;
}

/**
 * Writes secret content to a fresh temp file (exclusive create, mode 600: never follows a planted
 * symlink, never reuses a file with looser permissions) and returns commit/discard handles.
 * commit() atomically renames it over the target, so the target never holds the secret with loose
 * permissions and readers never see a partial file.
 */
export function stageSecretFile(file, content) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  return { commit: () => renameSync(tmp, file), discard: () => rmSync(tmp, { force: true }) };
}

export function writeSecretFile(file, content) {
  stageSecretFile(file, content).commit();
}

/** Runs the Prisma CLI inside a service directory. Throws on failure unless `allowFailure`. */
export function runPrisma(svc, args, { env = {}, capture = false, allowFailure = false } = {}) {
  if (!existsSync(PRISMA_BIN)) throw new Error(`Prisma CLI not installed: run \`npm install\` in ${REPO_ROOT}`);
  const res = spawnSync(PRISMA_BIN, args, {
    cwd: serviceDir(svc),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`prisma ${args.join(' ')} failed for ${svc}${capture ? `:\n${res.stderr}\n${res.stdout}` : ''}`);
  }
  return res;
}

/**
 * Rehearses the full production sequence on the disposable TEST instance: bootstrap → ephemeral
 * credentials → `prisma migrate deploy` as each service's migrator → bootstrap again (privilege
 * re-assertion). Returns per-service connection URLs for the test suite. Never touches DEV.
 */
export function provisionTestInstance({ log = () => {} } = {}) {
  const { dev, test } = loadTargets();
  if (!test.adminPassword) throw new Error('POSTGRES_TEST_PASSWORD is not set (see .env.example)');
  if (test.port === dev.port || test.container === dev.container)
    throw new Error('test target resolves to the dev instance — refusing');
  const database = runSql(test, 'select current_database()');
  if (database !== test.database || !/_test$/.test(database))
    throw new Error(`unexpected test database "${database}" — refusing`);

  applyBootstrap(test);
  /** @type {Record<string, string>} */
  const passwords = {};
  for (const svc of SERVICES) {
    const { app, migrator } = roleNames(svc);
    passwords[app] = generatePassword();
    passwords[migrator] = generatePassword();
  }
  setRolePasswords(test, passwords);

  /** @type {Record<string, { appUrl: string, migratorUrl: string }>} */
  const services = {};
  for (const svc of SERVICES) {
    const { app, migrator } = roleNames(svc);
    const common = { host: test.host, port: test.port, database: test.database, schema: svc };
    services[svc] = {
      appUrl: connectionUrl({ user: app, password: passwords[app], ...common }),
      migratorUrl: connectionUrl({ user: migrator, password: passwords[migrator], ...common }),
    };
  }
  try {
    for (const svc of SERVICES) {
      log(`migrate deploy → ${svc}`);
      runPrisma(svc, ['migrate', 'deploy'], {
        env: { MIGRATION_DATABASE_URL: services[svc].migratorUrl },
        capture: true,
      });
    }
  } finally {
    applyBootstrap(test); // re-assert privileges even if a migration failed part-way
  }
  return { target: test, services, passwords };
}

export function isContainerRunning(name) {
  const res = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() === 'true';
}
