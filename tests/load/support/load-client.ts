// Load-test support for the 30-user test (tests/load/thirty-users.spec.ts): an API + Socket.IO client per simulated
// user, the request/delivery metrics, and a read-only resource sampler (RSS/CPU and macOS footprint of the backend
// process, its PostgreSQL and Redis connections, PostgreSQL sessions per role). Every client talks to the public port
// with its own client address (X-Forwarded-For, trusted by the test gateway), so per-IP rate limits apply as for
// separate people. Sockets behave like the web app's realtime client (smartconnect-frontend/web/src/lib/realtime.ts):
// when the gateway evicts a room because it could not re-check access, they resubscribe with the same backoff and
// catch up from history.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { io, type Socket } from 'socket.io-client';
import { PASSWORD, verificationToken } from '../../e2e/support/fixtures.js';
import { PORTS, WEB_URL } from '../../e2e/support/stack.js';

const run = promisify(execFile);
export const PUBLIC = `http://127.0.0.1:${PORTS.gateway}`;
export const UNIFIED = process.env.E2E_BACKEND === 'unified';
/** Socket.IO: the public port on the unified backend; the realtime gateway's own port in the seven-process stack. */
const REALTIME = UNIFIED ? PUBLIC : `http://127.0.0.1:${PORTS.realtime}`;
/** The web app's resubscribe backoff (lib/realtime.ts RETRY_MS). */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export type Room = 'channel' | 'inbox';
export interface Eviction {
  room: Room;
  from: number;
  /** When the resubscription succeeded; undefined while it has not. */
  to?: number;
  /** The catch-up after the resubscription has run. */
  checked?: boolean;
}

export interface Sample {
  category: string;
  status: number;
  ms: number;
  expected: boolean;
}

/** Every response and realtime delivery the test observed. */
export class Metrics {
  readonly samples: Sample[] = [];
  readonly unexpected: string[] = [];
  readonly deliveries: { kind: string; ms: number }[] = [];
  readonly missed: string[] = [];
  socketConnects = 0;
  socketFailures: string[] = [];
  reconnects = 0;
  reconnectFailures: string[] = [];
  /** Recipients that dropped their connection on purpose after a message was sent (they catch up from history). */
  excused = 0;
  /** Recipients whose room was evicted around the message (they resubscribe and catch up from history). */
  excusedEvicted = 0;
  evictions: Record<Room, number> = { channel: 0, inbox: 0 };
  resubscribeRefusals = 0;
  catchUpChecked = 0;
  recoveryFailures: string[] = [];
  fileChecks = 0;
  fileFailures: string[] = [];

  record(category: string, status: number, ms: number, expected: boolean, detail: string): void {
    this.samples.push({ category, status, ms, expected });
    if (!expected) this.unexpected.push(`${category} ${status} ${detail}`);
  }

  summary() {
    const by = new Map<string, Sample[]>();
    for (const s of this.samples) by.set(s.category, [...(by.get(s.category) ?? []), s]);
    const stats = (list: { ms: number }[]) => {
      const ms = list.map((s) => s.ms).sort((a, b) => a - b);
      const at = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)]! : 0);
      return { count: ms.length, p50: at(50), p95: at(95), p99: at(99), max: ms.at(-1) ?? 0 };
    };
    const statusClass = (lo: number, hi: number) => this.samples.filter((s) => s.status >= lo && s.status < hi).length;
    return {
      requests: this.samples.length,
      expectedResponses: this.samples.filter((s) => s.expected).length,
      unexpectedResponses: this.unexpected.length,
      status2xx: statusClass(200, 300),
      status4xx: statusClass(400, 500),
      status4xxExpected: this.samples.filter((s) => s.status >= 400 && s.status < 500 && s.expected).length,
      status5xx: statusClass(500, 600),
      networkErrors: this.samples.filter((s) => s.status === 0).length,
      latencyMs: stats(this.samples),
      latencyByCategoryMs: Object.fromEntries([...by.entries()].sort().map(([c, list]) => [c, stats(list)])),
      deliveries: {
        expected: this.deliveries.length + this.missed.length,
        delivered: this.deliveries.length,
        missed: this.missed.length,
        excusedOffline: this.excused,
        excusedEvicted: this.excusedEvicted,
        latencyMs: stats(this.deliveries),
        latencyByKindMs: Object.fromEntries(
          [...new Set(this.deliveries.map((d) => d.kind))]
            .sort()
            .map((k) => [k, stats(this.deliveries.filter((d) => d.kind === k))]),
        ),
      },
      sockets: {
        connects: this.socketConnects,
        failures: this.socketFailures.length,
        reconnects: this.reconnects,
        reconnectFailures: this.reconnectFailures.length,
        catchUpMessagesChecked: this.catchUpChecked,
        evictions: this.evictions,
        resubscribeRefusals: this.resubscribeRefusals,
        recoveryFailures: this.recoveryFailures.length,
      },
      files: { verified: this.fileChecks, failures: this.fileFailures.length },
    };
  }
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Mean pause between a user's actions (LOAD_THINK_MS; default 375 ms, a stress pace), uniformly 0.4-1.6 x the mean. */
export const THINK_MS = Number(process.env.LOAD_THINK_MS ?? 375);
export const think = () => sleep(THINK_MS * (0.4 + Math.random() * 1.2));

interface CallOptions {
  body?: unknown;
  raw?: Uint8Array;
  token?: string | null;
  /** Statuses that are correct for this call; anything else is recorded as unexpected. */
  expect?: number[];
  category: string;
}

/** One simulated user: API calls through the public gateway and a Socket.IO connection through the same port. */
export class ApiUser {
  id = '';
  accessToken = '';
  refreshToken = '';
  socket: Socket | undefined;
  online = false;
  /** Message ids this user's socket has seen created, with the time they arrived. */
  readonly seen = new Map<string, number>();
  readonly evictions: Eviction[] = [];
  /** Called once an evicted room is subscribed again, to catch up from history as the web app does. */
  onRecovered: ((eviction: Eviction) => Promise<void>) | undefined;
  private channel: { organizationId: string; workspaceId: string; channelId: string } | undefined;

  constructor(
    readonly label: string,
    readonly email: string,
    readonly address: string,
    private readonly metrics: Metrics,
  ) {}

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: CallOptions,
  ): Promise<{ status: number; body: T; bytes?: Uint8Array }> {
    const expected = options.expect ?? [200, 201, 202, 204];
    const token = options.token === undefined ? this.accessToken : options.token;
    const headers: Record<string, string> = { 'x-forwarded-for': this.address, origin: WEB_URL };
    if (token) headers.authorization = `Bearer ${token}`;
    let body: Uint8Array | string | undefined;
    if (options.raw) {
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = String(options.raw.byteLength);
      body = options.raw;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const started = performance.now();
    let status = 0;
    let parsed: unknown;
    let bytes: Uint8Array | undefined;
    try {
      const res = await fetch(`${PUBLIC}/api/v1${path}`, { method, headers, body });
      status = res.status;
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('json')) parsed = await res.json();
      else bytes = new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      parsed = { networkError: (error as Error).message };
    }
    const ms = performance.now() - started;
    this.metrics.record(options.category, status, ms, expected.includes(status), `${method} ${path} (${this.label})`);
    return { status, body: (parsed ?? {}) as T, bytes };
  }

  /** Register through the public gateway, verify through identity's dev mailbox, log in as a native client. */
  async signUp(displayName: string): Promise<void> {
    await this.call('POST', '/auth/register', {
      token: null,
      category: 'auth_register',
      expect: [202],
      body: { email: this.email, password: PASSWORD, displayName },
    });
    const token = await verificationToken(this.email);
    await this.call('POST', '/auth/email/verify', {
      token: null,
      category: 'auth_verify',
      expect: [204],
      body: { token },
    });
    const login = await this.call<{ accessToken: string; refreshToken: string }>('POST', '/auth/login', {
      token: null,
      category: 'auth_login',
      expect: [200],
      body: { email: this.email, password: PASSWORD, tokenDelivery: 'body' },
    });
    this.accessToken = login.body.accessToken;
    this.refreshToken = login.body.refreshToken;
    const me = await this.call<{ id: string }>('GET', '/auth/me', { category: 'auth_me', expect: [200] });
    this.id = me.body.id;
  }

  async refresh(): Promise<void> {
    const res = await this.call<{ accessToken: string; refreshToken: string }>('POST', '/auth/refresh', {
      token: null,
      category: 'auth_refresh',
      expect: [200],
      body: { refreshToken: this.refreshToken },
    });
    if (res.status === 200) {
      this.accessToken = res.body.accessToken;
      this.refreshToken = res.body.refreshToken;
    }
  }

  /** Connects (or reconnects) and subscribes to one channel and the organization inbox. */
  async connect(channel: { organizationId: string; workspaceId: string; channelId: string }): Promise<boolean> {
    this.channel = channel;
    if (!this.socket) {
      this.socket = io(REALTIME, {
        path: '/realtime/socket.io',
        transports: ['websocket'],
        reconnection: false,
        auth: { token: this.accessToken },
        extraHeaders: { origin: WEB_URL },
      });
      this.socket.on('message.changed', (e: { type: string; messageId: string }) => {
        if (e.type === 'created' && !this.seen.has(e.messageId)) this.seen.set(e.messageId, Date.now());
      });
      this.socket.on('conversation.changed', (e: { change: string; messageId: string | null }) => {
        if (e.change === 'message.created' && e.messageId && !this.seen.has(e.messageId))
          this.seen.set(e.messageId, Date.now());
      });
      this.socket.on('unsubscribed', () => this.evicted('channel'));
      this.socket.on('inbox.unsubscribed', () => this.evicted('inbox'));
    } else {
      this.socket.auth = { token: this.accessToken };
      this.socket.connect();
    }
    const socket = this.socket;
    const connected = await new Promise<string>((resolve) => {
      if (socket.connected) return resolve('ok');
      socket.once('connect', () => resolve('ok'));
      socket.once('connect_error', (error) => resolve(error.message));
    });
    if (connected !== 'ok') {
      this.metrics.socketFailures.push(`${this.label}: ${connected}`);
      return false;
    }
    const acks = await Promise.all([
      socket.timeout(10_000).emitWithAck('subscribe', channel),
      socket.timeout(10_000).emitWithAck('inbox.subscribe', { organizationId: channel.organizationId }),
    ]).catch((error: unknown) => [{ ok: false, error: String(error) }]);
    const ok = (acks as { ok: boolean }[]).every((a) => a.ok);
    if (!ok) this.metrics.socketFailures.push(`${this.label}: subscribe ${JSON.stringify(acks)}`);
    else this.metrics.socketConnects += 1;
    this.online = ok;
    // A (re)connect subscribes every room again, which also ends any eviction still waiting for its retry.
    if (ok)
      for (const eviction of this.evictions.filter((e) => e.to === undefined)) {
        eviction.to = Date.now();
        await Promise.resolve(this.onRecovered?.(eviction)).finally(() => (eviction.checked = true));
      }
    return ok;
  }

  disconnect(): void {
    this.online = false;
    this.socket?.disconnect();
  }

  /** Whether this user's `room` was evicted at any time in [from, to]. */
  evictedDuring(room: Room, from: number, to: number): boolean {
    return this.evictions.some((e) => e.room === room && e.from <= to && (e.to ?? Infinity) >= from);
  }

  private evicted(room: Room): void {
    const eviction: Eviction = { room, from: Date.now() };
    this.evictions.push(eviction);
    this.metrics.evictions[room] += 1;
    const join = room === 'channel' ? 'subscribe' : 'inbox.subscribe';
    const payload = room === 'channel' ? this.channel : { organizationId: this.channel?.organizationId };
    const attempt = (failures: number) =>
      setTimeout(
        () => {
          const socket = this.socket;
          if (!socket?.connected || eviction.to !== undefined) return; // a reconnect subscribed again
          void socket
            .timeout(10_000)
            .emitWithAck(join, payload)
            .then((ack: { ok: boolean }) => (ack.ok ? undefined : Promise.reject(new Error('refused'))))
            .then(
              () => {
                eviction.to = Date.now();
                return Promise.resolve(this.onRecovered?.(eviction)).finally(() => {
                  eviction.checked = true;
                });
              },
              () => {
                this.metrics.resubscribeRefusals += 1;
                attempt(failures + 1);
              },
            );
        },
        RETRY_MS[Math.min(failures, RETRY_MS.length - 1)],
      );
    attempt(0);
  }
}

/**
 * Waits until every expected recipient's socket has seen the message and records each delivery's latency from
 * `sentAt`. A recipient still waiting after `timeoutMs` is a miss, unless it dropped its connection on purpose after
 * the message was sent (`offline`: since when) or the gateway evicted the message's room around it; both catch up
 * from history instead, which the test checks.
 */
export async function expectDelivery(
  metrics: Metrics,
  kind: string,
  room: Room,
  messageId: string,
  sentAt: number,
  recipients: ApiUser[],
  offline: Map<ApiUser, number>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(recipients);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const r of pending)
      if (r.seen.has(messageId)) {
        metrics.deliveries.push({ kind, ms: r.seen.get(messageId)! - sentAt });
        pending.delete(r);
      } else if ((offline.get(r) ?? -1) >= sentAt) {
        metrics.excused += 1;
        pending.delete(r);
      }
    if (pending.size > 0) await sleep(25);
  }
  for (const r of pending)
    if (r.evictedDuring(room, sentAt, Date.now())) metrics.excusedEvicted += 1;
    else metrics.missed.push(`${kind} ${messageId} -> ${r.label}`);
}

/**
 * Read-only resource sampling of the backend: the unified process, or the sum of the seven processes. RSS and CPU
 * (ps), their TCP connections by peer (lsof: Redis :6379, PostgreSQL :15433, inbound on the public port) and
 * PostgreSQL sessions per role (pg_stat_activity on the test instance, which serves only this stack while the
 * test-database lock is held).
 */
export class ResourceSampler {
  readonly samples: {
    t: number;
    phase: string;
    rssMb: number;
    cpu: number;
    pg: Record<string, number>;
    tcp: { redis: number; postgres: number; inbound: number };
    load: number;
  }[] = [];
  readonly footprints: { label: string; mb: number }[] = [];
  private timer: NodeJS.Timeout | undefined;
  private phase = 'setup';
  pids: number[] = [];

  private async sh(cmd: string, args: string[]): Promise<string> {
    try {
      return (await run(cmd, args, { timeout: 15_000 })).stdout;
    } catch (error) {
      return (error as { stdout?: string }).stdout ?? '';
    }
  }

  private async tick(): Promise<void> {
    const [ps, pg, tcp, load] = await Promise.all([
      this.sh('ps', ['-o', 'rss=,%cpu=', '-p', this.pids.join(',')]),
      this.sh('docker', [
        'exec',
        'smartconnect-postgres-test',
        'sh',
        '-c',
        `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -F, -c "select usename, count(*) from pg_stat_activity where usename like 'sc_%' group by 1"`,
      ]),
      this.sh('lsof', ['-nP', '-a', '-p', this.pids.join(','), '-iTCP', '-sTCP:ESTABLISHED']),
      this.sh('sysctl', ['-n', 'vm.loadavg']),
    ]);
    const rows = ps
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number));
    const rss = rows.reduce((a, r) => a + (r[0] ?? 0), 0);
    const cpu = +rows.reduce((a, r) => a + (r[1] ?? 0), 0).toFixed(1);
    const peers = tcp
      .split('\n')
      .map((l) => /(\S+)->(\S+) \(ESTABLISHED\)/.exec(l))
      .filter((m) => m !== null);
    this.samples.push({
      t: Date.now(),
      phase: this.phase,
      rssMb: Math.round(rss / 1024),
      cpu,
      pg: Object.fromEntries(
        pg
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split(','))
          .map(([role, n]) => [role!, Number(n)]),
      ),
      tcp: {
        redis: peers.filter((m) => m[2]!.endsWith(':6379')).length,
        postgres: peers.filter((m) => m[2]!.endsWith(':15433')).length,
        inbound: peers.filter((m) => m[1]!.endsWith(`:${PORTS.gateway}`)).length,
      },
      load: Number(load.replace(/[{}]/g, '').trim().split(/\s+/)[0]),
    });
  }

  async start(): Promise<void> {
    const listeners = await Promise.all(
      Object.values(PORTS).map((port) => this.sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])),
    );
    this.pids = [...new Set(listeners.flatMap((out) => out.split('\n').filter(Boolean).map(Number)))].sort();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 2_000);
  }

  /** Labels the samples that follow (setup, concurrent, ...). */
  mark(phase: string): void {
    this.phase = phase;
  }

  /** macOS footprint (physical memory charged to the process, incl. compressed), at a labelled point. */
  async footprint(label: string): Promise<void> {
    const unit = { KB: 1 / 1024, MB: 1, GB: 1024 } as const;
    const each = await Promise.all(
      this.pids.map(async (pid) => {
        const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(await this.sh('footprint', ['-p', String(pid)]));
        return m ? Number(m[1]) * unit[m[2] as keyof typeof unit] : NaN;
      }),
    );
    if (each.every(Number.isFinite)) this.footprints.push({ label, mb: Math.round(each.reduce((a, b) => a + b, 0)) });
  }

  stop() {
    clearInterval(this.timer);
    const peak = <T>(list: T[], f: (s: T) => number) => (list.length ? Math.max(...list.map(f)) : 0);
    const byPhase = (phase: string) => this.samples.filter((s) => s.phase === phase);
    const pgTotal = (s: (typeof this.samples)[number]) => Object.values(s.pg).reduce((a, b) => a + b, 0);
    const roles = [...new Set(this.samples.flatMap((s) => Object.keys(s.pg)))].sort();
    const phases = [...new Set(this.samples.map((s) => s.phase))];
    return {
      pids: this.pids,
      samples: this.samples.length,
      rssMb: {
        first: this.samples[0]?.rssMb,
        peak: peak(this.samples, (s) => s.rssMb),
        last: this.samples.at(-1)?.rssMb,
      },
      footprintMb: this.footprints,
      perPhase: Object.fromEntries(
        phases.map((phase) => {
          const list = byPhase(phase);
          return [
            phase,
            {
              samples: list.length,
              cpuPercentPeak: peak(list, (s) => s.cpu),
              cpuPercentMean: +(list.reduce((a, s) => a + s.cpu, 0) / Math.max(1, list.length)).toFixed(1),
              rssMbPeak: peak(list, (s) => s.rssMb),
              pgSessionsPeak: peak(list, pgTotal),
              backendTcpPeak: {
                postgres: peak(list, (s) => s.tcp.postgres),
                redis: peak(list, (s) => s.tcp.redis),
                inbound: peak(list, (s) => s.tcp.inbound),
              },
              loadAveragePeak: peak(list, (s) => s.load),
            },
          ];
        }),
      ),
      pgSessionsPeakByRole: Object.fromEntries(roles.map((r) => [r, peak(this.samples, (s) => s.pg[r] ?? 0)])),
    };
  }
}
