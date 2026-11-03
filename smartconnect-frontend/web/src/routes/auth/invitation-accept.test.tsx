import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { problem, stubApi } from '@/test/api-stub';
import { acme, inAcme, signedIn, signedOut, user } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const preview = {
  organization: { name: 'Acme Corp', slug: 'acme' },
  role: { name: 'Member' },
  emailHint: 'a***@example.com',
  expiresAt: '2026-12-01T00:00:00.000Z',
};
const previewOk = { 'POST /invitations/preview': () => preview };

describe('invitation acceptance', () => {
  it('previews with the token from the fragment, clears it from the URL, and never puts it in a URL', async () => {
    const stub = stubApi({ ...signedOut, ...previewOk });
    const { router } = await renderApp('/invitations/accept#token=inv-token-1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Join Acme Corp' })).toBeInTheDocument();
    expect(router.state.location.hash).toBe('');
    expect(stub.callsTo('POST /invitations/preview')[0]?.body).toEqual({ token: 'inv-token-1' });
    expect(stub.calls.every((call) => !call.path.includes('inv-token-1') && !call.query.toString())).toBe(true);
  });

  it('explains a link without a token', async () => {
    stubApi(signedOut);
    await renderApp('/invitations/accept');
    expect(await screen.findByText(/missing its token/)).toBeInTheDocument();
  });

  it('reports an invalid invitation', async () => {
    stubApi({ ...signedOut, 'POST /invitations/preview': () => problem(404, 'invitation_invalid') });
    await renderApp('/invitations/accept#token=bad');
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid, has expired or was withdrawn');
  });

  it('offers sign in and registration to signed-out visitors', async () => {
    stubApi({ ...signedOut, ...previewOk });
    await renderApp('/invitations/accept#token=t');
    expect(await screen.findByText(/sent to a\*\*\*@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', expect.stringContaining('/login'));
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      expect.stringContaining('/register'),
    );
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).not.toContain('token');
  });

  it('keeps the invitation across the in-app sign-in and lets the person accept afterwards', async () => {
    const stub = stubApi({
      ...signedOut,
      ...previewOk,
      'POST /auth/login': () => ({ accessToken: 'a', tokenType: 'Bearer', expiresIn: 900 }),
      'POST /invitations/accept': () => ({ organizationId: 'org-1' }),
      'GET /orgs': () => ({ data: [acme] }),
      'GET /orgs/org-1': () => ({ ...acme, description: null }),
      'GET /orgs/org-1/me': () => ({ memberId: 'm', role: { permissions: [] } }),
    });
    const { user: actor, router } = await renderApp('/invitations/accept#token=keep-me');
    await actor.click(await screen.findByRole('link', { name: 'Sign in' }));
    await screen.findByLabelText('Email');
    stub.on(signedIn());
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'correct horse battery');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));

    await actor.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme'));
    expect(stub.callsTo('POST /invitations/accept')[0]?.body).toEqual({ token: 'keep-me' });
  });

  it('asks unverified people to verify first and does not offer to accept', async () => {
    stubApi({ ...signedIn(user({ emailVerified: false })), ...previewOk });
    await renderApp('/invitations/accept#token=t');
    expect(await screen.findByText(/Verify your email address before accepting/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });

  it.each([
    ['invitation_email_mismatch', 403, 'sent to a different email address', 'Sign out and use another account'],
    ['invitation_invalid', 404, 'invalid, has expired or was withdrawn', null],
    ['already_member', 409, "You're already a member", 'Open Acme Corp'],
  ])('handles %s', async (code, status, text, action) => {
    stubApi({ ...signedIn(), ...previewOk, 'POST /invitations/accept': () => problem(status, code) });
    const { user: actor } = await renderApp('/invitations/accept#token=t');
    await actor.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    if (action) expect(screen.getByText(action)).toBeInTheDocument();
  });

  it('re-checks verification when the server says the email is not verified', async () => {
    let verified = true;
    stubApi({
      ...signedIn(),
      'GET /auth/me': () => user({ emailVerified: verified }),
      ...previewOk,
      'POST /invitations/accept': () => {
        verified = false;
        return problem(403, 'email_not_verified');
      },
    });
    const { user: actor } = await renderApp('/invitations/accept#token=t');
    await actor.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText(/Verify your email address before accepting/)).toBeInTheDocument();
  });

  it.each(['signed-out', 'signed-in'])('has no axe violations (%s)', async (state) => {
    stubApi({ ...(state === 'signed-in' ? inAcme() : signedOut), ...previewOk });
    await renderApp('/invitations/accept#token=t');
    await screen.findByRole('heading', { level: 1, name: 'Join Acme Corp' });
    expect(await axeViolations()).toEqual([]);
  });
});
