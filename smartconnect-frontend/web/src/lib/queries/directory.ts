import { useQuery } from '@tanstack/react-query';
import type { Department, Team, TeamMember } from '@/lib/api/types';
import { useApi } from '@/lib/services';
import { useApiMutation } from './mutation';

const departmentsKey = (orgId: string) => ['orgs', orgId, 'departments'] as const;
const teamsKey = (orgId: string) => ['orgs', orgId, 'teams'] as const;

export function useDepartments(orgId: string) {
  const api = useApi();
  return useQuery({
    queryKey: departmentsKey(orgId),
    queryFn: async () => (await api.get<{ data: Department[] }>(`/orgs/${orgId}/departments`)).data,
  });
}

export function useCreateDepartment(orgId: string) {
  return useApiMutation(
    (api, body: { name: string; description?: string; parentId?: string }) =>
      api.post<Department>(`/orgs/${orgId}/departments`, body),
    [departmentsKey(orgId)],
  );
}

export function useUpdateDepartment(orgId: string) {
  return useApiMutation(
    (api, { id, ...body }: { id: string; name: string; description: string | null; parentId: string | null }) =>
      api.patch<Department>(`/orgs/${orgId}/departments/${id}`, body),
    [departmentsKey(orgId)],
  );
}

export function useDeleteDepartment(orgId: string) {
  return useApiMutation((api, id: string) => api.delete(`/orgs/${orgId}/departments/${id}`), [departmentsKey(orgId)]);
}

export function useTeams(orgId: string, departmentId: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...teamsKey(orgId), 'list', departmentId],
    queryFn: async () =>
      (await api.get<{ data: Team[] }>(`/orgs/${orgId}/teams`, { departmentId: departmentId || undefined })).data,
  });
}

export function useCreateTeam(orgId: string) {
  return useApiMutation(
    (api, body: { name: string; description?: string; departmentId?: string; visibility: 'public' | 'private' }) =>
      api.post<Team>(`/orgs/${orgId}/teams`, body),
    [teamsKey(orgId)],
  );
}

export function useUpdateTeam(orgId: string) {
  return useApiMutation(
    (
      api,
      {
        id,
        ...body
      }: {
        id: string;
        name: string;
        description: string | null;
        departmentId: string | null;
        visibility: 'public' | 'private';
      },
    ) => api.patch<Team>(`/orgs/${orgId}/teams/${id}`, body),
    [teamsKey(orgId)],
  );
}

export function useDeleteTeam(orgId: string) {
  return useApiMutation((api, id: string) => api.delete(`/orgs/${orgId}/teams/${id}`), [teamsKey(orgId)]);
}

export function useTeamMembers(orgId: string, teamId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...teamsKey(orgId), teamId, 'members'],
    queryFn: async () => (await api.get<{ data: TeamMember[] }>(`/orgs/${orgId}/teams/${teamId}/members`)).data,
    enabled,
  });
}

export function useSetTeamMember(orgId: string, teamId: string) {
  return useApiMutation(
    (api, { userId, role }: { userId: string; role: 'lead' | 'member' }) =>
      api.put<TeamMember>(`/orgs/${orgId}/teams/${teamId}/members/${userId}`, { role }),
    [teamsKey(orgId)],
  );
}

export function useRemoveTeamMember(orgId: string, teamId: string) {
  return useApiMutation(
    (api, userId: string) => api.delete(`/orgs/${orgId}/teams/${teamId}/members/${userId}`),
    [teamsKey(orgId)],
  );
}
