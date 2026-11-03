import { useQuery } from '@tanstack/react-query';
import type { Channel, Workspace, WorkspaceMember } from '@/lib/api/types';
import { useApi } from '@/lib/services';
import { useApiMutation } from './mutation';

const workspacesKey = (orgId: string) => ['orgs', orgId, 'workspaces'] as const;
const workspaceKey = (orgId: string, workspaceId: string) => [...workspacesKey(orgId), workspaceId] as const;
const channelsKey = (orgId: string, workspaceId: string) => [...workspaceKey(orgId, workspaceId), 'channels'] as const;
const workspacePath = (orgId: string, workspaceId: string) => `/orgs/${orgId}/workspaces/${workspaceId}`;

export function useWorkspaces(orgId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: workspacesKey(orgId ?? ''),
    queryFn: () => api.listAll<Workspace>(`/orgs/${orgId}/workspaces`),
    enabled: orgId !== undefined,
  });
}

export function useWorkspace(orgId: string, workspaceId: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...workspaceKey(orgId, workspaceId), 'details'],
    queryFn: () => api.get<Workspace>(workspacePath(orgId, workspaceId)),
  });
}

export function useWorkspaceMembers(orgId: string, workspaceId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...workspaceKey(orgId, workspaceId), 'members'],
    queryFn: () => api.listAll<WorkspaceMember>(`${workspacePath(orgId, workspaceId)}/members`),
    enabled,
  });
}

/** Channels are listed for members only (public ones plus the private ones the caller is in). */
export function useChannels(orgId: string | undefined, workspaceId: string | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: channelsKey(orgId ?? '', workspaceId ?? ''),
    queryFn: () => api.listAll<Channel>(`${workspacePath(orgId!, workspaceId!)}/channels`),
    enabled: enabled && orgId !== undefined && workspaceId !== undefined,
  });
}

export function useChannel(orgId: string, workspaceId: string, channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...channelsKey(orgId, workspaceId), channelId],
    queryFn: () => api.get<Channel>(`${workspacePath(orgId, workspaceId)}/channels/${channelId}`),
  });
}

export function useChannelMembers(orgId: string, workspaceId: string, channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...channelsKey(orgId, workspaceId), channelId, 'members'],
    queryFn: () => api.listAll<WorkspaceMember>(`${workspacePath(orgId, workspaceId)}/channels/${channelId}/members`),
  });
}

export function useCreateWorkspace(orgId: string) {
  return useApiMutation(
    (api, body: { name: string; slug: string; description?: string; visibility: 'open' | 'private' }) =>
      api.post<Workspace>(`/orgs/${orgId}/workspaces`, body),
    [workspacesKey(orgId)],
  );
}

export function useUpdateWorkspace(orgId: string, workspaceId: string) {
  return useApiMutation(
    (api, body: { name: string; description: string | null; visibility: 'open' | 'private' }) =>
      api.patch<Workspace>(workspacePath(orgId, workspaceId), body),
    [workspacesKey(orgId)],
  );
}

export function useJoinWorkspace(orgId: string) {
  return useApiMutation(
    (api, workspaceId: string) => api.post<Workspace>(`${workspacePath(orgId, workspaceId)}/join`),
    [workspacesKey(orgId)],
  );
}

export function useLeaveWorkspace(orgId: string) {
  return useApiMutation(
    (api, workspaceId: string) => api.post(`${workspacePath(orgId, workspaceId)}/leave`),
    [workspacesKey(orgId)],
  );
}

export function useCreateChannel(orgId: string, workspaceId: string) {
  return useApiMutation(
    (api, body: { name: string; topic?: string; description?: string; type: 'public' | 'private' }) =>
      api.post<Channel>(`${workspacePath(orgId, workspaceId)}/channels`, body),
    [channelsKey(orgId, workspaceId)],
  );
}

export function useJoinChannel(orgId: string, workspaceId: string) {
  return useApiMutation(
    (api, channelId: string) => api.post<Channel>(`${workspacePath(orgId, workspaceId)}/channels/${channelId}/join`),
    [channelsKey(orgId, workspaceId)],
  );
}

export function useLeaveChannel(orgId: string, workspaceId: string) {
  return useApiMutation(
    (api, channelId: string) => api.post(`${workspacePath(orgId, workspaceId)}/channels/${channelId}/leave`),
    [channelsKey(orgId, workspaceId)],
  );
}

const wsMembersKey = (orgId: string, workspaceId: string) => [...workspaceKey(orgId, workspaceId), 'members'] as const;

export function useSetWorkspaceMember(orgId: string, workspaceId: string) {
  return useApiMutation(
    (api, { userId, role }: { userId: string; role: string }) =>
      api.put<WorkspaceMember>(`${workspacePath(orgId, workspaceId)}/members/${userId}`, { role }),
    [wsMembersKey(orgId, workspaceId)],
  );
}

export function useRemoveWorkspaceMember(orgId: string, workspaceId: string) {
  return useApiMutation(
    (api, userId: string) => api.delete(`${workspacePath(orgId, workspaceId)}/members/${userId}`),
    [wsMembersKey(orgId, workspaceId)],
  );
}

export function useSetChannelMember(orgId: string, workspaceId: string, channelId: string) {
  return useApiMutation(
    (api, { userId, role }: { userId: string; role: string }) =>
      api.put<WorkspaceMember>(`${workspacePath(orgId, workspaceId)}/channels/${channelId}/members/${userId}`, {
        role,
      }),
    [[...channelsKey(orgId, workspaceId), channelId, 'members']],
  );
}

export function useRemoveChannelMember(orgId: string, workspaceId: string, channelId: string) {
  return useApiMutation(
    (api, userId: string) => api.delete(`${workspacePath(orgId, workspaceId)}/channels/${channelId}/members/${userId}`),
    [[...channelsKey(orgId, workspaceId), channelId, 'members']],
  );
}
