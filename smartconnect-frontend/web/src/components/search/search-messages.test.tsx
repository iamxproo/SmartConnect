import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { json, problem, stubApi, type Handler } from '@/test/api-stub';
import { inAcme, member } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const ada = member({ userId: 'user-1', displayName: 'Ada Lovelace' });
const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' });
const page = (data: unknown[], nextCursor: string | null = null) => json(200, { data, nextCursor });
const channelLocation = { kind: 'channel', workspaceId: 'ws-1', channelId: 'ch-1' };
const hit = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg-1',
  senderUserId: 'user-2',
  body: 'The quarterly budget review is on Friday',
  threadRootId: null,
  createdAt: '2026-05-01T10:00:00Z',
  location: channelLocation,
  ...overrides,
});
const fileHit = {
  fileId: 'file-1',
  name: 'budget.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  messageId: 'msg-1',
  location: channelLocation,
  createdAt: '2026-05-01T10:00:00Z',
};
const ownFile = {
  id: 'file-9',
  name: 'Budget notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 12,
  status: 'available',
  uploadedByUserId: 'user-1',
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt: '2026-04-01T10:00:00Z',
};

const setup = (extra: Record<string, Handler> = {}) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/members': (call) => (call.query.has('userId') ? page([grace]) : page([ada, grace])),
    'GET /orgs/org-1/channels': () =>
      page([
        {
          id: 'ch-1',
          workspaceId: 'ws-1',
          workspaceName: 'Eng',
          name: 'general',
          type: 'public',
          isMember: true,
          archivedAt: null,
        },
      ]),
    'GET /orgs/org-1/workspaces': () => page([]),
    'GET /orgs/org-1/conversations': () => page([]),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1': () => json(200, { id: 'ch-1', name: 'general' }),
    'GET /orgs/org-1/message-search': (call) => (call.query.get('type') === 'files' ? page([fileHit]) : page([hit()])),
    'GET /orgs/org-1/files': () => page([ownFile]),
    ...extra,
  });

const messageCalls = (stub: ReturnType<typeof setup>, type: 'messages' | 'files' = 'messages') =>
  stub.callsTo('GET /orgs/org-1/message-search').filter((call) => (call.query.get('type') ?? 'messages') === type);

describe('message and file sources on the search page', () => {
  it('shows messages with the sender, place and highlighted words, and opens one with ?message=', async () => {
    const stub = setup();
    const { user, router } = await renderApp('/o/acme/search?q=budget%20review');
    const messages = await screen.findByRole('region', { name: /Messages/ });
    const result = await within(messages).findByRole('button', { name: /quarterly budget review/ });
    expect(result).toHaveTextContent('Grace Hopper · in #general');
    expect([...result.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['budget', 'review']);
    expect(messageCalls(stub)[0]!.query.get('limit')).toBe('20');
    await user.click(result);
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-1/c/ch-1'));
    expect(router.state.location.search).toEqual({ message: 'msg-1' });
  });

  it('opens a message of a direct or group conversation in that conversation', async () => {
    setup({
      'GET /orgs/org-1/message-search': (call) =>
        call.query.get('type') === 'files'
          ? page([])
          : page([hit({ location: { kind: 'group', conversationId: 'conv-4' } })]),
    });
    const { user, router } = await renderApp('/o/acme/search?q=budget');
    await user.click(await screen.findByRole('button', { name: /quarterly budget/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages/conv-4'));
    expect(router.state.location.search).toEqual({ message: 'msg-1' });
  });

  it('never interprets message text as markup', async () => {
    const evil = '<img src=x onerror="alert(1)"> budget <b>bold</b>';
    setup({
      'GET /orgs/org-1/message-search': (call) =>
        call.query.get('type') === 'files' ? page([]) : page([hit({ body: evil })]),
    });
    await renderApp('/o/acme/search?q=budget');
    const result = await screen.findByRole('button', { name: /img src/ });
    expect(result.querySelector('img')).toBeNull();
    expect(result.querySelector('b')).toBeNull();
    expect(result).toHaveTextContent(evil);
    expect([...result.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['budget']);
  });

  it('lists attachments and own uploads once each, and downloads a file', async () => {
    const stub = setup({
      'GET /orgs/org-1/files': () => page([ownFile, { ...ownFile, id: 'file-1', name: 'budget.pdf' }]),
      'GET /orgs/org-1/files/file-1/content': () => new Response('pdf-bytes', { status: 200 }),
    });
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { user } = await renderApp('/o/acme/search?q=budget');
    const files = await screen.findByRole('region', { name: /Files/ });
    const buttons = await within(files).findAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('budget.pdf'),
      expect.stringContaining('Budget notes.txt'),
    ]);
    expect(messageCalls(stub, 'files')).toHaveLength(1);
    await user.click(buttons[0]!);
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(stub.callsTo('GET /orgs/org-1/files/file-1/content')).toHaveLength(1);
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('keeps the other sections when messages fail, and says so', async () => {
    setup({ 'GET /orgs/org-1/message-search': () => problem(503, 'dependency_unavailable') });
    await renderApp('/o/acme/search?q=budget');
    const messages = await screen.findByRole('region', { name: /Messages/ });
    expect(await within(messages).findByRole('alert')).toHaveTextContent('Couldn’t search messages.');
    expect(await screen.findByRole('region', { name: /People/ })).toBeInTheDocument();
  });

  it('pages messages with the cursor', async () => {
    const stub = setup({
      'GET /orgs/org-1/message-search': (call) => {
        if (call.query.get('type') === 'files') return page([]);
        return call.query.get('cursor') === 'c2'
          ? page([hit({ id: 'msg-2', body: 'second budget page' })])
          : page([hit()], 'c2');
      },
    });
    const { user } = await renderApp('/o/acme/search?q=budget');
    await user.click(await screen.findByRole('button', { name: 'Load more messages' }));
    expect(await screen.findByRole('button', { name: /second budget page/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quarterly budget/ })).toBeInTheDocument();
    expect(messageCalls(stub).map((call) => call.query.get('cursor'))).toEqual([null, 'c2']);
  });

  it('moves between results with the arrow keys', async () => {
    setup();
    const { user } = await renderApp('/o/acme/search?q=budget');
    await screen.findByRole('button', { name: /quarterly budget/ });
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{ArrowDown}');
    const first = document.activeElement as HTMLElement;
    expect(first).toHaveAttribute('data-search-result');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).not.toBe(first);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('has no accessibility violations with results and chips', async () => {
    setup();
    const { user } = await renderApp('/o/acme/search?q=budget');
    await screen.findByRole('button', { name: /quarterly budget/ });
    await user.click(screen.getByRole('button', { name: 'Has file' }));
    expect(await axeViolations()).toEqual([]);
  });
});

describe('search modifiers and chips', () => {
  it('turns typed modifiers into removable chips that filter messages and files only', async () => {
    const stub = setup();
    const { user, router } = await renderApp('/o/acme/search');
    await user.type(
      await screen.findByRole('searchbox'),
      'budget from:@"Grace Hopper" in:#general before:2026-06-01 after:2026-01-01 has:file ',
    );
    for (const label of ['from: Grace Hopper', 'in: #general', 'before: 2026-06-01', 'after: 2026-01-01', 'has: file'])
      expect(await screen.findByRole('button', { name: `Remove filter ${label}` })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('budget ');
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'budget' }));

    await waitFor(() => expect(screen.getByRole('region', { name: /Messages/ })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: /People/ })).not.toBeInTheDocument();
    await waitFor(() => expect(messageCalls(stub).at(-1)!.query.get('channelId')).toBe('ch-1'));
    const filtered = messageCalls(stub).at(-1)!;
    expect(Object.fromEntries(filtered.query)).toMatchObject({
      q: 'budget',
      from: 'user-2',
      channelId: 'ch-1',
      before: '2026-06-01',
      after: '2026-01-01',
      has: 'file',
    });
    // own uploads cannot match a conversation filter
    expect(stub.callsTo('GET /orgs/org-1/files').some((call) => call.query.get('q') === 'budget')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Remove filter from: Grace Hopper' }));
    expect(screen.queryByRole('button', { name: /Remove filter from/ })).not.toBeInTheDocument();
    await waitFor(() => expect(messageCalls(stub).at(-1)!.query.has('from')).toBe(false));
    expect(messageCalls(stub).at(-1)!.query.get('before')).toBe('2026-06-01');
  });

  it('leaves a name that matches nobody in the box and explains', async () => {
    setup({ 'GET /orgs/org-1/members': () => page([]) });
    const { user } = await renderApp('/o/acme/search');
    await user.type(await screen.findByRole('searchbox'), 'budget from:@nobody ');
    expect(await screen.findByText(/No single match for from:@nobody/)).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('budget from:@nobody ');
    expect(screen.queryByRole('button', { name: /Remove filter/ })).not.toBeInTheDocument();
  });

  it('picks a person and a channel with the chip pickers', async () => {
    const stub = setup();
    const { user } = await renderApp('/o/acme/search?q=budget');
    await user.click(await screen.findByRole('button', { name: 'From…' }));
    const fromPicker = await screen.findByRole('group', { name: 'Filter by person' });
    await user.click(await within(fromPicker).findByRole('button', { name: /Grace Hopper/ }));
    expect(screen.getByRole('button', { name: 'Remove filter from: Grace Hopper' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'In…' }));
    const inPicker = await screen.findByRole('group', { name: 'Filter by channel' });
    await user.click(await within(inPicker).findByRole('button', { name: /#general/ }));
    expect(screen.getByRole('button', { name: 'Remove filter in: #general' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        messageCalls(stub).some(
          (call) => call.query.get('channelId') === 'ch-1' && call.query.get('from') === 'user-2',
        ),
      ).toBe(true),
    );
  });

  it('takes modifiers that arrive in the address (from the palette) as chips', async () => {
    setup();
    const { router } = await renderApp('/o/acme/search?q=budget%20has%3Afile');
    expect(await screen.findByRole('button', { name: 'Remove filter has: file' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'budget' }));
  });

  it('asks for words when only chips are set', async () => {
    const stub = setup();
    const { user } = await renderApp('/o/acme/search');
    await user.click(await screen.findByRole('button', { name: 'Has file' }));
    expect(await screen.findByText('Add words to search for within these filters.')).toBeInTheDocument();
    expect(messageCalls(stub)).toHaveLength(0);
  });
});

describe('message and file sources in the palette', () => {
  it('shows the top 3 messages and files', async () => {
    const stub = setup();
    const { user } = await renderApp('/o/acme');
    await user.click(await screen.findByRole('button', { name: 'Search' }));
    await user.type(await screen.findByRole('combobox', { name: 'Search' }), 'budget');
    const list = await screen.findByRole('listbox', { name: 'Search results' });
    expect(await within(list).findByRole('group', { name: 'Messages' })).toBeInTheDocument();
    expect(await within(list).findByRole('group', { name: 'Files' })).toBeInTheDocument();
    expect(messageCalls(stub).every((call) => call.query.get('limit') === '3')).toBe(true);
  });
});
