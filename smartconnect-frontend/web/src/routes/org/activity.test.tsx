import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_LIVE_POLL_MS, ACTIVITY_POLL_MS, type ActivityItem } from '@/lib/queries/activity';
import { json, problem, stubApi, type Handler } from '@/test/api-stub';
import { channel, conversation, inAcme, member, workspace } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const ACTIVITY = '/orgs/org-1/activity';
const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'g@example.com' });

const item = (overrides: Partial<ActivityItem> & { id: string }): ActivityItem => ({
  kind: 'mention',
  message: {
    id: overrides.id.split(':')[1]!,
    senderUserId: 'user-2',
    excerpt: 'ping <@user-1> about the plan',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    threadRootId: null,
  },
  location: { kind: 'channel', workspaceId: 'ws-1', channelId: 'ch-1' },
  unread: true,
  ...overrides,
});
const mention = item({ id: 'mention:m1' });
const reply = item({
  id: 'thread_reply:m2',
  kind: 'thread_reply',
  unread: false,
  message: {
    id: 'm2',
    senderUserId: 'user-2',
    excerpt: 'replying here',
    createdAt: '2026-11-02T10:00:00.000Z',
    threadRootId: 'm0',
  },
  location: { kind: 'group', conversationId: 'conv-1' },
});

const setup = (extra: Record<string, Handler> = {}, items: ActivityItem[] = [mention, reply]) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/workspaces': () => ({ data: [workspace()] }),
    'GET /orgs/org-1/workspaces/ws-1': () => workspace(),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1': () => channel(),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1/members': () => ({ data: [] }),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1/messages': () => json(200, { data: [], nextCursor: null }),
    'GET /orgs/org-1/members': () => json(200, { data: [member(), grace], nextCursor: null }),
    'GET /orgs/org-1/conversations': () => json(200, { data: [conversation()], nextCursor: null }),
    'GET /orgs/org-1/conversations/conv-1': () => conversation(),
    'GET /orgs/org-1/conversations/conv-1/messages': () => json(200, { data: [], nextCursor: null }),
    [`GET ${ACTIVITY}`]: (call) => {
      const filter = call.query.get('filter');
      return json(200, {
        data: items.filter(
          (i) =>
            filter === 'all' ||
            (filter === 'unread' && i.unread) ||
            (filter === 'mentions' && i.kind === 'mention') ||
            (filter === 'threads' && i.kind === 'thread_reply'),
        ),
        nextCursor: null,
      });
    },
    ...extra,
  });

afterEach(() => vi.useRealTimers());

describe('activity bell', () => {
  it('shows the unread count, capped as 99+, and links to the activity page', async () => {
    setup({ 'GET /orgs/org-1/activity/unread-count': () => ({ count: 7 }) });
    await renderApp('/o/acme');
    const bell = await screen.findByRole('link', { name: 'Activity, 7 unread' });
    expect(bell).toHaveAttribute('href', '/o/acme/activity');
    expect(bell).toHaveTextContent('7');
  });

  it('reads "99+" at the server cap and nothing when there is nothing unread', async () => {
    const stub = setup({ 'GET /orgs/org-1/activity/unread-count': () => ({ count: 100 }) });
    await renderApp('/o/acme');
    expect(await screen.findByRole('link', { name: 'Activity, 99 or more unread' })).toHaveTextContent('99+');
    stub.on({ 'GET /orgs/org-1/activity/unread-count': () => ({ count: 0 }) });
  });

  it('polls every 30 s, every 60 s while the inbox is live, and refetches on inbox events', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stub = setup({ 'GET /orgs/org-1/activity/unread-count': () => ({ count: 1 }) });
    const { realtime } = await renderApp('/o/acme');
    await screen.findByRole('link', { name: 'Activity, 1 unread' });
    const calls = () => stub.callsTo('GET /orgs/org-1/activity/unread-count').length;

    const c0 = calls();
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MS + 200);
    expect(calls()).toBeGreaterThan(c0);

    act(() => realtime.setInboxLive(true));
    const c1 = calls();
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MS + 200);
    expect(calls()).toBe(c1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_LIVE_POLL_MS);
    expect(calls()).toBeGreaterThan(c1);

    const c2 = calls();
    act(() => realtime.inboxEvent('conv-1'));
    await waitFor(() => expect(calls()).toBeGreaterThan(c2));
  });
});

describe('activity page', () => {
  it('lists items with the sender, location, resolved excerpt and time, and has no accessibility violations', async () => {
    setup();
    await renderApp('/o/acme/activity');
    const list = await screen.findByRole('list', { name: 'Activity' });
    const [first, second] = within(list).getAllByRole('link');
    await waitFor(() => expect(first).toHaveTextContent('Grace Hopper'));
    expect(first).toHaveTextContent('mentioned you');
    expect(first).toHaveTextContent('(unread)');
    await waitFor(() => expect(first).toHaveTextContent('general'));
    await waitFor(() => expect(first).toHaveTextContent('ping @Ada Lovelace about the plan'));
    expect(first).toHaveTextContent(/5 min/);
    expect(second).toHaveTextContent('replied in a thread');
    expect(second).toHaveTextContent('Group conversation');
    expect(second).not.toHaveTextContent('(unread)');
    expect(await axeViolations()).toEqual([]);
  });

  it('asks the server for the chosen filter', async () => {
    const stub = setup();
    const { user } = await renderApp('/o/acme/activity');
    await screen.findByRole('list', { name: 'Activity' });
    const filterOf = () => stub.callsTo(`GET ${ACTIVITY}`).at(-1)!.query.get('filter');
    expect(filterOf()).toBe('all');
    for (const [name, filter] of [
      ['Unread', 'unread'],
      ['Mentions', 'mentions'],
      ['Threads', 'threads'],
    ] as const) {
      await user.click(screen.getByRole('button', { name }));
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(filterOf()).toBe(filter));
    }
    const links = await within(await screen.findByRole('list', { name: 'Activity' })).findAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('replied in a thread');
  });

  it('marks an unread item read and opens its channel with ?message=', async () => {
    const stub = setup({ 'POST /orgs/org-1/activity/read': () => undefined });
    const { user, router } = await renderApp('/o/acme/activity');
    await user.click((await screen.findAllByRole('link', { name: /mentioned you/ }))[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-1/c/ch-1'));
    expect(router.state.location.searchStr).toBe('?message=m1');
    expect(stub.callsTo('POST /orgs/org-1/activity/read').map((c) => c.body)).toEqual([{ itemIds: ['mention:m1'] }]);
  });

  it("opens a conversation item with the reply's id and does not mark an already read item", async () => {
    const stub = setup({ 'POST /orgs/org-1/activity/read': () => undefined });
    const { user, router } = await renderApp('/o/acme/activity');
    await user.click((await screen.findAllByRole('link', { name: /replied in a thread/ }))[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages/conv-1'));
    expect(router.state.location.searchStr).toBe('?message=m2');
    expect(stub.callsTo('POST /orgs/org-1/activity/read')).toHaveLength(0);
  });

  it('marks everything read', async () => {
    const stub = setup({
      'POST /orgs/org-1/activity/read-all': () => undefined,
      'GET /orgs/org-1/activity/unread-count': () => ({ count: 1 }),
    });
    const { user } = await renderApp('/o/acme/activity');
    const button = await screen.findByRole('button', { name: 'Mark all as read' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(stub.callsTo('POST /orgs/org-1/activity/read-all')).toHaveLength(1));
  });

  it('explains an empty list and a failure, and retries', async () => {
    let failing = true;
    setup({
      [`GET ${ACTIVITY}`]: () => (failing ? problem(500, 'internal') : json(200, { data: [], nextCursor: null })),
    });
    const { user } = await renderApp('/o/acme/activity');
    expect(await screen.findByText("Couldn't load activity")).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unread' }));
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });
});

describe('notification levels', () => {
  const prefs = (data: object[]) => ({ 'GET /orgs/org-1/notification-preferences': () => ({ data }) });

  it('sets the level of a channel from its header', async () => {
    const stub = setup({
      ...prefs([]),
      'PUT /orgs/org-1/workspaces/ws-1/channels/ch-1/messages/preferences': () => undefined,
    });
    const { user } = await renderApp('/o/acme/w/ws-1/c/ch-1');
    await user.click(await screen.findByRole('button', { name: 'Notifications: All' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Mentions only/ }));
    await waitFor(() =>
      expect(
        stub.callsTo('PUT /orgs/org-1/workspaces/ws-1/channels/ch-1/messages/preferences').map((c) => c.body),
      ).toEqual([{ level: 'mentions' }]),
    );
  });

  it('shows the current level of a conversation, sets it, and marks muted conversations in the list', async () => {
    const stub = setup({
      ...prefs([{ location: { kind: 'direct', conversationId: 'conv-1' }, level: 'none' }]),
      'PUT /orgs/org-1/conversations/conv-1/preferences': () => undefined,
    });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    const trigger = await screen.findByRole('button', { name: 'Notifications: Off' });
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    expect(await within(nav).findByText('Notifications off')).toBeInTheDocument();
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitemradio', { name: /All activity/ }));
    await waitFor(() =>
      expect(stub.callsTo('PUT /orgs/org-1/conversations/conv-1/preferences').map((c) => c.body)).toEqual([
        { level: 'all' },
      ]),
    );
  });
});
