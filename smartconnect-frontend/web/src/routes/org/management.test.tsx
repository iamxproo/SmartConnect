import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { problem, stubApi } from '@/test/api-stub';
import { axeViolations, renderApp } from '@/test/render-app';
import { inAcme, page, workspace } from '@/test/fixtures';

describe('edit departments', () => {
  const eng = { id: 'dep-1', name: 'Engineering', description: null, parentId: null, createdAt: '' };
  const platform = { id: 'dep-2', name: 'Platform', description: 'Infra', parentId: 'dep-1', createdAt: '' };
  const sales = { id: 'dep-3', name: 'Sales', description: null, parentId: null, createdAt: '' };
  const base = { 'GET /orgs/org-1/departments': () => ({ data: [eng, platform, sales] }) };

  it('hides editing without the permission', async () => {
    stubApi({ ...inAcme([]), ...base });
    await renderApp('/o/acme/departments');
    await screen.findByText('Part of Engineering');
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  });

  it('saves changes with PATCH, never offering the department or its descendants as parent', async () => {
    const stub = stubApi({
      ...inAcme(['departments.manage']),
      ...base,
      'PATCH /orgs/org-1/departments/:id': () => eng,
    });
    const { user } = await renderApp('/o/acme/departments');
    await user.click(await screen.findByRole('button', { name: 'Edit Engineering' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Engineering' });
    expect(await axeViolations()).toEqual([]);
    const parent = within(dialog).getByLabelText('Part of (optional)');
    expect(
      within(parent)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Top level', 'Sales']);
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Product Engineering');
    await user.selectOptions(parent, 'Sales');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stub.callsTo('PATCH /orgs/org-1/departments/dep-1')[0]?.body).toEqual({
      name: 'Product Engineering',
      description: null,
      parentId: 'dep-3',
    });
  });

  it('shows the server cycle error on the parent field', async () => {
    stubApi({
      ...inAcme(['departments.manage']),
      ...base,
      'PATCH /orgs/org-1/departments/:id': () =>
        problem(422, 'validation_failed', {
          errors: [
            { field: 'parentId', code: 'department_cycle', message: 'A department cannot be nested inside itself' },
          ],
        }),
    });
    const { user } = await renderApp('/o/acme/departments');
    await user.click(await screen.findByRole('button', { name: 'Edit Sales' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Sales' });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    const parent = await within(dialog).findByLabelText('Part of (optional)');
    await waitFor(() => expect(parent).toHaveAccessibleDescription('A department cannot be nested inside itself'));
    expect(parent).toHaveAttribute('aria-invalid', 'true');
  });

  it('validates the name before calling the API', async () => {
    const stub = stubApi({ ...inAcme(['departments.manage']), ...base });
    const { user } = await renderApp('/o/acme/departments');
    await user.click(await screen.findByRole('button', { name: 'Edit Sales' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(stub.callsTo('PATCH /orgs/org-1/departments/dep-3')).toHaveLength(0);
  });
});

describe('edit teams', () => {
  const team = {
    id: 'team-1',
    name: 'Backend',
    description: 'APIs',
    departmentId: null,
    visibility: 'public',
    memberCount: 2,
    myRole: null,
    createdAt: '',
  };
  const base = {
    'GET /orgs/org-1/departments': () => ({
      data: [{ id: 'dep-1', name: 'Engineering', description: null, parentId: null, createdAt: '' }],
    }),
    'GET /orgs/org-1/teams': () => ({ data: [team] }),
  };

  it('hides editing without the permission', async () => {
    stubApi({ ...inAcme([]), ...base });
    await renderApp('/o/acme/teams');
    await screen.findByText('Backend');
    expect(screen.queryByRole('button', { name: 'Edit Backend' })).not.toBeInTheDocument();
  });

  it('saves name, description, department and visibility', async () => {
    const stub = stubApi({ ...inAcme(['teams.manage']), ...base, 'PATCH /orgs/org-1/teams/:id': () => team });
    const { user } = await renderApp('/o/acme/teams');
    await user.click(await screen.findByRole('button', { name: 'Edit Backend' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Backend' });
    expect(within(dialog).getByLabelText('Description (optional)')).toHaveValue('APIs');
    await user.selectOptions(within(dialog).getByLabelText('Department (optional)'), 'Engineering');
    await user.selectOptions(within(dialog).getByLabelText('Visibility'), 'private');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stub.callsTo('PATCH /orgs/org-1/teams/team-1')[0]?.body).toEqual({
      name: 'Backend',
      description: 'APIs',
      departmentId: 'dep-1',
      visibility: 'private',
    });
  });

  it('keeps the dialog open and shows a server refusal', async () => {
    stubApi({
      ...inAcme(['teams.manage']),
      ...base,
      'PATCH /orgs/org-1/teams/:id': () => problem(403, 'forbidden'),
    });
    const { user } = await renderApp('/o/acme/teams');
    await user.click(await screen.findByRole('button', { name: 'Edit Backend' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("don't have permission");
  });

  it('deletes a team after confirmation', async () => {
    const stub = stubApi({ ...inAcme(['teams.manage']), ...base, 'DELETE /orgs/org-1/teams/team-1': () => undefined });
    const { user } = await renderApp('/o/acme/teams');
    await user.click(await screen.findByRole('button', { name: 'Delete Backend' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete team' }));
    await waitFor(() => expect(stub.callsTo('DELETE /orgs/org-1/teams/team-1')).toHaveLength(1));
  });
});

describe('workspace settings', () => {
  const channels = { 'GET /orgs/org-1/workspaces/ws-1/channels': () => ({ data: [] }) };
  const members = { 'GET /orgs/org-1/workspaces/ws-1/members': () => page([]) };
  const withWorkspace = (myRole: 'admin' | 'member') => ({
    ...inAcme([]),
    ...channels,
    ...members,
    'GET /orgs/org-1/workspaces/ws-1': () => workspace({ myRole, description: 'Builders' }),
  });

  it('shows the entry point to workspace administrators only', async () => {
    stubApi(withWorkspace('member'));
    await renderApp('/o/acme/w/ws-1');
    await screen.findByRole('heading', { name: 'Engineering' });
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('refuses the page itself to non-administrators', async () => {
    stubApi(withWorkspace('member'));
    await renderApp('/o/acme/w/ws-1/settings');
    expect(await screen.findByText('Administrators only')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Workspace settings' })).not.toBeInTheDocument();
  });

  it('saves from the settings page that the administrator reaches through the link', async () => {
    const stub = stubApi({ ...withWorkspace('admin'), 'PATCH /orgs/org-1/workspaces/ws-1': () => workspace() });
    const { user, router } = await renderApp('/o/acme/w/ws-1');
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme/w/ws-1/settings'));
    const form = await screen.findByRole('form', { name: 'Workspace settings' });
    expect(await axeViolations()).toEqual([]);
    expect(within(form).getByLabelText('Description (optional)')).toHaveValue('Builders');
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Platform');
    await user.selectOptions(within(form).getByLabelText('Visibility'), 'private');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Workspace settings saved')).toBeInTheDocument();
    expect(stub.callsTo('PATCH /orgs/org-1/workspaces/ws-1')[0]?.body).toEqual({
      name: 'Platform',
      description: 'Builders',
      visibility: 'private',
    });
  });

  it('shows the server error', async () => {
    stubApi({ ...withWorkspace('admin'), 'PATCH /orgs/org-1/workspaces/ws-1': () => problem(403, 'forbidden') });
    const { user } = await renderApp('/o/acme/w/ws-1/settings');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("don't have permission");
  });
});

describe('organization settings', () => {
  it('shows read-only details, and no navigation entry, without organization.update', async () => {
    stubApi(inAcme([]));
    await renderApp('/o/acme/settings');
    expect(await screen.findByText('7 days')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Organization settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('saves name, description and expiry for administrators', async () => {
    const stub = stubApi({ ...inAcme(['organization.update']), 'PATCH /orgs/org-1': () => ({}) });
    const { user } = await renderApp('/o/acme/settings');
    const form = await screen.findByRole('form', { name: 'Organization settings' });
    expect(await axeViolations()).toEqual([]);
    expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0);
    await user.clear(within(form).getByLabelText('Description (optional)'));
    await user.clear(within(form).getByLabelText('Invitations expire after (days)'));
    await user.type(within(form).getByLabelText('Invitations expire after (days)'), '14');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Organization settings saved')).toBeInTheDocument();
    expect(stub.callsTo('PATCH /orgs/org-1')[0]?.body).toEqual({
      name: 'Acme Corp',
      description: null,
      settings: { invitationExpiryDays: 14 },
    });
  });

  it('rejects an out-of-range expiry before calling the API', async () => {
    const stub = stubApi(inAcme(['organization.update']));
    const { user } = await renderApp('/o/acme/settings');
    const field = await screen.findByLabelText('Invitations expire after (days)');
    await user.clear(field);
    await user.type(field, '45');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a whole number of days from 1 to 30.')).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(/1 and 30/);
    expect(stub.callsTo('PATCH /orgs/org-1')).toHaveLength(0);
  });

  it('shows the server error on the field it names', async () => {
    stubApi({
      ...inAcme(['organization.update']),
      'PATCH /orgs/org-1': () =>
        problem(422, 'validation_failed', {
          errors: [{ field: 'name', code: 'too_long', message: 'Name is too long.' }],
        }),
    });
    const { user } = await renderApp('/o/acme/settings');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByLabelText('Name')).toHaveAccessibleDescription('Name is too long.');
  });
});
