import { useQuery } from '@tanstack/react-query';
import type { StoredFile } from '@/lib/api/types';
import { useApi } from '@/lib/services';
import { useApiMutation } from './mutation';

export const filesKey = (orgId: string) => ['orgs', orgId, 'files'] as const;

/** The signed-in person's own uploaded files, newest first. */
export function useFiles(orgId: string) {
  const api = useApi();
  return useQuery({ queryKey: filesKey(orgId), queryFn: () => api.listAll<StoredFile>(`/orgs/${orgId}/files`) });
}

export function useDeleteFile(orgId: string) {
  return useApiMutation((api, id: string) => api.delete(`/orgs/${orgId}/files/${id}`), [filesKey(orgId)]);
}
