import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';
import { ProbeModule } from './support/probe.module.js';

const ECHO = '/api/v1/__probe/echo';

describe('global DTO validation', () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  const post = (body: unknown) =>
    request(gateway.server)
      .post(ECHO)
      .send(body as object);

  async function expectValidationErrors(body: unknown) {
    const res = await post(body).expect(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const problem = problemOf(res);
    expect(problem).toMatchObject({ status: 422, code: 'validation_failed', title: 'Request validation failed' });
    expect(problem.detail).toMatch(/^\d+ validation errors?$/);
    return problem.errors ?? [];
  }

  it('accepts a valid body and hands the handler a DTO instance', async () => {
    const body = { name: 'General', count: 2, nested: { level: 1 }, items: [{ label: 'a' }] };
    const res = await post(body).expect(200);
    expect(res.body).toMatchObject({ received: body, isDto: true });
  });

  it('rejects unknown fields instead of silently stripping them', async () => {
    expect(await expectValidationErrors({ name: 'General', isAdmin: true })).toContainEqual({
      field: 'isAdmin',
      code: 'unknown_field',
      message: 'property isAdmin should not exist',
    });
  });

  it('reports a missing required field', async () => {
    const errors = await expectValidationErrors({});
    expect(errors.map((error) => error.field)).toEqual(['name', 'name']);
    expect(errors.map((error) => error.code).sort()).toEqual(['invalid_type', 'too_long']);
  });

  it('reports wrong types without implicit conversion', async () => {
    const errors = await expectValidationErrors({ name: 'General', count: '2' });
    expect(errors).toContainEqual(expect.objectContaining({ field: 'count', code: 'invalid_type' }));
  });

  it('reports constraint violations with stable codes', async () => {
    const errors = await expectValidationErrors({ name: 'x'.repeat(21), count: -1 });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'name', code: 'too_long' }),
        expect.objectContaining({ field: 'count', code: 'too_small' }),
      ]),
    );
  });

  it('uses dotted and indexed paths for nested objects and arrays', async () => {
    const errors = await expectValidationErrors({
      name: 'General',
      nested: { level: 0 },
      items: [{ label: 'ok' }, { label: 7 }],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'nested.level', code: 'too_small' }),
        expect.objectContaining({ field: 'items[1].label', code: 'invalid_type' }),
      ]),
    );
  });

  it('rejects unknown fields inside nested objects', async () => {
    const errors = await expectValidationErrors({ name: 'General', nested: { level: 1, extra: true } });
    expect(errors).toContainEqual(expect.objectContaining({ field: 'nested.extra', code: 'unknown_field' }));
  });

  it('rejects a JSON array where an object is expected', async () => {
    const errors = await expectValidationErrors([{ name: 'General' }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('treats a request without a body as an empty object', async () => {
    const res = await request(gateway.server).post(ECHO).expect(422);
    expect(problemOf(res).errors?.map((error) => error.field)).toContain('name');
  });

  it('never echoes submitted values in errors (they may be secrets)', async () => {
    const secret = 'sk_live_DO_NOT_ECHO_THIS_VALUE';
    const res = await post({ name: secret, count: secret, nested: { level: secret }, unexpected: secret }).expect(422);
    expect(new Set(problemOf(res).errors?.map((error) => error.field))).toEqual(
      new Set(['name', 'count', 'nested.level', 'unexpected']),
    );
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('does not let __proto__ in a body pollute prototypes', async () => {
    const res = await request(gateway.server)
      .post(ECHO)
      .set('Content-Type', 'application/json')
      .send('{"name":"General","__proto__":{"polluted":true}}');
    expect([200, 422]).toContain(res.status);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
