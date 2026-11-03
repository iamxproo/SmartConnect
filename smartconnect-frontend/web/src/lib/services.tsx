import { QueryClient } from '@tanstack/react-query';
import { createContext, use } from 'react';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { createAuthStore, type AuthStore } from '@/lib/auth';
import { createRealtimeClient, type RealtimeClient } from '@/lib/realtime';

export interface Services {
  api: ApiClient;
  auth: AuthStore;
  queryClient: QueryClient;
  realtime: RealtimeClient;
}

/** Wires the API client, the auth store, the server-state cache and live updates. One set per application instance. */
export function createServices(options: { realtime?: RealtimeClient } = {}): Services {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // A definite answer from the API (403, 404, 422…) will not change on retry.
        retry: (count, error) => !(error instanceof ApiError) && count < 2,
      },
    },
  });
  const api = createApiClient();
  const realtime = options.realtime ?? createRealtimeClient(api);
  // Signing out must not leave the previous person's data in the cache, or their socket open.
  const auth = createAuthStore(api, () => {
    realtime.close();
    queryClient.clear();
  });
  return { api, auth, queryClient, realtime };
}

export const ApiContext = createContext<ApiClient | null>(null);
export const RealtimeContext = createContext<RealtimeClient | null>(null);

export function useApi(): ApiClient {
  const api = use(ApiContext);
  if (!api) throw new Error('useApi must be used inside the application providers');
  return api;
}

export function useRealtime(): RealtimeClient {
  const realtime = use(RealtimeContext);
  if (!realtime) throw new Error('useRealtime must be used inside the application providers');
  return realtime;
}
