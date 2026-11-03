import type { OpenAPIObject, ResponseObject, SchemaObject } from '@nestjs/swagger';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemOf, startGateway, type TestGateway } from './support/gateway.js';

describe('OpenAPI document', () => {
  let gateway: TestGateway;
  let document: OpenAPIObject;
  beforeAll(async () => {
    gateway = await startGateway({ env: { API_DOCS_ENABLED: 'true' } });
    document = (await request(gateway.server).get('/docs/openapi.json').expect(200)).body as OpenAPIObject;
  });
  afterAll(async () => {
    await gateway.app.close();
  });

  const operations = () =>
    Object.entries(document.paths).flatMap(([path, item]) =>
      (['get', 'put', 'post', 'delete', 'patch'] as const).flatMap((method) =>
        item[method] ? [{ path, method, operation: item[method] }] : [],
      ),
    );

  it('is OpenAPI 3.1 and documents only real routes: health, auth, invitation and admin operations (no placeholders)', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toMatchObject({ title: 'SmartConnect API', version: 'v1' });
    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/v1/admin/accounts/summary',
      '/api/v1/admin/organizations',
      '/api/v1/auth/email/verification',
      '/api/v1/auth/email/verify',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/logout-all',
      '/api/v1/auth/me',
      '/api/v1/auth/password/change',
      '/api/v1/auth/password/forgot',
      '/api/v1/auth/password/reset',
      '/api/v1/auth/refresh',
      '/api/v1/auth/register',
      '/api/v1/auth/sessions',
      '/api/v1/auth/sessions/revoke-others',
      '/api/v1/auth/sessions/{sessionId}',
      '/api/v1/invitations/accept',
      '/api/v1/invitations/preview',
      '/api/v1/orgs/{orgId}/invitations',
      '/health/live',
      '/health/ready',
    ]);
  });

  it('gives every operation a unique id, a summary and a tag', () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['Health_live', 'Health_ready', 'AuthRoutes_login']));
    for (const { operation } of operations()) {
      expect(operation.summary).toBeTruthy();
      expect(operation.tags).toHaveLength(1);
    }
  });

  it('marks exactly the protected documented operations with bearer security', () => {
    const secured = operations()
      .filter(({ operation }) => operation.security?.some((requirement) => 'accessToken' in requirement))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(secured).toEqual([
      'DELETE /api/v1/auth/sessions/{sessionId}',
      'GET /api/v1/admin/accounts/summary',
      'GET /api/v1/admin/organizations',
      'GET /api/v1/auth/me',
      'GET /api/v1/auth/sessions',
      'POST /api/v1/auth/email/verification',
      'POST /api/v1/auth/logout-all',
      'POST /api/v1/auth/password/change',
      'POST /api/v1/auth/sessions/revoke-others',
      'POST /api/v1/invitations/accept',
      'POST /api/v1/orgs/{orgId}/invitations',
    ]);
    expect(document.components?.securitySchemes?.accessToken).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('documents the problem details schema from docs/api/conventions.md', () => {
    const schema = document.components?.schemas?.ProblemDetailsDto as SchemaObject;
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ['code', 'detail', 'errors', 'instance', 'requestId', 'status', 'title', 'type'].sort(),
    );
    expect(schema.required?.sort()).toEqual(
      ['code', 'detail', 'instance', 'requestId', 'status', 'title', 'type'].sort(),
    );
    expect(document.components?.schemas?.FieldErrorDto).toBeDefined();
  });

  it('applies the conventions to every response: X-Request-Id header and a 500 problem', () => {
    for (const { operation } of operations()) {
      const internal = operation.responses['500'] as ResponseObject;
      expect(internal.content?.['application/problem+json']?.schema).toEqual({
        $ref: '#/components/schemas/ProblemDetailsDto',
      });
      for (const response of Object.values(operation.responses) as ResponseObject[]) {
        expect(response.headers?.['X-Request-Id']).toEqual({ $ref: '#/components/headers/XRequestId' });
      }
    }
    expect(document.components?.headers?.XRequestId).toBeDefined();
  });

  it('documents the readiness 503 as a problem response', () => {
    const ready = document.paths['/health/ready']?.get;
    const unavailable = ready?.responses['503'] as ResponseObject;
    expect(unavailable.content?.['application/problem+json']).toBeDefined();
  });

  it('serialises to JSON without unresolved references', () => {
    const json = JSON.stringify(document);
    const refs = [...json.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, section, name] of refs) {
      expect((document.components as Record<string, Record<string, unknown>>)[section!]?.[name!]).toBeDefined();
    }
  });
});

describe('API docs exposure', () => {
  it('serves Swagger UI and the JSON document when API_DOCS_ENABLED=true', async () => {
    const gateway = await startGateway({ env: { API_DOCS_ENABLED: 'true' } });
    try {
      const ui = await request(gateway.server).get('/docs').expect(200);
      expect(ui.headers['content-type']).toMatch(/^text\/html/);
      const json = await request(gateway.server).get('/docs/openapi.json').expect(200);
      expect((json.body as OpenAPIObject).openapi).toBe('3.1.0');
      expect(Object.keys((json.body as OpenAPIObject).paths)).toContain('/health/ready');
    } finally {
      await gateway.app.close();
    }
  });

  it('serves nothing under /docs when disabled (the default outside development)', async () => {
    const gateway = await startGateway();
    try {
      for (const path of ['/docs', '/docs/openapi.json']) {
        const res = await request(gateway.server).get(path).expect(404);
        expect(problemOf(res).code).toBe('not_found');
      }
    } finally {
      await gateway.app.close();
    }
  });
});
