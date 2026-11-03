// startBackend() with fake applications (real HTTP servers answering /health/ready): start order, readiness gating
// of the public listener, clean-up of a partial start, ordered and idempotent shutdown, the shutdown deadline.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { START_ORDER, type AppName } from '../src/apps.js';
import { startBackend, type BackendPlan } from '../src/backend.js';
import type { RunningApp, Starter } from '../src/compose.js';

const plan = { configs: {}, internalPorts: {}, ports: [], logLevel: 'fatal' } as unknown as BackendPlan;
const open = new Set<http.Server>();
afterEach(async () => {
  await Promise.all([...open].map((s) => new Promise((resolve) => s.close(resolve))));
  open.clear();
});

interface FakeOptions {
  /** Readiness answers 503 for this long after listening. */
  readyAfterMs?: number;
  neverReady?: boolean;
  failStart?: boolean;
  closeHangs?: boolean;
}

function fakes(events: string[], options: Partial<Record<AppName, FakeOptions>> = {}): Record<AppName, Starter> {
  const starter =
    (name: AppName): Starter =>
    async () => {
      const o = options[name] ?? {};
      events.push(`start:${name}`);
      if (o.failStart) throw new Error(`${name} could not start`);
      const since = Date.now();
      const server = http.createServer((req, res) => {
        const ready = !o.neverReady && Date.now() - since >= (o.readyAfterMs ?? 0);
        if (ready && !events.includes(`ready:${name}`)) events.push(`ready:${name}`);
        res.statusCode = req.url === '/health/ready' && ready ? 200 : 503;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      open.add(server);
      const port = (server.address() as AddressInfo).port;
      const app: RunningApp = {
        name,
        host: '127.0.0.1',
        port,
        url: `http://127.0.0.1:${port}`,
        server,
        async close() {
          events.push(`close:${name}`);
          if (o.closeHangs) return new Promise(() => undefined);
          await new Promise((resolve) => server.close(resolve));
          open.delete(server);
        },
      };
      return app;
    };
  return Object.fromEntries(START_ORDER.map((name) => [name, starter(name)])) as Record<AppName, Starter>;
}

describe('startBackend', () => {
  it('starts in dependency order, each only once the previous one is ready, and the public gateway last', async () => {
    const events: string[] = [];
    const backend = await startBackend(plan, {
      starters: fakes(events, { identity: { readyAfterMs: 150 }, realtime: { readyAfterMs: 150 } }),
    });
    const starts = events.filter((e) => e.startsWith('start:')).map((e) => e.slice(6));
    expect(starts).toEqual([...START_ORDER]);
    for (const [i, name] of START_ORDER.entries()) {
      if (i === 0) continue;
      const previous = START_ORDER[i - 1]!;
      expect(events.indexOf(`start:${name}`), `${name} after ${previous} is ready`).toBeGreaterThan(
        events.indexOf(`ready:${previous}`),
      );
    }
    // D6: the public listener opens only after every internal application is ready.
    for (const name of START_ORDER.filter((n) => n !== 'gateway'))
      expect(events.indexOf('start:gateway')).toBeGreaterThan(events.indexOf(`ready:${name}`));
    expect(backend.publicUrl).toBe(backend.apps.find((a) => a.name === 'gateway')!.url);
    await backend.close();
  });

  it('closes exactly what it started, in shutdown order, when a start fails part-way, and rethrows', async () => {
    const events: string[] = [];
    await expect(startBackend(plan, { starters: fakes(events, { files: { failStart: true } }) })).rejects.toThrow(
      'files could not start',
    );
    expect(events.filter((e) => e.startsWith('close:'))).toEqual([
      'close:workspace',
      'close:organization',
      'close:identity',
    ]);
    expect(events).not.toContain('start:messaging');
    expect(events).not.toContain('start:gateway');
    expect(open.size).toBe(0);
  });

  it('fails the start when an application never becomes ready, and closes that one too', async () => {
    const events: string[] = [];
    await expect(
      startBackend(plan, { readyTimeoutMs: 300, starters: fakes(events, { messaging: { neverReady: true } }) }),
    ).rejects.toThrow(/not ready/);
    expect(events.filter((e) => e.startsWith('close:'))).toEqual([
      'close:messaging',
      'close:files',
      'close:workspace',
      'close:organization',
      'close:identity',
    ]);
    expect(events).not.toContain('start:realtime');
    expect(open.size).toBe(0);
  });

  it('shuts down group by group (gateway and realtime first, identity last), once, however often it is asked', async () => {
    const events: string[] = [];
    const backend = await startBackend(plan, { starters: fakes(events) });
    const first = backend.close();
    const second = backend.close();
    expect(second).toBe(first);
    const result = await first;
    expect(result.timedOut).toBe(false);
    expect(result.failed).toEqual([]);
    const closes = events.filter((e) => e.startsWith('close:')).map((e) => e.slice(6));
    expect(closes.slice(0, 2).sort()).toEqual(['gateway', 'realtime']);
    expect(closes.slice(2)).toEqual(['messaging', 'files', 'workspace', 'organization', 'identity']);
    expect(await backend.close()).toBe(result);
    expect(open.size).toBe(0);
  });

  it('reports a shutdown that does not finish within its deadline', async () => {
    const backend = await startBackend(plan, {
      shutdownTimeoutMs: 200,
      starters: fakes([], { workspace: { closeHangs: true } }),
    });
    expect((await backend.close()).timedOut).toBe(true);
  });
});
