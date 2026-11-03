import { vi } from 'vitest';

// Network double for tests: replaces `fetch` (the only boundary the app talks through) and answers by
// "METHOD /path" with `:param` segments. Lives in test code only.

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

type Answer = Response | object | null | undefined;
export type Handler = (call: RecordedCall, params: Record<string, string>) => Answer | Promise<Answer>;

const compile = (route: string) => {
  const [method, path] = route.split(' ') as [string, string];
  const names: string[] = [];
  const pattern = path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${pattern}$`), names };
};

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      type: `https://docs.smartconnect.dev/errors/${code.replaceAll('_', '-')}`,
      title: code,
      status,
      code,
      detail: `Server says ${code}`,
      requestId: 'req-test-0001',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

export interface ApiStub {
  calls: RecordedCall[];
  /** Requests nothing was registered for (the stub answered 501). */
  unhandled: string[];
  /** Registers or replaces handlers. A handler returning a plain object answers 200 with it as JSON. */
  on(routes: Record<string, Handler>): void;
  callsTo(route: string): RecordedCall[];
}

/** Installs the fetch double. `routes` objects may return a Response, a plain object (200 JSON) or nothing (204). */
export function stubApi(routes: Record<string, Handler> = {}): ApiStub {
  const handlers = new Map<string, { compiled: ReturnType<typeof compile>; handler: Handler }>();
  const stub: ApiStub = {
    calls: [],
    unhandled: [],
    on(next) {
      for (const [route, handler] of Object.entries(next)) handlers.set(route, { compiled: compile(route), handler });
    },
    callsTo: (route) => {
      const { method, regex } = compile(route);
      return stub.calls.filter((call) => call.method === method && regex.test(call.path));
    },
  };
  stub.on(routes);

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, 'http://localhost');
      const call: RecordedCall = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/api\/v1/, ''),
        query: url.searchParams,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        credentials: init?.credentials,
      };
      stub.calls.push(call);
      for (const { compiled, handler } of handlers.values()) {
        const match = compiled.regex.exec(call.path);
        if (compiled.method !== call.method || !match) continue;
        const params = Object.fromEntries(compiled.names.map((name, index) => [name, match[index + 1] ?? '']));
        return Promise.resolve(handler(call, params)).then((result) =>
          result instanceof Response ? result : result ? json(200, result) : json(204),
        );
      }
      stub.unhandled.push(`${call.method} ${call.path}`);
      return Promise.resolve(problem(501, 'test_unhandled_request'));
    }),
  );
  return stub;
}
