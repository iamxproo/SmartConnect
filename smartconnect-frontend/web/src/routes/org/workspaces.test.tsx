import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { channel, inAcme, member, page, workspace } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const desktopSidebar = () => within(screen.getByRole('complementary', { name: 'Sidebar' }));

const engineering = workspace();
const secret = workspace({
  id: 'ws-2',
  name: 'Skunkworks',
  slug: 'skunkworks',
  visibility: 'private',
  myRole: 'admin',
});
const sales = workspace({ id: 'ws-3', name: 'Sales', slug: 'sales', myRole: null });

const withWorkspaces = (permissions: string[] = []) => ({
  ...inAcme(permissions),
  'GET /orgs/org-1/workspaces': () => ({ data: [engineering, secret, sales] }),
  'GET /orgs/org-1/workspaces/:id': (_call: unknown, params: Record<string, string>) =>
    [engineering, secret, sales].find((item) => item.id === params.id) ?? problem(404, 'not_found'),
});

describe('workspace list', () => {
  it('lists open and private workspaces with the right action for each', async () => {
    stubApi(withWorkspaces());
    await renderApp('/o/acme/workspaces');
    expect(await screen.findByRole('heading', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Skunkworks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join Sales' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Engineering' })).not.toBeInTheDocument();
  });

  it('joins an open workspace and moves into it', async () => {
    const stub = stubApi({
      ...withWorkspaces(),
      'POST /orgs/org-1/workspaces/ws-3/join': () => ({ ...sales, myRole: 'member' }),
      'GET /orgs/org-1/workspaces/ws-3/channels': () => ({ data: [] }),
    });
    const { user, router } = await renderApp('/o/acme/workspaces');
    await user.click(await screen.findByRole('button', { name: 'Join Sales' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-3'));
    expect(stub.callsTo('POST /orgs/org-1/workspaces/ws-3/join')).toHaveLength(1);
  });

  it('shows a refused join instead of navigating', async () => {
    stubApi({ ...withWorkspaces(), 'POST /orgs/org-1/workspaces/ws-3/join': () => problem(403, 'forbidden') });
    const { user, router } = await renderApp('/o/acme/workspaces');
    await user.click(await screen.findByRole('button', { name: 'Join Sales' }));
    expect(await screen.findByText("You don't have permission to do this.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/o/acme/workspaces');
  });

  it('confirms before leaving and explains the last-administrator refusal', async () => {
    stubApi({ ...withWorkspaces(), 'POST /orgs/org-1/workspaces/ws-2/leave': () => problem(409, 'last_admin') });
    const { user } = await renderApp('/o/acme/workspaces');
    await user.click(await screen.findByRole('button', { name: 'Leave Skunkworks' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave Skunkworks?' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('last administrator');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('creates a workspace (permission holders only) and opens it', async () => {
    const stub = stubApi({
      ...withWorkspaces(['workspaces.create']),
      'POST /orgs/org-1/workspaces': () => json(201, workspace({ id: 'ws-9', name: 'Design', slug: 'design' })),
      'GET /orgs/org-1/workspaces/ws-9': () => workspace({ id: 'ws-9', name: 'Design', slug: 'design' }),
      'GET /orgs/org-1/workspaces/ws-9/channels': () => ({ data: [] }),
      'GET /orgs/org-1/workspaces/ws-9/members': () => page([]),
    });
    const { user, router } = await renderApp('/o/acme/workspaces');
    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workspace' });
    await user.type(within(dialog).getByLabelText('Workspace name'), 'Design');
    await user.selectOptions(within(dialog).getByLabelText('Visibility'), 'private');
    await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-9'));
    expect(stub.callsTo('POST /orgs/org-1/workspaces')[0]?.body).toEqual({
      name: 'Design',
      slug: 'design',
      visibility: 'private',
    });
  });

  it('keeps the create dialog open and shows the server refusal', async () => {
    stubApi({
      ...withWorkspaces(['workspaces.create']),
      'POST /orgs/org-1/workspaces': () => problem(403, 'forbidden'),
    });
    const { user } = await renderApp('/o/acme/workspaces');
    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workspace' });
    await user.type(within(dialog).getByLabelText('Workspace name'), 'Design');
    await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("don't have permission");
  });
});

describe('workspace and channels', () => {
  const general = channel();
  const random = channel({ id: 'ch-2', name: 'random', isDefault: false, isMember: false, myRole: null });
  const leadership = channel({ id: 'ch-3', name: 'leadership', type: 'private', isDefault: false });
  const withChannels = () => ({
    ...withWorkspaces(),
    'GET /orgs/org-1/workspaces/ws-1/channels': () => ({ data: [general, random, leadership] }),
    'GET /orgs/org-1/workspaces/ws-1/channels/:id': (_call: unknown, params: Record<string, string>) =>
      [general, random, leadership].find((item) => item.id === params.id) ?? problem(404, 'not_found'),
    'GET /orgs/org-1/workspaces/ws-1/members': () =>
      page([
        { userId: 'user-1', role: 'admin', joinedAt: '' },
        { userId: 'user-9', role: 'member', joinedAt: '' },
      ]),
    'GET /orgs/org-1/members': () => page([member()]),
    'GET /orgs/org-1/workspaces/ws-1/channels/:id/messages': () => page([]),
  });

  it('lists the channels the API returns in the sidebar, private ones included', async () => {
    stubApi(withChannels());
    await renderApp('/o/acme/w/ws-1');
    const channels = await desktopSidebar().findByRole('navigation', { name: 'Channels' });
    expect(await within(channels).findByRole('link', { name: 'general' })).toBeInTheDocument();
    expect(within(channels).getByRole('link', { name: 'leadership' })).toBeInTheDocument();
    expect(within(channels).getByRole('link', { name: 'random, not joined' })).toBeInTheDocument();
  });

  it('names workspace members from the organization member list', async () => {
    stubApi(withChannels());
    await renderApp('/o/acme/w/ws-1');
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Unknown member')).toBeInTheDocument();
  });

  it('switches workspace from the sidebar switcher', async () => {
    stubApi({
      ...withChannels(),
      'GET /orgs/org-1/workspaces/ws-2/channels': () => ({ data: [] }),
      'GET /orgs/org-1/workspaces/ws-2/members': () => page([]),
    });
    const { user, router } = await renderApp('/o/acme/w/ws-1');
    await user.click(await desktopSidebar().findByRole('button', { name: 'Workspace: Engineering' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Skunkworks' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-2'));
    expect(await desktopSidebar().findByRole('button', { name: 'Workspace: Skunkworks' })).toBeInTheDocument();
  });

  it('shows a channel with its conversation', async () => {
    stubApi(withChannels());
    await renderApp('/o/acme/w/ws-1/c/ch-1');
    expect(await screen.findByRole('heading', { name: '# general' })).toBeInTheDocument();
    expect(await screen.findByText('No messages yet.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message #general' })).toBeInTheDocument();
  });

  it('navigates between channels from the sidebar', async () => {
    stubApi(withChannels());
    const { user } = await renderApp('/o/acme/w/ws-1/c/ch-1');
    await user.click(await desktopSidebar().findByRole('link', { name: 'leadership' }));
    expect(await screen.findByRole('heading', { name: '# leadership' })).toBeInTheDocument();
  });

  it('joins a public channel', async () => {
    const stub = stubApi({
      ...withChannels(),
      'POST /orgs/org-1/workspaces/ws-1/channels/ch-2/join': () => ({ ...random, isMember: true }),
    });
    const { user } = await renderApp('/o/acme/w/ws-1');
    await user.click(await screen.findByRole('button', { name: 'Join random' }));
    expect(await screen.findByText('Joined #random')).toBeInTheDocument();
    expect(stub.callsTo('POST /orgs/org-1/workspaces/ws-1/channels/ch-2/join')).toHaveLength(1);
  });

  it('leaves a channel after confirmation', async () => {
    const stub = stubApi({
      ...withChannels(),
      'POST /orgs/org-1/workspaces/ws-1/channels/ch-1/leave': () => undefined,
    });
    const { user } = await renderApp('/o/acme/w/ws-1/c/ch-1');
    await user.click(await screen.findByRole('button', { name: 'Leave channel' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave channel' }));
    expect(await screen.findByText('Left #general')).toBeInTheDocument();
    expect(stub.callsTo('POST /orgs/org-1/workspaces/ws-1/channels/ch-1/leave')).toHaveLength(1);
  });

  it('creates a channel and reports a name clash', async () => {
    const stub = stubApi({
      ...withChannels(),
      'POST /orgs/org-1/workspaces/ws-1/channels': (call) =>
        (call.body as { name: string }).name === 'general'
          ? problem(409, 'channel_name_taken')
          : json(201, channel({ id: 'ch-7', name: 'launch', isDefault: false })),
    });
    const { user, router } = await renderApp('/o/acme/w/ws-1');
    await user.click(await screen.findByRole('button', { name: 'New channel' }));
    const dialog = await screen.findByRole('dialog', { name: 'New channel' });
    await user.type(within(dialog).getByLabelText('Channel name'), 'general');
    await user.click(within(dialog).getByRole('button', { name: 'Create channel' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');

    await user.clear(within(dialog).getByLabelText('Channel name'));
    await user.type(within(dialog).getByLabelText('Channel name'), 'launch');
    await user.click(within(dialog).getByRole('button', { name: 'Create channel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-1/c/ch-7'));
    expect(stub.callsTo('POST /orgs/org-1/workspaces/ws-1/channels').at(-1)?.body).toEqual({
      name: 'launch',
      type: 'public',
    });
  });

  it('does not list channels for a workspace the person has not joined', async () => {
    const stub = stubApi(withChannels());
    await renderApp('/o/acme/w/ws-3');
    expect(await screen.findByText('Join this workspace to see its channels and members.')).toBeInTheDocument();
    expect(stub.callsTo('GET /orgs/org-1/workspaces/ws-3/channels')).toHaveLength(0);
  });

  it('shows not found for a workspace the server hides', async () => {
    stubApi(withChannels());
    await renderApp('/o/acme/w/ws-404');
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
  });

  it.each(['/o/acme/w/ws-1', '/o/acme/w/ws-1/c/ch-1', '/o/acme/w/ws-3'])(
    'has no axe violations at %s',
    async (path) => {
      stubApi(withChannels());
      await renderApp(path);
      await screen.findByRole('heading', { level: 2 });
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(await axeViolations()).toEqual([]);
    },
  );
});
