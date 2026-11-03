import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeInGroups,
  createSignalHandler,
  onceWithDeadline,
  waitUntilReady,
  type Closable,
} from '../src/lifecycle.js';

describe('createSignalHandler', () => {
  function harness() {
    let clock = 0;
    const exits: number[] = [];
    const forced: string[] = [];
    let shutdowns = 0;
    let finish: (code: number) => void = () => undefined;
    const handle = createSignalHandler(
      () => {
        shutdowns += 1;
        return new Promise<number>((resolve) => (finish = resolve));
      },
      (code) => exits.push(code),
      { now: () => clock, onForced: (signal) => forced.push(signal) },
    );
    return {
      handle,
      exits,
      forced,
      shutdowns: () => shutdowns,
      finish: (code: number) => finish(code),
      tick: (ms: number) => (clock += ms),
    };
  }

  it('starts the shutdown on the first signal and exits with its code', async () => {
    const h = harness();
    h.handle('SIGTERM');
    expect(h.shutdowns()).toBe(1);
    h.finish(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.exits).toEqual([0]);
  });

  it('ignores the same Ctrl-C delivered twice (to npm and to node) instead of cutting the shutdown short', () => {
    const h = harness();
    h.handle('SIGINT');
    h.tick(20);
    h.handle('SIGINT');
    expect(h.shutdowns()).toBe(1);
    expect(h.exits).toEqual([]);
    expect(h.forced).toEqual([]);
  });

  it('exits at once with 1 on a second, later signal', () => {
    const h = harness();
    h.handle('SIGINT');
    h.tick(1_500);
    h.handle('SIGINT');
    expect(h.forced).toEqual(['SIGINT']);
    expect(h.exits).toEqual([1]);
    expect(h.shutdowns()).toBe(1);
  });
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function readinessServer(notReadyResponses: number): Promise<string> {
  let left = notReadyResponses;
  const server = http.createServer((_req, res) => {
    res.statusCode = left-- > 0 ? 503 : 200;
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health/ready`),
    ),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('waitUntilReady', () => {
  it('waits through 503 answers until the application answers 200', async () => {
    await expect(waitUntilReady(await readinessServer(3), { intervalMs: 10 })).resolves.toBeUndefined();
  });

  it('gives up after the timeout, also when nothing is listening yet', async () => {
    await expect(waitUntilReady(await readinessServer(1_000), { timeoutMs: 200, intervalMs: 20 })).rejects.toThrow(
      /not ready at .* within 200 ms/,
    );
    await expect(waitUntilReady('http://127.0.0.1:9/health/ready', { timeoutMs: 150, intervalMs: 20 })).rejects.toThrow(
      /not ready/,
    );
  });
});

describe('closeInGroups', () => {
  function fakes(events: string[], delays: Record<string, number> = {}, failing: string[] = []) {
    const map = new Map<string, Closable>();
    for (const name of ['identity', 'organization', 'workspace', 'files', 'messaging', 'realtime', 'gateway'])
      map.set(name, {
        async close() {
          events.push(`begin:${name}`);
          await sleep(delays[name] ?? 1);
          events.push(`end:${name}`);
          if (failing.includes(name)) throw new Error(`${name} failed to close`);
        },
      });
    return map;
  }

  it('closes group by group, the applications of one group together', async () => {
    const events: string[] = [];
    const report = await closeInGroups(fakes(events, { gateway: 30 }), [
      ['gateway', 'realtime'],
      ['messaging'],
      ['identity'],
    ]);
    // realtime begins while the gateway is still closing; messaging only after both have finished.
    expect(events.slice(0, 2).sort()).toEqual(['begin:gateway', 'begin:realtime']);
    expect(events.indexOf('begin:messaging')).toBeGreaterThan(events.indexOf('end:gateway'));
    expect(events.indexOf('begin:identity')).toBeGreaterThan(events.indexOf('end:messaging'));
    expect(report).toEqual({ closed: ['realtime', 'gateway', 'messaging', 'identity'], failed: [] });
  });

  it('skips applications that were never started, and keeps going when one fails to close', async () => {
    const events: string[] = [];
    const started = fakes(events, {}, ['messaging']);
    started.delete('workspace');
    const report = await closeInGroups(started, [['messaging'], ['workspace'], ['identity']]);
    expect(events).not.toContain('begin:workspace');
    expect(report).toEqual({
      closed: ['identity'],
      failed: [{ name: 'messaging', error: 'messaging failed to close' }],
    });
  });
});

describe('onceWithDeadline', () => {
  it('runs the shutdown once: every call gets the same result', async () => {
    let runs = 0;
    const close = onceWithDeadline(async () => {
      runs += 1;
      await sleep(10);
      return { closed: ['identity'], failed: [] };
    }, 1_000);
    const [a, b] = [close(), close()];
    expect(a).toBe(b);
    expect(await a).toEqual({ closed: ['identity'], failed: [], timedOut: false });
    expect(await close()).toEqual({ closed: ['identity'], failed: [], timedOut: false });
    expect(runs).toBe(1);
  });

  it('reports a shutdown that overruns its deadline', async () => {
    const close = onceWithDeadline(() => new Promise(() => undefined), 50);
    expect(await close()).toEqual({ closed: [], failed: [], timedOut: true });
  });
});
