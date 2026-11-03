import type { ChannelRef, ChannelWatcher, InboxWatcher, RealtimeClient } from '@/lib/realtime';

/** In-memory realtime client: tests see what is watched and play the gateway's part. */
export function createFakeRealtime() {
  const watching = new Map<ChannelWatcher, ChannelRef>();
  const inboxes = new Map<InboxWatcher, string>();
  const watchersOf = (channelId: string) =>
    [...watching].filter(([, ref]) => ref.channelId === channelId).map(([watcher]) => watcher);
  return {
    watch(ref, watcher) {
      watching.set(watcher, ref);
      return () => watching.delete(watcher);
    },
    watchInbox(organizationId, watcher) {
      inboxes.set(watcher, organizationId);
      return () => inboxes.delete(watcher);
    },
    close: () => {
      watching.clear();
      inboxes.clear();
    },
    refs: () => [...watching.values()],
    inboxRefs: () => [...inboxes.values()],
    change: (channelId: string) => watchersOf(channelId).forEach((watcher) => watcher.onChange()),
    setLive: (channelId: string, live: boolean) => watchersOf(channelId).forEach((watcher) => watcher.onLive(live)),
    /** `conversation.changed` for a conversation, or null for "events may have been missed". */
    inboxEvent: (conversationId: string | null) =>
      [...inboxes.keys()].forEach((watcher) => watcher.onEvent(conversationId)),
    setInboxLive: (live: boolean) => [...inboxes.keys()].forEach((watcher) => watcher.onLive(live)),
  } satisfies RealtimeClient & Record<string, unknown>;
}

export type FakeRealtime = ReturnType<typeof createFakeRealtime>;
