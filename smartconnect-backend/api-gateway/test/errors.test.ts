import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemOf, startGateway, UUID, type TestGateway } from './support/gateway.js';
import { INTERNAL_SECRET_MESSAGE, ProbeModule } from './support/probe.module.js';

describe('standardized errors (RFC 9457 problem details)', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  it('answers unknown routes with a complete 404 problem', async () => {
    const res = await request(gateway.server).get('/api/v1/channels?cursor=abc').expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json; charset=utf-8$/);
    expect(res.body).toEqual({
      type: 'https://docs.smartconnect.dev/errors/not-found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'The requested resource does not exist.',
      instance: '/api/v1/channels',
      requestId: expect.stringMatching(UUID) as string,
    });
  });

  it.each(['/', '/nope', '/docs', '/api', '/apiary', '/health'])(
    'answers unknown paths outside /api/v1 (%s) with a 404 problem, not an HTML page',
    async (path) => {
      const res = await request(gateway.server).get(path).expect(404);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemOf(res)).toMatchObject({ code: 'not_found', instance: path });
    },
  );

  it('answers a wrong method on a health path with a 404 problem', async () => {
    const res = await request(gateway.server).post('/health/live').expect(404);
    expect(problemOf(res).code).toBe('not_found');
  });

  it('does not reflect the requested path or method in the detail', async () => {
    const res = await request(gateway.server).delete('/api/v1/<script>alert(1)</script>').expect(404);
    expect(problemOf(res).detail).toBe('The requested resource does not exist.');
  });

  it('passes domain problems through with their code and detail', async () => {
    const res = await request(gateway.server).get('/api/v1/__probe/domain-problem').expect(409);
    expect(problemOf(res)).toMatchObject({
      type: 'https://docs.smartconnect.dev/errors/name-taken',
      title: 'Conflict',
      status: 409,
      code: 'name_taken',
      detail: 'A channel with this name already exists.',
    });
  });

  it('replaces framework 4xx messages with the generic detail for the status', async () => {
    const res = await request(gateway.server).get('/api/v1/__probe/framework-4xx').expect(400);
    expect(problemOf(res)).toMatchObject({ code: 'bad_request', detail: 'The request could not be understood.' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('turns unexpected errors into a generic 500 and logs the cause server-side only', async () => {
    const res = await request(gateway.server)
      .get('/api/v1/__probe/boom')
      .set('X-Request-Id', 'boom-request-1')
      .expect(500);
    expect(problemOf(res)).toMatchObject({
      status: 500,
      code: 'internal_error',
      title: 'Internal server error',
      requestId: 'boom-request-1',
    });
    const raw = JSON.stringify(res.body);
    for (const leak of ['ECONNREFUSED', '10.20.30.40', 'hunter2', 'at ', '.ts']) expect(raw).not.toContain(leak);

    const [logged] = gateway.logger.events('unhandled_error');
    expect(logged?.message).toMatchObject({
      requestId: 'boom-request-1',
      method: 'GET',
      path: '/api/v1/__probe/boom',
      error: INTERNAL_SECRET_MESSAGE,
    });
    expect(logged?.stack).toContain('ProbeController.boom');
  });
});
