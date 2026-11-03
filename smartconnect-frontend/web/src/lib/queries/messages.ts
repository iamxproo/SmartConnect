import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Message, MessagePage } from '@/lib/api/types';
import { useApi, useRealtime } from '@/lib/services';
import { channelScope } from './message-actions';
import { useApiMutation } from './mutation';

export const MESSAGE_POLL_MS = 5000;
export const MESSAGE_LIVE_POLL_MS = 60_000;
const PAGE_SIZE = 50;

const basePath = (orgId: string, workspaceId: string, channelId: string) =>
  channelScope(orgId, workspaceId, channelId).path;
const messagesKey = (orgId: string, workspaceId: string, channelId: string) =>
  channelScope(orgId, workspaceId, channelId).key;

type Pages = InfiniteData<MessagePage<Message>, string | undefined>;

/**
 * Newest-first pages. Realtime events (ids only) refetch the loaded pages; every refetch replaces them, so edits,
 * deletions and new messages all merge. Without a live subscription the pages are polled every few seconds while
 * the tab is visible; with one, rarely, because realtime delivery is best effort.
 */
export function useMessages(orgId: string, workspaceId: string, channelId: string) {
  const api = useApi();
  const live = useLiveChannel(orgId, workspaceId, channelId);
  return useInfiniteQuery({
    queryKey: messagesKey(orgId, workspaceId, channelId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<MessagePage<Message>>(
        basePath(orgId, workspaceId, channelId),
        { limit: PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live ? MESSAGE_LIVE_POLL_MS : MESSAGE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

function useLiveChannel(orgId: string, workspaceId: string, channelId: string): boolean {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(
    () =>
      realtime.watch(
        { organizationId: orgId, workspaceId, channelId },
        {
          onChange: () => void queryClient.invalidateQueries({ queryKey: messagesKey(orgId, workspaceId, channelId) }),
          onLive: setLive,
        },
      ),
    [realtime, queryClient, orgId, workspaceId, channelId],
  );
  return live;
}

/** Sends with a caller-chosen clientMessageId: repeating it is safe (the server replays the original message). */
export function useSendMessage(orgId: string, workspaceId: string, channelId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      body,
      clientMessageId,
      attachmentFileIds,
    }: {
      body: string;
      clientMessageId: string;
      attachmentFileIds?: string[];
    }) => api.post<Message>(basePath(orgId, workspaceId, channelId), { body, clientMessageId, attachmentFileIds }),
    onSuccess: (message) => {
      // Show the confirmed message at once instead of waiting for the next poll.
      queryClient.setQueryData<Pages>(messagesKey(orgId, workspaceId, channelId), (pages) => {
        const [first, ...rest] = pages?.pages ?? [];
        if (!pages || !first || pages.pages.some((page) => page.data.some((item) => item.id === message.id))) {
          return pages;
        }
        return { ...pages, pages: [{ ...first, data: [message, ...first.data] }, ...rest] };
      });
    },
  });
}

export function useEditMessage(orgId: string, workspaceId: string, channelId: string) {
  return useApiMutation(
    (api, { id, body }: { id: string; body: string }) =>
      api.patch<Message>(`${basePath(orgId, workspaceId, channelId)}/${id}`, { body }),
    [messagesKey(orgId, workspaceId, channelId)],
  );
}

export function useDeleteMessage(orgId: string, workspaceId: string, channelId: string) {
  return useApiMutation(
    (api, id: string) => api.delete(`${basePath(orgId, workspaceId, channelId)}/${id}`),
    [messagesKey(orgId, workspaceId, channelId)],
  );
}

/** Moves the channel read cursor forward to a message. Nothing needs refetching: the unread count is read on opening. */
export function useMarkChannelRead(orgId: string, workspaceId: string, channelId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (messageId: string) => api.post<void>(`${basePath(orgId, workspaceId, channelId)}/read`, { messageId }),
  });
}
