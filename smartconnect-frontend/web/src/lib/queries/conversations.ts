import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { createContext, use, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import type { Conversation, ConversationMessage, Member, MessagePage, Page, Participant } from '@/lib/api/types';
import { useApi, useRealtime } from '@/lib/services';
import { conversationScope } from './message-actions';
import { useApiMutation } from './mutation';

export const CONVERSATION_POLL_MS = 5000;
export const CONVERSATION_LIST_POLL_MS = 30_000;
/** While the inbox subscription works, events drive refetching and polling is only a safety net. */
export const CONVERSATION_LIVE_POLL_MS = 60_000;
const PAGE_SIZE = 50;
const LIST_PAGE_SIZE = 30;
const LOOKUP_CHUNK = 100;

const baseKey = (orgId: string) => ['orgs', orgId, 'conversations'] as const;
const listKey = (orgId: string) => [...baseKey(orgId), 'list'] as const;
const itemKey = (orgId: string, id: string) => [...baseKey(orgId), 'item', id] as const;
const messagesKey = (orgId: string, id: string) => conversationScope(orgId, id).key;
const path = (orgId: string, id?: string) => `/orgs/${orgId}/conversations${id ? `/${id}` : ''}`;

/** Whether the organization's inbox subscription is delivering events; provided by the messages layout. */
export const InboxLiveContext = createContext(false);

/** Follows the inbox of one organization: events refetch the list and the conversation they name. */
export function useInboxWatch(orgId: string): boolean {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(
    () =>
      realtime.watchInbox(orgId, {
        // null: events may have been missed, so everything is refetched.
        onEvent: (id) =>
          void queryClient.invalidateQueries({
            queryKey: baseKey(orgId),
            predicate: ({ queryKey }) => !id || queryKey[3] === 'list' || queryKey[4] === id,
          }),
        onLive: setLive,
      }),
    [realtime, queryClient, orgId],
  );
  return live;
}

const refreshAll = (queryClient: QueryClient, orgId: string) =>
  queryClient.invalidateQueries({ queryKey: baseKey(orgId) });

/** Polling every `ms`, rarely while events arrive, and not at all once the conversation is gone (404). */
function useInterval(ms: number) {
  const live = use(InboxLiveContext);
  return (query: { state: { error: Error | null } }) =>
    isNotFound(query.state.error) ? false : live ? CONVERSATION_LIVE_POLL_MS : ms;
}

/** Ordered as served (lastActivityAt, newest first). */
export function useConversations(orgId: string) {
  const api = useApi();
  const interval = useInterval(CONVERSATION_LIST_POLL_MS);
  return useInfiniteQuery({
    queryKey: listKey(orgId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<Conversation>>(path(orgId), { limit: LIST_PAGE_SIZE, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: interval,
  });
}

export function useConversation(orgId: string, id: string) {
  const api = useApi();
  const interval = useInterval(CONVERSATION_POLL_MS);
  return useQuery({
    queryKey: itemKey(orgId, id),
    queryFn: ({ signal }) => api.get<Conversation>(path(orgId, id), undefined, signal),
    refetchInterval: interval,
  });
}

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

export function useConversationMessages(orgId: string, id: string) {
  const api = useApi();
  const interval = useInterval(CONVERSATION_POLL_MS);
  return useInfiniteQuery({
    queryKey: messagesKey(orgId, id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<MessagePage<ConversationMessage>>(
        `${path(orgId, id)}/messages`,
        { limit: PAGE_SIZE, cursor: pageParam },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: interval,
  });
}

type Pages = InfiniteData<MessagePage<ConversationMessage>, string | undefined>;

/** Sends with a caller-chosen clientMessageId: repeating it is safe (the server replays the original message). */
export function useSendConversationMessage(orgId: string, id: string) {
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
    }) => api.post<ConversationMessage>(`${path(orgId, id)}/messages`, { body, clientMessageId, attachmentFileIds }),
    onSuccess: (message) => {
      queryClient.setQueryData<Pages>(messagesKey(orgId, id), (pages) => {
        const [first, ...rest] = pages?.pages ?? [];
        if (!pages || !first || pages.pages.some((page) => page.data.some((item) => item.id === message.id))) {
          return pages;
        }
        return { ...pages, pages: [{ ...first, data: [message, ...first.data] }, ...rest] };
      });
      void queryClient.invalidateQueries({ queryKey: listKey(orgId) });
    },
  });
}

export function useEditConversationMessage(orgId: string, id: string) {
  return useApiMutation(
    (api, { id: messageId, body }: { id: string; body: string }) =>
      api.patch<ConversationMessage>(`${path(orgId, id)}/messages/${messageId}`, { body }),
    [messagesKey(orgId, id)],
  );
}

export function useDeleteConversationMessage(orgId: string, id: string) {
  return useApiMutation(
    (api, messageId: string) => api.delete(`${path(orgId, id)}/messages/${messageId}`),
    [messagesKey(orgId, id), listKey(orgId)],
  );
}

/** Moves the read cursor forward; the unread count of the list and the conversation then change. */
export function useMarkRead(orgId: string, id: string) {
  return useApiMutation(
    (api, messageId: string) => api.post<void>(`${path(orgId, id)}/read`, { messageId }),
    [listKey(orgId), itemKey(orgId, id)],
  );
}

export function useStartDirect(orgId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    // 200 (existed) and 201 (created) both resolve with the conversation.
    mutationFn: (userId: string) => api.post<Conversation>(`${path(orgId)}/direct`, { userId }),
    onSuccess: () => refreshAll(queryClient, orgId),
  });
}

export function useCreateGroup(orgId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { title?: string; userIds: string[] }) => api.post<Conversation>(`${path(orgId)}/groups`, body),
    onSuccess: () => refreshAll(queryClient, orgId),
  });
}

export function useRenameGroup(orgId: string, id: string) {
  return useApiMutation(
    (api, title: string | null) => api.patch<Conversation>(path(orgId, id), { title }),
    [baseKey(orgId)],
  );
}

export function useSetParticipant(orgId: string, id: string) {
  return useApiMutation(
    (api, { userId, role }: { userId: string; role?: Participant['role'] }) =>
      api.put<Participant>(`${path(orgId, id)}/participants/${userId}`, role ? { role } : {}),
    [baseKey(orgId)],
  );
}

/** Removing someone, or leaving (the caller's own id). */
export function useRemoveParticipant(orgId: string, id: string) {
  return useApiMutation(
    (api, userId: string) => api.delete(`${path(orgId, id)}/participants/${userId}`),
    [baseKey(orgId)],
  );
}

/**
 * Names for user ids, from the member directory (`?userId=a&userId=b`). The directory answers active members
 * only: anyone missing has left the organization and is shown as a former member.
 */
export function useMemberNames(orgId: string, userIds: readonly string[]) {
  const api = useApi();
  const ids = useMemo(() => [...new Set(userIds)].sort(), [userIds]);
  const lookup = useQuery({
    queryKey: ['orgs', orgId, 'members', 'lookup', ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const found: Member[] = [];
      for (let from = 0; from < ids.length; from += LOOKUP_CHUNK) {
        const page = await api.get<Page<Member>>(`/orgs/${orgId}/members`, {
          userId: ids.slice(from, from + LOOKUP_CHUNK),
          limit: LOOKUP_CHUNK,
        });
        found.push(...page.data);
      }
      return found;
    },
  });
  const names = useMemo(() => new Map(lookup.data?.map((m) => [m.userId, m.displayName])), [lookup.data]);
  return (userId: string | null) => (userId && names.get(userId)) || (lookup.isSuccess ? 'Former member' : '…');
}

/** Heading for a conversation: its title, else the other participants' names. */
export function conversationName(
  conversation: Pick<Conversation, 'title' | 'participants'>,
  selfId: string,
  nameOf: (userId: string) => string,
): string {
  if (conversation.title) return conversation.title;
  const others = conversation.participants.filter((p) => p.userId !== selfId).map((p) => nameOf(p.userId));
  return others.length > 0 ? others.join(', ') : 'Just you';
}
