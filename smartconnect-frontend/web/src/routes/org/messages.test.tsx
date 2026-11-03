import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_LIVE_POLL_MS, MESSAGE_POLL_MS } from '@/lib/queries/messages';
import { json, problem, stubApi } from '@/test/api-stub';
import { channel, inAcme, member, message, workspace } from '@/test/fixtures';
import { actionsOf, chooseAction } from '@/test/message-actions';
import { axeViolations, renderApp } from '@/test/render-app';

const PATH = '/o/acme/w/ws-1/c/ch-1';
const MESSAGES = '/orgs/org-1/workspaces/ws-1/channels/ch-1/messages';
const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'g@example.com' });

const setup = (options: { channel?: Partial<ReturnType<typeof channel>>; messages?: unknown[]; extra?: object } = {}) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/workspaces': () => ({ data: [workspace()] }),
    'GET /orgs/org-1/workspaces/ws-1': () => workspace(),
    'GET /orgs/org-1/workspaces/ws-1/channels': () => ({ data: [channel(options.channel)] }),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1': () => channel(options.channel),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1/members': () => ({ data: [] }),
    'GET /orgs/org-1/members': () => json(200, { data: [member(), grace], nextCursor: null }),
    [`GET ${MESSAGES}`]: () => json(200, { data: options.messages ?? [], nextCursor: null }),
    ...options.extra,
  });

const log = () => screen.findByRole('log', { name: 'Messages in #general' });
const texts = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((item) => item.querySelector('p')?.textContent);

afterEach(() => vi.useRealTimers());

describe('history', () => {
  it('shows messages oldest to newest with sender names from the member list', async () => {
    setup({
      messages: [
        message({ id: 'm3', body: 'third', senderUserId: 'user-2', createdAt: '2026-11-03T10:03:00.000Z' }),
        message({ id: 'm2', body: 'second', senderUserId: 'gone', createdAt: '2026-11-03T10:02:00.000Z' }),
        message({ id: 'm1', body: 'first', createdAt: '2026-11-03T10:01:00.000Z' }),
      ],
    });
    await renderApp(PATH);
    const list = await log();
    await within(list).findByText('first');
    expect(texts(list)).toEqual(['first', 'second', 'third']);
    expect(within(list).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(list).getByText('Former member')).toBeInTheDocument();
    expect(list).toHaveAttribute('aria-live', 'polite');
  });

  it('loads older messages through nextCursor and puts them above the existing ones', async () => {
    const stub = setup({
      extra: {
        [`GET ${MESSAGES}`]: (call: { query: URLSearchParams }) =>
          call.query.get('cursor') === 'c2'
            ? json(200, {
                data: [message({ id: 'm1', body: 'older', createdAt: '2026-11-03T09:00:00.000Z' })],
                nextCursor: null,
              })
            : json(200, { data: [message({ id: 'm2', body: 'newer' })], nextCursor: 'c2' }),
      },
    });
    const { user } = await renderApp(PATH);
    await user.click(await screen.findByRole('button', { name: 'Load older messages' }));
    const list = await log();
    await within(list).findByText('older');
    expect(texts(list)).toEqual(['older', 'newer']);
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
    expect(stub.callsTo(`GET ${MESSAGES}`).some((call) => call.query.get('cursor') === 'c2')).toBe(true);
  });

  it('renders bodies as plain text with line breaks, never as markup', async () => {
    setup({ messages: [message({ body: '<script>alert(1)</script>\n<b>bold?</b>' })] });
    await renderApp(PATH);
    const list = await log();
    const body = await within(list).findByText(/alert\(1\)/);
    expect(body.textContent).toBe('<script>alert(1)</script>\n<b>bold?</b>');
    expect(body).toHaveClass('whitespace-pre-wrap');
    expect(list.querySelector('script, b')).toBeNull();
  });

  it('shows a tombstone for deleted messages and an (edited) marker for edited ones', async () => {
    setup({
      messages: [
        message({ id: 'm2', body: 'fixed text', editedAt: '2026-11-03T10:05:00.000Z' }),
        message({ id: 'm1', body: null, deletedAt: '2026-11-03T10:04:00.000Z' }),
      ],
    });
    await renderApp(PATH);
    expect(await screen.findByText('Message deleted')).toBeInTheDocument();
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('merges polled messages without duplicates', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polled = false;
    setup({
      extra: {
        [`GET ${MESSAGES}`]: () =>
          json(200, {
            data: polled
              ? [
                  message({ id: 'm2', body: 'arrived', createdAt: '2026-11-03T10:05:00.000Z' }),
                  message({ id: 'm1', body: 'first' }),
                ]
              : [message({ id: 'm1', body: 'first' })],
            nextCursor: null,
          }),
      },
    });
    await renderApp(PATH);
    const list = await log();
    await within(list).findByText('first');
    polled = true;
    await vi.advanceTimersByTimeAsync(MESSAGE_POLL_MS + 100);
    await within(list).findByText('arrived');
    expect(texts(list)).toEqual(['first', 'arrived']);
  });
});

describe('sending', () => {
  const type = async (user: Awaited<ReturnType<typeof renderApp>>['user'], text: string) =>
    user.type(await screen.findByRole('textbox', { name: 'Message #general' }), text);

  it('shows the message as pending until the server confirms, then as sent', async () => {
    let release: (value: Response) => void = () => undefined;
    const stub = setup({
      extra: { [`POST ${MESSAGES}`]: () => new Promise<Response>((resolve) => (release = resolve)) },
    });
    const { user } = await renderApp(PATH);
    await type(user, 'hi there{Enter}');

    const list = await log();
    expect(await within(list).findByText('Sending…')).toBeInTheDocument();
    const call = stub.callsTo(`POST ${MESSAGES}`)[0];
    expect(call?.body).toMatchObject({ body: 'hi there' });
    const clientMessageId = (call?.body as { clientMessageId: string }).clientMessageId;
    expect(clientMessageId).toMatch(/[0-9a-f-]{36}/);
    expect(screen.getByRole('textbox', { name: 'Message #general' })).toHaveValue('');

    release(json(201, message({ id: 'm9', body: 'hi there', clientMessageId })));
    await waitFor(() => expect(within(list).queryByText('Sending…')).not.toBeInTheDocument());
    expect(texts(list)).toEqual(['hi there']);
  });

  it('keeps Shift+Enter for new lines and never sends blank text', async () => {
    const stub = setup();
    const { user } = await renderApp(PATH);
    const box = await screen.findByRole('textbox', { name: 'Message #general' });
    await user.type(box, '   {Enter}');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('   line one\nline two');
    expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(0);
  });

  it('refuses bodies over 40 000 characters', async () => {
    const stub = setup();
    const { user } = await renderApp(PATH);
    const box = await screen.findByRole('textbox', { name: 'Message #general' });
    fireEvent.change(box, { target: { value: 'x'.repeat(40_001) } });
    expect(box).toHaveAccessibleDescription(/at most 40,000 characters/);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.type(box, '{Enter}');
    expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(0);
  });

  it('offers retry on failure and reuses the same clientMessageId (a 200 replay counts as success)', async () => {
    let attempts = 0;
    const stub = setup({
      extra: {
        [`POST ${MESSAGES}`]: (call: { body: unknown }) =>
          ++attempts === 1
            ? problem(503, 'service_unavailable')
            : json(
                200,
                message({
                  id: 'm9',
                  body: 'retry me',
                  clientMessageId: (call.body as { clientMessageId: string }).clientMessageId,
                }),
              ),
      },
    });
    const { user } = await renderApp(PATH);
    await type(user, 'retry me{Enter}');
    const failure = await screen.findByText(/Not sent:/);
    expect(failure).toHaveTextContent('having trouble');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Not sent:/)).not.toBeInTheDocument());

    const [first, second] = stub
      .callsTo(`POST ${MESSAGES}`)
      .map((call) => (call.body as { clientMessageId: string }).clientMessageId);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(texts(await log())).toEqual(['retry me']);
  });

  it('explains a refusal because the person is no longer a member', async () => {
    setup({ extra: { [`POST ${MESSAGES}`]: () => problem(403, 'not_a_channel_member') } });
    const { user } = await renderApp(PATH);
    await type(user, 'hello{Enter}');
    expect(await screen.findByText(/Join this channel to post in it/)).toBeInTheDocument();
  });
});

describe('who can post', () => {
  it('offers to join when the channel is visible but the person is not a member', async () => {
    const stub = setup({
      channel: { isMember: false, myRole: null },
      messages: [message()],
      extra: { 'POST /orgs/org-1/workspaces/ws-1/channels/ch-1/join': () => channel() },
    });
    const { user } = await renderApp(PATH);
    expect(await screen.findByText('Hello team')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message #general' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join channel to post' }));
    await waitFor(() => expect(stub.callsTo('POST /orgs/org-1/workspaces/ws-1/channels/ch-1/join')).toHaveLength(1));
  });

  it('disables posting in an archived channel and says why', async () => {
    setup({ channel: { archivedAt: '2026-10-01T00:00:00.000Z' }, messages: [message()] });
    await renderApp(PATH);
    expect(await screen.findByText(/This channel is archived/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message #general' })).not.toBeInTheDocument();
  });

  it('reports channel_archived from the server when archiving happened meanwhile', async () => {
    setup({ extra: { [`POST ${MESSAGES}`]: () => problem(409, 'channel_archived') } });
    const { user } = await renderApp(PATH);
    await user.type(await screen.findByRole('textbox', { name: 'Message #general' }), 'late{Enter}');
    expect(await screen.findByText(/archived and read-only/)).toBeInTheDocument();
  });
});

describe('editing and deleting', () => {
  const mine = message({ id: 'm1', body: 'my words' });
  const theirs = message({
    id: 'm2',
    body: 'their words',
    senderUserId: 'user-2',
    createdAt: '2026-11-03T10:01:00.000Z',
  });
  const rowOf = async (text: string) => (await screen.findByText(text)).closest('li') as HTMLElement;

  it('lets members edit and delete only their own messages', async () => {
    setup({ messages: [theirs, mine] });
    const { user } = await renderApp(PATH);
    expect(await actionsOf(user, await rowOf('my words'))).toEqual([
      'Reply in thread',
      'Add reaction',
      'Save message',
      'Copy link',
      'Edit',
      'Delete',
    ]);
    expect(await actionsOf(user, await rowOf('their words'))).toEqual([
      'Reply in thread',
      'Add reaction',
      'Save message',
      'Copy link',
    ]);
  });

  it('lets a channel administrator delete, but not edit, other people’s messages', async () => {
    setup({ channel: { myRole: 'admin' }, messages: [theirs, mine] });
    const { user } = await renderApp(PATH);
    expect((await actionsOf(user, await rowOf('their words'))).slice(-1)).toEqual(['Delete']);
    expect(await actionsOf(user, await rowOf('their words'))).not.toContain('Edit');
  });

  it('edits in place and saves with PATCH', async () => {
    const stub = setup({
      messages: [mine],
      extra: {
        [`PATCH ${MESSAGES}/:id`]: () => ({ ...mine, body: 'better words', editedAt: '2026-11-03T10:09:00.000Z' }),
      },
    });
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('my words'), 'Edit');
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(box);
    await user.type(box, 'better words');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.callsTo(`PATCH ${MESSAGES}/m1`)).toHaveLength(1));
    expect(stub.callsTo(`PATCH ${MESSAGES}/m1`)[0]?.body).toEqual({ body: 'better words' });
  });

  it('reports editing a message that was deleted meanwhile', async () => {
    setup({ messages: [mine], extra: { [`PATCH ${MESSAGES}/:id`]: () => problem(409, 'message_deleted') } });
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('my words'), 'Edit');
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This message was deleted.')).toBeInTheDocument();
  });

  it('confirms before deleting and sends DELETE', async () => {
    const stub = setup({ messages: [mine], extra: { [`DELETE ${MESSAGES}/:id`]: () => undefined } });
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('my words'), 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this message?' });
    expect(stub.callsTo(`DELETE ${MESSAGES}/m1`)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete message' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${MESSAGES}/m1`)).toHaveLength(1));
  });

  it('shows a refused delete in the dialog', async () => {
    setup({ messages: [mine], extra: { [`DELETE ${MESSAGES}/:id`]: () => problem(403, 'forbidden') } });
    const { user } = await renderApp(PATH);
    await chooseAction(user, await rowOf('my words'), 'Delete');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete message' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("don't have permission");
  });
});

describe('realtime', () => {
  const arriving = () => {
    let arrived = false;
    const stub = setup({
      extra: {
        [`GET ${MESSAGES}`]: () =>
          json(200, {
            data: arrived
              ? [
                  message({ id: 'm2', body: 'arrived', createdAt: '2026-11-03T10:05:00.000Z' }),
                  message({ id: 'm1', body: 'first' }),
                ]
              : [message({ id: 'm1', body: 'first' })],
            nextCursor: null,
          }),
      },
    });
    return { stub, arrive: () => (arrived = true) };
  };

  it('watches the open channel and refetches as soon as the gateway reports a change', async () => {
    const { arrive } = arriving();
    const { realtime } = await renderApp(PATH);
    const list = await log();
    await within(list).findByText('first');
    expect(realtime.refs()).toEqual([{ organizationId: 'org-1', workspaceId: 'ws-1', channelId: 'ch-1' }]);
    arrive();
    act(() => realtime.change('ch-1'));
    await within(list).findByText('arrived');
  });

  it('polls rarely while live, and every few seconds again once not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { stub } = arriving();
    const { realtime } = await renderApp(PATH);
    await within(await log()).findByText('first');
    const polls = () => stub.callsTo(`GET ${MESSAGES}`).length;
    act(() => realtime.setLive('ch-1', true));
    const live = polls();
    await vi.advanceTimersByTimeAsync(MESSAGE_POLL_MS * 2);
    expect(polls()).toBe(live);
    await vi.advanceTimersByTimeAsync(MESSAGE_LIVE_POLL_MS);
    expect(polls()).toBeGreaterThan(live);

    act(() => realtime.setLive('ch-1', false));
    const offline = polls();
    await vi.advanceTimersByTimeAsync(MESSAGE_POLL_MS + 100);
    expect(polls()).toBeGreaterThan(offline);
  });
});

describe('accessibility', () => {
  it('has no axe violations with messages, composer and a tombstone', async () => {
    setup({
      messages: [message({ id: 'm2' }), message({ id: 'm1', body: null, deletedAt: '2026-11-03T10:04:00.000Z' })],
    });
    await renderApp(PATH);
    await screen.findByText('Hello team');
    expect(await axeViolations()).toEqual([]);
  });
});
