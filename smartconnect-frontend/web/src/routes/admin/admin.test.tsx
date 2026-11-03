import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { inAcme, signedIn, signedOut, user } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const tokens = () => ({ accessToken: 'a', tokenType: 'Bearer', expiresIn: 900 });
const superAdmin = (passwordChangeRequired = false) =>
  user({
    id: 'admin-1',
    email: 'root@example.com',
    displayName: 'Super Admin',
    platformRoles: ['super_admin'],
    passwordChangeRequired,
  });
const adminData = {
  'GET /admin/accounts/summary': () => ({
    total: 12,
    verified: 10,
    active: 11,
    suspended: 1,
    deactivated: 0,
    superAdmins: 1,
  }),
  'GET /admin/organizations': () => ({
    data: [
      {
        id: 'org-2',
        slug: 'globex',
        name: 'Globex',
        status: 'active',
        memberCount: 7,
        createdAt: '2026-11-02T10:00:00.000Z',
      },
      {
        id: 'org-1',
        slug: 'acme',
        name: 'Acme',
        status: 'suspended',
        memberCount: 3,
        createdAt: '2026-11-01T10:00:00Z',
      },
    ],
    total: 2,
    nextCursor: null,
  }),
};

async function signInAsAdmin(actor: Awaited<ReturnType<typeof renderApp>>['user'], password = 'their password') {
  await actor.type(screen.getByLabelText('Admin ID'), 'root@example.com');
  await actor.type(screen.getByLabelText('Password'), password);
  await actor.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('platform administration sign-in (/admin/login)', () => {
  it('signs a Super Admin in through the ordinary login endpoint and opens the dashboard', async () => {
    const stub = stubApi({ ...signedOut, 'POST /auth/login': tokens });
    const { router, user: actor } = await renderApp('/admin/login');
    expect(await heading('Platform administration')).toBeInTheDocument();
    stub.on({ ...signedIn(superAdmin()), ...adminData });
    await signInAsAdmin(actor);

    expect(await heading('Platform administration')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin');
    expect(stub.callsTo('POST /auth/login')[0]).toMatchObject({
      body: { email: 'root@example.com', password: 'their password' },
      credentials: 'include',
    });
    // Totals and the organization directory, from the admin APIs.
    expect(await screen.findByText('Super Admins')).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Globex' })).toBeInTheDocument();
    expect(within(table).getByText('Suspended')).toBeInTheDocument();
    expect(screen.getByText('2 in total.')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('shows the generic credential failure and stays on the page', async () => {
    stubApi({ ...signedOut, 'POST /auth/login': () => problem(401, 'invalid_credentials') });
    const { router, user: actor } = await renderApp('/admin/login');
    await signInAsAdmin(actor, 'wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is incorrect.');
    expect(router.state.location.pathname).toBe('/admin/login');
  });

  it('signs an account without the Super Admin role straight back out, without calling any admin API', async () => {
    const stub = stubApi({ ...signedOut, 'POST /auth/login': tokens, 'POST /auth/logout': () => json(204) });
    const { router, user: actor } = await renderApp('/admin/login');
    // A real organization owner: organization roles grant nothing here.
    stub.on({ 'GET /auth/me': () => user({ platformRoles: [] }) });
    await signInAsAdmin(actor);

    expect(await screen.findByRole('alert')).toHaveTextContent('This account is not a platform administrator.');
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(stub.callsTo('POST /auth/logout')).toHaveLength(1);
    expect(stub.callsTo('GET /admin/accounts/summary')).toHaveLength(0);
    expect(stub.callsTo('GET /admin/organizations')).toHaveLength(0);
  });

  it('validates before calling the API', async () => {
    const stub = stubApi(signedOut);
    const { user: actor } = await renderApp('/admin/login');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Admin ID')).toHaveAccessibleDescription(/Enter your admin ID \(an email address\)\./);
    expect(stub.callsTo('POST /auth/login')).toHaveLength(0);
  });
});

describe('first sign-in with an issued password', () => {
  it('requires a new password before anything else, then opens the dashboard', async () => {
    const stub = stubApi({
      ...signedOut,
      'POST /auth/login': tokens,
      'POST /auth/password/change': () => json(204),
    });
    const { router, user: actor } = await renderApp('/admin/login');
    stub.on({ ...signedIn(superAdmin(true)), ...adminData });
    await signInAsAdmin(actor);

    expect(await heading('Choose your password')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/password');
    expect(stub.callsTo('GET /admin/accounts/summary')).toHaveLength(0);

    // The usual policy applies to the new password.
    await actor.type(screen.getByLabelText('Current password'), 'their password');
    await actor.type(screen.getByLabelText('New password'), 'too short');
    await actor.type(screen.getByLabelText('Confirm new password'), 'too short');
    await actor.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(stub.callsTo('POST /auth/password/change')).toHaveLength(0);

    stub.on({ 'GET /auth/me': () => superAdmin(false) });
    await actor.clear(screen.getByLabelText('New password'));
    await actor.clear(screen.getByLabelText('Confirm new password'));
    await actor.type(screen.getByLabelText('New password'), 'a long passphrase of my own');
    await actor.type(screen.getByLabelText('Confirm new password'), 'a long passphrase of my own');
    await actor.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(stub.callsTo('POST /auth/password/change')[0]!.body).toEqual({
      currentPassword: 'their password',
      newPassword: 'a long passphrase of my own',
    });
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('sends the account there from any other page too', async () => {
    stubApi({ ...signedIn(superAdmin(true)), 'GET /orgs': () => ({ data: [] }) });
    const { router } = await renderApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/password'));
  });
});

describe('admin route guard', () => {
  it('sends signed-out visitors to the admin sign-in page', async () => {
    stubApi(signedOut);
    const { router } = await renderApp('/admin');
    expect(await heading('Platform administration')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(router.state.location.search).toEqual({ redirect: '/admin' });
  });

  it('refuses a signed-in organization member and never asks the admin APIs', async () => {
    const stub = stubApi({ ...inAcme(['*']), ...adminData });
    await renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'Not a platform administrator' })).toBeInTheDocument();
    expect(stub.callsTo('GET /admin/accounts/summary')).toHaveLength(0);
    expect(stub.callsTo('GET /admin/organizations')).toHaveLength(0);
  });

  it('shows the server refusal if the role was withdrawn after sign-in', async () => {
    stubApi({
      ...signedIn(superAdmin()),
      'GET /admin/accounts/summary': () => problem(403, 'platform_admin_required'),
      'GET /admin/organizations': () => problem(403, 'platform_admin_required'),
    });
    await renderApp('/admin');
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain('This account is not a platform administrator.');
  });

  it('takes a signed-in Super Admin from the sign-in page to the dashboard', async () => {
    stubApi({ ...signedIn(superAdmin()), ...adminData });
    const { router } = await renderApp('/admin/login');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
  });
});
