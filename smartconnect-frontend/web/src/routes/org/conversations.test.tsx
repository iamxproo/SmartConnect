import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_LIST_POLL_MS,
  CONVERSATION_LIVE_POLL_MS,
  CONVERSATION_POLL_MS,
} from '@/lib/queries/conversations';
import { json, problem, stubApi, type Handler } from '@/test/api-stub';
import { conversation, conversationMessage, inAcme, member } from '@/test/fixtures';
import { actionsOf, chooseAction } from '@/test/message-actions';
import { axeViolations, renderApp } from '@/test/render-app';

const CONVS = '/orgs/org-1/conversations';
const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' });
const alan = member({ id: 'member-3', userId: 'user-3', displayName: 'Alan Turing', email: 'alan@example.com' });
const lin = member({ id: 'member-4', userId: 'user-4', displayName: 'Lin Clark', email: 'lin@example.com' });
const directory = [member(), grace, alan, lin];

const group = (overrides: Partial<ReturnType<typeof conversation>> = {}) =>
  conversation({
    id: 'conv-g',
    kind: 'group',
    title: 'Compilers',
    myRole: 'admin',
    participants: [
      { userId: 'user-1', role: 'admin', joinedAt: '2026-11-01T00:00:00.000Z' },
      { userId: 'user-2', role: 'member', joinedAt: '2026-11-01T00:00:00.000Z' },
      { userId: 'user-3', role: 'member', joinedAt: '2026-11-01T00:00:00.000Z' },
    ],
    ...overrides,
  });

const empty = () => json(200, { data: [], nextCursor: null });

/** Signed in at Acme, with a member directory that honours the repeated `userId` filter. */
const setup = (extra: Record<string, Handler> = {}) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/members': (call) => {
      const ids = call.query.getAll('userId');
      return json(200, { data: ids.length > 0 ? directory.filter((m) => ids.includes(m.userId)) : directory });
    },
    [`GET ${CONVS}`]: empty,
    ...extra,
  });

const listNav = () => screen.findByRole('navigation', { name: 'Conversations' });

afterEach(() => vi.useRealTimers());

describe('conversation list', () => {
  it('shows conversations in the served order with names, unread badges and a group indicator', async () => {
    setup({
      [`GET ${CONVS}`]: () =>
        json(200, {
          data: [
            conversation({ id: 'c-b', unreadCount: 100 }),
            group({ id: 'c-a', unreadCount: 7 }),
            conversation({
              id: 'c-c',
              participants: [
                { userId: 'user-1', role: 'member', joinedAt: '2026-11-01T00:00:00.000Z' },
                { userId: 'user-3', role: 'member', joinedAt: '2026-11-01T00:00:00.000Z' },
              ],
            }),
          ],
          nextCursor: null,
        }),
    });
    await renderApp('/o/acme/messages');
    const nav = await listNav();
    await within(nav).findByText('Alan Turing');
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveTextContent('Grace Hopper');
    expect(links[0]).toHaveTextContent('99+');
    expect(links[1]).toHaveTextContent('Compilers');
    expect(links[1]).toHaveTextContent('group');
    expect(links[1]).toHaveTextContent('7');
    expect(links[2]).toHaveTextContent('Alan Turing');
    expect(links[2]).not.toHaveTextContent(/\d unread/);
    expect(await screen.findByRole('heading', { name: 'Select a conversation' })).toBeInTheDocument();
  });

  it('resolves names with one directory lookup naming every participant', async () => {
    const stub = setup({ [`GET ${CONVS}`]: () => json(200, { data: [conversation()], nextCursor: null }) });
    await renderApp('/o/acme/messages');
    await within(await listNav()).findByText('Grace Hopper');
    const lookup = stub.callsTo('GET /orgs/org-1/members').find((call) => call.query.has('userId'));
    expect(lookup?.query.getAll('userId').sort()).toEqual(['user-1', 'user-2']);
    expect(lookup?.query.get('limit')).toBe('100');
  });

  it('pages with the cursor', async () => {
    const stub = setup({
      [`GET ${CONVS}`]: (call) =>
        call.query.get('cursor') === 'next'
          ? json(200, { data: [conversation({ id: 'c-2', title: 'Older' })], nextCursor: null })
          : json(200, { data: [conversation({ id: 'c-1', title: 'Newer' })], nextCursor: 'next' }),
    });
    const { user } = await renderApp('/o/acme/messages');
    await user.click(await screen.findByRole('button', { name: 'Load more conversations' }));
    const nav = await listNav();
    expect(await within(nav).findByText('Older')).toBeInTheDocument();
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([expect.stringContaining('Newer'), expect.stringContaining('Older')]);
    expect(stub.callsTo(`GET ${CONVS}`).some((call) => call.query.get('cursor') === 'next')).toBe(true);
  });

  it('says so when there are no conversations', async () => {
    setup();
    await renderApp('/o/acme/messages');
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });
});

describe('starting conversations', () => {
  it.each([200, 201])('starts a direct message with a searched member (answer %i) and opens it', async (status) => {
    const stub = setup({
      [`POST ${CONVS}/direct`]: () => json(status, conversation()),
      [`GET ${CONVS}/conv-1`]: () => conversation(),
      [`GET ${CONVS}/conv-1/messages`]: () => json(200, { data: [conversationMessage()], nextCursor: null }),
    });
    const { user, router } = await renderApp('/o/acme/messages');
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const dialog = await screen.findByRole('dialog', { name: 'New message' });
    const search = within(dialog).getByRole('combobox', { name: 'Find a person' });
    expect(search).toHaveFocus();
    await within(dialog).findByRole('option', { name: /Grace Hopper/ });
    expect(within(dialog).queryByRole('option', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
    await user.type(search, 'gra');
    expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    await user.click(within(dialog).getByRole('option', { name: /Grace Hopper/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages/conv-1'));
    expect(stub.callsTo(`POST ${CONVS}/direct`)[0]?.body).toEqual({ userId: 'user-2' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Grace Hopper' })).toBeInTheDocument();
  });

  it('is keyboard operable: arrows move, Enter chooses', async () => {
    const stub = setup({ [`POST ${CONVS}/direct`]: () => problem(422, 'user_not_in_organization') });
    const { user } = await renderApp('/o/acme/messages');
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const search = await screen.findByRole('combobox', { name: 'Find a person' });
    await screen.findByRole('option', { name: /Grace Hopper/ });
    await user.keyboard('{ArrowDown}{Enter}');
    expect(stub.callsTo(`POST ${CONVS}/direct`)[0]?.body).toEqual({ userId: 'user-3' });
    expect(search).toHaveAttribute('aria-activedescendant');
    expect(await screen.findByRole('alert')).toHaveTextContent('not an active member');
  });

  it('creates a group from 2 to 49 others with an optional title', async () => {
    const stub = setup({
      [`POST ${CONVS}/groups`]: () => json(201, group()),
      [`GET ${CONVS}/conv-g`]: () => group(),
      [`GET ${CONVS}/conv-g/messages`]: empty,
    });
    const { user, router } = await renderApp('/o/acme/messages');
    await user.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    const create = within(dialog).getByRole('button', { name: 'Create group' });
    expect(create).toBeDisabled();
    await user.click(await within(dialog).findByRole('option', { name: /Grace Hopper/ }));
    expect(create).toBeDisabled();
    await user.click(within(dialog).getByRole('option', { name: /Alan Turing/ }));
    expect(create).toBeEnabled();
    expect(within(dialog).getByRole('list', { name: 'Chosen people' })).toHaveTextContent('Alan Turing');
    await user.type(within(dialog).getByRole('textbox', { name: 'Group name (optional)' }), 'Compilers');
    await user.click(create);

    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages/conv-g'));
    expect(stub.callsTo(`POST ${CONVS}/groups`)[0]?.body).toEqual({
      title: 'Compilers',
      userIds: ['user-2', 'user-3'],
    });
  });
});

describe('conversation view', () => {
  const messages = [
    conversationMessage({ id: 'cm-3', body: 'third', createdAt: '2026-11-03T10:03:00.000Z' }),
    conversationMessage({
      id: 'cm-2',
      body: '<b>second</b>',
      senderUserId: 'user-1',
      createdAt: '2026-11-03T10:02:00.000Z',
    }),
    conversationMessage({ id: 'cm-1', body: null, deletedAt: '2026-11-03T10:01:00.000Z' }),
  ];
  const open = (extra: Parameters<typeof setup>[0] = {}) =>
    setup({
      [`GET ${CONVS}/conv-1`]: () => conversation(),
      [`GET ${CONVS}/conv-1/messages`]: () => json(200, { data: messages, nextCursor: null }),
      ...extra,
    });
  const log = () => screen.findByRole('log', { name: 'Messages with Grace Hopper' });

  it('renders history oldest to newest as plain text, with tombstones and sender names', async () => {
    open();
    await renderApp('/o/acme/messages/conv-1');
    const list = await log();
    await within(list).findByText('third');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('p')?.textContent),
    ).toEqual(['Message deleted', '<b>second</b>', 'third']);
    expect(list.querySelector('b')).toBeNull();
    expect(within(list).getAllByText('Grace Hopper')).toHaveLength(2);
    expect(within(list).getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('pages older messages through nextCursor', async () => {
    const stub = open({
      [`GET ${CONVS}/conv-1/messages`]: (call) =>
        call.query.get('cursor') === 'c2'
          ? json(200, { data: [conversationMessage({ id: 'cm-0', body: 'older' })], nextCursor: null })
          : json(200, { data: [conversationMessage({ id: 'cm-9', body: 'newer' })], nextCursor: 'c2' }),
    });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    await user.click(await screen.findByRole('button', { name: 'Load older messages' }));
    await within(await log()).findByText('older');
    expect(stub.callsTo(`GET ${CONVS}/conv-1/messages`).some((call) => call.query.get('cursor') === 'c2')).toBe(true);
  });

  it('sends with an idempotent client id, reusing it on retry', async () => {
    let attempts = 0;
    const stub = open({
      [`POST ${CONVS}/conv-1/messages`]: (call) =>
        ++attempts === 1
          ? problem(503, 'service_unavailable')
          : json(
              200,
              conversationMessage({
                id: 'cm-9',
                body: 'hello',
                senderUserId: 'user-1',
                clientMessageId: (call.body as { clientMessageId: string }).clientMessageId,
              }),
            ),
    });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    await user.type(await screen.findByRole('textbox', { name: 'Message Grace Hopper' }), 'hello{Enter}');
    await screen.findByText(/Not sent:/);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Not sent:/)).not.toBeInTheDocument());
    const ids = stub
      .callsTo(`POST ${CONVS}/conv-1/messages`)
      .map((c) => (c.body as { clientMessageId: string }).clientMessageId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('edits own messages and deletes with confirmation; others’ messages offer nothing in a direct chat', async () => {
    const stub = open({
      [`PATCH ${CONVS}/conv-1/messages/cm-2`]: () => conversationMessage({ id: 'cm-2', body: 'fixed' }),
      [`DELETE ${CONVS}/conv-1/messages/cm-2`]: () => undefined,
    });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    const row = (await screen.findByText('<b>second</b>')).closest('li') as HTMLElement;
    expect(await actionsOf(user, (await screen.findByText('third')).closest('li') as HTMLElement)).not.toEqual(
      expect.arrayContaining(['Edit']),
    );
    await chooseAction(user, row, 'Edit');
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(box);
    await user.type(box, 'fixed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(stub.callsTo(`PATCH ${CONVS}/conv-1/messages/cm-2`)[0]?.body).toEqual({ body: 'fixed' }),
    );
    await chooseAction(user, row, 'Delete');
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete message' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${CONVS}/conv-1/messages/cm-2`)).toHaveLength(1));
  });

  it('lets a group administrator delete other people’s messages', async () => {
    setup({
      [`GET ${CONVS}/conv-g`]: () => group(),
      [`GET ${CONVS}/conv-g/messages`]: () =>
        json(200, { data: [conversationMessage({ conversationId: 'conv-g' })], nextCursor: null }),
    });
    const { user } = await renderApp('/o/acme/messages/conv-g');
    const row = (await screen.findByText('Hi Ada')).closest('li') as HTMLElement;
    const actions = await actionsOf(user, row);
    expect(actions).toContain('Delete');
    expect(actions).not.toContain('Edit');
  });

  describe('marking as read', () => {
    it('posts the newest message id once, while the tab is visible', async () => {
      const stub = open({ [`POST ${CONVS}/conv-1/read`]: () => undefined });
      await renderApp('/o/acme/messages/conv-1');
      await waitFor(() => expect(stub.callsTo(`POST ${CONVS}/conv-1/read`)).toHaveLength(1));
      expect(stub.callsTo(`POST ${CONVS}/conv-1/read`)[0]?.body).toEqual({ messageId: 'cm-3' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.callsTo(`POST ${CONVS}/conv-1/read`)).toHaveLength(1);
    });

    it('waits while the document is hidden, and does not repeat what is already read', async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      const stub = open({ [`POST ${CONVS}/conv-1/read`]: () => undefined });
      try {
        await renderApp('/o/acme/messages/conv-1');
        await within(await log()).findByText('third');
        expect(stub.callsTo(`POST ${CONVS}/conv-1/read`)).toHaveLength(0);
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        act(() => void document.dispatchEvent(new Event('visibilitychange')));
        await waitFor(() => expect(stub.callsTo(`POST ${CONVS}/conv-1/read`)).toHaveLength(1));
      } finally {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
    });

    it('does nothing when the newest message is already the read cursor or your own', async () => {
      const stub = open({ [`GET ${CONVS}/conv-1`]: () => conversation({ lastReadMessageId: 'cm-3' }) });
      await renderApp('/o/acme/messages/conv-1');
      await within(await log()).findByText('third');
      expect(stub.callsTo(`POST ${CONVS}/conv-1/read`)).toHaveLength(0);
    });
  });

  it('shows a not-available state for a missing or removed conversation, with a way back', async () => {
    setup({ [`GET ${CONVS}/conv-x`]: () => problem(404, 'conversation_not_found') });
    const { user, router } = await renderApp('/o/acme/messages/conv-x');
    expect(await screen.findByRole('heading', { name: 'Conversation not available' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Back to conversations' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages'));
  });

  it('explains participant_inactive and disables the composer', async () => {
    open({ [`POST ${CONVS}/conv-1/messages`]: () => problem(409, 'participant_inactive') });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    await user.type(await screen.findByRole('textbox', { name: 'Message Grace Hopper' }), 'hello{Enter}');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Grace Hopper' })).toBeDisabled());
    expect(screen.getAllByText(/no longer in this organization/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    open();
    await renderApp('/o/acme/messages/conv-1');
    await screen.findByText('third');
    expect(await axeViolations()).toEqual([]);
  });
});

describe('group panel', () => {
  const openPanel = async (overrides: Parameters<typeof group>[0] = {}, extra: Parameters<typeof setup>[0] = {}) => {
    const stub = setup({
      [`GET ${CONVS}/conv-g`]: () => group(overrides),
      [`GET ${CONVS}/conv-g/messages`]: empty,
      ...extra,
    });
    const app = await renderApp('/o/acme/messages/conv-g');
    await app.user.click(await screen.findByRole('button', { name: 'Details' }));
    const panel = await screen.findByRole('complementary', { name: 'Group details' });
    return { ...app, stub, panel: within(panel), panelElement: panel };
  };

  it('lists participants with roles, moves focus in, and Escape closes it returning focus', async () => {
    const { panel, panelElement, user } = await openPanel();
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: 'Group details' })).toHaveFocus();
    expect(await panel.findByText('Grace Hopper')).toBeInTheDocument();
    expect(panel.getByText('(you)')).toBeInTheDocument();
    expect(panel.getAllByText('admin')).toHaveLength(1);
    expect(panel.getAllByText('member')).toHaveLength(2);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(panelElement).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Details' })).toHaveFocus();
  });

  it('offers administrators every control', async () => {
    const { panel } = await openPanel();
    await panel.findByText('Grace Hopper');
    expect(panel.getByRole('form', { name: 'Rename group' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Make admin: Grace Hopper' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Remove Grace Hopper' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Demote Ada Lovelace to member' })).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Remove Ada Lovelace' })).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Add people' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Leave group' })).toBeInTheDocument();
  });

  it('offers plain members only the participant list and leaving', async () => {
    const { panel } = await openPanel({ myRole: 'member' });
    await panel.findByText('Grace Hopper');
    expect(panel.queryByRole('form', { name: 'Rename group' })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /admin|Demote/ })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Leave group' })).toBeInTheDocument();
  });

  it('promotes, and reports last_admin when demoting the last administrator', async () => {
    const { panel, user, stub } = await openPanel(
      {},
      {
        [`PUT ${CONVS}/conv-g/participants/:userId`]: (call) =>
          (call.body as { role?: string }).role === 'member'
            ? problem(409, 'last_admin')
            : { userId: 'user-2', role: 'admin', joinedAt: 'x' },
      },
    );
    await user.click(await panel.findByRole('button', { name: 'Make admin: Grace Hopper' }));
    await waitFor(() =>
      expect(stub.callsTo(`PUT ${CONVS}/conv-g/participants/user-2`)[0]?.body).toEqual({ role: 'admin' }),
    );
    await user.click(panel.getByRole('button', { name: 'Demote Ada Lovelace to member' }));
    expect(await screen.findByText(/last administrator/)).toBeInTheDocument();
  });

  it('removes a participant after confirmation', async () => {
    const { panel, user, stub } = await openPanel(
      {},
      { [`DELETE ${CONVS}/conv-g/participants/:userId`]: () => undefined },
    );
    await user.click(await panel.findByRole('button', { name: 'Remove Grace Hopper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Grace Hopper?' });
    expect(stub.callsTo(`DELETE ${CONVS}/conv-g/participants/user-2`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${CONVS}/conv-g/participants/user-2`)).toHaveLength(1));
  });

  it('renames the group', async () => {
    const { panel, user, stub } = await openPanel({}, { [`PATCH ${CONVS}/conv-g`]: () => group({ title: 'Renamed' }) });
    const box = await panel.findByRole('textbox', { name: 'Group name' });
    await user.clear(box);
    await user.type(box, '  Renamed ');
    await user.click(panel.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(stub.callsTo(`PATCH ${CONVS}/conv-g`)[0]?.body).toEqual({ title: 'Renamed' }));
  });

  it('adds someone who is not yet a participant', async () => {
    const { panel, user, stub } = await openPanel(
      {},
      {
        [`PUT ${CONVS}/conv-g/participants/:userId`]: () =>
          json(201, { userId: 'user-4', role: 'member', joinedAt: 'x' }),
      },
    );
    await user.click(await panel.findByRole('button', { name: 'Add people' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add people' });
    await within(dialog).findByRole('option', { name: /Lin Clark/ });
    expect(within(dialog.querySelector('[role=listbox]') as HTMLElement).getAllByRole('option')).toHaveLength(1);
    await user.click(within(dialog).getByRole('option', { name: /Lin Clark/ }));
    await waitFor(() => expect(stub.callsTo(`PUT ${CONVS}/conv-g/participants/user-4`)[0]?.body).toEqual({}));
  });

  it('leaves after confirmation, and the conversation disappears from the list', async () => {
    let left = false;
    const { panel, user, stub, router } = await openPanel(
      {},
      {
        [`GET ${CONVS}`]: () => json(200, { data: left ? [] : [group()], nextCursor: null }),
        [`DELETE ${CONVS}/conv-g/participants/:userId`]: () => {
          left = true;
          return undefined;
        },
      },
    );
    const nav = await listNav();
    await within(nav).findByText('Compilers');
    await user.click(await panel.findByRole('button', { name: 'Leave group' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave this group?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave group' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${CONVS}/conv-g/participants/user-1`)).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages'));
    await waitFor(() => expect(within(nav).queryByText('Compilers')).not.toBeInTheDocument());
  });
});

describe('realtime', () => {
  const live = () => {
    let arrived = false;
    const stub = setup({
      [`GET ${CONVS}`]: () => json(200, { data: [conversation()], nextCursor: null }),
      [`GET ${CONVS}/conv-1`]: () => conversation(),
      [`GET ${CONVS}/conv-1/messages`]: () =>
        json(200, {
          data: arrived
            ? [
                conversationMessage({ id: 'cm-2', body: 'arrived', createdAt: '2026-11-03T10:05:00.000Z' }),
                conversationMessage(),
              ]
            : [conversationMessage()],
          nextCursor: null,
        }),
    });
    return { stub, arrive: () => (arrived = true) };
  };
  const messageCalls = (stub: ReturnType<typeof setup>) => stub.callsTo(`GET ${CONVS}/conv-1/messages`).length;
  const listCalls = (stub: ReturnType<typeof setup>) => stub.callsTo(`GET ${CONVS}`).length;

  it('watches the organization inbox', async () => {
    live();
    const { realtime } = await renderApp('/o/acme/messages');
    await within(await listNav()).findByRole('link');
    // One watcher for the messages layout and one for the activity bell.
    expect(new Set(realtime.inboxRefs())).toEqual(new Set(['org-1']));
  });

  it('refetches the list, and the open conversation only when it is the one named', async () => {
    const { stub, arrive } = live();
    const { realtime } = await renderApp('/o/acme/messages/conv-1');
    await screen.findByText('Hi Ada');
    const lists = listCalls(stub);
    const messagesBefore = messageCalls(stub);

    act(() => realtime.inboxEvent('conv-other'));
    await waitFor(() => expect(listCalls(stub)).toBeGreaterThan(lists));
    expect(messageCalls(stub)).toBe(messagesBefore);

    arrive();
    act(() => realtime.inboxEvent('conv-1'));
    expect(await screen.findByText('arrived')).toBeInTheDocument();
  });

  it('refetches everything after a (re)subscription, which covers missed events', async () => {
    const { stub, arrive } = live();
    const { realtime } = await renderApp('/o/acme/messages/conv-1');
    await screen.findByText('Hi Ada');
    arrive();
    const lists = listCalls(stub);
    act(() => realtime.inboxEvent(null));
    expect(await screen.findByText('arrived')).toBeInTheDocument();
    expect(listCalls(stub)).toBeGreaterThan(lists);
  });

  it('polls the open conversation every 5 s and the list every 30 s when not live, rarely when live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { stub } = live();
    const { realtime } = await renderApp('/o/acme/messages/conv-1');
    await screen.findByText('Hi Ada');

    const m0 = messageCalls(stub);
    await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_MS + 200);
    expect(messageCalls(stub)).toBeGreaterThan(m0);
    const l0 = listCalls(stub);
    await vi.advanceTimersByTimeAsync(CONVERSATION_LIST_POLL_MS);
    expect(listCalls(stub)).toBeGreaterThan(l0);

    act(() => realtime.setInboxLive(true));
    const m1 = messageCalls(stub);
    const l1 = listCalls(stub);
    await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_MS * 3);
    expect(messageCalls(stub)).toBe(m1);
    expect(listCalls(stub)).toBe(l1);
    await vi.advanceTimersByTimeAsync(CONVERSATION_LIVE_POLL_MS);
    expect(messageCalls(stub)).toBeGreaterThan(m1);

    act(() => realtime.setInboxLive(false));
    const m2 = messageCalls(stub);
    await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_MS + 200);
    expect(messageCalls(stub)).toBeGreaterThan(m2);
  });
});
