// Playwright global setup (make e2e): the whole platform as a browser sees it, on its own ports, against the
// disposable test PostgreSQL (never the dev database) and the local Redis on a run-unique events channel.
// - Built services (make build): identity 3301, organization 3302, workspace 3303, messaging 3304, realtime 3305,
//   files 3309, API gateway 3300.
// - The web app's Vite dev server on 5174, proxying /api and /realtime to this stack (not :3000 / :3105).
// Signing keys are generated per run in a temporary directory; credentials are never printed. Logs: E2E_LOG_DIR.
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isContainerRunning,
  loadTargets,
  parseEnvFile,
  provisionTestInstance,
} from '../../../infrastructure/scripts/lib/db-lib.mjs';

export const PORTS = {
  gateway: 3300,
  identity: 3301,
  organization: 3302,
  workspace: 3303,
  messaging: 3304,
  realtime: 3305,
  /** Not 3306: MySQL's default port, often taken on developer machines. */
  files: 3309,
};
export const WEB_PORT = 5174;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
/** Organization creators for this run (the allowlist is fixed at startup). Tests take one each. */
export const FOUNDERS = 100;

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const service = (name: string) => path.join(REPO, 'smartconnect-backend', name);

function writeKeys(dir: string) {
  const kid = `e2e-${randomUUID()}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' };
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
  writeFileSync(path.join(dir, 'private.jwk.json'), JSON.stringify(privateJwk), { mode: 0o600 });
  writeFileSync(path.join(dir, 'public.jwks.json'), JSON.stringify({ keys: [publicJwk] }));
  return { privateFile: path.join(dir, 'private.jwk.json'), publicFile: path.join(dir, 'public.jwks.json') };
}

async function waitReady(name: string, url: string, child: ChildProcess, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with ${child.exitCode} (see its log in E2E_LOG_DIR)`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} was not ready at ${url} within ${timeoutMs} ms`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { test } = loadTargets();
  if (!isContainerRunning(test.container)) throw new Error(`${test.container} is not running: make test-db-up`);
  const { services } = provisionTestInstance();

  const runId = Date.now().toString(36);
  const logDir = process.env.E2E_LOG_DIR ?? mkdtempSync(path.join(tmpdir(), 'smartconnect-e2e-logs-'));
  mkdirSync(logDir, { recursive: true });
  const keys = writeKeys(mkdtempSync(path.join(tmpdir(), 'smartconnect-e2e-keys-')));
  const rootEnv = parseEnvFile(path.join(REPO, '.env'));
  if (!rootEnv.REDIS_PASSWORD) throw new Error('REDIS_PASSWORD is not set in .env; start Redis with make infra-up');
  const redisUrl = `redis://:${encodeURIComponent(rootEnv.REDIS_PASSWORD)}@127.0.0.1:${rootEnv.REDIS_PORT ?? 6379}/0`;
  const events = `e2e:events:${runId}`;
  const founders = Array.from({ length: FOUNDERS }, (_, i) => `founder-${runId}-${i}@example.com`);
  const local = (port: number) => `http://127.0.0.1:${port}`;

  const common = {
    NODE_ENV: 'development',
    AUTH_JWT_PUBLIC_JWKS_FILE: keys.publicFile,
    WEB_APP_URL: WEB_URL,
    LOG_LEVEL: 'warn',
  };
  const stack: [string, string, number, Record<string, string | undefined>][] = [
    ['identity', service('services/identity'), PORTS.identity, { AUTH_JWT_PRIVATE_JWK_FILE: keys.privateFile }],
    [
      'organization',
      service('services/organization'),
      PORTS.organization,
      { IDENTITY_SERVICE_URL: local(PORTS.identity), ORGANIZATION_CREATOR_EMAILS: founders.join(',') },
    ],
    [
      'workspace',
      service('services/workspace'),
      PORTS.workspace,
      { ORGANIZATION_SERVICE_URL: local(PORTS.organization) },
    ],
    [
      'messaging',
      service('services/messaging'),
      PORTS.messaging,
      {
        WORKSPACE_SERVICE_URL: local(PORTS.workspace),
        ORGANIZATION_SERVICE_URL: local(PORTS.organization),
        FILES_SERVICE_URL: local(PORTS.files),
        REDIS_URL: redisUrl,
        REALTIME_EVENTS_CHANNEL: events,
      },
    ],
    [
      'realtime-gateway',
      service('realtime-gateway'),
      PORTS.realtime,
      {
        WORKSPACE_SERVICE_URL: local(PORTS.workspace),
        MESSAGING_SERVICE_URL: local(PORTS.messaging),
        REDIS_URL: redisUrl,
        REALTIME_EVENTS_CHANNEL: events,
        CORS_ALLOWED_ORIGINS: WEB_URL,
        REAUTHORIZE_INTERVAL_SECONDS: '5',
      },
    ],
    [
      'files',
      service('services/files'),
      PORTS.files,
      {
        ORGANIZATION_SERVICE_URL: local(PORTS.organization),
        MESSAGING_SERVICE_URL: local(PORTS.messaging),
        // Uploaded bytes live only for the run, never in the repository's .local/ directory.
        FILES_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'smartconnect-e2e-files-')),
      },
    ],
    [
      'api-gateway',
      service('api-gateway'),
      PORTS.gateway,
      {
        IDENTITY_SERVICE_URL: local(PORTS.identity),
        ORGANIZATION_SERVICE_URL: local(PORTS.organization),
        WORKSPACE_SERVICE_URL: local(PORTS.workspace),
        MESSAGING_SERVICE_URL: local(PORTS.messaging),
        FILES_SERVICE_URL: local(PORTS.files),
        CORS_ALLOWED_ORIGINS: WEB_URL,
        // Every browser context sends its own X-Forwarded-For (support/fixtures.ts), so each simulated person gets
        // their own per-IP rate-limit buckets, as people on different machines would. The limits stay on.
        TRUST_PROXY_HOPS: '1',
      },
    ],
  ];

  const children: ChildProcess[] = [];
  const stop = async () => {
    for (const child of children.reverse()) child.kill('SIGTERM');
    const running = children.filter((child) => child.exitCode === null);
    await Promise.all(running.map((child) => new Promise((resolve) => child.once('exit', resolve))));
  };
  try {
    for (const [name, cwd, port, extra] of stack) {
      const log = openSync(path.join(logDir, `${name}.log`), 'w');
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...common,
        ...extra,
        PORT: String(port),
        DATABASE_URL: services[name]?.appUrl,
      };
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
      const child = spawn(process.execPath, ['dist/main.js'], { cwd, env, stdio: ['ignore', log, log] });
      children.push(child);
      await waitReady(name, `${local(port)}/health/ready`, child);
    }
    const viteLog = openSync(path.join(logDir, 'vite.log'), 'w');
    const vite = spawn(
      process.execPath,
      [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(WEB_PORT), '--strictPort'],
      {
        cwd: path.join(REPO, 'smartconnect-frontend/web'),
        env: {
          ...process.env,
          WEB_DEV_API_TARGET: local(PORTS.gateway),
          WEB_DEV_REALTIME_TARGET: local(PORTS.realtime),
        },
        stdio: ['ignore', viteLog, viteLog],
      },
    );
    children.push(vite);
    await waitReady('vite', WEB_URL, vite);
  } catch (error) {
    await stop();
    throw error;
  }

  process.env.E2E_FOUNDERS = founders.join(',');
  // admin.spec.ts grants the Super Admin role directly (ADR 0015), as `make admin-seed` does on the dev database. The
  // test instance's own, per-provisioning credentials; never printed.
  process.env.E2E_IDENTITY_DATABASE_URL = services.identity?.appUrl;
  process.env.E2E_IDENTITY_URL = local(PORTS.identity);
  process.env.E2E_ORGANIZATION_URL = local(PORTS.organization);
  process.env.E2E_LOG_DIR = logDir;
  console.log(`[e2e] stack ready (run ${runId}); logs in ${logDir}`);
  return stop;
}
