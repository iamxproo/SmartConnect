import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@/lib/api/client';
import { createRealtimeClient } from './realtime';

const { FakeSocket, sockets } = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  /** Records what the client sends; `fire` plays the gateway. */
  class FakeSocket {
    readonly handlers = new Map<string, Handler>();
    readonly emitted: { event: string; payload: unknown; ack?: (response: unknown) => void }[] = [];
    connected = false;
    active = true;
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
    constructor(readonly options: { auth: (send: (data: object) => void) => void }) {}
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, payload: unknown, ack?: (response: unknown) => void) {
      this.emitted.push({ event, payload, ack });
      return this;
    }
    fire(event: string, ...args: unknown[]) {
      this.connected = event === 'connect' ? true : event === 'disconnect' ? false : this.connected;
      this.handlers.get(event)?.(...args);
    }
    subscribes() {
      return this.emitted.filter((e) => e.event === 'subscribe');
    }
  }
  return { FakeSocket, sockets: [] as InstanceType<typeof FakeSocket>[] };
});

vi.mock('socket.io-client', () => ({
  io: (options: ConstructorParameters<typeof FakeSocket>[0]) => {
    const socket = new FakeSocket(options);
    sockets.push(socket);
    return socket;
  },
}));

const ref = { organizationId: 'org-1', workspaceId: 'ws-1', channelId: 'ch-1' };
const watcher = () => ({ onChange: vi.fn(), onLive: vi.fn() });

function setup() {
  const api = { getAccessToken: () => 'token-1', refresh: vi.fn(() => Promise.resolve(true)) };
  const client = createRealtimeClient(api as unknown as ApiClient);
  const w = watcher();
  const stop = client.watch(ref, w);
  const socket = sockets.at(-1)!;
  socket.fire('connect');
  socket.subscribes().at(-1)!.ack!({ ok: true });
  return { api, client, w, stop, socket };
}

afterEach(() => vi.useRealTimers());

describe('realtime client', () => {
  it('connects on the first watch with the in-memory token, subscribes, then refetches once subscribed', () => {
    const { w, socket } = setup();
    expect(socket.options).toMatchObject({ path: '/realtime/socket.io', transports: ['websocket'] });
    const send = vi.fn();
    socket.options.auth(send);
    expect(send).toHaveBeenCalledWith({ token: 'token-1' });
    expect(socket.subscribes().map((e) => e.payload)).toEqual([ref]);
    expect(w.onLive).toHaveBeenLastCalledWith(true);
    expect(w.onChange).toHaveBeenCalledTimes(1);
  });

  it('refetches on events for the watched channel only', () => {
    const { w, socket } = setup();
    socket.fire('message.changed', { type: 'created', ...ref, messageId: 'm-1' });
    socket.fire('message.changed', { type: 'created', ...ref, channelId: 'other', messageId: 'm-2' });
    expect(w.onChange).toHaveBeenCalledTimes(2);
  });

  it('is not live when the gateway refuses the subscription', () => {
    const client = createRealtimeClient({ getAccessToken: () => 't' } as unknown as ApiClient);
    const w = watcher();
    client.watch(ref, w);
    const socket = sockets.at(-1)!;
    socket.fire('connect');
    socket.subscribes()[0]!.ack!({ ok: false, code: 'not_found' });
    expect(w.onLive).toHaveBeenLastCalledWith(false);
  });

  it('after the gateway ends the socket (token expiry), refreshes, reconnects, resubscribes and refetches', async () => {
    vi.useFakeTimers();
    const { api, w, socket } = setup();
    socket.fire('disconnect', 'io server disconnect');
    expect(w.onLive).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    socket.fire('connect');
    expect(socket.subscribes()).toHaveLength(2);
    socket.subscribes()[1]!.ack!({ ok: true });
    expect(w.onLive).toHaveBeenLastCalledWith(true);
    expect(w.onChange).toHaveBeenCalledTimes(2);
  });

  it('leaves dropped connections to Socket.IO’s own reconnection', async () => {
    vi.useFakeTimers();
    const { api, socket } = setup();
    socket.fire('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('refetches and stops being live when the gateway revokes the subscription', () => {
    const { w, socket } = setup();
    socket.fire('unsubscribed', { channelId: 'ch-1' });
    expect(w.onLive).toHaveBeenLastCalledWith(false);
    expect(w.onChange).toHaveBeenCalledTimes(2);
  });

  it('retries a subscription the gateway could not check, and gives up on not_found', async () => {
    vi.useFakeTimers();
    const client = createRealtimeClient({ getAccessToken: () => 't' } as unknown as ApiClient);
    const w = watcher();
    client.watch(ref, w);
    const socket = sockets.at(-1)!;
    socket.fire('connect');
    socket.subscribes()[0]!.ack!({ ok: false, code: 'unavailable' });
    expect(w.onLive).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_000);
    socket.subscribes()[1]!.ack!({ ok: true });
    expect(w.onLive).toHaveBeenLastCalledWith(true);

    // Evicted (access lost, or a check failed): one retry, which not_found ends.
    socket.fire('unsubscribed', { channelId: 'ch-1' });
    await vi.advanceTimersByTimeAsync(1_000);
    socket.subscribes()[2]!.ack!({ ok: false, code: 'not_found' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.subscribes()).toHaveLength(3);
    expect(w.onLive).toHaveBeenLastCalledWith(false);
  });

  it('keeps backing off while the gateway ends sessions before any subscription works', async () => {
    vi.useFakeTimers();
    const { api, socket } = setup();
    socket.fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    socket.fire('connect');
    socket.fire('disconnect', 'io server disconnect');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.refresh).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes and disconnects when the last watcher leaves, and on close', () => {
    const { client, stop, socket } = setup();
    stop();
    expect(socket.emitted.at(-1)).toMatchObject({ event: 'unsubscribe', payload: { channelId: 'ch-1' } });
    expect(socket.disconnect).toHaveBeenCalledTimes(1);

    client.watch(ref, watcher());
    const next = sockets.at(-1)!;
    expect(next).not.toBe(socket);
    client.close();
    expect(next.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('inbox watch', () => {
  const inboxWatcher = () => ({ onEvent: vi.fn(), onLive: vi.fn() });
  const inboxSubscribes = (socket: InstanceType<typeof FakeSocket>) =>
    socket.emitted.filter((e) => e.event === 'inbox.subscribe');

  function setupInbox() {
    const api = { getAccessToken: () => 'token-1', refresh: vi.fn(() => Promise.resolve(true)) };
    const client = createRealtimeClient(api as unknown as ApiClient);
    const w = inboxWatcher();
    const stop = client.watchInbox('org-1', w);
    const socket = sockets.at(-1)!;
    socket.fire('connect');
    inboxSubscribes(socket).at(-1)!.ack!({ ok: true });
    return { api, client, w, stop, socket };
  }

  it('subscribes on connect, goes live and asks for a full refetch once subscribed', () => {
    const { w, socket } = setupInbox();
    expect(inboxSubscribes(socket).map((e) => e.payload)).toEqual([{ organizationId: 'org-1' }]);
    expect(w.onLive).toHaveBeenLastCalledWith(true);
    expect(w.onEvent).toHaveBeenCalledTimes(1);
    expect(w.onEvent).toHaveBeenLastCalledWith(null);
  });

  it('routes conversation.changed to the watched organization with the conversation id', () => {
    const { w, socket } = setupInbox();
    socket.fire('conversation.changed', {
      organizationId: 'org-1',
      conversationId: 'conv-9',
      change: 'message.created',
      messageId: 'm-1',
    });
    socket.fire('conversation.changed', { organizationId: 'org-other', conversationId: 'conv-8', change: 'read' });
    expect(w.onEvent).toHaveBeenCalledTimes(2);
    expect(w.onEvent).toHaveBeenLastCalledWith('conv-9');
  });

  it('resubscribes after a reconnect and refetches', async () => {
    vi.useFakeTimers();
    const { api, w, socket } = setupInbox();
    socket.fire('disconnect', 'io server disconnect');
    expect(w.onLive).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    socket.fire('connect');
    expect(inboxSubscribes(socket)).toHaveLength(2);
    inboxSubscribes(socket)[1]!.ack!({ ok: true });
    expect(w.onLive).toHaveBeenLastCalledWith(true);
    expect(w.onEvent).toHaveBeenCalledTimes(2);
  });

  it('retries `unavailable` with backoff, treats inbox.unsubscribed as a retry, and ends on not_found', async () => {
    vi.useFakeTimers();
    const { w, socket } = setupInbox();
    socket.fire('inbox.unsubscribed', { organizationId: 'org-1' });
    expect(w.onLive).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inboxSubscribes(socket)).toHaveLength(2);
    inboxSubscribes(socket)[1]!.ack!({ ok: false, code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(inboxSubscribes(socket)).toHaveLength(3);
    inboxSubscribes(socket)[2]!.ack!({ ok: false, code: 'not_found' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inboxSubscribes(socket)).toHaveLength(3);
    expect(w.onLive).toHaveBeenLastCalledWith(false);
  });

  it('shares the socket with channel watches and leaves the inbox on unwatch', () => {
    const { client, stop, socket } = setupInbox();
    const stopChannel = client.watch(ref, watcher());
    expect(sockets.at(-1)).toBe(socket);
    socket.subscribes().at(-1)!.ack!({ ok: true });
    stop();
    expect(socket.emitted.at(-1)).toMatchObject({ event: 'inbox.unsubscribe', payload: { organizationId: 'org-1' } });
    expect(socket.disconnect).not.toHaveBeenCalled();
    stopChannel();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
