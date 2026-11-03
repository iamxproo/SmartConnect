// Socket.IO on the public port (ADR 0016 decision 10). The realtime gateway attaches Socket.IO (engine.io) to its own
// HTTP server, which handles WebSocket upgrades for its path and nothing else. The public server, owned by the API
// gateway, hands every upgrade request for that path to the realtime server inside the process; the realtime
// gateway then applies exactly its own checks (origin allowlist, token handshake, payload limit, rooms). Any other
// upgrade is refused, as the public server did before it had an upgrade listener.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { SOCKET_PATH } from '@smartconnect/realtime-gateway/dist/realtime/hub.js';

/** engine.io matches its path with a trailing slash (`/realtime/socket.io/?EIO=4&transport=websocket`). */
export const REALTIME_UPGRADE_PREFIX = `${SOCKET_PATH}/`;

export function attachRealtimeUpgrade(publicServer: Server, realtimeServer: Server): void {
  publicServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url?.startsWith(REALTIME_UPGRADE_PREFIX)) realtimeServer.emit('upgrade', req, socket, head);
    else socket.destroy();
  });
}
