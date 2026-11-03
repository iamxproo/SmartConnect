// A stand-in for a backend service: records what the gateway forwards and answers as each test instructs.
// Listens on an ephemeral loopback port and is closed by the test that started it.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** The body bytes exactly as received (`body` is their UTF-8 reading). */
  rawBody: Buffer;
}

export type UpstreamHandler = (request: RecordedRequest, res: ServerResponse) => void;

export interface FakeUpstream {
  url: string;
  requests: RecordedRequest[];
  /** Replaces the response behaviour for subsequent requests. */
  respondWith(handler: UpstreamHandler): void;
  close(): Promise<void>;
}

export const jsonResponse =
  (status: number, body: unknown, headers: Record<string, string | string[]> = {}): UpstreamHandler =>
  (_request, res) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  let handler: UpstreamHandler = jsonResponse(200, { ok: true });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        rawBody: Buffer.concat(chunks),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
