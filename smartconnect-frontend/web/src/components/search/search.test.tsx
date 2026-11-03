import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi, type Handler } from '@/test/api-stub';
import { conversation, inAcme, member, workspace } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' });
const channelHit = {
  id: 'ch-9',
  workspaceId: 'ws-1',
  workspaceName: 'Engineering',
  name: 'graceful-exits',
  type: 'private',
  isMember: true,
  archivedAt: null,
};
const page = (data: unknown[], nextCursor: string | null = null) => json(200, { data, nextCursor });

/** Answers the three search endpoints; anything without `q` (sidebar, lookups) gets an empty list. */
const setup = (extra: Record<string, Handler> = {}) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/members': (call) => (call.query.has('q') ? page([member(), grace]) : page([])),
    'GET /orgs/org-1/channels': () => page([channelHit]),
    'GET /orgs/org-1/workspaces': (call) =>
      call.query.has('q') ? page([workspace({ id: 'ws-7', name: 'Grace Labs', visibility: 'private' })]) : page([]),
    'GET /orgs/org-1/conversations': () => page([]),
    'GET /orgs/org-1/message-search': () => page([]),
    'GET /orgs/org-1/files': () => page([]),
    ...extra,
  });

const palette = () => screen.findByRole('dialog', { name: 'Search' });
const box = () => screen.findByRole('combobox', { name: 'Search' });
const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent);

async function openPalette(path = '/o/acme') {
  const view = await renderApp(path);
  await view.user.click(await screen.findByRole('button', { name: 'Search' }));
  return { ...view, input: await box() };
}

describe('search palette', () => {
  it('opens from the top bar and with Ctrl+K and Cmd+K, focuses the box, and Escape closes and restores focus', async () => {
    setup();
    const { user, input } = await openPalette();
    expect(await palette()).toBeInTheDocument();
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus());

    await user.keyboard('{Control>}k{/Control}');
    expect(await box()).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await box()).toBeInTheDocument();
  });

  it('is not offered outside an organization', async () => {
    setup();
    await renderApp('/');
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('searches after a pause, once, and groups people, channels and workspaces', async () => {
    const stub = setup();
    const { user, input } = await openPalette();
    expect(screen.getByRole('status')).toHaveTextContent('Type to search');
    await user.type(input, 'grace');
    // typing alone sends nothing: only the settled text is searched
    expect(stub.calls.filter((call) => call.query.has('q'))).toHaveLength(0);
    await screen.findByRole('option', { name: /Grace Hopper/ });
    const searched = stub.calls.filter((call) => call.query.has('q'));
    expect(new Set(searched.map((call) => call.query.get('q')))).toEqual(new Set(['grace']));
    expect(searched.map((call) => call.path).sort()).toEqual([
      '/orgs/org-1/channels',
      '/orgs/org-1/files',
      '/orgs/org-1/members',
      '/orgs/org-1/message-search',
      '/orgs/org-1/message-search',
      '/orgs/org-1/workspaces',
    ]);
    const limits = (path: string) => searched.filter((call) => call.path === path).map((c) => c.query.get('limit'));
    expect(limits('/orgs/org-1/members')).toEqual(['5']);
    expect(limits('/orgs/org-1/message-search')).toEqual(['3', '3']); // the top 3 messages and files

    const list = screen.getByRole('listbox', { name: 'Search results' });
    expect(within(list).getByRole('group', { name: 'People' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'Channels' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'Workspaces' })).toBeInTheDocument();
    // yourself is not offered as a person to message
    expect(screen.queryByRole('option', { name: /Ada Lovelace/ })).not.toBeInTheDocument();
    expect(optionNames()).toHaveLength(4); // Grace, the channel, the workspace and "show all"
  });

  it('moves with the arrow keys (wrapping) via aria-activedescendant and opens the chosen channel with Enter', async () => {
    setup();
    const { user, input, router } = await openPalette();
    await user.type(input, 'grace');
    await screen.findByRole('option', { name: /graceful-exits/ });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true'); // wrapped to the last
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveFocus(); // focus never leaves the box
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-1/c/ch-9'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens a workspace', async () => {
    setup();
    const first = await openPalette();
    await first.user.type(first.input, 'grace');
    await first.user.click(await screen.findByRole('option', { name: /Grace Labs/ }));
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/o/acme/w/ws-7'));
  });

  it('starts the direct conversation with a person and opens it', async () => {
    const stub = setup({
      'POST /orgs/org-1/conversations/direct': () => json(201, conversation({ id: 'conv-77', participants: [] })),
    });
    const { user, input, router } = await openPalette();
    await user.type(input, 'grace');
    await user.click(await screen.findByRole('option', { name: /Grace Hopper/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/messages/conv-77'));
    expect(stub.callsTo('POST /orgs/org-1/conversations/direct')[0]!.body).toEqual({ userId: 'user-2' });
  });

  it('shows why a person could not be opened and stays open', async () => {
    setup({ 'POST /orgs/org-1/conversations/direct': () => problem(409, 'participant_inactive') });
    const { user, input, router } = await openPalette();
    await user.type(input, 'grace');
    await user.click(await screen.findByRole('option', { name: /Grace Hopper/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The other person is no longer in this organization');
    expect(router.state.location.pathname).toBe('/o/acme');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('leads to the search page with the query', async () => {
    setup();
    const { user, input, router } = await openPalette();
    await user.type(input, 'grace');
    await user.click(await screen.findByRole('option', { name: /Show all results for “grace”/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/search'));
    expect(router.state.location.search).toEqual({ q: 'grace' });
  });

  it('highlights matches as elements and never interprets markup in results', async () => {
    const evil = '<img src=x onerror="alert(1)">Gr<b>ace</b>';
    setup({
      'GET /orgs/org-1/members': (call) =>
        call.query.get('q') === '.*'
          ? page([])
          : page([member({ id: 'm-9', userId: 'user-9', displayName: evil, email: 'grace@example.com' })]),
      'GET /orgs/org-1/channels': () => page([]),
      'GET /orgs/org-1/workspaces': () => page([]),
    });
    const { user, input } = await openPalette();
    await user.type(input, 'grace');
    const option = await screen.findByRole('option', { name: /img src/ });
    // the markup is shown as text
    expect(option).toHaveTextContent(evil);
    expect(option.querySelector('img')).toBeNull();
    expect(option.querySelector('b')).toBeNull();
    // the match in the e-mail address is marked, case-insensitively
    const marks = option.querySelectorAll('mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['grace']);

    await user.clear(input);
    await user.type(input, '<IMG');
    await waitFor(() =>
      expect(within(screen.getByRole('option', { name: /img src/ })).getByText('<img')).toBeInTheDocument(),
    );
    expect(document.querySelector('img')).toBeNull();
    // regular-expression characters are literal
    await user.clear(input);
    await user.type(input, '.*');
    await screen.findByText(/No results for “\.\*”/);
  });

  it('says so when nothing matches, and keeps the other sections when one source fails', async () => {
    setup({
      'GET /orgs/org-1/members': () => problem(500, 'internal_error'),
      'GET /orgs/org-1/channels': () => page([]),
      'GET /orgs/org-1/workspaces': () => page([]),
    });
    const { user, input } = await openPalette();
    await user.type(input, 'zzz');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t search people.');
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument(); // not claimed while a source failed
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('retries a failed source', async () => {
    let failing = true;
    setup({
      'GET /orgs/org-1/members': (call) => {
        if (!call.query.has('q')) return page([]);
        return failing ? problem(500, 'internal_error') : page([grace]);
      },
    });
    const { user, input } = await openPalette();
    await user.type(input, 'grace');
    await user.click(await within(await screen.findByRole('alert')).findByRole('button', { name: 'Try again' }));
    failing = false;
    await user.click(await within(await screen.findByRole('alert')).findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /Grace Hopper/ })).toBeInTheDocument();
  });

  it('reports an empty result', async () => {
    setup({
      'GET /orgs/org-1/members': () => page([]),
      'GET /orgs/org-1/channels': () => page([]),
      'GET /orgs/org-1/workspaces': () => page([]),
    });
    const { user, input } = await openPalette();
    await user.type(input, 'nobody');
    expect(await screen.findByText('No results for “nobody”.')).toBeInTheDocument();
  });

  it('remembers nothing: no storage entry, and a reopened palette is empty', async () => {
    setup();
    const { user, input } = await openPalette();
    await user.type(input, 'secretterm');
    await screen.findByRole('option', { name: /Grace Hopper/ });
    const stored = () =>
      [window.localStorage, window.sessionStorage].flatMap((storage) =>
        Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`),
      );
    expect(stored().join('\n')).not.toContain('secretterm');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await box()).toHaveValue('');
    expect(stored().join('\n')).not.toContain('secretterm');
  });

  it('has no accessibility violations while open with results', async () => {
    setup();
    const { user, input } = await openPalette();
    await user.type(input, 'grace');
    await screen.findByRole('option', { name: /Grace Hopper/ });
    expect(await axeViolations()).toEqual([]);
  });
});

describe('search page', () => {
  it('shows results in sections for the q in the address, highlighted', async () => {
    const stub = setup();
    await renderApp('/o/acme/search?q=grace');
    expect(await screen.findByRole('heading', { level: 3, name: /People/ })).toBeInTheDocument();
    const people = screen.getByRole('region', { name: /People/ });
    expect(await within(people).findByRole('button', { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: /Channels/ })).getByRole('button', { name: /graceful-exits/ }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: /Workspaces/ })).getByRole('button', { name: /Grace Labs/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search this organization' })).toHaveValue('grace');
    expect(document.querySelectorAll('mark').length).toBeGreaterThan(0);
    expect(stub.calls.find((call) => call.query.get('q') === 'grace')!.query.get('limit')).toBe('20');
    expect(await axeViolations()).toEqual([]);
  });

  it('invites a search when there is no q', async () => {
    const stub = setup();
    await renderApp('/o/acme/search');
    expect(await screen.findByText('Search your organization')).toBeInTheDocument();
    expect(stub.calls.filter((call) => call.query.has('q'))).toHaveLength(0);
  });

  it('updates the address after a pause while typing, and searches the settled text only', async () => {
    const stub = setup();
    const { user, router } = await renderApp('/o/acme/search');
    await user.type(await screen.findByRole('searchbox'), 'gra');
    expect(router.state.location.search).toEqual({});
    await waitFor(() => expect(router.state.location.search).toEqual({ q: 'gra' }));
    await screen.findByRole('button', { name: /Grace Hopper/ });
    expect(new Set(stub.calls.filter((call) => call.query.has('q')).map((call) => call.query.get('q')))).toEqual(
      new Set(['gra']),
    );
  });

  it('opens a person, channel or workspace from the page', async () => {
    setup({ 'POST /orgs/org-1/conversations/direct': () => json(200, conversation({ id: 'conv-5' })) });
    const { user, router } = await renderApp('/o/acme/search?q=grace');
    await user.click(await screen.findByRole('button', { name: /graceful-exits/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-1/c/ch-9'));
  });

  it('shows an error with a retry for one source, and empty text for another', async () => {
    setup({
      'GET /orgs/org-1/members': () => problem(500, 'internal_error'),
      'GET /orgs/org-1/channels': () => page([]),
    });
    await renderApp('/o/acme/search?q=grace');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t search people.');
    expect(await screen.findByText('No channels match “grace”.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Grace Labs/ })).toBeInTheDocument();
  });

  it('loads more of a source with its cursor', async () => {
    const stub = setup({
      'GET /orgs/org-1/channels': (call) =>
        call.query.get('cursor') === 'next'
          ? page([{ ...channelHit, id: 'ch-10', name: 'graceful-two' }])
          : page([channelHit], 'next'),
    });
    const { user } = await renderApp('/o/acme/search?q=grace');
    const channels = await screen.findByRole('region', { name: /Channels/ });
    await user.click(await within(channels).findByRole('button', { name: 'Load more channels' }));
    expect(await within(channels).findByRole('button', { name: /graceful-two/ })).toBeInTheDocument();
    expect(within(channels).getByRole('button', { name: /graceful-exits/ })).toBeInTheDocument();
    expect(within(channels).queryByRole('button', { name: 'Load more channels' })).not.toBeInTheDocument();
    expect(stub.callsTo('GET /orgs/org-1/channels').some((call) => call.query.get('cursor') === 'next')).toBe(true);
  });
});
