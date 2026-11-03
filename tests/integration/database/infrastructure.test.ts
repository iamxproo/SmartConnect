// Local infrastructure checks. READ-ONLY against the dev instance (no writes, no restarts).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_SQL,
  REPO_ROOT,
  SERVICES,
  loadTargets,
  parseEnvFile,
  runSql,
  serviceDir,
} from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { query } from '../../support/database.js';

const dev = loadTargets().dev;
const rootEnv = parseEnvFile(path.join(REPO_ROOT, '.env'));

function docker(...args: string[]): string {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`docker ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// --- minimal RESP client: exercises the real TCP path a service would use ----------------------
type Reply = { value: string; length: number };
function parseReply(buf: string): Reply | null {
  const end = buf.indexOf('\r\n');
  if (end < 0) return null;
  const type = buf[0];
  const line = buf.slice(1, end);
  if (type === '+' || type === ':') return { value: line, length: end + 2 };
  if (type === '-') return { value: `ERR ${line}`, length: end + 2 };
  if (type === '$') {
    const n = Number(line);
    if (n < 0) return { value: '(nil)', length: end + 2 };
    if (buf.length < end + 4 + n) return null;
    return { value: buf.slice(end + 2, end + 2 + n), length: end + 4 + n };
  }
  if (type === '*') {
    let offset = end + 2;
    const parts: string[] = [];
    for (let i = 0; i < Number(line); i++) {
      const part = parseReply(buf.slice(offset));
      if (!part) return null;
      parts.push(part.value);
      offset += part.length;
    }
    return { value: parts.join(' '), length: offset };
  }
  throw new Error(`unexpected RESP reply type ${type}`);
}

function redis(commands: string[][]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(rootEnv.REDIS_PORT ?? 6379), '127.0.0.1');
    const replies: string[] = [];
    let buffer = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('redis timeout')));
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        commands
          .map((c) => `*${c.length}\r\n${c.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`)
          .join(''),
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let reply = parseReply(buffer); reply; reply = parseReply(buffer)) {
        replies.push(reply.value);
        buffer = buffer.slice(reply.length);
      }
      if (replies.length >= commands.length) {
        socket.end();
        resolve(replies);
      }
    });
  });
}

describe('PostgreSQL development instance (read-only)', () => {
  it('accepts a TCP connection from a least-privilege runtime role and runs PostgreSQL 16', async () => {
    const url = parseEnvFile(path.join(serviceDir('identity'), '.env')).DATABASE_URL;
    expect(url, 'run `make db-bootstrap` to provision service credentials').toBeTruthy();
    const [row] = await query<{ version: string; db: string; usr: string; sp: string }>(
      url!,
      "select version() as version, current_database() as db, current_user as usr, current_setting('search_path') as sp",
    );
    expect(row!.version).toMatch(/^PostgreSQL 16\./);
    expect(row!.version).toMatch(/aarch64|arm64/); // the container, not a host-native server
    expect(row!.db).toBe(dev.database);
    expect(row!.usr).toBe('sc_identity_app');
    expect(row!.sp).toBe('identity');
  });

  it('never writes bind parameters (token hashes, emails, message bodies) into logs', () => {
    expect(
      runSql(
        dev,
        "select current_setting('log_parameter_max_length') || ',' || current_setting('log_parameter_max_length_on_error')",
      ),
    ).toBe('0,0');
  });

  it('contains the smartconnect database with all 14 service schemas, each owned by its migrator', () => {
    const rows = runSql(
      dev,
      `select nspname || '=' || pg_get_userbyid(nspowner) from pg_namespace
                              where nspname = any(string_to_array('${SERVICES.join(',')}', ',')) order by 1`,
    ).split('\n');
    expect(rows).toEqual([...SERVICES].sort().map((s) => `${s}=sc_${s}_migrator`));
  });

  it('has every service migration applied successfully', () => {
    for (const svc of SERVICES) {
      const dirs = readdirMigrations(svc);
      const applied = runSql(
        dev,
        `select count(*) filter (where finished_at is not null and rolled_back_at is null)
                                   || '/' || count(*) from ${svc}._prisma_migrations`,
      );
      expect(applied, svc).toBe(`${dirs.length}/${dirs.length}`);
    }
  });
});

function readdirMigrations(svc: string): string[] {
  const dir = path.join(serviceDir(svc), 'prisma/migrations');
  return existsSync(dir)
    ? spawnSync('ls', [dir], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((d) => /^\d{14}_/.test(d))
    : [];
}

describe('Redis', () => {
  it('rejects unauthenticated clients and accepts the configured password', async () => {
    const [noAuth, auth, ping] = await redis([['PING'], ['AUTH', rootEnv.REDIS_PASSWORD!], ['PING']]);
    expect(noAuth).toMatch(/^ERR NOAUTH/);
    expect(auth).toBe('OK');
    expect(ping).toBe('PONG');
  });

  it('persists with AOF and is memory-bounded', async () => {
    const replies = await redis([
      ['AUTH', rootEnv.REDIS_PASSWORD!],
      ['CONFIG', 'GET', 'appendonly'],
      ['CONFIG', 'GET', 'appendfsync'],
      ['CONFIG', 'GET', 'maxmemory'],
      ['CONFIG', 'GET', 'maxmemory-policy'],
    ]);
    expect(replies.slice(1)).toEqual([
      'appendonly yes',
      'appendfsync everysec',
      'maxmemory 268435456',
      'maxmemory-policy volatile-lru',
    ]);
  });

  it('runs as the unprivileged redis user', () => {
    expect(
      docker('exec', 'smartconnect-redis', 'sh', '-c', 'ps -o user,args | grep "[r]edis-server" | cut -d" " -f1'),
    ).toBe('redis');
  });
});

describe('Docker Compose', () => {
  it.each(['smartconnect-postgres', 'smartconnect-redis'])('%s health check reports healthy', (container) => {
    expect(docker('inspect', '-f', '{{.State.Health.Status}}', container)).toBe('healthy');
  });

  it.each(['smartconnect-postgres', 'smartconnect-redis', 'smartconnect-postgres-test'])(
    '%s publishes ports on loopback only',
    (container) => {
      const bindings = JSON.parse(docker('inspect', '-f', '{{json .HostConfig.PortBindings}}', container)) as Record<
        string,
        { HostIp: string }[]
      >;
      const hostIps = Object.values(bindings)
        .flat()
        .map((b) => b.HostIp);
      expect(hostIps.length).toBeGreaterThan(0);
      expect(new Set(hostIps)).toEqual(new Set(['127.0.0.1']));
    },
  );

  it.each(['smartconnect-postgres', 'smartconnect-redis'])(
    '%s exposes no secrets through docker inspect',
    (container) => {
      const config = docker(
        'inspect',
        '-f',
        '{{json .Config.Env}}{{json .Config.Cmd}}{{json .Config.Entrypoint}}',
        container,
      );
      for (const secret of [rootEnv.POSTGRES_PASSWORD!, rootEnv.REDIS_PASSWORD!]) expect(config).not.toContain(secret);
    },
  );
});

describe('single source of truth for the service list', () => {
  it('bootstrap SQL, tooling and backend services agree', () => {
    const sql = readFileSync(BOOTSTRAP_SQL, 'utf8');
    const block = sql.match(/services CONSTANT text\[\] := ARRAY\[([^\]]+)\]/)![1]!;
    const fromSql = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const withSchemas = SERVICES.filter((svc: string) =>
      existsSync(path.join(serviceDir(svc), 'prisma/schema.prisma')),
    );
    expect(fromSql).toEqual([...SERVICES]);
    expect(withSchemas).toEqual([...SERVICES]);
  });
});
