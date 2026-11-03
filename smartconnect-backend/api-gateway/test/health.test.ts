import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadinessState } from '@smartconnect/backend-kit';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';

describe('startup and shutdown', () => {
  it('listens, serves health on a real socket, and becomes not-ready then closed on shutdown', async () => {
    const { app, logger } = await startGateway({ init: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);

    const readiness = app.get(ReadinessState);
    await app.close();
    expect(readiness.isReady()).toBe(false);
    expect(logger.events('service_stopping')).toHaveLength(1);
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });

  it('is not ready before bootstrap completes', async () => {
    const { app } = await startGateway({ init: false });
    expect(app.get(ReadinessState).isReady()).toBe(false);
    await app.close();
  });
});

describe('health endpoints', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway();
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  it('GET /health/live reports only liveness, uncached', async () => {
    const res = await request(gateway.server).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /health/ready reports readiness, uncached', async () => {
    const res = await request(gateway.server).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('exposes no versions, configuration or infrastructure details', async () => {
    for (const path of ['/health/live', '/health/ready']) {
      const res = await request(gateway.server).get(path);
      expect(Object.keys(res.body as object)).toEqual(['status']);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['server']).toBeUndefined();
    }
  });

  it('is unversioned: health is not served under /api/v1', async () => {
    await request(gateway.server).get('/api/v1/health/live').expect(404);
  });

  it('answers 503 problem details once shutdown has begun', async () => {
    const readiness = gateway.app.get(ReadinessState);
    readiness.beforeApplicationShutdown();
    try {
      const res = await request(gateway.server).get('/health/ready').expect(503);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemOf(res)).toMatchObject({ status: 503, code: 'not_ready', instance: '/health/ready' });
      // Liveness is independent of readiness: the process is still alive while draining.
      await request(gateway.server).get('/health/live').expect(200);
    } finally {
      readiness.onApplicationBootstrap();
    }
  });
});
