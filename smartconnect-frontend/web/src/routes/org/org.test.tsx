import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { acme, globex, inAcme, member, membership, page, signedIn, user as account, workspace } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const desktopSidebar = () => within(screen.getByRole('complementary', { name: 'Sidebar' }));

describe('organization list', () => {
  const noOrgs = (eligibility: object) => ({
    ...signedIn(),
    'GET /orgs': () => ({ data: [] }),
    'GET /orgs/creation-eligibility': () => eligibility,
  });

  it('offers to create an organization, or to join by invitation, when the server allows creating one', async () => {
    stubApi(noOrgs({ allowed: true, reason: null }));
    await renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Create your organization' })).toBeInTheDocument();
    expect(screen.getByText(/You'll be its owner, and you can invite your employees by email/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an organization' })).toHaveAttribute('href', '/organizations/new');
  });

  it('explains joining by invitation, without a dead-end link, when this server keeps creation to its administrators', async () => {
    stubApi(noOrgs({ allowed: false, reason: 'not_allowed' }));
    await renderApp('/');
    expect(await screen.findByText("You're not part of a company yet")).toBeInTheDocument();
    expect(screen.getByText(/People join a company by invitation/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an organization' })).not.toBeInTheDocument();
  });

  it('asks an unverified person to verify first, and offers a new verification email', async () => {
    stubApi({
      ...noOrgs({ allowed: false, reason: 'email_not_verified' }),
      ...signedIn(account({ emailVerified: false })),
    });
    await renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Verify your email to get started' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Resend verification email' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Create an organization' })).not.toBeInTheDocument();
  });

  it('still offers the link, and lets the server decide, when it cannot say', async () => {
    stubApi({ ...signedIn(), 'GET /orgs': () => ({ data: [] }) }); // no eligibility answer
    await renderApp('/');
    expect(await screen.findByRole('link', { name: 'Create an organization' })).toHaveAttribute(
      'href',
      '/organizations/new',
    );
  });

  it('goes straight into the only organization', async () => {
    stubApi(inAcme());
    const { router } = await renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme'));
    expect(await screen.findByText('Makers of everything')).toBeInTheDocument();
  });

  it('lets people with several organizations choose one', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs': () => ({ data: [acme, globex] }),
      'GET /orgs/org-2': () => ({ ...acme, id: 'org-2', slug: 'globex', name: 'Globex', description: null }),
      'GET /orgs/org-2/me': () => membership(['*'], 'Owner'),
    });
    const { user, router } = await renderApp('/');
    await user.click(await screen.findByRole('link', { name: /Globex/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/globex'));
  });

  it('says an unknown or foreign organization is not found', async () => {
    stubApi(inAcme());
    await renderApp('/o/not-mine');
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
  });

  it('switches organizations from the sidebar', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs': () => ({ data: [acme, globex] }),
      'GET /orgs/org-2': () => ({ ...acme, id: 'org-2', slug: 'globex', name: 'Globex', description: 'Global things' }),
      'GET /orgs/org-2/me': () => membership(['*'], 'Owner'),
    });
    const { user, router } = await renderApp('/o/acme');
    await user.click(await desktopSidebar().findByRole('button', { name: /^Organization: Acme Corp\b/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Globex' }));

    expect(await screen.findByText('Global things')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/o/globex');
    expect(desktopSidebar().getByRole('button', { name: /^Organization: Globex\b/ })).toBeInTheDocument();
  });
});

describe('creating an organization', () => {
  it('reports a refusal plainly and never pretends it worked', async () => {
    stubApi({
      ...signedIn(),
      'GET /orgs': () => ({ data: [] }),
      'POST /orgs': () => problem(403, 'organization_creation_not_allowed'),
    });
    const { user, router } = await renderApp('/organizations/new');
    await user.type(await screen.findByLabelText('Company name'), 'Initech');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not authorized to create organizations');
    expect(router.state.location.pathname).toBe('/organizations/new');
    expect(screen.queryByText(/was created/)).not.toBeInTheDocument();
  });

  it('suggests an address from the name, sends it, and opens the new organization', async () => {
    const stub = stubApi({
      ...signedIn(),
      'GET /orgs': () => ({ data: [] }),
      'POST /orgs': () => json(201, { ...acme, description: null, status: 'active', settings: {}, createdAt: '' }),
      'GET /orgs/org-1': () => ({ ...acme, description: null }),
      'GET /orgs/org-1/me': () => membership(['*'], 'Owner'),
    });
    const { user, router } = await renderApp('/organizations/new');
    await user.type(await screen.findByLabelText('Company name'), 'Acme Corp');
    expect(screen.getByLabelText('Address')).toHaveValue('acme-corp');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme'));
    expect(stub.callsTo('POST /orgs')[0]?.body).toEqual({ name: 'Acme Corp', slug: 'acme-corp' });
  });

  it('says why creating is not possible, and keeps the button off, when the server says so', async () => {
    for (const [reason, text] of [
      ['not_allowed', /created by the platform's administrators/],
      ['limit_reached', /most organizations one account can have/],
      ['email_not_verified', /Verify your email address first/],
    ] as const) {
      stubApi({
        ...signedIn(),
        'GET /orgs': () => ({ data: [] }),
        'GET /orgs/creation-eligibility': () => ({ allowed: false, reason }),
      });
      const view = await renderApp('/organizations/new');
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create organization' })).toBeDisabled();
      view.unmount();
    }
  });

  it('shows a taken address on the field', async () => {
    stubApi({
      ...signedIn(),
      'GET /orgs': () => ({ data: [] }),
      'POST /orgs': () => problem(409, 'slug_taken'),
    });
    const { user } = await renderApp('/organizations/new');
    await user.type(await screen.findByLabelText('Company name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('address is already taken');
  });
});

describe('a new organization', () => {
  const region = () => screen.findByRole('region', { name: 'Get started' });

  it('leads its owner to invite the team and to create a workspace', async () => {
    stubApi({ ...inAcme(['*']), 'GET /orgs/org-1/members': () => page([member()]) });
    await renderApp('/o/acme');
    const steps = within(await region());
    expect(steps.getByRole('link', { name: 'Invite people' })).toHaveAttribute('href', '/o/acme/invitations');
    expect(steps.getByRole('link', { name: 'Open workspaces' })).toHaveAttribute('href', '/o/acme/workspaces');
  });

  it('marks what is done, and goes away once others have joined and a workspace exists', async () => {
    const two = page([member(), member({ id: 'member-2', userId: 'user-2' })]);
    stubApi({ ...inAcme(['*']), 'GET /orgs/org-1/members': () => two });
    const first = await renderApp('/o/acme');
    const steps = within(await region());
    expect(steps.getByLabelText('Done')).toBeInTheDocument();
    expect(steps.queryByRole('link', { name: 'Invite people' })).not.toBeInTheDocument();
    first.unmount();

    stubApi({
      ...inAcme(['*']),
      'GET /orgs/org-1/members': () => two,
      'GET /orgs/org-1/workspaces': () => page([workspace()]),
    });
    await renderApp('/o/acme');
    expect(await screen.findByText('Makers of everything')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('is not shown to members who can do neither, and asks nothing for it', async () => {
    const stub = stubApi(inAcme());
    await renderApp('/o/acme');
    expect(await screen.findByText('Makers of everything')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
    expect(stub.callsTo('GET /orgs/org-1/members')).toHaveLength(0);
  });
});

describe('permission-gated UI', () => {
  it('hides administrator actions from plain members, and explains the invitations page', async () => {
    stubApi({ ...inAcme([]), 'GET /orgs/org-1/workspaces': () => ({ data: [] }) });
    const { user, router } = await renderApp('/o/acme');
    await desktopSidebar().findByRole('link', { name: 'Members' });
    expect(desktopSidebar().queryByRole('link', { name: 'Invitations' })).not.toBeInTheDocument();

    await user.click(desktopSidebar().getByRole('link', { name: 'Workspaces' }));
    expect(await screen.findByText('No workspaces yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New workspace' })).not.toBeInTheDocument();

    await router.navigate({ to: '/o/$orgSlugOrId/invitations', params: { orgSlugOrId: 'acme' } });
    expect(await screen.findByText('Invitations are managed by administrators')).toBeInTheDocument();
  });

  it('shows them to holders of the permission, and `*` means everything', async () => {
    stubApi(inAcme(['*']));
    const { user } = await renderApp('/o/acme');
    await user.click(await desktopSidebar().findByRole('link', { name: 'Invitations' }));
    expect(await screen.findByRole('form', { name: 'Invite someone' })).toBeInTheDocument();
  });

  it('shows a specific permission only to those who hold it', async () => {
    stubApi(inAcme(['workspaces.create']));
    const { user } = await renderApp('/o/acme');
    await user.click(await desktopSidebar().findByRole('link', { name: 'Workspaces' }));
    expect(await screen.findByRole('button', { name: 'New workspace' })).toBeInTheDocument();
    expect(desktopSidebar().queryByRole('link', { name: 'Invitations' })).not.toBeInTheDocument();
  });

  it('treats the server as authoritative: a 403 on an action the UI offered is shown, not hidden', async () => {
    stubApi({
      ...inAcme(['*']),
      'GET /orgs/org-1/members': () =>
        page([
          member(),
          member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'grace@example.com' }),
        ]),
      'GET /orgs/org-1/roles': () => ({
        data: [
          { id: 'role-1', key: 'member', name: 'Member', description: null, permissions: [], isSystem: true },
          { id: 'role-2', key: 'admin', name: 'Admin', description: null, permissions: [], isSystem: true },
        ],
      }),
      'PATCH /orgs/org-1/members/:id': () => problem(403, 'forbidden'),
    });
    const { user } = await renderApp('/o/acme/members');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for Grace Hopper' }), 'Admin');
    expect(await screen.findByText("You don't have permission to do this.")).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role for Grace Hopper' })).toHaveValue('role-1');
  });
});

describe('accessibility', () => {
  it.each([
    ['/', []],
    ['/organizations/new', []],
    ['/o/acme', ['*']],
    ['/o/acme/members', ['*']],
    ['/o/acme/invitations', ['*']],
    ['/o/acme/departments', ['*']],
    ['/o/acme/teams', ['*']],
    ['/o/acme/workspaces', ['*']],
  ] as const)('has no axe violations at %s', async (path, permissions) => {
    stubApi({
      ...inAcme([...permissions]),
      'GET /orgs': () => ({ data: path === '/' ? [] : [acme] }),
      'GET /orgs/org-1/members': () => page([member()]),
      'GET /orgs/org-1/roles': () => ({ data: [] }),
      'GET /orgs/org-1/invitations': () => page([]),
      'GET /orgs/org-1/departments': () => ({ data: [] }),
      'GET /orgs/org-1/teams': () => ({ data: [] }),
    });
    await renderApp(path);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(await axeViolations()).toEqual([]);
  });
});
