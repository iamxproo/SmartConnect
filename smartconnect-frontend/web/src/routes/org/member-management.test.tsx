import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { channel, inAcme, member, page, workspace } from '@/test/fixtures';
import { renderApp } from '@/test/render-app';

const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'g@example.com' });
const alan = member({ id: 'member-3', userId: 'user-3', displayName: 'Alan Turing', email: 'a@example.com' });
const WS = '/orgs/org-1/workspaces/ws-1';

const setup = (options: {
  wsRole?: 'admin' | 'member';
  channel?: Partial<ReturnType<typeof channel>>;
  extra?: object;
}) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/members': () => page([member(), grace, alan]),
    'GET /orgs/org-1/workspaces': () => ({ data: [workspace({ myRole: options.wsRole ?? 'member' })] }),
    'GET /orgs/org-1/workspaces/ws-1': () => workspace({ myRole: options.wsRole ?? 'member' }),
    [`GET ${WS}/channels`]: () => ({ data: [channel(options.channel)] }),
    [`GET ${WS}/channels/ch-1`]: () => channel(options.channel),
    [`GET ${WS}/channels/ch-1/messages`]: () => page([]),
    [`GET ${WS}/members`]: () =>
      page([
        { userId: 'user-1', role: 'admin', joinedAt: '' },
        { userId: 'user-2', role: 'member', joinedAt: '' },
      ]),
    [`GET ${WS}/channels/ch-1/members`]: () => ({
      data: [
        { userId: 'user-1', role: 'admin', joinedAt: '' },
        { userId: 'user-2', role: 'member', joinedAt: '' },
      ],
    }),
    ...options.extra,
  });

describe('workspace members', () => {
  it('shows management controls only to workspace administrators', async () => {
    setup({ wsRole: 'member' });
    await renderApp('/o/acme/w/ws-1');
    await screen.findByText('Grace Hopper');
    expect(screen.queryByRole('form', { name: 'Add a member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Grace Hopper' })).not.toBeInTheDocument();
  });

  it('lets an administrator add a member, change a role and remove someone', async () => {
    const stub = setup({
      wsRole: 'admin',
      extra: {
        [`PUT ${WS}/members/:id`]: () => ({}),
        [`DELETE ${WS}/members/:id`]: () => undefined,
      },
    });
    const { user } = await renderApp('/o/acme/w/ws-1');
    const form = await screen.findByRole('form', { name: 'Add a member' });
    await user.selectOptions(within(form).getByLabelText('Person'), 'Alan Turing');
    await user.selectOptions(within(form).getByLabelText('Role'), 'guest');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(stub.callsTo(`PUT ${WS}/members/user-3`)).toHaveLength(1));
    expect(stub.callsTo(`PUT ${WS}/members/user-3`)[0]?.body).toEqual({ role: 'guest' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Role for Grace Hopper' }), 'admin');
    await waitFor(() => expect(stub.callsTo(`PUT ${WS}/members/user-2`)).toHaveLength(1));
    expect(stub.callsTo(`PUT ${WS}/members/user-2`)[0]?.body).toEqual({ role: 'admin' });

    await user.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(stub.callsTo(`DELETE ${WS}/members/user-2`)).toHaveLength(1));
  });

  it('shows the last-administrator refusal from the server', async () => {
    setup({ wsRole: 'admin', extra: { [`PUT ${WS}/members/:id`]: () => problem(409, 'last_admin') } });
    const { user } = await renderApp('/o/acme/w/ws-1');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for Ada Lovelace' }), 'member');
    expect(await screen.findByText(/last administrator/)).toBeInTheDocument();
  });
});

describe('channel members', () => {
  it('lets a member of a public channel add people but not remove them', async () => {
    const stub = setup({ extra: { [`PUT ${WS}/channels/ch-1/members/:id`]: () => json(200, {}) } });
    const { user } = await renderApp('/o/acme/w/ws-1/c/ch-1');
    const form = await screen.findByRole('form', { name: 'Add a member' });
    expect(screen.queryByRole('button', { name: 'Remove Grace Hopper' })).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('Person'), 'Alan Turing');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(stub.callsTo(`PUT ${WS}/channels/ch-1/members/user-3`)).toHaveLength(1));
  });

  it('lets only a channel administrator remove people from a private channel', async () => {
    setup({ channel: { type: 'private', myRole: 'member' } });
    await renderApp('/o/acme/w/ws-1/c/ch-1');
    await screen.findByText('Grace Hopper');
    expect(screen.queryByRole('form', { name: 'Add a member' })).not.toBeInTheDocument();
  });

  it('offers removal to a channel administrator and shows server refusals', async () => {
    setup({
      channel: { myRole: 'admin' },
      extra: { [`DELETE ${WS}/channels/ch-1/members/:id`]: () => problem(403, 'forbidden') },
    });
    const { user } = await renderApp('/o/acme/w/ws-1/c/ch-1');
    await user.click(await screen.findByRole('button', { name: 'Remove Grace Hopper' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("don't have permission");
  });
});
