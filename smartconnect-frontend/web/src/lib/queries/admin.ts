import { useQuery } from '@tanstack/react-query';
import type { AdminAccountSummary, AdminOrganization, Page } from '@/lib/api/types';
import { useApi } from '@/lib/services';

export const ADMIN_ORGANIZATIONS_PAGE = 50;

export function useAdminAccountSummary() {
  const api = useApi();
  return useQuery({
    queryKey: ['admin', 'accounts', 'summary'],
    queryFn: () => api.get<AdminAccountSummary>('/admin/accounts/summary'),
  });
}

/** The newest organizations on the platform (one page) and the platform total. */
export function useAdminOrganizations() {
  const api = useApi();
  return useQuery({
    queryKey: ['admin', 'organizations'],
    queryFn: () =>
      api.get<Page<AdminOrganization> & { total: number }>('/admin/organizations', { limit: ADMIN_ORGANIZATIONS_PAGE }),
  });
}
