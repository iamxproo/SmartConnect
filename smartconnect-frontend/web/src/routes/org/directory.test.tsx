import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { inAcme, member, page } from '@/test/fixtures';
import { renderApp } from '@/test/render-app';

const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' });
const roles = {
  'GET /orgs/org-1/roles': () => ({
    data: [
      { id: 'role-1', key: 'member', name: 'Member', description: null, permissions: [], isSystem: true },
      { id: 'role-2', key: 'admin', name: 'Admin', description: null, permissions: ['members.invite'], isSystem: true },
    ],
  }),
};

describe('members', () => {
  const base = { 'GET /orgs/org-1/members': () => page([member(), grace]), ...roles };

  it('lets plain members see everyone but change nobody; they can only leave', async () => {
    stubApi({ ...inAcme([]), ...base });
    await renderApp('/o/acme/members');
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Grace Hopper' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave organization' })).toBeInTheDocument();
  });

  it('changes a role with PATCH', async () => {
    const stub = stubApi({
      ...inAcme(['members.manage']),
      ...base,
      'PATCH /orgs/org-1/members/:id': () => ({ ...grace }),
    });
    const { user } = await renderApp('/o/acme/members');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for Grace Hopper' }), 'Admin');
    expect(await screen.findByText('Role updated for Grace Hopper')).toBeInTheDocument();
    expect(stub.callsTo('PATCH /orgs/org-1/members/member-2')[0]?.body).toEqual({ roleId: 'role-2' });
  });

  it('removes a member after confirmation', async () => {
    const stub = stubApi({ ...inAcme(['members.manage']), ...base, 'DELETE /orgs/org-1/members/:id': () => undefined });
    const { user } = await renderApp('/o/acme/members');
    await user.click(await screen.findByRole('button', { name: 'Remove Grace Hopper' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(stub.callsTo('DELETE /orgs/org-1/members/member-2')).toHaveLength(1));
  });

  it('leaves the organization and returns to the list', async () => {
    const stub = stubApi({
      ...inAcme([]),
      ...base,
      'DELETE /orgs/org-1/members/:id': () => {
        stub.on({ 'GET /orgs': () => ({ data: [] }) }); // the server no longer lists the organization
        return undefined;
      },
    });
    const { user, router } = await renderApp('/o/acme/members');
    await user.click(await screen.findByRole('button', { name: 'Leave organization' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave organization' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(stub.callsTo('DELETE /orgs/org-1/members/member-1')).toHaveLength(1);
  });
});

describe('invitations (administrators)', () => {
  const pending = {
    id: 'inv-1',
    email: 'new@example.com',
    role: { id: 'role-1', key: 'member', name: 'Member' },
    status: 'pending',
    expiresAt: '2026-12-01T00:00:00.000Z',
    createdAt: '',
  };
  const base = { ...inAcme(['members.invite']), ...roles, 'GET /orgs/org-1/invitations': () => page([pending]) };

  it('lists invitations and filters by status through the API', async () => {
    const stub = stubApi(base);
    const { user } = await renderApp('/o/acme/invitations');
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'revoked');
    await waitFor(() =>
      expect(stub.callsTo('GET /orgs/org-1/invitations').some((call) => call.query.get('status') === 'revoked')).toBe(
        true,
      ),
    );
  });

  it('sends an invitation, and reports an already-pending one on the form', async () => {
    const stub = stubApi({
      ...base,
      'POST /orgs/org-1/invitations': (call) =>
        (call.body as { email: string }).email === 'dup@example.com'
          ? problem(409, 'invitation_pending')
          : json(201, pending),
    });
    const { user } = await renderApp('/o/acme/invitations');
    await screen.findByText('new@example.com');
    await user.selectOptions(await screen.findByLabelText('Role'), 'Admin');
    await user.type(screen.getByLabelText('Email address'), 'dup@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already pending');

    await user.clear(screen.getByLabelText('Email address'));
    await user.type(screen.getByLabelText('Email address'), 'fresh@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation sent')).toBeInTheDocument();
    expect(stub.callsTo('POST /orgs/org-1/invitations').at(-1)?.body).toEqual({
      email: 'fresh@example.com',
      roleId: 'role-2',
    });
  });

  it('validates the email before calling the API', async () => {
    const stub = stubApi(base);
    const { user } = await renderApp('/o/acme/invitations');
    await user.click(await screen.findByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(stub.callsTo('POST /orgs/org-1/invitations')).toHaveLength(0);
  });

  it('lists every invitation by default, with when each was accepted and where each email stands', async () => {
    const stub = stubApi({
      ...base,
      'GET /orgs/org-1/invitations': () =>
        page([
          { ...pending, delivery: 'sent' },
          { ...pending, id: 'inv-2', email: 'bounced@example.com', delivery: 'failed' },
          {
            ...pending,
            id: 'inv-3',
            email: 'joined@example.com',
            status: 'accepted',
            acceptedAt: '2026-11-04T12:00:00.000Z',
          },
          { ...pending, id: 'inv-4', email: 'gone@example.com', status: 'revoked' },
        ]),
    });
    await renderApp('/o/acme/invitations');
    expect(await screen.findByText(/Email sent/)).toBeInTheDocument();
    expect(screen.getByText(/Email couldn't be sent/)).toBeInTheDocument();
    const acceptedOn = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
      new Date('2026-11-04T12:00:00.000Z'),
    );
    expect(screen.getByText(new RegExp(`accepted ${acceptedOn}`))).toBeInTheDocument();
    expect(screen.getByText(/· revoked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend invitation to bounced@example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend invitation to joined@example.com' })).not.toBeInTheDocument();
    expect(stub.callsTo('GET /orgs/org-1/invitations')[0]?.query.get('status')).toBe('all');
  });

  it('never says an invitation email was sent when it was not', async () => {
    stubApi({ ...base, 'POST /orgs/org-1/invitations': () => json(201, { ...pending, delivery: 'failed' }) });
    const { user } = await renderApp('/o/acme/invitations');
    await screen.findByRole('option', { name: 'Admin' });
    await user.selectOptions(screen.getByLabelText('Role'), 'Admin');
    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText("The invitation email couldn't be sent")).toBeInTheDocument();
    expect(screen.queryByText('Invitation sent')).not.toBeInTheDocument();
  });

  it('resends and revokes', async () => {
    const stub = stubApi({
      ...base,
      'POST /orgs/org-1/invitations/inv-1/resend': () => pending,
      'DELETE /orgs/org-1/invitations/inv-1': () => undefined,
    });
    const { user } = await renderApp('/o/acme/invitations');
    await user.click(await screen.findByRole('button', { name: 'Resend invitation to new@example.com' }));
    expect(await screen.findByText('Invitation resent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke invitation for new@example.com' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke invitation' }));
    await waitFor(() => expect(stub.callsTo('DELETE /orgs/org-1/invitations/inv-1')).toHaveLength(1));
  });
});

describe('departments', () => {
  const eng = { id: 'dep-1', name: 'Engineering', description: null, parentId: null, createdAt: '' };
  const platform = { id: 'dep-2', name: 'Platform', description: 'Infra', parentId: 'dep-1', createdAt: '' };
  const base = { 'GET /orgs/org-1/departments': () => ({ data: [eng, platform] }) };

  it('shows the hierarchy read-only without the permission', async () => {
    stubApi({ ...inAcme([]), ...base });
    await renderApp('/o/acme/departments');
    expect(await screen.findByText('Part of Engineering')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New department|Delete/ })).not.toBeInTheDocument();
  });

  it('creates a department under a parent', async () => {
    const stub = stubApi({
      ...inAcme(['departments.manage']),
      ...base,
      'POST /orgs/org-1/departments': () => json(201, eng),
    });
    const { user } = await renderApp('/o/acme/departments');
    await user.click(await screen.findByRole('button', { name: 'New department' }));
    const dialog = await screen.findByRole('dialog', { name: 'New department' });
    await user.type(within(dialog).getByLabelText('Name'), 'Support');
    await user.selectOptions(within(dialog).getByLabelText('Part of (optional)'), 'Engineering');
    await user.click(within(dialog).getByRole('button', { name: 'Create department' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stub.callsTo('POST /orgs/org-1/departments')[0]?.body).toEqual({ name: 'Support', parentId: 'dep-1' });
  });

  it('explains why a non-empty department cannot be deleted', async () => {
    stubApi({
      ...inAcme(['departments.manage']),
      ...base,
      'DELETE /orgs/org-1/departments/dep-1': () => problem(409, 'department_not_empty'),
    });
    const { user } = await renderApp('/o/acme/departments');
    await user.click(await screen.findByRole('button', { name: 'Delete Engineering' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete department' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not empty');
  });
});

describe('teams', () => {
  const team = {
    id: 'team-1',
    name: 'Backend',
    description: null,
    departmentId: null,
    visibility: 'public',
    memberCount: 1,
    myRole: 'lead',
    createdAt: '',
  };
  const base = {
    'GET /orgs/org-1/departments': () => ({ data: [] }),
    'GET /orgs/org-1/teams': () => ({ data: [team] }),
    'GET /orgs/org-1/teams/team-1/members': () => ({
      data: [{ userId: 'user-1', displayName: 'Ada Lovelace', email: 'ada@example.com', role: 'lead', joinedAt: '' }],
    }),
    'GET /orgs/org-1/members': () => page([member(), grace]),
  };

  it('lets a team lead add a member without the org-wide permission', async () => {
    const stub = stubApi({ ...inAcme([]), ...base, 'PUT /orgs/org-1/teams/team-1/members/:id': () => ({}) });
    const { user } = await renderApp('/o/acme/teams');
    expect(screen.queryByRole('button', { name: 'New team' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Members of Backend' }));
    await user.selectOptions(await screen.findByLabelText('Person'), 'Grace Hopper');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(stub.callsTo('PUT /orgs/org-1/teams/team-1/members/user-2')).toHaveLength(1));
    expect(stub.callsTo('PUT /orgs/org-1/teams/team-1/members/user-2')[0]?.body).toEqual({ role: 'member' });
  });

  it('creates a team for holders of teams.manage', async () => {
    const stub = stubApi({ ...inAcme(['teams.manage']), ...base, 'POST /orgs/org-1/teams': () => json(201, team) });
    const { user } = await renderApp('/o/acme/teams');
    await user.click(await screen.findByRole('button', { name: 'New team' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    await user.type(within(dialog).getByLabelText('Name'), 'Frontend');
    await user.selectOptions(within(dialog).getByLabelText('Visibility'), 'private');
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(stub.callsTo('POST /orgs/org-1/teams')).toHaveLength(1));
    expect(stub.callsTo('POST /orgs/org-1/teams')[0]?.body).toEqual({ name: 'Frontend', visibility: 'private' });
  });
});
