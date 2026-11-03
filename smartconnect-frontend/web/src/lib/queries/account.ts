import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/api/types';
import { useApi } from '@/lib/services';
import { useApiMutation } from './mutation';

const sessionsKey = ['account', 'sessions'] as const;

export function useSessions() {
  const api = useApi();
  return useQuery({ queryKey: sessionsKey, queryFn: () => api.listAll<Session>('/auth/sessions') });
}

/** Ending the current session leaves nothing to refresh (the list would 401), so only other sessions refetch it. */
export function useRevokeSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, current }: { id: string; current: boolean }) => {
      await api.delete(`/auth/sessions/${id}`);
      if (!current) await queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
}

export function useRevokeOtherSessions() {
  return useApiMutation((api, _: void) => api.post('/auth/sessions/revoke-others'), [sessionsKey]);
}

export function useLogoutEverywhere() {
  return useApiMutation((api, _: void) => api.post('/auth/logout-all'), []);
}

export function useChangePassword() {
  return useApiMutation(
    (api, body: { currentPassword: string; newPassword: string }) => api.post('/auth/password/change', body),
    [sessionsKey],
  );
}
