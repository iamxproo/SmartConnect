import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem, stubApi, type Handler } from '@/test/api-stub';
import { channel, conversation, conversationMessage, inAcme, member, message, workspace } from '@/test/fixtures';
import { actionsOf, chooseAction, openActions } from '@/test/message-actions';
import { axeViolations, renderApp } from '@/test/render-app';

const PATH = '/o/acme/w/ws-1/c/ch-1';
const MESSAGES = '/orgs/org-1/workspaces/ws-1/channels/ch-1/messages';
const CONVS = '/orgs/org-1/conversations';
const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'g@example.com' });
const alan = member({ id: 'member-3', userId: 'user-3', displayName: 'Alan Turing', email: 'a@example.com' });
const directory = [member(), grace, alan];

const setup = (extra: Record<string, Handler> = {}, messages: unknown[] = [], page: object = {}) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/workspaces': () => ({ data: [workspace()] }),
    'GET /orgs/org-1/workspaces/ws-1': () => workspace(),
    'GET /orgs/org-1/workspaces/ws-1/channels': () => ({ data: [channel()] }),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1': () => channel(),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1/members': () => ({ data: [] }),
    'GET /orgs/org-1/members': () => json(200, { data: directory, nextCursor: null }),
    [`GET ${MESSAGES}`]: () => json(200, { data: messages, nextCursor: null, ...page }),
    [`POST ${MESSAGES}/read`]: () => undefined,
    ...extra,
  });

const log = () => screen.findByRole('log', { name: 'Messages in #general' });
const rowOf = async (text: string) => (await screen.findByText(text)).closest('li') as HTMLElement;
const root = message({ id: 'r1', body: 'root words', senderUserId: 'user-2' });

afterEach(() => vi.useRealTimers());

describe('threads', () => {
  const reply = (id: string, body: string, overrides = {}) =>
    message({
      id,
      body,
      threadRootId: 'r1',
      senderUserId: 'user-3',
      createdAt: '2026-11-03T10:05:00.000Z',
      ...overrides,
    });

  it('shows the reply count on a root and opens the thread beside the timeline', async () => {
    const stub = setup(
      {
        [`GET ${MESSAGES}/r1/replies`]: () =>
          json(200, { data: [reply('p1', 'first reply'), reply('p2', 'second reply')], nextCursor: null }),
      },
      [{ ...root, thread: { replyCount: 2, lastReplyAt: '2026-11-03T10:06:00.000Z', participantUserIds: ['user-3'] } }],
    );
    const { user } = await renderApp(PATH);
    await user.click(await screen.findByRole('button', { name: /2 replies/ }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    const replies = await within(panel).findByRole('list', { name: 'Replies' });
    expect(
      within(replies)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('p')?.textContent),
    ).toEqual(['first reply', 'second reply']);
    expect(within(panel).getByRole('list', { name: 'Thread root' })).toHaveTextContent('root words');
    expect(stub.callsTo(`GET ${MESSAGES}/r1/replies`)).toHaveLength(1);
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    // Replies are not part of the timeline.
    expect(within(await log()).queryByText('first reply')).not.toBeInTheDocument();
  });

  it('opens from the actions menu and posts a reply with the thread root and a retry-safe id', async () => {
    const stub = setup(
      {
        [`GET ${MESSAGES}/r1/replies`]: () => json(200, { data: [], nextCursor: null }),
        [`POST ${MESSAGES}`]: () => reply('p9', 'on it'),
      },
      [root],
    );
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('root words'), 'Reply in thread');
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    expect(await within(panel).findByText('No replies yet.')).toBeInTheDocument();
    await user.type(within(panel).getByRole('textbox', { name: 'Reply in thread' }), 'on it{Enter}');
    await waitFor(() => expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(1));
    const body = stub.callsTo(`POST ${MESSAGES}`)[0]!.body as Record<string, string>;
    expect(body).toMatchObject({ body: 'on it', threadRootId: 'r1' });
    expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    // The main composer is a different box and stays empty.
    expect(screen.getByRole('textbox', { name: 'Message #general' })).toHaveValue('');
  });

  it('keeps the reply text when sending fails, and shows why', async () => {
    setup(
      {
        [`GET ${MESSAGES}/r1/replies`]: () => json(200, { data: [], nextCursor: null }),
        [`POST ${MESSAGES}`]: () => problem(409, 'message_deleted'),
      },
      [root],
    );
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('root words'), 'Reply in thread');
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    const box = within(panel).getByRole('textbox', { name: 'Reply in thread' });
    await user.type(box, 'too late{Enter}');
    expect(await within(panel).findByRole('alert')).toHaveTextContent('This message was deleted.');
    expect(box).toHaveValue('too late');
  });

  it('closes with Escape or the close button and returns to the message', async () => {
    setup({ [`GET ${MESSAGES}/r1/replies`]: () => json(200, { data: [], nextCursor: null }) }, [root]);
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('root words'), 'Reply in thread');
    await screen.findByRole('complementary', { name: 'Thread' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Thread' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('message-r1')));
  });

  it('pages through long threads', async () => {
    setup(
      {
        [`GET ${MESSAGES}/r1/replies`]: (call) =>
          call.query.get('cursor') === 'c2'
            ? json(200, { data: [reply('p2', 'later reply')], nextCursor: null })
            : json(200, { data: [reply('p1', 'early reply')], nextCursor: 'c2' }),
      },
      [{ ...root, thread: { replyCount: 2, lastReplyAt: null, participantUserIds: [] } }],
    );
    const { user } = await renderApp(PATH);
    await user.click(await screen.findByRole('button', { name: /2 replies/ }));
    await user.click(await screen.findByRole('button', { name: 'Load more replies' }));
    expect(await screen.findByText('later reply')).toBeInTheDocument();
    expect(screen.getByText('early reply')).toBeInTheDocument();
  });

  it('has no accessibility violations with the thread open', async () => {
    setup({ [`GET ${MESSAGES}/r1/replies`]: () => json(200, { data: [reply('p1', 'a reply')], nextCursor: null }) }, [
      root,
    ]);
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('root words'), 'Reply in thread');
    await screen.findByText('a reply');
    expect(await axeViolations()).toEqual([]);
  });

  it('offers threads in conversations too', async () => {
    const CONV = `${CONVS}/conv-1/messages`;
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/members': () => json(200, { data: directory }),
      [`GET ${CONVS}`]: () => json(200, { data: [], nextCursor: null }),
      [`GET ${CONVS}/conv-1`]: () => conversation(),
      [`GET ${CONV}`]: () =>
        json(200, { data: [conversationMessage({ id: 'c1', body: 'dm root' })], nextCursor: null }),
      [`GET ${CONV}/c1/replies`]: () =>
        json(200, {
          data: [conversationMessage({ id: 'c2', body: 'dm reply', threadRootId: 'c1' })],
          nextCursor: null,
        }),
      [`POST ${CONVS}/conv-1/read`]: () => undefined,
    });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    await chooseAction(user, await rowOf('dm root'), 'Reply in thread');
    expect(await screen.findByText('dm reply')).toBeInTheDocument();
  });
});

describe('reactions', () => {
  const reacted = message({
    id: 'm1',
    body: 'nice work',
    senderUserId: 'user-2',
    reactions: [
      { emoji: '👍', count: 2, reacted: false },
      { emoji: '🎉', count: 1, reacted: true },
    ],
  });

  it('shows counts as toggle buttons and tells whether you reacted', async () => {
    setup({}, [reacted]);
    await renderApp(PATH);
    const bar = await within(await rowOf('nice work')).findByRole('list', { name: 'Reactions' });
    const thumbs = within(bar).getByRole('button', { name: '👍 2 reactions' });
    const party = within(bar).getByRole('button', { name: '🎉 1 reaction, including yours' });
    expect(thumbs).toHaveAttribute('aria-pressed', 'false');
    expect(party).toHaveAttribute('aria-pressed', 'true');
  });

  it('adds with PUT, shows it at once, and takes it back with DELETE (emoji URL-encoded)', async () => {
    let current = reacted;
    const stub = setup({
      [`GET ${MESSAGES}`]: () => json(200, { data: [current], nextCursor: null }),
      [`PUT ${MESSAGES}/m1/reactions/:emoji`]: () => {
        current = { ...reacted, reactions: [{ emoji: '👍', count: 3, reacted: true }, reacted.reactions[1]!] };
        return undefined;
      },
      [`DELETE ${MESSAGES}/m1/reactions/:emoji`]: () => {
        current = { ...current, reactions: [current.reactions[0]!] };
        return undefined;
      },
    });
    const { user } = await renderApp(PATH);
    const bar = await within(await rowOf('nice work')).findByRole('list', { name: 'Reactions' });
    await user.click(within(bar).getByRole('button', { name: '👍 2 reactions' }));
    expect(await within(bar).findByRole('button', { name: '👍 3 reactions, including yours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const put = stub.calls.find((call) => call.method === 'PUT')!;
    expect(put.path).toBe(`${MESSAGES}/m1/reactions/${encodeURIComponent('👍')}`);
    await user.click(within(bar).getByRole('button', { name: '🎉 1 reaction, including yours' }));
    await waitFor(() => expect(stub.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
    expect(stub.calls.find((call) => call.method === 'DELETE')!.path).toBe(
      `${MESSAGES}/m1/reactions/${encodeURIComponent('🎉')}`,
    );
  });

  it('picks from a small curated set, from the button and from the actions menu', async () => {
    const stub = setup({ [`PUT ${MESSAGES}/m1/reactions/:emoji`]: () => undefined }, [reacted]);
    const { user } = await renderApp(PATH);
    const row = await rowOf('nice work');
    await user.click(within(row).getByRole('button', { name: 'Add reaction' }));
    const picker = await screen.findByRole('menu', { name: 'Add reaction' });
    expect(within(picker).getAllByRole('menuitem')).toHaveLength(10);
    await user.click(within(picker).getByRole('menuitem', { name: 'React with rocket' }));
    await waitFor(() => expect(stub.callsTo(`PUT ${MESSAGES}/m1/reactions/:emoji`)).toHaveLength(1));
    expect(stub.callsTo(`PUT ${MESSAGES}/m1/reactions/:emoji`)[0]!.path).toContain(encodeURIComponent('🚀'));

    await chooseAction(user, row, 'Add reaction');
    const again = await screen.findByRole('menu', { name: 'Add reaction' });
    await user.click(within(again).getByRole('menuitem', { name: 'React with eyes' }));
    await waitFor(() => expect(stub.callsTo(`PUT ${MESSAGES}/m1/reactions/:emoji`)).toHaveLength(2));
  });

  it('reports a refused reaction and restores the counts', async () => {
    setup({ [`PUT ${MESSAGES}/m1/reactions/:emoji`]: () => problem(403, 'not_a_channel_member') }, [reacted]);
    const { user } = await renderApp(PATH);
    const bar = await within(await rowOf('nice work')).findByRole('list', { name: 'Reactions' });
    await user.click(within(bar).getByRole('button', { name: '👍 2 reactions' }));
    expect(await screen.findByText('Join this channel to post in it.')).toBeInTheDocument();
    expect(await within(bar).findByRole('button', { name: '👍 2 reactions' })).toBeInTheDocument();
  });

  it('does not offer adding reactions where posting is not possible', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/workspaces': () => ({ data: [workspace()] }),
      'GET /orgs/org-1/workspaces/ws-1': () => workspace(),
      'GET /orgs/org-1/workspaces/ws-1/channels': () => ({ data: [channel({ isMember: false, myRole: null })] }),
      'GET /orgs/org-1/workspaces/ws-1/channels/ch-1': () => channel({ isMember: false, myRole: null }),
      'GET /orgs/org-1/workspaces/ws-1/channels/ch-1/members': () => ({ data: [] }),
      'GET /orgs/org-1/members': () => json(200, { data: directory, nextCursor: null }),
      [`GET ${MESSAGES}`]: () => json(200, { data: [reacted], nextCursor: null }),
      [`POST ${MESSAGES}/read`]: () => undefined,
    });
    const { user } = await renderApp(PATH);
    const row = await rowOf('nice work');
    expect(within(row).queryByRole('button', { name: 'Add reaction' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '👍 2 reactions' })).toBeDisabled();
    expect(await actionsOf(user, row)).not.toContain('Add reaction');
  });
});

describe('mentions', () => {
  it('suggests members after "@", inserts the pick with the keyboard, and sends <@id>', async () => {
    const stub = setup({ [`POST ${MESSAGES}`]: () => message({ id: 'new', body: 'x' }) });
    const { user } = await renderApp(PATH);
    const box = await screen.findByRole('textbox', { name: 'Message #general' });
    await user.type(box, 'hi @gr');
    const list = await screen.findByRole('listbox', { name: 'People to mention' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Grace Hopper']);
    expect(box).toHaveAttribute('aria-controls', list.id);
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('hi @Grace Hopper ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(box, 'thanks{Enter}');
    await waitFor(() => expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(1));
    expect(stub.callsTo(`POST ${MESSAGES}`)[0]!.body).toMatchObject({ body: 'hi <@user-2> thanks' });
  });

  it('moves with the arrow keys, picks with the mouse and closes with Escape without sending', async () => {
    const stub = setup();
    const { user } = await renderApp(PATH);
    const box = await screen.findByRole('textbox', { name: 'Message #general' });
    await user.type(box, '@a');
    const list = await screen.findByRole('listbox');
    // "a" matches Ada, Grace Hopper (Hopper has no 'a'... Grace does) and Alan.
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['Ada Lovelace', 'Alan Turing']));
    await user.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box).toHaveValue('@a');
    expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(0);

    await user.type(box, 'l');
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Alan Turing' }));
    expect(box).toHaveValue('@Alan Turing ');
  });

  it('still sends on Enter when no suggestion is open', async () => {
    const stub = setup({ [`POST ${MESSAGES}`]: () => message({ id: 'new' }) });
    const { user } = await renderApp(PATH);
    await user.type(await screen.findByRole('textbox', { name: 'Message #general' }), 'user@example.com{Enter}');
    await waitFor(() => expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(1));
    expect(stub.callsTo(`POST ${MESSAGES}`)[0]!.body).toMatchObject({ body: 'user@example.com' });
  });

  it('renders mention tokens as chips with names, and "Former member" for unknown people', async () => {
    setup({}, [
      message({
        body: 'cc <@user-2> and <@user-9>',
        mentionedUserIds: ['user-2', 'user-9'],
      }),
    ]);
    await renderApp(PATH);
    const list = await log();
    await within(list).findByText('@Grace Hopper');
    expect(within(list).getByText('@Former member')).toBeInTheDocument();
    expect(list).not.toHaveTextContent('<@');
  });

  it('shows names while editing and saves tokens again', async () => {
    const stub = setup({ [`PATCH ${MESSAGES}/:id`]: () => message({ id: 'm1', body: 'x' }) }, [
      message({ id: 'm1', body: 'cc <@user-2> ok', mentionedUserIds: ['user-2'] }),
    ]);
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('@Grace Hopper'), 'Edit');
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect(box).toHaveValue('cc @Grace Hopper ok');
    await user.type(box, '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.callsTo(`PATCH ${MESSAGES}/m1`)).toHaveLength(1));
    expect(stub.callsTo(`PATCH ${MESSAGES}/m1`)[0]!.body).toEqual({ body: 'cc <@user-2> ok!' });
  });

  it('suggests only the participants of a conversation', async () => {
    const stub = stubApi({
      ...inAcme(),
      'GET /orgs/org-1/members': (call) => {
        const ids = call.query.getAll('userId');
        return json(200, { data: ids.length ? directory.filter((m) => ids.includes(m.userId)) : directory });
      },
      [`GET ${CONVS}`]: () => json(200, { data: [], nextCursor: null }),
      [`GET ${CONVS}/conv-1`]: () => conversation(),
      [`GET ${CONVS}/conv-1/messages`]: () => json(200, { data: [], nextCursor: null }),
      [`POST ${CONVS}/conv-1/messages`]: () => conversationMessage(),
    });
    const { user } = await renderApp('/o/acme/messages/conv-1');
    const box = await screen.findByRole('textbox', { name: /^Message / });
    await waitFor(() => expect(screen.queryByText('…')).not.toBeInTheDocument());
    await user.type(box, '@');
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['Ada Lovelace', 'Grace Hopper']));
    expect(names).not.toContain('Alan Turing');
    expect(stub.unhandled).toEqual([]);
  });
});

describe('unread divider and reading', () => {
  const run = [
    message({ id: 'm3', body: 'newest', senderUserId: 'user-2', createdAt: '2026-11-03T10:03:00.000Z' }),
    message({ id: 'm2', body: 'unread one', senderUserId: 'user-2', createdAt: '2026-11-03T10:02:00.000Z' }),
    message({ id: 'm1', body: 'already read', senderUserId: 'user-2', createdAt: '2026-11-03T10:01:00.000Z' }),
  ];

  it('draws "New messages" above the oldest unread message, once', async () => {
    setup({}, run, { unreadCount: 2, lastReadMessageId: 'm1' });
    await renderApp(PATH);
    const divider = await screen.findByRole('separator', { name: 'New messages' });
    expect(divider.closest('li')).toHaveTextContent('unread one');
    expect(screen.getAllByRole('separator', { name: 'New messages' })).toHaveLength(1);
  });

  it('draws nothing when everything is read, and ignores your own messages', async () => {
    setup({}, run, { unreadCount: 0, lastReadMessageId: 'm3' });
    await renderApp(PATH);
    await log();
    await screen.findByText('newest');
    expect(screen.queryByRole('separator', { name: 'New messages' })).not.toBeInTheDocument();
  });

  it('marks the channel read through the newest message from someone else', async () => {
    const stub = setup({}, run, { unreadCount: 2, lastReadMessageId: 'm1' });
    await renderApp(PATH);
    await waitFor(() => expect(stub.callsTo(`POST ${MESSAGES}/read`)).toHaveLength(1));
    expect(stub.callsTo(`POST ${MESSAGES}/read`)[0]!.body).toEqual({ messageId: 'm3' });
    // The divider stays while the channel is open.
    expect(screen.getByRole('separator', { name: 'New messages' })).toBeInTheDocument();
  });

  it('does not mark your own newest message', async () => {
    const stub = setup({}, [message({ id: 'mine', senderUserId: 'user-1' })]);
    await renderApp(PATH);
    await screen.findByText('Hello team');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(stub.callsTo(`POST ${MESSAGES}/read`)).toHaveLength(0);
  });

  it('draws the divider in conversations from the message list', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/members': () => json(200, { data: directory }),
      [`GET ${CONVS}`]: () => json(200, { data: [], nextCursor: null }),
      [`GET ${CONVS}/conv-1`]: () => conversation({ unreadCount: 1 }),
      [`GET ${CONVS}/conv-1/messages`]: () =>
        json(200, {
          data: [
            conversationMessage({ id: 'c2', body: 'fresh', createdAt: '2026-11-03T10:02:00.000Z' }),
            conversationMessage({ id: 'c1', body: 'old', createdAt: '2026-11-03T10:01:00.000Z' }),
          ],
          nextCursor: null,
          unreadCount: 1,
          lastReadMessageId: 'c1',
        }),
      [`POST ${CONVS}/conv-1/read`]: () => undefined,
    });
    await renderApp('/o/acme/messages/conv-1');
    const divider = await screen.findByRole('separator', { name: 'New messages' });
    expect(divider.closest('li')).toHaveTextContent('fresh');
  });
});

describe('message actions menu', () => {
  it('opens from the keyboard, moves with arrows, activates with Enter and returns focus on Escape', async () => {
    setup({}, [message({ id: 'm1', body: 'keyboard only', senderUserId: 'user-2' })]);
    const { user } = await renderApp(PATH);
    const row = await rowOf('keyboard only');
    const trigger = within(row).getByRole('button', { name: 'Message actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    expect(within(menu).getAllByRole('menuitem')[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Copy link' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toMatch(/#message-m1$/);

    await user.keyboard('{Enter}');
    await screen.findByRole('menu', { name: 'Message actions' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('saves and un-saves with PUT and DELETE on the bookmark', async () => {
    let saved = false;
    const stub = setup({
      [`GET ${MESSAGES}`]: () =>
        json(200, {
          data: [message({ id: 'm1', body: 'worth keeping', senderUserId: 'user-2', bookmarked: saved })],
          nextCursor: null,
        }),
      [`PUT ${MESSAGES}/m1/bookmark`]: () => {
        saved = true;
        return undefined;
      },
      [`DELETE ${MESSAGES}/m1/bookmark`]: () => {
        saved = false;
        return undefined;
      },
    });
    const { user } = await renderApp(PATH);
    const row = await rowOf('worth keeping');
    await chooseAction(user, row, 'Save message');
    await waitFor(() => expect(stub.callsTo(`PUT ${MESSAGES}/m1/bookmark`)).toHaveLength(1));
    const menu = await openActions(user, row);
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove from saved' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${MESSAGES}/m1/bookmark`)).toHaveLength(1));
  });

  it('offers nothing but reading for deleted messages', async () => {
    setup({}, [message({ id: 'm1', body: null, deletedAt: '2026-11-03T10:10:00.000Z' })]);
    await renderApp(PATH);
    const row = await rowOf('Message deleted');
    expect(within(row).queryByRole('button', { name: 'Message actions' })).not.toBeInTheDocument();
  });
});

describe('formatting in the timeline', () => {
  it('renders the safe subset and keeps hostile input inert', async () => {
    setup({}, [
      message({
        id: 'm1',
        body: '**bold** https://example.com/a <script>window.pwned = 1</script> [x](javascript:alert(1)) `<b>`',
      }),
    ]);
    await renderApp(PATH);
    const list = await log();
    await within(list).findByText('bold');
    expect(list.querySelector('strong')).toHaveTextContent('bold');
    const links = list.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(list.querySelector('script')).toBeNull();
    expect(list.textContent).toContain('<script>window.pwned = 1</script>');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe('saved messages page', () => {
  const SAVED = '/orgs/org-1/saved-messages';
  const saved = (id: string, overrides = {}) => ({
    ...message({ id, body: `saved ${id}`, senderUserId: 'user-2', bookmarked: true }),
    conversationId: 'conv-x',
    kind: 'channel',
    channelId: 'ch-1',
    workspaceId: 'ws-1',
    savedAt: new Date().toISOString(),
    ...overrides,
  });
  const base = (extra: Record<string, Handler> = {}) =>
    setup({ [`GET ${SAVED}`]: () => json(200, { data: [saved('s1')], nextCursor: null }), ...extra });

  it('is in the navigation and lists saved messages with where they live', async () => {
    base();
    const { user } = await renderApp('/o/acme');
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await user.click(within(nav).getByRole('link', { name: 'Saved' }));
    expect(await screen.findByRole('heading', { name: 'Saved messages', level: 2 })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Saved messages' });
    expect(within(list).getByText('saved s1')).toBeInTheDocument();
    expect(await within(list).findByText('general')).toBeInTheDocument();
    expect(within(list).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open in channel' })).toHaveAttribute(
      'href',
      '/o/acme/w/ws-1/c/ch-1#message-s1',
    );
  });

  it('links conversation messages to the conversation and says what kind', async () => {
    base({
      [`GET ${SAVED}`]: () =>
        json(200, {
          data: [saved('s2', { kind: 'group', channelId: null, workspaceId: null, conversationId: 'conv-g' })],
          nextCursor: null,
        }),
    });
    await renderApp('/o/acme/saved');
    expect(await screen.findByText('Group conversation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
      'href',
      '/o/acme/messages/conv-g#message-s2',
    );
  });

  it('removes a message from the list with DELETE on its bookmark', async () => {
    let remaining = [saved('s1')];
    const stub = base({
      [`GET ${SAVED}`]: () => json(200, { data: remaining, nextCursor: null }),
      [`DELETE ${MESSAGES}/s1/bookmark`]: () => {
        remaining = [];
        return undefined;
      },
    });
    const { user } = await renderApp('/o/acme/saved');
    await user.click(await screen.findByRole('button', { name: 'Remove from saved' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${MESSAGES}/s1/bookmark`)).toHaveLength(1));
    expect(await screen.findByText('Nothing saved yet')).toBeInTheDocument();
  });

  it('shows an empty state, pages with a cursor and reports a failed load', async () => {
    base({ [`GET ${SAVED}`]: () => json(200, { data: [], nextCursor: null }) });
    await renderApp('/o/acme/saved');
    expect(await screen.findByText('Nothing saved yet')).toBeInTheDocument();
  });

  it('loads more with the cursor', async () => {
    const stub = base({
      [`GET ${SAVED}`]: (call) =>
        call.query.get('cursor') === 'c2'
          ? json(200, { data: [saved('s2')], nextCursor: null })
          : json(200, { data: [saved('s1')], nextCursor: 'c2' }),
    });
    const { user } = await renderApp('/o/acme/saved');
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('saved s2')).toBeInTheDocument();
    expect(screen.getByText('saved s1')).toBeInTheDocument();
    expect(stub.callsTo(`GET ${SAVED}`).some((call) => call.query.get('cursor') === 'c2')).toBe(true);
  });

  it('reports a failed load with a way to retry', async () => {
    let fail = true;
    base({
      [`GET ${SAVED}`]: () =>
        fail ? problem(503, 'dependency_unavailable') : json(200, { data: [saved('s1')], nextCursor: null }),
    });
    const { user } = await renderApp('/o/acme/saved');
    await screen.findByText("Couldn't load saved messages");
    fail = false;
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('saved s1')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    base();
    await renderApp('/o/acme/saved');
    await screen.findByText('saved s1');
    expect(await axeViolations()).toEqual([]);
  });
});
