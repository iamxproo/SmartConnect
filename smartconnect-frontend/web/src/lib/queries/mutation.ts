import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { useApi } from '@/lib/services';

/** A mutation that refreshes the listed query-key prefixes once it succeeds. */
export function useApiMutation<Variables, Result>(
  run: (api: ApiClient, variables: Variables) => Promise<Result>,
  invalidate: readonly QueryKey[],
) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: Variables) => run(api, variables),
    onSuccess: () => Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}
