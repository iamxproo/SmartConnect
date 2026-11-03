import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { Invitation, InvitationStatus, Member, Membership, Organization, OrgSummary, Role } from '@/lib/api/types';
import { useApi } from '@/lib/services';
import { useApiMutation } from './mutation';

export const orgsKey = ['orgs', 'list'] as const;
const orgKey = (orgId: string) => ['orgs', orgId] as const;

export function useOrgs() {
  const api = useApi();
  return useQuery({
    queryKey: orgsKey,
    queryFn: async () => (await api.get<{ data: OrgSummary[] }>('/orgs')).data,
  });
}

/** The organization named by the current URL (`/o/$orgSlugOrId/...`), resolved through the caller's own list. */
export function useCurrentOrg() {
  const ref = useParams({ strict: false }).orgSlugOrId;
  const orgs = useOrgs();
  const org = ref ? orgs.data?.find((candidate) => candidate.slug === ref || candidate.id === ref) : undefined;
  return { ref, org, orgs };
}

/** The organization of the current URL, inside the org layout (which only renders its children when it exists). */
export function useRequiredOrg(): OrgSummary {
  const { org } = useCurrentOrg();
  if (!org) throw new Error('useRequiredOrg must be used below the organization layout');
  return org;
}

export function useOrganization(orgId: string) {
  const api = useApi();
  return useQuery({ queryKey: [...orgKey(orgId), 'details'], queryFn: () => api.get<Organization>(`/orgs/${orgId}`) });
}

export function useMembership(orgId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...orgKey(orgId ?? ''), 'membership'],
    queryFn: () => api.get<Membership>(`/orgs/${orgId}/me`),
    enabled: orgId !== undefined,
  });
}

/** UI-only permission check (`*` = everything). The server stays authoritative and may still answer 403. */
export function usePermissions(orgId: string | undefined): (permission: string) => boolean {
  const permissions = useMembership(orgId).data?.role.permissions;
  return (permission) => permissions?.includes('*') === true || permissions?.includes(permission) === true;
}

export const useCan = (orgId: string | undefined, permission: string): boolean => usePermissions(orgId)(permission);

export function useRoles(orgId: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...orgKey(orgId), 'roles'],
    queryFn: async () => (await api.get<{ data: Role[] }>(`/orgs/${orgId}/roles`)).data,
  });
}

export function useMembers(orgId: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...orgKey(orgId), 'members'],
    queryFn: () => api.listAll<Member>(`/orgs/${orgId}/members`),
  });
}

export function useCreateOrg() {
  return useApiMutation(
    (api, body: { name: string; slug: string; description?: string }) => api.post<Organization>('/orgs', body),
    [orgsKey],
  );
}

export function useUpdateOrganization(orgId: string) {
  return useApiMutation(
    (api, body: { name: string; description: string | null; settings: { invitationExpiryDays: number } }) =>
      api.patch<Organization>(`/orgs/${orgId}`, body),
    [orgKey(orgId), orgsKey],
  );
}

export function useUpdateMember(orgId: string) {
  return useApiMutation(
    (api, { memberId, roleId }: { memberId: string; roleId: string }) =>
      api.patch<Member>(`/orgs/${orgId}/members/${memberId}`, { roleId }),
    [
      [...orgKey(orgId), 'members'],
      [...orgKey(orgId), 'membership'],
    ],
  );
}

export function useRemoveMember(orgId: string) {
  return useApiMutation(
    (api, memberId: string) => api.delete(`/orgs/${orgId}/members/${memberId}`),
    [[...orgKey(orgId), 'members'], orgsKey],
  );
}

export function useInvitations(orgId: string, status: InvitationStatus | '') {
  const api = useApi();
  return useQuery({
    queryKey: [...orgKey(orgId), 'invitations', status],
    queryFn: () => api.listAll<Invitation>(`/orgs/${orgId}/invitations`, { status }),
  });
}

const invitationsKey = (orgId: string) => [...orgKey(orgId), 'invitations'];

export function useSendInvitation(orgId: string) {
  return useApiMutation(
    (api, body: { email: string; roleId: string }) => api.post<Invitation>(`/orgs/${orgId}/invitations`, body),
    [invitationsKey(orgId)],
  );
}

export function useResendInvitation(orgId: string) {
  return useApiMutation(
    (api, id: string) => api.post<Invitation>(`/orgs/${orgId}/invitations/${id}/resend`),
    [invitationsKey(orgId)],
  );
}

export function useRevokeInvitation(orgId: string) {
  return useApiMutation((api, id: string) => api.delete(`/orgs/${orgId}/invitations/${id}`), [invitationsKey(orgId)]);
}
