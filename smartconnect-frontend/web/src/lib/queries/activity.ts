import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Page } from '@/lib/api/types';
import { useApi, useRealtime } from '@/lib/services';
import { useApiMutation } from './mutation';

export const ACTIVITY_POLL_MS = 30_000;
/** While the inbox subscription works, events drive refetching and polling is only a safety net. */
export const ACTIVITY_LIVE_POLL_MS = 60_000;
/** The server caps the unread count at 100, which means "100 or more". */
export const ACTIVITY_COUNT_CAP = 100;
const PAGE_SIZE = 30;

export type ActivityFilter = 'all' | 'unread' | 'mentions' | 'threads';
export type NotificationLevel = 'all' | 'mentions' | 'none';

export type ActivityLocation =
  { kind: 'channel'; workspaceId: string; channelId: string } | { kind: 'direct' | 'group'; conversationId: string };

export interface ActivityItem {
  /** "<kind>:<messageId>" */
  id: string;
  kind: 'mention' | 'thread_reply';
  message: {
    id: string;
    senderUserId: string | null;
    /** Plain text, at most 200 characters; mentions stay as `<@userId>` tokens. */
    excerpt: string;
    createdAt: string;
    threadRootId: string | null;
  };
  location: ActivityLocation;
  unread: boolean;
}

export interface NotificationPreference {
  location: ActivityLocation;
  level: Exclude<NotificationLevel, 'all'>;
}

const baseKey = (orgId: string) => ['orgs', orgId, 'activity'] as const;
const countKey = (orgId: string) => [...baseKey(orgId), 'unread-count'] as const;
const listKey = (orgId: string, filter: ActivityFilter) => [...baseKey(orgId), 'list', filter] as const;
const prefsKey = (orgId: string) => ['orgs', orgId, 'notification-preferences'] as const;
const path = (orgId: string, suffix = '') => `/orgs/${orgId}/activity${suffix}`;

/** Follows the inbox events of one organization and refetches activity on each; returns whether events arrive. */
export function useActivityWatch(orgId: string | undefined): boolean {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!orgId) return;
    return realtime.watchInbox(orgId, {
      onEvent: () => void queryClient.invalidateQueries({ queryKey: baseKey(orgId) }),
      onLive: setLive,
    });
  }, [realtime, queryClient, orgId]);
  return orgId ? live : false;
}

/** Unread activity items (at most 100), polled every 30 s, or 60 s while the inbox is live. */
export function useUnreadActivityCount(orgId: string | undefined, live: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: countKey(orgId ?? ''),
    enabled: orgId !== undefined,
    queryFn: ({ signal }) => api.get<{ count: number }>(path(orgId ?? '', '/unread-count'), undefined, signal),
    select: (data) => data.count,
    refetchInterval: live ? ACTIVITY_LIVE_POLL_MS : ACTIVITY_POLL_MS,
  });
}

export function useActivity(orgId: string, filter: ActivityFilter) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: listKey(orgId, filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<ActivityItem>>(path(orgId), { filter, limit: PAGE_SIZE, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: ACTIVITY_POLL_MS,
  });
}

export function useMarkActivityRead(orgId: string) {
  return useApiMutation(
    (api, itemIds: string[]) => api.post<void>(path(orgId, '/read'), { itemIds }),
    [baseKey(orgId)],
  );
}

export function useMarkAllActivityRead(orgId: string) {
  return useApiMutation((api, _: void) => api.post<void>(path(orgId, '/read-all')), [baseKey(orgId)]);
}

/** The levels that differ from "all". */
export function useNotificationPreferences(orgId: string) {
  const api = useApi();
  return useQuery({
    queryKey: prefsKey(orgId),
    queryFn: ({ signal }) =>
      api.get<{ data: NotificationPreference[] }>(`/orgs/${orgId}/notification-preferences`, undefined, signal),
    select: (data) => data.data,
  });
}

export const levelAt = (prefs: NotificationPreference[] | undefined, location: ActivityLocation): NotificationLevel =>
  prefs?.find((pref) =>
    pref.location.kind === 'channel'
      ? location.kind === 'channel' && pref.location.channelId === location.channelId
      : location.kind !== 'channel' && pref.location.conversationId === location.conversationId,
  )?.level ?? 'all';

export function useSetNotificationLevel(orgId: string, location: ActivityLocation) {
  const url =
    location.kind === 'channel'
      ? `/orgs/${orgId}/workspaces/${location.workspaceId}/channels/${location.channelId}/messages/preferences`
      : `/orgs/${orgId}/conversations/${location.conversationId}/preferences`;
  return useApiMutation(
    (api, level: NotificationLevel) => api.put<void>(url, { level }),
    [prefsKey(orgId), baseKey(orgId)],
  );
}
