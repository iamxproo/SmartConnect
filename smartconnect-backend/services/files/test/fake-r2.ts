// Test-only stand-in for a private Cloudflare R2 bucket: an in-memory S3 API (PUT, GET, HEAD, DELETE, ListObjectsV2)
// on an ephemeral loopback port that checks every request as R2 does. Header-signed requests must carry a valid SigV4
// signature from the configured key (checked with the signer the published AWS examples verify), a date within 15
// minutes, and, for PUT, a body matching x-amz-content-sha256; presigned GETs must be valid and not expired; anything
// unsigned is refused (the bucket is private). It can also fail like a provider: an outage, dropped connections, a
// hang, or a few transient errors before recovering. No network beyond 127.0.0.1, no real credentials.
import { createHash } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { signatureOf, UNSIGNED_PAYLOAD, type S3Credentials } from '../src/storage/s3-signature.js';

export const FAKE_CREDENTIALS: S3Credentials = {
  accessKeyId: 'f0a1b2c3d4e5f60718293a4b5c6d7e8f',
  secretAccessKey: 'test-only-secret-0123456789abcdef0123456789abcdef',
};

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: 'header' | 'presigned' | 'none';
}

export interface FakeR2 {
  url: string;
  bucket: string;
  objects: Map<string, { body: Buffer; contentType: string }>;
  requests: FakeRequest[];
  /** ok; outage (503 ServiceUnavailable); drop (connection reset); hang (never answers). */
  mode: 'ok' | 'outage' | 'drop' | 'hang';
  /** The next N requests answer 503 SlowDown, then it recovers. */
  failNext: number;
  /** Objects per ListObjectsV2 page (R2's own is 1000). */
  pageSize: number;
  /** The bucket's clock, for signature dates and link expiry. */
  now: () => Date;
  close(): Promise<void>;
}

const xmlError = (res: ServerResponse, status: number, code: string, message = code) => {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
};

const decodePath = (raw: string) => raw.split('/').map(decodeURIComponent).join('/');
const parseAmzDate = (value: string) =>
  new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );

export async function startFakeR2({
  bucket = 'smartconnect-files',
  credentials = FAKE_CREDENTIALS,
}: { bucket?: string; credentials?: S3Credentials } = {}): Promise<FakeR2> {
  const sockets = new Set<Socket>();
  const fake: FakeR2 = {
    url: '',
    bucket,
    objects: new Map(),
    requests: [],
    mode: 'ok',
    failNext: 0,
    pageSize: 1000,
    now: () => new Date(),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  /** null when the request is properly authorized; otherwise the refusal has been sent. */
  function authorize(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: Record<string, string>,
    body: Buffer,
  ) {
    const host = req.headers.host ?? '';
    const scope = { region: 'auto', service: 's3' };
    if (query['X-Amz-Algorithm']) {
      const [accessKeyId, day, region, service] = (query['X-Amz-Credential'] ?? '').split('/');
      if (accessKeyId !== credentials.accessKeyId) return xmlError(res, 403, 'InvalidAccessKeyId');
      const amzDate = query['X-Amz-Date'] ?? '';
      const expires = Number(query['X-Amz-Expires']);
      if (!amzDate.startsWith(day ?? '-') || region !== scope.region || service !== scope.service || !(expires > 0))
        return xmlError(res, 400, 'AuthorizationQueryParametersError');
      const { 'X-Amz-Signature': given, ...signedQuery } = query;
      const expected = signatureOf(
        { method: req.method ?? 'GET', path, query: signedQuery, headers: { host }, payloadHash: UNSIGNED_PAYLOAD },
        credentials,
        scope,
        amzDate,
      ).signature;
      if (given !== expected) return xmlError(res, 403, 'SignatureDoesNotMatch');
      if (fake.now().getTime() > parseAmzDate(amzDate).getTime() + expires * 1000)
        return xmlError(res, 403, 'AccessDenied', 'Request has expired');
      return null;
    }
    const authorization = req.headers.authorization;
    if (!authorization) return xmlError(res, 403, 'AccessDenied'); // private bucket: nothing anonymous
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(
        authorization,
      );
    if (!match) return xmlError(res, 400, 'AuthorizationHeaderMalformed');
    const [, accessKeyId, , , , signedNames, given] = match;
    if (accessKeyId !== credentials.accessKeyId) return xmlError(res, 403, 'InvalidAccessKeyId');
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    if (Math.abs(fake.now().getTime() - parseAmzDate(amzDate).getTime()) > 15 * 60 * 1000)
      return xmlError(res, 403, 'RequestTimeTooSkewed');
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    if (payloadHash !== UNSIGNED_PAYLOAD && createHash('sha256').update(body).digest('hex') !== payloadHash)
      return xmlError(res, 400, 'XAmzContentSHA256Mismatch');
    const headers = Object.fromEntries(signedNames!.split(';').map((name) => [name, String(req.headers[name] ?? '')]));
    const expected = signatureOf(
      { method: req.method ?? 'GET', path, query, headers, payloadHash },
      credentials,
      scope,
      amzDate,
    ).signature;
    if (given !== expected) return xmlError(res, 403, 'SignatureDoesNotMatch');
    return null;
  }

  function handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = decodePath(url.pathname);
    const query = Object.fromEntries(url.searchParams);
    fake.requests.push({
      method: req.method ?? '',
      path,
      query,
      auth: query['X-Amz-Algorithm'] ? 'presigned' : req.headers.authorization ? 'header' : 'none',
    });
    if (fake.mode === 'drop') return req.socket.destroy();
    if (fake.mode === 'hang') return;
    if (fake.mode === 'outage') return xmlError(res, 503, 'ServiceUnavailable');
    if (fake.failNext > 0) {
      fake.failNext -= 1;
      return xmlError(res, 503, 'SlowDown');
    }
    if (authorize(req, res, path, query, body) !== null) return;

    const [, bucketName, ...rest] = path.split('/');
    if (bucketName !== bucket) return xmlError(res, 404, 'NoSuchBucket');
    const key = rest.join('/');

    if (!key && req.method === 'GET' && query['list-type'] === '2') {
      const keys = [...fake.objects.keys()].sort();
      const start = Number(query['continuation-token'] ?? 0);
      const page = keys.slice(start, start + fake.pageSize);
      const truncated = start + fake.pageSize < keys.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><KeyCount>${page.length}</KeyCount>` +
          page
            .map((k) => `<Contents><Key>${k}</Key><Size>${fake.objects.get(k)!.body.length}</Size></Contents>`)
            .join('') +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + fake.pageSize}</NextContinuationToken>` : '') +
          '</ListBucketResult>',
      );
    }
    if (!key) return xmlError(res, 400, 'InvalidRequest');
    const object = fake.objects.get(key);
    switch (req.method) {
      case 'PUT':
        if (Number(req.headers['content-length']) !== body.length) return xmlError(res, 400, 'IncompleteBody');
        fake.objects.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') });
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      case 'GET':
      case 'HEAD':
        if (!object) return req.method === 'HEAD' ? (res.writeHead(404), res.end()) : xmlError(res, 404, 'NoSuchKey');
        res.writeHead(200, {
          'content-type': query['response-content-type'] ?? object.contentType,
          'content-length': String(object.body.length),
          ...(query['response-content-disposition'] && {
            'content-disposition': query['response-content-disposition'],
          }),
          ...(query['response-cache-control'] && { 'cache-control': query['response-cache-control'] }),
        });
        return res.end(req.method === 'GET' ? object.body : undefined);
      case 'DELETE':
        fake.objects.delete(key);
        res.writeHead(204);
        return res.end();
      default:
        return xmlError(res, 405, 'MethodNotAllowed');
    }
  }

  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => handle(req, res, Buffer.concat(parts)));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
