// The public server hands Socket.IO upgrades to the realtime server in process; the realtime server's own checks
// (here an origin allowlist and the handshake auth, as in the realtime gateway) still decide. Other upgrades are
// refused; ordinary HTTP on the public server is unaffected.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtimeUpgrade, REALTIME_UPGRADE_PREFIX } from '../src/realtime-upgrade.js';

let publicServer: http.Server;
let realtimeServer: http.Server;
let sockets: SocketServer;
let publicPort: number;
const clients: Socket[] = [];

beforeEach(async () => {
  publicServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end('public');
  });
  realtimeServer = http.createServer();
  sockets = new SocketServer(realtimeServer, {
    path: '/realtime/socket.io',
    transports: ['websocket'],
    allowRequest: (req, callback) => callback(null, req.headers.origin !== 'http://evil.example'),
  });
  sockets.use((socket, next) => (socket.handshake.auth.token === 'good' ? next() : next(new Error('unauthenticated'))));
  sockets.on('connection', (socket) => socket.on('ping', (ack: (v: string) => void) => ack('pong')));
  attachRealtimeUpgrade(publicServer, realtimeServer);
  await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve));
  publicPort = (publicServer.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await sockets.close();
  await new Promise((resolve) => publicServer.close(resolve));
});

function client(options: { token?: string; origin?: string } = {}): Socket {
  const socket = connect(`http://127.0.0.1:${publicPort}`, {
    path: '/realtime/socket.io',
    transports: ['websocket'],
    reconnection: false,
    auth: { token: options.token ?? 'good' },
    extraHeaders: options.origin ? { origin: options.origin } : undefined,
  });
  clients.push(socket);
  return socket;
}

const outcome = (socket: Socket) =>
  new Promise<string>((resolve) => {
    socket.once('connect', () => resolve('connected'));
    socket.once('connect_error', (error) => resolve(`error:${error.message}`));
  });

describe('attachRealtimeUpgrade', () => {
  it('uses the realtime gateway path with its trailing slash', () => {
    expect(REALTIME_UPGRADE_PREFIX).toBe('/realtime/socket.io/');
  });

  it('serves Socket.IO through the public port, on the unchanged path, with the handshake intact', async () => {
    const socket = client();
    expect(await outcome(socket)).toBe('connected');
    expect(await socket.emitWithAck('ping')).toBe('pong');
  });

  it("leaves the realtime server's own checks in charge: a bad token or a foreign origin is refused", async () => {
    expect(await outcome(client({ token: 'bad' }))).toBe('error:unauthenticated');
    expect(await outcome(client({ origin: 'http://evil.example' }))).toMatch(/^error:/);
  });

  it('refuses an upgrade for any other path, and leaves ordinary HTTP untouched', async () => {
    const refused = await new Promise<string>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: publicPort,
        path: '/api/v1/anything',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', (res) => resolve(`response ${res.statusCode}`));
      req.on('error', (error) => resolve(`closed (${(error as NodeJS.ErrnoException).code})`));
      req.end();
    });
    expect(refused).toMatch(/^closed/);
    const res = await fetch(`http://127.0.0.1:${publicPort}/api/v1/anything`);
    expect([res.status, await res.text()]).toEqual([404, 'public']);
  });
});
