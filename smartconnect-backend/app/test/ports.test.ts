import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findBusyPorts } from '../src/ports.js';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function listen(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    servers.push(server);
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((resolve) => servers.pop()!.close(resolve));
  return port;
}

describe('findBusyPorts', () => {
  it('reports nothing for free ports, and leaves nothing listening', async () => {
    const port = await freePort();
    expect(await findBusyPorts([{ app: 'identity', host: '127.0.0.1', port }])).toEqual([]);
    // The check released the port again.
    expect(await findBusyPorts([{ app: 'identity', host: '127.0.0.1', port }])).toEqual([]);
  });

  it('reports every busy port at once, and never stops the process that owns it', async () => {
    const [a, b] = [await listen(), await listen('0.0.0.0')];
    const free = await freePort();
    const busy = await findBusyPorts([
      { app: 'identity', host: '127.0.0.1', port: a },
      { app: 'organization', host: '127.0.0.1', port: free },
      { app: 'gateway', host: '0.0.0.0', port: b },
    ]);
    expect(busy).toEqual([
      { app: 'identity', host: '127.0.0.1', port: a, reason: 'in use' },
      { app: 'gateway', host: '0.0.0.0', port: b, reason: 'in use' },
    ]);
    // Both owners still accept connections.
    for (const port of [a, b])
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
  });
});
