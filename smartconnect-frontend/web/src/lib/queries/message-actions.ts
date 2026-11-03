// What a message offers beyond text, for channels and for direct and group conversations alike: thread replies,
// reactions and saving. A scope names where the messages live; the hooks do the rest.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type { Message, MessageContext, Page, Reaction, SavedMessage } from '@/lib/api/types';
import { useApi } from '@/lib/services';

export const REPLY_POLL_MS = 10_000;
export const SAVED_POLL_MS = 30_000;
const PAGE_SIZE = 50;

export interface MessageScope {
  /** `/orgs/o/workspaces/w/channels/c/messages` or `/orgs/o/conversations/id/messages`. */
  path: string;
  /** Key of the timeline. Replies live below it, so whatever refreshes the timeline refreshes them too. */
  key: QueryKey;
}

export const channelScope = (orgId: string, workspaceId: string, channelId: string): MessageScope => ({
  path: `/orgs/${orgId}/workspaces/${workspaceId}/channels/${channelId}/messages`,
  key: ['orgs', orgId, 'workspaces', workspaceId, 'channels', channelId, 'messages'],
});

export const conversationScope = (orgId: string, conversationId: string): MessageScope => ({
  path: `/orgs/${orgId}/conversations/${conversationId}/messages`,
  key: ['orgs', orgId, 'conversations', 'item', conversationId, 'messages'],
});

export const savedKey = (orgId: string) => ['orgs', orgId, 'saved'] as const;

/** The scope a saved message lives in. */
export const scopeOfSaved = (orgId: string, message: SavedMessage): MessageScope =>
  message.channelId && message.workspaceId
    ? channelScope(orgId, message.workspaceId, message.channelId)
    : conversationScope(orgId, message.conversationId);

type Reacting = Pick<Message, 'id' | 'reactions'>;

/** Applies `patch` to one message wherever it is cached (timeline pages and thread replies). */
function patchMessage<T extends { id: string }>(
  queryClient: QueryClient,
  key: QueryKey,
  id: string,
  patch: (message: T) => T,
) {
  queryClient.setQueriesData<InfiniteData<Page<T>>>({ queryKey: key }, (data) =>
    data && Array.isArray(data.pages)
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            data: page.data.map((message) => (message.id === id ? patch(message) : message)),
          })),
        }
      : data,
  );
}

export function withReaction(reactions: Reaction[], emoji: string, on: boolean): Reaction[] {
  const found = reactions.find((reaction) => reaction.emoji === emoji);
  if (on) {
    if (found?.reacted) return reactions;
    return found
      ? reactions.map((r) => (r === found ? { ...r, count: r.count + 1, reacted: true } : r))
      : [...reactions, { emoji, count: 1, reacted: true }];
  }
  if (!found?.reacted) return reactions;
  return found.count <= 1
    ? reactions.filter((r) => r !== found)
    : reactions.map((r) => (r === found ? { ...r, count: r.count - 1, reacted: false } : r));
}

/** Replies of one thread, oldest first. */
export function useReplies(scope: MessageScope, rootId: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...scope.key, 'replies', rootId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<Message>>(`${scope.path}/${rootId}/replies`, { limit: PAGE_SIZE, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: REPLY_POLL_MS,
  });
}

export const CONTEXT_SIZE = 10;

/** A message with the ones around it (a jump from search, activity or a link). Lives below the timeline key. */
export function useMessageContext(scope: MessageScope, messageId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...scope.key, 'context', messageId],
    enabled: messageId !== undefined,
    queryFn: ({ signal }) =>
      api.get<MessageContext<Message>>(
        `${scope.path}/${messageId}/context`,
        { before: CONTEXT_SIZE, after: CONTEXT_SIZE },
        signal,
      ),
    retry: false,
    refetchInterval: REPLY_POLL_MS,
  });
}

/** Repeating a clientMessageId is safe: the server replays the original reply. */
export function useSendReply(scope: MessageScope, rootId: string) {
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
    }) => api.post<Message>(scope.path, { body, clientMessageId, threadRootId: rootId, attachmentFileIds }),
    // The reply list, and the reply count on the root.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: scope.key }),
  });
}

/** PUT/DELETE of a reaction, shown at once and corrected by the refetch if the server disagrees. */
export function useReact(scope: MessageScope) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, emoji, on }: { id: string; emoji: string; on: boolean }) => {
      const path = `${scope.path}/${id}/reactions/${encodeURIComponent(emoji)}`;
      return on ? api.put<void>(path) : api.delete(path);
    },
    onMutate: ({ id, emoji, on }) =>
      patchMessage<Reacting>(queryClient, scope.key, id, (m) => ({
        ...m,
        reactions: withReaction(m.reactions, emoji, on),
      })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: scope.key }),
  });
}

export function useBookmark(scope: MessageScope, orgId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, saved }: { id: string; saved: boolean }) =>
      saved ? api.put<void>(`${scope.path}/${id}/bookmark`) : api.delete(`${scope.path}/${id}/bookmark`),
    onMutate: ({ id, saved }) =>
      patchMessage<{ id: string; bookmarked: boolean }>(queryClient, scope.key, id, (m) => ({
        ...m,
        bookmarked: saved,
      })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: scope.key }),
        queryClient.invalidateQueries({ queryKey: savedKey(orgId) }),
      ]),
  });
}

/** Messages the signed-in person saved and can still see, most recently saved first. */
export function useSavedMessages(orgId: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: savedKey(orgId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<SavedMessage>>(`/orgs/${orgId}/saved-messages`, { limit: PAGE_SIZE, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: SAVED_POLL_MS,
  });
}

/** Removes a message from the saved list (from the saved page, where the scope comes from the message itself). */
export function useUnsave(orgId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: SavedMessage) => api.delete(`${scopeOfSaved(orgId, message).path}/${message.id}/bookmark`),
    onSettled: (_data, _error, message) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: savedKey(orgId) }),
        queryClient.invalidateQueries({ queryKey: scopeOfSaved(orgId, message).key }),
      ]),
  });
}
