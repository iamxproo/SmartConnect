import { io, type Socket } from 'socket.io-client';
import type { ApiClient } from '@/lib/api/client';

export interface ChannelRef {
  organizationId: string;
  workspaceId: string;
  channelId: string;
}

export interface ChannelWatcher {
  /** Something in the channel changed, or events may have been missed: refetch. */
  onChange: () => void;
  /** Whether events for the channel are currently arriving. */
  onLive: (live: boolean) => void;
}

export interface InboxWatcher {
  /** A conversation changed (its id), or events may have been missed (null): refetch. */
  onEvent: (conversationId: string | null) => void;
  /** Whether events for the inbox are currently arriving. */
  onLive: (live: boolean) => void;
}

export interface RealtimeClient {
  /** Follows a channel until the returned function is called. */
  watch(ref: ChannelRef, watcher: ChannelWatcher): () => void;
  /** Follows the caller's direct and group conversations in one organization until the returned function is called. */
  watchInbox(organizationId: string, watcher: InboxWatcher): () => void;
  close(): void;
}

type Ack = { ok: true } | { ok: false; code: string };

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const channelKey = (channelId: string) => `channel:${channelId}`;
const inboxKey = (organizationId: string) => `inbox:${organizationId}`;
const backoff = (failures: number) => RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];

interface Listener {
  onLive: (live: boolean) => void;
  /** `id` is the conversation an inbox event is about; channel listeners ignore it. */
  onChange: (id?: string) => void;
}

/** One room on the gateway: a channel, or the caller's inbox of one organization. */
interface Watched {
  key: string;
  join: 'subscribe' | 'inbox.subscribe';
  leave: 'unsubscribe' | 'inbox.unsubscribe';
  payload: object;
  leavePayload: object;
  watchers: Set<Listener>;
  failures: number;
  retry?: ReturnType<typeof setTimeout>;
}

/**
 * One Socket.IO connection to the realtime gateway, opened while at least one channel is watched. Events carry ids
 * only: watchers refetch through the REST API, which authorizes again. The gateway replays nothing, so every
 * (re)subscription also triggers a refetch, which covers events missed while disconnected.
 */
export function createRealtimeClient(api: ApiClient): RealtimeClient {
  const watched = new Map<string, Watched>();
  let socket: Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const notify = (entry: Watched | undefined, live?: boolean, id?: string) => {
    for (const watcher of entry?.watchers ?? []) {
      if (live !== undefined) watcher.onLive(live);
      watcher.onChange(id);
    }
  };

  const subscribe = (entry: Watched) =>
    socket?.emit(entry.join, entry.payload, (ack: Ack) => {
      if (watched.get(entry.key) !== entry) return;
      if (ack.ok) {
        // Only a working subscription proves the session is usable: until then, reconnects keep backing off.
        attempts = 0;
        entry.failures = 0;
      } else if (ack.code === 'unavailable') resubscribeLater(entry);
      notify(entry, ack.ok);
    });

  // The gateway fails closed when it cannot check access (refusal or eviction): retry with backoff. `not_found` is
  // final, and an eviction for lost access ends with one.
  const resubscribeLater = (entry: Watched) => {
    clearTimeout(entry.retry);
    entry.retry = setTimeout(() => {
      if (watched.get(entry.key) === entry && socket?.connected) subscribe(entry);
    }, backoff(entry.failures++));
  };

  // Refused handshakes and server-side disconnects (token expired) are not retried by Socket.IO itself.
  const reconnectLater = () => {
    clearTimeout(retry);
    retry = setTimeout(() => {
      api.refresh().then((ok) => {
        if (ok && socket && watched.size > 0) socket.connect();
      }, reconnectLater);
    }, backoff(attempts++));
  };

  function open(): Socket {
    const url = (import.meta.env.VITE_REALTIME_URL as string | undefined) || undefined;
    const options = {
      path: '/realtime/socket.io',
      transports: ['websocket'],
      auth: (send: (data: object) => void) => send({ token: api.getAccessToken() ?? '' }),
    };
    const next = url ? io(url, options) : io(options);
    next.on('connect', () => {
      for (const entry of watched.values()) subscribe(entry);
    });
    next.on('disconnect', (reason) => {
      for (const { watchers } of watched.values()) for (const watcher of watchers) watcher.onLive(false);
      if (reason === 'io server disconnect') reconnectLater();
    });
    next.on('connect_error', () => {
      if (!next.active) reconnectLater();
    });
    next.on('message.changed', (event: { channelId?: unknown }) => {
      if (typeof event?.channelId === 'string') notify(watched.get(channelKey(event.channelId)));
    });
    next.on('conversation.changed', (event: { organizationId?: unknown; conversationId?: unknown }) => {
      if (typeof event?.organizationId !== 'string') return;
      const id = typeof event.conversationId === 'string' ? event.conversationId : undefined;
      notify(watched.get(inboxKey(event.organizationId)), undefined, id);
    });
    next.on('unsubscribed', (event: { channelId?: unknown }) => {
      const entry = typeof event?.channelId === 'string' ? watched.get(channelKey(event.channelId)) : undefined;
      if (!entry) return;
      notify(entry, false);
      resubscribeLater(entry);
    });
    next.on('inbox.unsubscribed', (event: { organizationId?: unknown }) => {
      const entry = typeof event?.organizationId === 'string' ? watched.get(inboxKey(event.organizationId)) : undefined;
      if (!entry) return;
      notify(entry, false);
      resubscribeLater(entry);
    });
    return next;
  }

  function close() {
    clearTimeout(retry);
    socket?.disconnect();
    socket = undefined;
  }

  function follow(topic: Omit<Watched, 'watchers' | 'failures'>, listener: Listener) {
    const entry = watched.get(topic.key) ?? { ...topic, watchers: new Set(), failures: 0 };
    watched.set(topic.key, entry);
    entry.watchers.add(listener);
    if (!socket) socket = open();
    else if (entry.watchers.size === 1 && socket.connected) subscribe(entry);
    return () => {
      entry.watchers.delete(listener);
      if (entry.watchers.size > 0) return;
      clearTimeout(entry.retry);
      watched.delete(entry.key);
      socket?.emit(entry.leave, entry.leavePayload);
      if (watched.size === 0) close();
    };
  }

  return {
    watch: (ref, watcher) =>
      follow(
        {
          key: channelKey(ref.channelId),
          join: 'subscribe',
          leave: 'unsubscribe',
          payload: ref,
          leavePayload: { channelId: ref.channelId },
        },
        { onLive: watcher.onLive, onChange: () => watcher.onChange() },
      ),
    watchInbox: (organizationId, watcher) =>
      follow(
        {
          key: inboxKey(organizationId),
          join: 'inbox.subscribe',
          leave: 'inbox.unsubscribe',
          payload: { organizationId },
          leavePayload: { organizationId },
        },
        { onLive: watcher.onLive, onChange: (id) => watcher.onEvent(id ?? null) },
      ),
    close() {
      for (const entry of watched.values()) clearTimeout(entry.retry);
      watched.clear();
      close();
    },
  };
}
