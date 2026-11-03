import { readApiError } from './errors';
import type { Page, TokenResponse } from './types';

const REFRESH_LOCK = 'smartconnect-refresh';
const MAX_LIST_PAGES = 20;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | string[] | undefined>;
  signal?: AbortSignal;
  /** Public endpoint: no bearer token and no refresh-and-retry on 401. */
  anonymous?: boolean;
}

export function defaultBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return (configured || '/api/v1').replace(/\/+$/, '');
}

/**
 * API client. The access token lives in this closure only (never in web storage). A 401 triggers one refresh and
 * one retry; refreshes are single-flight in this tab and, via the Web Locks API, across tabs, because reusing a
 * rotated refresh token ends the session.
 */
export function createApiClient({ baseUrl = defaultBaseUrl() }: { baseUrl?: string } = {}) {
  let accessToken: string | null = null;
  let inflightRefresh: Promise<boolean> | null = null;
  const sessionLostListeners = new Set<() => void>();

  function send(path: string, options: RequestOptions, token: string | null): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (token && !options.anonymous) headers.set('Authorization', `Bearer ${token}`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (Array.isArray(value)) for (const item of value) query.append(key, item);
      else if (value !== undefined && value !== '') query.set(key, String(value));
    }
    const search = query.size > 0 ? `?${query.toString()}` : '';
    return fetch(`${baseUrl}${path}${search}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      // The refresh cookie is scoped to /auth; nothing else needs credentials.
      credentials: path.startsWith('/auth/') ? 'include' : 'same-origin',
    });
  }

  async function refreshOnce(): Promise<boolean> {
    const response = await send('/auth/refresh', { method: 'POST', body: {}, anonymous: true }, null);
    if (response.status === 401) {
      accessToken = null;
      return false;
    }
    if (!response.ok) throw await readApiError(response);
    accessToken = ((await response.json()) as TokenResponse).accessToken;
    return true;
  }

  /** Resolves true when a new access token is held, false when there is no valid session; throws otherwise. */
  function refresh(): Promise<boolean> {
    inflightRefresh ??= (
      typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(REFRESH_LOCK, refreshOnce)
        : refreshOnce()
    ).finally(() => {
      inflightRefresh = null;
    });
    return inflightRefresh;
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const tokenUsed = accessToken;
    let response = await send(path, options, tokenUsed);
    if (response.status === 401 && !options.anonymous) {
      // Another request may already have refreshed while this one was in flight.
      const renewed = accessToken !== tokenUsed || (await refresh());
      if (renewed) response = await send(path, options, accessToken);
      else for (const listener of sessionLostListeners) listener();
    }
    if (!response.ok) throw await readApiError(response);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    request,
    get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
      request<T>(path, { query, signal }),
    post: <T>(path: string, body?: unknown, options?: Pick<RequestOptions, 'anonymous'>) =>
      request<T>(path, { ...options, method: 'POST', body }),
    put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
    patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
    delete: (path: string) => request<void>(path, { method: 'DELETE' }),
    refresh,
    setAccessToken(token: string | null) {
      accessToken = token;
    },
    /** For the realtime handshake, which cannot go through `request`. Never store it elsewhere. */
    getAccessToken: () => accessToken,
    /** Called when a refresh proves the session is over (expired, revoked, or the refresh token was reused). */
    onSessionLost(listener: () => void) {
      sessionLostListeners.add(listener);
      return () => sessionLostListeners.delete(listener);
    },
    /** Reads every page of a cursor-paginated list (bounded). */
    async listAll<T>(path: string, query: RequestOptions['query'] = {}): Promise<T[]> {
      const items: T[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await request<Page<T>>(path, { query: { ...query, limit: 100, cursor } });
        items.push(...result.data);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return items;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
