import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/api/types';
import { problem, stubApi } from '@/test/api-stub';
import { signedIn } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-1',
  createdAt: '2026-11-01T09:00:00.000Z',
  lastUsedAt: '2026-11-03T09:00:00.000Z',
  expiresAt: '2026-12-01T09:00:00.000Z',
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
  current: true,
  ...overrides,
});
const phone = session({
  id: 'sess-2',
  current: false,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Safari/604',
});

describe('account navigation', () => {
  it('opens the account pages from the user menu', async () => {
    stubApi({ ...signedIn(), 'GET /orgs': () => ({ data: [] }), 'GET /auth/sessions': () => ({ data: [session()] }) });
    const { user, router } = await renderApp('/');
    await user.click(await screen.findByRole('button', { name: /Account menu/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/sessions'));
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
  });
});

describe('sessions', () => {
  const base = { ...signedIn(), 'GET /auth/sessions': () => ({ data: [session(), phone], nextCursor: null }) };

  it('lists sessions and marks the current one', async () => {
    stubApi(base);
    await renderApp('/account');
    expect(await screen.findByText('Safari on iOS')).toBeInTheDocument();
    const current = screen.getByText('Chrome on macOS').closest('li');
    expect(within(current as HTMLElement).getByText('This device')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('ends one other session after confirmation', async () => {
    const stub = stubApi({ ...base, 'DELETE /auth/sessions/:id': () => undefined });
    const { user } = await renderApp('/account/sessions');
    await user.click(await screen.findByRole('button', { name: /End session on Safari on iOS/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(stub.callsTo('DELETE /auth/sessions/sess-2')).toHaveLength(1));
    expect(await screen.findByText('Session ended')).toBeInTheDocument();
  });

  it('signs out the other devices', async () => {
    const stub = stubApi({ ...base, 'POST /auth/sessions/revoke-others': () => undefined });
    const { user } = await renderApp('/account/sessions');
    await user.click(await screen.findByRole('button', { name: 'Sign out other devices' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out other devices' }));
    await waitFor(() => expect(stub.callsTo('POST /auth/sessions/revoke-others')).toHaveLength(1));
  });

  it('signs out cleanly after revoking the current session', async () => {
    const stub = stubApi({
      ...base,
      'DELETE /auth/sessions/:id': () => undefined,
      'POST /auth/logout': () => undefined,
    });
    const { user, router } = await renderApp('/account/sessions');
    await user.click(await screen.findByRole('button', { name: 'Sign out of this device' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(stub.callsTo('DELETE /auth/sessions/sess-1')).toHaveLength(1);
    expect(router.state.location.search).toEqual({ redirect: undefined });
  });

  it('signs out everywhere', async () => {
    const stub = stubApi({ ...base, 'POST /auth/logout-all': () => undefined, 'POST /auth/logout': () => undefined });
    const { user, router } = await renderApp('/account/sessions');
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(stub.callsTo('POST /auth/logout-all')).toHaveLength(1);
  });

  it('shows a refused revocation in the dialog', async () => {
    stubApi({ ...base, 'DELETE /auth/sessions/:id': () => problem(404, 'not_found') });
    const { user } = await renderApp('/account/sessions');
    await user.click(await screen.findByRole('button', { name: /End session on Safari on iOS/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'End session' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("doesn't exist");
  });

  it('shows a load failure with retry', async () => {
    stubApi({ ...signedIn(), 'GET /auth/sessions': () => problem(500, 'internal_error') });
    await renderApp('/account/sessions');
    expect(await screen.findByText("Couldn't load sessions")).toBeInTheDocument();
  });
});

describe('change password', () => {
  const fill = async (
    user: Awaited<ReturnType<typeof renderApp>>['user'],
    values: { current?: string; next?: string; confirm?: string },
  ) => {
    if (values.current) await user.type(await screen.findByLabelText('Current password'), values.current);
    if (values.next) await user.type(screen.getByLabelText('New password'), values.next);
    if (values.confirm) await user.type(screen.getByLabelText('Confirm new password'), values.confirm);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
  };

  it('explains what happens to other sessions and is accessible', async () => {
    stubApi(signedIn());
    await renderApp('/account/password');
    expect(await screen.findByText(/signs you out on every other device/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('validates the new password and its confirmation before calling the API', async () => {
    const stub = stubApi(signedIn());
    const { user } = await renderApp('/account/password');
    await fill(user, { current: 'old-password-1', next: 'short', confirm: 'different' });
    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(/Use at least 12 characters\./);
    expect(stub.callsTo('POST /auth/password/change')).toHaveLength(0);
  });

  it('changes the password and clears the form', async () => {
    const stub = stubApi({ ...signedIn(), 'POST /auth/password/change': () => undefined });
    const { user } = await renderApp('/account/password');
    await fill(user, { current: 'old-password-1', next: 'brand-new-password', confirm: 'brand-new-password' });
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(stub.callsTo('POST /auth/password/change')[0]?.body).toEqual({
      currentPassword: 'old-password-1',
      newPassword: 'brand-new-password',
    });
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('puts a wrong current password on its field', async () => {
    stubApi({ ...signedIn(), 'POST /auth/password/change': () => problem(403, 'current_password_incorrect') });
    const { user } = await renderApp('/account/password');
    await fill(user, { current: 'wrong-password-1', next: 'brand-new-password', confirm: 'brand-new-password' });
    const field = await screen.findByLabelText('Current password');
    await waitFor(() => expect(field).toHaveAccessibleDescription('The current password is incorrect.'));
    expect(field).toHaveFocus();
  });

  it('maps a server validation error to the new password field', async () => {
    stubApi({
      ...signedIn(),
      'POST /auth/password/change': () =>
        problem(422, 'validation_failed', {
          errors: [{ field: 'newPassword', code: 'too_short', message: 'newPassword is too short' }],
        }),
    });
    const { user } = await renderApp('/account/password');
    await fill(user, { current: 'old-password-1', next: 'brand-new-password', confirm: 'brand-new-password' });
    await waitFor(() =>
      expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(/newPassword is too short/),
    );
  });
});
