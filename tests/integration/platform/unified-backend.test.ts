// The unified backend (ADR 0016 Phase 1) exactly as it runs: the BUILT smartconnect-backend/app/dist/main.js, one
// process hosting the API gateway, realtime gateway and five services, against the test database and the shared
// Redis (REDIS_URL derived from the root .env, as for `make backend-start`). Covers REST through the public gateway,
// the services' internal HTTP calls, Socket.IO on the same public port with Redis fan-out, the port check, the
// rejection of a bad configuration before any port opens, credentials never reaching the logs, and the ordered SIGTERM
// shutdown. Ports 3320-3326 (the e2e stacks use 3300-3305 and 3309).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnvFile } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { appUrl } from '../../support/database.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_DIR = path.join(REPO, 'smartconnect-backend/app');
const PORTS = {
  public: 3320,
  identity: 3321,
  organization: 3322,
  workspace: 3323,
  messaging: 3324,
  realtime: 3325,
  files: 3326,
};
const PUBLIC = `http://127.0.0.1:${PORTS.public}`;
const ORIGIN = 'http://127.0.0.1:5999';
const PASSWORD = 'correct horse battery staple 42';
const SERVICES = ['identity', 'organization', 'workspace', 'messaging', 'files'] as const;

const runId = randomUUID().slice(0, 8);
const founder = `unified-founder-${runId}@example.com`;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateJwk = { ...privateKey.export({ format: 'jwk' }), kid: `unified-${runId}`, alg: 'EdDSA' };
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: `unified-${runId}`, alg: 'EdDSA', use: 'sig' };

interface Running {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  const keys = mkdtempSync(path.join(tmpdir(), 'unified-backend-keys-'));
  writeFileSync(path.join(keys, 'private.jwk.json'), JSON.stringify(privateJwk), { mode: 0o600 });
  writeFileSync(path.join(keys, 'public.jwks.json'), JSON.stringify({ keys: [publicJwk] }));
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'development',
    LOG_LEVEL: 'log',
    PORT: String(PORTS.public),
    IDENTITY_INTERNAL_PORT: String(PORTS.identity),
    ORGANIZATION_INTERNAL_PORT: String(PORTS.organization),
    WORKSPACE_INTERNAL_PORT: String(PORTS.workspace),
    MESSAGING_INTERNAL_PORT: String(PORTS.messaging),
    REALTIME_INTERNAL_PORT: String(PORTS.realtime),
    FILES_INTERNAL_PORT: String(PORTS.files),
    ...Object.fromEntries(SERVICES.map((svc) => [`${svc.toUpperCase()}_DATABASE_URL`, appUrl(svc)])),
    AUTH_JWT_PRIVATE_JWK_FILE: path.join(keys, 'private.jwk.json'),
    AUTH_JWT_PUBLIC_JWKS_FILE: path.join(keys, 'public.jwks.json'),
    CORS_ALLOWED_ORIGINS: ORIGIN,
    WEB_APP_URL: ORIGIN,
    ORGANIZATION_CREATOR_EMAILS: founder,
    REALTIME_EVENTS_CHANNEL: `unified-test:${runId}`,
    FILES_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'unified-backend-files-')),
    ...overrides,
  };
}

function launch(env: Record<string, string>): Running {
  const child = spawn(process.execPath, ['dist/main.js'], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output: () => text, exited };
}

async function waitReady(run: Running, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null)
      throw new Error(`unified backend exited with ${run.child.exitCode}:\n${run.output()}`);
    try {
      if ((await fetch(`${PUBLIC}/health/ready`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`unified backend not ready within ${timeoutMs} ms:\n${run.output()}`);
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

async function api(method: string, route: string, options: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${PUBLIC}/api/v1${route}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

/** Registers through the public gateway, verifies through identity's dev mailbox, logs in. */
async function person(email = `unified-${randomUUID().slice(0, 8)}@example.com`) {
  expect(
    (await api('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: 'Unified' } })).res.status,
  ).toBe(202);
  const mailbox = (await (
    await fetch(`http://127.0.0.1:${PORTS.identity}/dev/mailbox?to=${encodeURIComponent(email)}`)
  ).json()) as {
    data: { kind?: string; token?: string }[];
  };
  const token = mailbox.data.find((m) => m.kind === 'email_verification')!.token!;
  expect((await api('POST', '/auth/email/verify', { body: { token } })).res.status).toBe(204);
  const login = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  expect(login.res.status).toBe(200);
  return { email, token: login.body!.accessToken as string, login };
}

describe('unified backend (one process)', () => {
  let backend: Running;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const main = path.join(APP_DIR, 'dist/main.js');
    if (!existsSync(main)) throw new Error(`${main} is missing: the database suites build it in pretest:db`);
    backend = launch(environment());
    await waitReady(backend);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    if (backend?.child.exitCode === null) {
      backend.child.kill('SIGKILL');
      await backend.exited;
    }
  });

  it('is one process: the public port, plus the six internal ports on loopback only', async () => {
    const names = execFileSync('lsof', ['-nP', '-a', '-p', String(backend.child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1));
    expect([...new Set(names)].sort()).toEqual(
      Object.values(PORTS)
        .map((port) => `127.0.0.1:${port}`)
        .sort(),
    );
    for (const route of ['/health/live', '/health/ready']) expect((await fetch(`${PUBLIC}${route}`)).status).toBe(200);
    for (const port of Object.values(PORTS))
      expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(200);
  });

  it('serves the public REST API as the gateway does: auth flows, refresh cookie, problems, CORS, rate limits', async () => {
    const { token, login } = await person();
    const cookie = login.res.headers.get('set-cookie') ?? '';
    for (const attribute of ['Path=/api/v1/auth', 'HttpOnly', 'Secure', 'SameSite=Strict'])
      expect(cookie).toContain(attribute);
    expect(login.res.headers.get('ratelimit-limit')).not.toBeNull();
    expect(login.res.headers.get('x-request-id')).toMatch(/\S{8,}/);

    const me = await api('GET', '/auth/me', { token });
    expect(me.res.status).toBe(200);
    const anonymous = await api('GET', '/auth/me');
    expect(anonymous.res.status).toBe(401);
    expect(anonymous.res.headers.get('content-type')).toContain('application/problem+json');
    expect((await api('GET', '/no-such-route')).res.status).toBe(404);

    const preflight = (origin: string) =>
      fetch(`${PUBLIC}/api/v1/auth/login`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
    expect((await preflight(ORIGIN)).headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect((await preflight('http://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  // Filled by the next test and used by the Socket.IO test.
  const world = { orgId: '', workspaceId: '', channelId: '', token: '' };

  it('keeps the internal HTTP calls and their authorization: organization → identity, workspace → organization, messaging → workspace', async () => {
    const owner = await person(founder);
    const org = await api('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Unified Org', slug: `unified-${runId}` },
    });
    expect(org.res.status).toBe(201);
    const orgId = org.body!.id as string;
    const workspace = await api('POST', `/orgs/${orgId}/workspaces`, {
      token: owner.token,
      body: { name: 'Ops', slug: `ops-${runId}`, visibility: 'open' },
    });
    expect(workspace.res.status).toBe(201);
    const workspaceId = workspace.body!.id as string;
    const channels = await api('GET', `/orgs/${orgId}/workspaces/${workspaceId}/channels`, { token: owner.token });
    const general = (channels.body!.data as { id: string; name: string }[]).find((c) => c.name === 'general')!;
    const posted = await api('POST', `/orgs/${orgId}/workspaces/${workspaceId}/channels/${general.id}/messages`, {
      token: owner.token,
      body: { body: 'hello from one process' },
    });
    expect(posted.res.status).toBe(201);

    // Someone who is not a member sees nothing (404, never 403), through every service.
    const outsider = await person();
    expect((await api('GET', `/orgs/${orgId}`, { token: outsider.token })).res.status).toBe(404);
    expect((await api('GET', `/orgs/${orgId}/workspaces`, { token: outsider.token })).res.status).toBe(404);
    expect(
      (
        await api('GET', `/orgs/${orgId}/workspaces/${workspaceId}/channels/${general.id}/messages`, {
          token: outsider.token,
        })
      ).res.status,
    ).toBe(404);
    Object.assign(world, { orgId, workspaceId, channelId: general.id, token: owner.token });
  });

  it('serves Socket.IO on the public port: authenticated, origin-checked, and fed by Redis from messaging', async () => {
    const socketTo = (options: { token?: string; origin?: string }) => {
      const socket = connectClient(PUBLIC, {
        path: '/realtime/socket.io',
        transports: ['websocket'],
        reconnection: false,
        auth: options.token ? { token: options.token } : {},
        extraHeaders: options.origin ? { origin: options.origin } : undefined,
      });
      sockets.push(socket);
      return socket;
    };
    const outcome = (socket: Socket) =>
      new Promise<string>((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connect_error', (error) => resolve(`error:${error.message}`));
      });

    expect(await outcome(socketTo({}))).toBe('error:unauthenticated');
    expect(await outcome(socketTo({ token: world.token, origin: 'http://evil.example' }))).toMatch(/^error:/);

    const socket = socketTo({ token: world.token, origin: ORIGIN });
    expect(await outcome(socket)).toBe('connected');
    const ack = (await socket.emitWithAck('subscribe', {
      organizationId: world.orgId,
      workspaceId: world.workspaceId,
      channelId: world.channelId,
    })) as { ok: boolean };
    expect(ack).toEqual({ ok: true });

    const changed = new Promise<{ type: string; messageId: string }>((resolve) =>
      socket.once('message.changed', resolve),
    );
    const posted = await api(
      'POST',
      `/orgs/${world.orgId}/workspaces/${world.workspaceId}/channels/${world.channelId}/messages`,
      { token: world.token, body: { body: 'live through the public port' } },
    );
    expect(posted.res.status).toBe(201);
    expect(await changed).toMatchObject({ type: 'created', messageId: posted.body!.id });
  });

  it('refuses a second backend on the same ports: exit 1, nothing started, the first one untouched', async () => {
    const second = launch(environment());
    expect(await second.exited).toBe(1);
    expect(second.output()).toContain('ports already in use');
    expect((await fetch(`${PUBLIC}/health/ready`)).status).toBe(200);
  });

  it('rejects a bad configuration before opening any port, naming the variable but not its value', async () => {
    const offset = 10; // 3330-3336
    const bad = launch(
      environment({
        PORT: String(PORTS.public + offset),
        IDENTITY_INTERNAL_PORT: String(PORTS.identity + offset),
        ORGANIZATION_INTERNAL_PORT: String(PORTS.organization + offset),
        WORKSPACE_INTERNAL_PORT: String(PORTS.workspace + offset),
        MESSAGING_INTERNAL_PORT: String(PORTS.messaging + offset),
        REALTIME_INTERNAL_PORT: String(PORTS.realtime + offset),
        FILES_INTERNAL_PORT: String(PORTS.files + offset),
        IDENTITY_SERVICE_URL: 'https://public.example.com',
      }),
    );
    expect(await bad.exited).toBe(1);
    expect(bad.output()).toContain('IDENTITY_SERVICE_URL must not be set');
    expect(bad.output()).not.toContain('public.example.com');
    for (const port of Object.values(PORTS)) expect(await listening(port + offset)).toBe(false);
  });

  it('never writes a credential to its logs', () => {
    const output = backend.output();
    expect(output).toContain('"event":"backend_started"');
    const secrets = [
      privateJwk.d!,
      ...SERVICES.map((svc) => decodeURIComponent(new URL(appUrl(svc)).password)),
      parseEnvFile(path.join(REPO, '.env')).REDIS_PASSWORD as string,
    ].filter(Boolean);
    expect(secrets.length).toBeGreaterThanOrEqual(SERVICES.length + 1);
    for (const secret of secrets) expect(output.includes(secret)).toBe(false);
  });

  it('shuts down on SIGTERM, consumers before the services they call, and exits 0 with every port released', async () => {
    backend.child.kill('SIGTERM');
    expect(await backend.exited).toBe(0);
    const stopped = backend
      .output()
      .split('\n')
      .filter((line) => line.includes('"backend_stopped"'))
      .map((line) => JSON.parse(line) as { message: { closed: string[]; failed: unknown[] } })[0]!;
    expect(stopped.message.failed).toEqual([]);
    expect(stopped.message.closed.slice(0, 2).sort()).toEqual(['gateway', 'realtime']);
    expect(stopped.message.closed.slice(2)).toEqual(['messaging', 'files', 'workspace', 'organization', 'identity']);
    for (const port of Object.values(PORTS)) expect(await listening(port)).toBe(false);
  });
});
