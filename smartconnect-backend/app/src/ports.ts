// Port check before anything starts (decision D4): every port the backend will listen on must be free. A port is busy
// if something already answers on it over loopback, or if it cannot be bound. Nothing that is found is touched:
// another process owning a port is reported, never stopped. The check binds each port only for an instant.
import net from 'node:net';

export interface PortClaim {
  app: string;
  host: string;
  port: number;
}

export interface BusyPort extends PortClaim {
  reason: 'in use' | 'cannot bind';
}

const LOOPBACK = '127.0.0.1';

function answers(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOOPBACK, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function bindable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function findBusyPorts(claims: readonly PortClaim[], { timeoutMs = 300 } = {}): Promise<BusyPort[]> {
  const results = await Promise.all(
    claims.map(async (claim): Promise<BusyPort | undefined> => {
      if (await answers(claim.port, timeoutMs)) return { ...claim, reason: 'in use' };
      if (!(await bindable(claim.host, claim.port))) return { ...claim, reason: 'cannot bind' };
      return undefined;
    }),
  );
  return results.filter((busy): busy is BusyPort => busy !== undefined);
}
