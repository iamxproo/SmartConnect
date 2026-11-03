import { createContext, use, useSyncExternalStore } from 'react';
import type { ApiClient } from '@/lib/api/client';
import type { TokenResponse, User } from '@/lib/api/types';

export type AuthState =
  | { status: 'unknown' }
  /** `expired`: the session ended without the person asking (revoked, expired, refresh token reused). */
  | { status: 'anonymous'; expired?: true }
  | { status: 'authenticated'; user: User };

/** Who is signed in. The session itself (tokens) is owned by the API client; this store only knows the user. */
export function createAuthStore(api: ApiClient, onSignedOut: () => void) {
  let state: AuthState = { status: 'unknown' };
  let initializing: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function set(next: AuthState) {
    const wasSignedIn = state.status === 'authenticated';
    state = next;
    if (wasSignedIn && next.status === 'anonymous') onSignedOut();
    for (const listener of listeners) listener();
  }

  const loadUser = async () => set({ status: 'authenticated', user: await api.get<User>('/auth/me') });

  api.onSessionLost(() => set({ status: 'anonymous', expired: true }));

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Restores the session from the refresh cookie, once. A transient failure (network, 5xx) is retried next call. */
    async initialize(): Promise<AuthState> {
      initializing ??= (async () => {
        try {
          if (await api.refresh()) await loadUser();
          else set({ status: 'anonymous' });
        } catch (error) {
          initializing = null;
          throw error;
        }
      })();
      await initializing;
      return state;
    },
    async login(email: string, password: string) {
      const tokens = await api.post<TokenResponse>('/auth/login', { email, password }, { anonymous: true });
      api.setAccessToken(tokens.accessToken);
      await loadUser();
    },
    async logout() {
      try {
        await api.post('/auth/logout', undefined, { anonymous: true });
      } finally {
        api.setAccessToken(null);
        set({ status: 'anonymous' });
      }
    },
    reloadUser: loadUser,
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;

export const AuthContext = createContext<AuthStore | null>(null);

export function useAuthStore(): AuthStore {
  const store = use(AuthContext);
  if (!store) throw new Error('useAuthStore must be used inside the application providers');
  return store;
}

export function useAuthState(): AuthState {
  const store = useAuthStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
  );
}

/** The signed-in user. Only valid below the authenticated route layout. */
export function useUser(): User {
  const state = useAuthState();
  if (state.status !== 'authenticated') throw new Error('useUser requires a signed-in user');
  return state.user;
}
