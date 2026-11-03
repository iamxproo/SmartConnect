import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { createApiClient } from './client';
import { ApiError } from './errors';

const token = (value: string) => ({ accessToken: value, tokenType: 'Bearer', expiresIn: 900 });

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
});

describe('problem details', () => {
  it('turns problem+json into an ApiError with status, code, detail, field errors and request id', async () => {
    stubApi({
      'POST /orgs': () =>
        problem(422, 'validation_failed', {
          detail: '1 validation error',
          errors: [{ field: 'slug', code: 'invalid', message: 'Use lowercase letters' }],
        }),
    });
    const error = await createApiClient()
      .post('/orgs', {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'validation_failed',
      detail: '1 validation error',
      requestId: 'req-test-0001',
      errors: [{ field: 'slug', code: 'invalid', message: 'Use lowercase letters' }],
    });
  });

  it('still produces an ApiError when the body is not JSON (proxy error page)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })));
    const error = await createApiClient()
      .get('/orgs')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ApiError', status: 502, code: 'unknown_error' });
  });

  it('returns undefined for 204 and parses JSON otherwise', async () => {
    stubApi({ 'DELETE /orgs/1': () => undefined, 'GET /orgs': () => ({ data: [] }) });
    const api = createApiClient();
    await expect(api.delete('/orgs/1')).resolves.toBeUndefined();
    await expect(api.get('/orgs')).resolves.toEqual({ data: [] });
  });
});

describe('credentials and tokens', () => {
  it('sends the bearer token, and cookies only to /auth endpoints', async () => {
    const stub = stubApi({ 'GET /orgs': () => ({ data: [] }), 'GET /auth/me': () => ({}) });
    const api = createApiClient();
    api.setAccessToken('abc');
    await api.get('/orgs');
    await api.get('/auth/me');
    const [orgs, me] = stub.calls;
    expect(orgs?.headers.get('Authorization')).toBe('Bearer abc');
    expect(orgs?.credentials).toBe('same-origin');
    expect(me?.credentials).toBe('include');
  });

  it('never persists the access token anywhere in the browser', async () => {
    stubApi({ 'POST /auth/refresh': () => token('secret-access-token') });
    const api = createApiClient();
    await expect(api.refresh()).resolves.toBe(true);
    const everything = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]);
    expect(everything).not.toContain('secret-access-token');
  });

  it('keeps public endpoints anonymous: no bearer header and no refresh on 401', async () => {
    const stub = stubApi({ 'POST /auth/login': () => problem(401, 'invalid_credentials') });
    const api = createApiClient();
    api.setAccessToken('abc');
    await expect(api.post('/auth/login', {}, { anonymous: true })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.has('Authorization')).toBe(false);
  });

  it('builds query strings, skipping empty values', async () => {
    const stub = stubApi({ 'GET /orgs/1/invitations': () => ({ data: [] }) });
    await createApiClient().get('/orgs/1/invitations', { status: '', limit: 10, cursor: undefined });
    expect(stub.calls[0]?.query.toString()).toBe('limit=10');
  });
});

describe('refresh and retry', () => {
  it('refreshes once on 401 and retries the request with the new token', async () => {
    let first = true;
    const stub = stubApi({
      'POST /auth/refresh': () => token('fresh'),
      'GET /orgs': (call) => {
        if (first) {
          first = false;
          return problem(401, 'unauthenticated');
        }
        return call.headers.get('Authorization') === 'Bearer fresh'
          ? { data: ['ok'] }
          : problem(401, 'unauthenticated');
      },
    });
    const api = createApiClient();
    api.setAccessToken('stale');
    await expect(api.get('/orgs')).resolves.toEqual({ data: ['ok'] });
    expect(stub.callsTo('POST /auth/refresh')).toHaveLength(1);
    expect(stub.callsTo('GET /orgs')).toHaveLength(2);
  });

  it('single-flights refreshes: five simultaneous 401s cause exactly one refresh', async () => {
    const stub = stubApi({
      'POST /auth/refresh': () => token('fresh'),
      'GET /orgs': (call) => (call.headers.get('Authorization') === 'Bearer fresh' ? { data: [] } : problem(401, 'x')),
    });
    const api = createApiClient();
    api.setAccessToken('stale');
    await Promise.all(Array.from({ length: 5 }, () => api.get('/orgs')));
    expect(stub.callsTo('POST /auth/refresh')).toHaveLength(1);
  });

  it('announces a lost session when the refresh is rejected, and surfaces the original 401', async () => {
    stubApi({
      'POST /auth/refresh': () => problem(401, 'invalid_refresh_token'),
      'GET /orgs': () => problem(401, 'unauthenticated'),
    });
    const api = createApiClient();
    const lost = vi.fn();
    api.onSessionLost(lost);
    api.setAccessToken('stale');
    await expect(api.get('/orgs')).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not end the session when the refresh itself fails for a transient reason', async () => {
    stubApi({ 'POST /auth/refresh': () => problem(503, 'service_unavailable'), 'GET /orgs': () => problem(401, 'x') });
    const api = createApiClient();
    const lost = vi.fn();
    api.onSessionLost(lost);
    await expect(api.get('/orgs')).rejects.toMatchObject({ status: 503 });
    expect(lost).not.toHaveBeenCalled();
  });

  it('rejects with the network error when the server is unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(createApiClient().get('/orgs')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('across tabs (Web Locks)', () => {
  it('serialises refreshes from separate tabs so a rotated token is never reused concurrently', async () => {
    // A minimal lock manager: one holder at a time, like navigator.locks.request with the same name.
    let queue: Promise<unknown> = Promise.resolve();
    const request = vi.fn(<T>(_name: string, task: () => Promise<T>) => {
      const run = queue.then(task);
      queue = run.catch(() => undefined);
      return run;
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });

    let active = 0;
    let maxActive = 0;
    stubApi({
      'POST /auth/refresh': async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return token('fresh');
      },
    });
    const tabA = createApiClient();
    const tabB = createApiClient();
    await Promise.all([tabA.refresh(), tabB.refresh(), tabA.refresh()]);

    expect(request).toHaveBeenCalledTimes(2); // tab A's two calls shared one in-flight refresh
    expect(maxActive).toBe(1);
  });

  it('still works when the Web Locks API is unavailable', async () => {
    stubApi({ 'POST /auth/refresh': () => token('fresh') });
    await expect(createApiClient().refresh()).resolves.toBe(true);
  });
});

describe('listAll', () => {
  it('follows cursors until the list ends', async () => {
    const stub = stubApi({
      'GET /orgs/1/members': (call) =>
        call.query.get('cursor') === 'c2'
          ? json(200, { data: [3], nextCursor: null })
          : json(200, { data: [1, 2], nextCursor: 'c2' }),
    });
    await expect(createApiClient().listAll('/orgs/1/members')).resolves.toEqual([1, 2, 3]);
    expect(stub.calls.map((call) => call.query.get('limit'))).toEqual(['100', '100']);
  });
});
