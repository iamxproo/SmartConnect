import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '@smartconnect/backend-kit';
import { problemOf, startGateway, UUID, type TestGateway } from './support/gateway.js';
import { ProbeModule } from './support/probe.module.js';

describe('request ids', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  it('generates a UUID when the client sends none', async () => {
    const res = await request(gateway.server).get('/health/live');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('generates a distinct id per request', async () => {
    const [a, b] = await Promise.all([
      request(gateway.server).get('/health/live'),
      request(gateway.server).get('/health/live'),
    ]);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('propagates a valid inbound id to the response header, problem body and request log', async () => {
    const id = 'edge-proxy:4f1c2a9b.7';
    const res = await request(gateway.server).get('/api/v1/does-not-exist').set('X-Request-Id', id).expect(404);
    expect(res.headers['x-request-id']).toBe(id);
    expect(problemOf(res).requestId).toBe(id);
    const logged = gateway.logger.events<RequestLogEntry>('http_request').map((record) => record.message);
    expect(logged).toContainEqual(
      expect.objectContaining({ requestId: id, path: '/api/v1/does-not-exist', status: 404 }),
    );
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['spaces', 'has spaces in it'],
    ['log injection', 'abcdefgh\\n{"level":"fatal"}'],
    ['header-like characters', 'abcdefgh;admin=true'],
  ])('replaces an unsafe inbound id (%s) with a generated one', async (_case, unsafe) => {
    const res = await request(gateway.server).get('/health/live').set('X-Request-Id', unsafe);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('makes the id available to handler code after async gaps, isolated between concurrent requests', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `concurrent-${i}-0000`);
    const responses = await Promise.all(
      ids.map((id) => request(gateway.server).get('/api/v1/__probe/context').set('X-Request-Id', id)),
    );
    expect(responses.map((res) => (res.body as { requestId: string }).requestId)).toEqual(ids);
  });

  it('keeps the id available after the JSON body has been parsed', async () => {
    const res = await request(gateway.server)
      .post('/api/v1/__probe/echo')
      .set('X-Request-Id', 'after-body-parse-1')
      .send({ name: 'General' })
      .expect(200);
    expect((res.body as { requestId: string }).requestId).toBe('after-body-parse-1');
  });
});
