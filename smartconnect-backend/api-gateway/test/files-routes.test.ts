// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// File upload/download through the gateway (ADR 0013): exactly two content routes stream raw bytes; everything else
// stays JSON only; authentication, size cap and rate limits apply.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jsonResponse, startFakeUpstream, type FakeUpstream } from './support/fake-upstream.js';
import type { Request, Response } from 'express';
import { problemOf, startGateway, testConfig, type TestGateway } from './support/gateway.js';
import { signAccessToken } from './support/tokens.js';

const ORG = '019a4a00-0000-7000-8000-000000000001';
const FILE = '019a4a00-0000-7000-8000-000000000002';
const CONTENT = `/api/v1/orgs/${ORG}/files/${FILE}/content`;
const MAX = 4096;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const binary = (res: request.Response, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('files routes', () => {
  let files: FakeUpstream;
  let gateway: TestGateway;
  let auth: { Authorization: string };
  beforeAll(async () => {
    files = await startFakeUpstream();
    gateway = await startGateway({ env: { FILES_SERVICE_URL: files.url, FILES_MAX_BYTES: String(MAX) } });
    auth = { Authorization: `Bearer ${await signAccessToken()}` };
  });
  afterAll(async () => {
    await gateway.app.close();
    await files.close();
  });
  beforeEach(() => {
    files.requests.length = 0;
    files.respondWith(jsonResponse(200, { ok: 'files' }));
  });

  it.each([
    ['POST', `/api/v1/orgs/${ORG}/files`],
    ['GET', `/api/v1/orgs/${ORG}/files?limit=5`],
    ['GET', `/api/v1/orgs/${ORG}/files/${FILE}`],
    ['DELETE', `/api/v1/orgs/${ORG}/files/${FILE}`],
  ])('forwards JSON route %s %s to the files service', async (method, path) => {
    const verb = method.toLowerCase() as 'get' | 'post' | 'delete';
    const call = request(gateway.server)[verb](path).set(auth);
    const res = await (method === 'POST' ? call.send({ name: 'a.txt', sizeBytes: 3 }) : call);
    expect(res.status).toBe(200);
    expect(files.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`${method} ${path}`]);
  });

  describe('upload (PUT …/content)', () => {
    it('streams binary bytes intact with only allowlisted headers and an octet-stream type', async () => {
      const bytes = randomBytes(3000);
      const res = await request(gateway.server)
        .put(CONTENT)
        .set({
          ...auth,
          'Content-Type': 'application/octet-stream',
          Cookie: 'sid=1',
          Origin: 'http://localhost:5173',
          'X-User-Id': 'evil',
          Accept: 'application/json',
        })
        .send(bytes);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: 'files' });
      const [seen] = files.requests;
      expect(seen!.method).toBe('PUT');
      expect(seen!.url).toBe(`/api/v1/orgs/${ORG}/files/${FILE}/content`);
      expect(sha(seen!.rawBody)).toBe(sha(bytes));
      expect(seen!.headers['content-type']).toBe('application/octet-stream');
      expect(seen!.headers['content-length']).toBe('3000');
      expect(seen!.headers.authorization).toBe(auth.Authorization);
      expect(seen!.headers.accept).toBe('application/json');
      expect(seen!.headers.cookie).toBeUndefined();
      expect(seen!.headers['x-user-id']).toBeUndefined();
      expect(seen!.headers['x-request-id']).toBeTruthy();
    });

    it('passes the files service verdict (status and problem body) back unchanged', async () => {
      files.respondWith(
        jsonResponse(409, { code: 'already_uploaded', status: 409 }, { 'content-type': 'application/problem+json' }),
      );
      const res = await request(gateway.server)
        .put(CONTENT)
        .set(auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('abc'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('already_uploaded');
    });

    it('refuses bodies over the cap before reading them, and never contacts the upstream', async () => {
      const res = await request(gateway.server)
        .put(CONTENT)
        .set(auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(MAX + 1));
      expect(res.status).toBe(413);
      expect(problemOf(res).code).toBe('payload_too_large');
      expect(files.requests).toHaveLength(0);
      const exact = await request(gateway.server)
        .put(CONTENT)
        .set(auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(MAX));
      expect(exact.status).toBe(200);
    });

    it('answers 415 at once to any other content type, without hanging or contacting the upstream', async () => {
      for (const type of ['application/json', 'image/png', 'text/plain']) {
        const res = await request(gateway.server)
          .put(CONTENT)
          .set(auth)
          .set('Content-Type', type)
          .send(type === 'application/json' ? JSON.stringify({ a: 1 }) : 'abc');
        expect(res.status).toBe(415);
        expect(problemOf(res).code).toBe('unsupported_media_type');
      }
      expect(files.requests).toHaveLength(0);
    });

    it('requires a declared length (no chunked uploads)', async () => {
      const server = gateway.app.getHttpServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            port,
            host: '127.0.0.1',
            method: 'PUT',
            path: CONTENT,
            headers: { ...auth, 'Content-Type': 'application/octet-stream' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.write('chunked body');
        req.end();
      });
      expect(status).toBe(411);
      expect(files.requests).toHaveLength(0);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('answers 502 when the files service is unreachable', async () => {
      const down = await startGateway({ env: { FILES_SERVICE_URL: 'http://127.0.0.1:9' } });
      try {
        const res = await request(down.server)
          .put(CONTENT)
          .set(auth)
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('abc'));
        expect(res.status).toBe(502);
        expect(problemOf(res).code).toBe('bad_gateway');
      } finally {
        await down.app.close();
      }
    });

    it('rate-limits uploads per user', async () => {
      const fresh = await startGateway({ env: { FILES_SERVICE_URL: files.url } });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 101; i++) {
          statuses.push(
            (
              await request(fresh.server)
                .put(CONTENT)
                .set(auth)
                .set('Content-Type', 'application/octet-stream')
                .send(Buffer.from('x'))
            ).status,
          );
        }
        expect(statuses.slice(0, 100).every((status) => status === 200)).toBe(true);
        expect(statuses[100]).toBe(429);
      } finally {
        await fresh.app.close();
      }
    });
  });

  describe('download (GET …/content)', () => {
    it('streams the bytes back with the safe headers and drops everything else', async () => {
      const bytes = randomBytes(2500);
      files.respondWith((_request, res) => {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'content-disposition': `inline; filename="a.png"`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
          'set-cookie': 'leak=1',
          'x-internal': 'secret',
        });
        res.end(bytes);
      });
      const res = await request(gateway.server).get(CONTENT).set(auth).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(sha(res.body as Buffer)).toBe(sha(bytes));
      expect(res.headers).toMatchObject({
        'content-type': 'image/png',
        'content-length': String(bytes.length),
        'content-disposition': 'inline; filename="a.png"',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-internal']).toBeUndefined();
      expect(files.requests[0]!.headers.authorization).toBe(auth.Authorization);
    });

    it('passes a refusal from the files service (404 problem) through', async () => {
      files.respondWith(jsonResponse(404, { code: 'not_found' }, { 'content-type': 'application/problem+json' }));
      const res = await request(gateway.server).get(CONTENT).set(auth);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('streams larger-than-one-chunk bodies without changing a byte', async () => {
      const bytes = randomBytes(MAX * 64);
      files.respondWith((_request, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
        res.end(bytes);
      });
      const res = await request(gateway.server).get(CONTENT).set(auth).buffer(true).parse(binary);
      expect(sha(res.body as Buffer)).toBe(sha(bytes));
    });
  });

  it('requires authentication on both content routes and the JSON ones, before anything is forwarded', async () => {
    await request(gateway.server)
      .put(CONTENT)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('abc'))
      .expect(401);
    await request(gateway.server).get(CONTENT).expect(401);
    await request(gateway.server).get(CONTENT).set('Authorization', 'Bearer aaa.bbb.ccc').expect(401);
    await request(gateway.server).post(`/api/v1/orgs/${ORG}/files`).send({}).expect(401);
    await request(gateway.server).get(`/api/v1/orgs/${ORG}/files`).expect(401);
    expect(files.requests).toHaveLength(0);
  });

  describe('path escapes (encoded dot segments and separators)', () => {
    // Raw sockets: HTTP clients (and WHATWG URL) would collapse the dot segments before sending.
    const raw = async (method: string, path: string, body?: string): Promise<number> => {
      const server = gateway.app.getHttpServer();
      if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return new Promise<number>((resolve, reject) => {
        const req = http.request(
          { port, host: '127.0.0.1', method, path, headers: { ...auth, 'Content-Type': 'application/json' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    };
    afterAll(async () => {
      const server = gateway.app.getHttpServer();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it.each([
      ['POST', `/api/v1/orgs/${ORG}/files/%2e%2e/files`, '{"name":"a","sizeBytes":1}'],
      ['POST', `/api/v1/orgs/${ORG}/files/%2E%2e/files`, '{"name":"a","sizeBytes":1}'],
      ['GET', `/api/v1/orgs/${ORG}/files/%2e%2e/files/${FILE}/content`, undefined],
      ['GET', `/api/v1/orgs/${ORG}/files/..%2fdocs`, undefined],
      ['GET', `/api/v1/orgs/${ORG}/files/%5c..`, undefined],
      ['GET', `/api/v1/orgs/${ORG}/files/../../../docs`, undefined],
      ['GET', `/api/v1/orgs/${ORG}/files/./${FILE}`, undefined],
    ])('refuses %s %s with 400 before routing', async (method, path, body) => {
      expect(await raw(method, path, body)).toBe(400);
      expect(files.requests).toHaveLength(0);
    });
  });

  describe('every other route stays JSON only', () => {
    it.each([
      ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}`],
      ['POST', `/api/v1/orgs/${ORG}/files`],
      ['POST', CONTENT],
      ['PATCH', CONTENT],
      ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content/extra`],
      ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}/other`],
      ['PUT', `/api/v1/orgs/${ORG}/workspaces/${FILE}/content`],
      ['PUT', `/api/v1/orgs/${ORG}/conversations/${FILE}`],
      ['PUT', `/api/v1/orgs/${ORG}`],
    ])('answers 415 to an octet-stream %s %s', async (method, path) => {
      const verb = method.toLowerCase() as 'put' | 'post' | 'patch';
      const agent = request(gateway.server);
      const res = await agent[verb](path)
        .set(auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('abc'));
      expect(res.status).toBe(415);
      expect(problemOf(res).code).toBe('unsupported_media_type');
      expect(files.requests).toHaveLength(0);
    });
  });
});

describe('UpstreamProxy.forward defence in depth', () => {
  it('refuses file-content paths, which only stream() may carry', async () => {
    const { UpstreamProxy } = await import('../src/proxy/upstream-proxy.js');
    const proxy = new UpstreamProxy(testConfig({ FILES_SERVICE_URL: 'http://127.0.0.1:9' }));
    const req = { originalUrl: CONTENT, method: 'GET', get: () => undefined } as unknown as Request;
    await expect(proxy.forward('files', req, {} as Response)).rejects.toMatchObject({ status: 400 });
  });
});
