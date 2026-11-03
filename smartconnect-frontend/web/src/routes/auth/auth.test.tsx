import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem, stubApi } from '@/test/api-stub';
import { acme, inAcme, signedIn, signedOut, user } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

describe('route guard', () => {
  it('sends signed-out visitors to sign in and returns them to the page after signing in', async () => {
    const stub = stubApi({
      ...signedOut,
      ...inAcme(),
      'POST /auth/refresh': () => problem(401, 'invalid_refresh_token'),
      'POST /auth/login': () => ({ accessToken: 'a', tokenType: 'Bearer', expiresIn: 900 }),
    });
    const { router, user: actor } = await renderApp('/o/acme/members');
    expect(await heading('Sign in')).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: '/o/acme/members' });

    // The session now exists: later requests succeed.
    stub.on({ ...signedIn(), 'GET /orgs/org-1/members': () => json(200, { data: [], nextCursor: null }) });
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'correct horse battery');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await heading('Members')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/o/acme/members');
    expect(stub.callsTo('POST /auth/login')[0]).toMatchObject({
      body: { email: 'ada@example.com', password: 'correct horse battery' },
      credentials: 'include',
    });
  });

  it('keeps signed-in people off the sign-in page', async () => {
    stubApi({ ...inAcme() });
    const { router } = await renderApp('/login');
    await waitFor(() => expect(router.state.location.pathname).toBe('/o/acme'));
  });

  it('does not ask for any data while signed out', async () => {
    const stub = stubApi({ ...signedOut, 'GET /orgs': () => ({ data: [acme] }) });
    await renderApp('/');
    await heading('Sign in');
    expect(stub.callsTo('GET /orgs')).toHaveLength(0);
  });

  it('ignores a redirect target that leaves the site', async () => {
    stubApi(signedOut);
    const { router } = await renderApp('/login?redirect=https://evil.example/');
    expect(router.state.location.search).toEqual({});
  });
});

describe('sign in', () => {
  it('validates before calling the API, shows errors inline and focuses the first invalid field', async () => {
    const stub = stubApi(signedOut);
    const { user: actor } = await renderApp('/login');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));

    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Enter your email address.');
    expect(email).toHaveFocus();
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    expect(stub.callsTo('POST /auth/login')).toHaveLength(0);
  });

  it('shows the generic credential failure in an alert and keeps the typed email', async () => {
    stubApi({ ...signedOut, 'POST /auth/login': () => problem(401, 'invalid_credentials') });
    const { user: actor } = await renderApp('/login');
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'wrong');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is incorrect.');
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
  });

  it('says so when the API cannot be reached', async () => {
    stubApi({ ...signedOut, 'POST /auth/login': () => problem(503, 'service_unavailable') });
    const { user: actor } = await renderApp('/login');
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'whatever');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('having trouble');
  });
});

describe('register', () => {
  it('maps 422 field errors onto the fields', async () => {
    stubApi({
      ...signedOut,
      'POST /auth/register': () =>
        problem(422, 'validation_failed', {
          errors: [{ field: 'email', code: 'invalid', message: 'Email is not valid' }],
        }),
    });
    const { user: actor } = await renderApp('/register');
    await actor.type(screen.getByLabelText('Your name'), 'Ada');
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'long enough password');
    await actor.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Email is not valid')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('enforces the password length before calling the API', async () => {
    const stub = stubApi(signedOut);
    const { user: actor } = await renderApp('/register');
    await actor.type(screen.getByLabelText('Your name'), 'Ada');
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'short');
    await actor.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(stub.callsTo('POST /auth/register')).toHaveLength(0);
  });

  it('answers 202 neutrally: asks to check email and never claims an account was created', async () => {
    stubApi({ ...signedOut, 'POST /auth/register': () => json(202, { status: 'accepted' }) });
    const { user: actor } = await renderApp('/register');
    await actor.type(screen.getByLabelText('Your name'), 'Ada');
    await actor.type(screen.getByLabelText('Email'), 'ada@example.com');
    await actor.type(screen.getByLabelText('Password'), 'long enough password');
    await actor.click(screen.getByRole('button', { name: 'Create account' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('If ada@example.com can be used for a new account');
    expect(status).toHaveTextContent('verify your address');
    expect(document.body).not.toHaveTextContent(/account (was|has been) created|welcome/i);
  });
});

describe('forgot and reset password', () => {
  it('forgot password: 202 gives a neutral confirmation that does not reveal whether the account exists', async () => {
    stubApi({ ...signedOut, 'POST /auth/password/forgot': () => json(202, {}) });
    const { user: actor } = await renderApp('/forgot-password');
    await actor.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await actor.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If an account exists for that address');
  });

  it('reset: takes the token from the URL fragment, removes it from the URL, and submits it in the body', async () => {
    const stub = stubApi({ ...signedOut, 'POST /auth/password/reset': () => undefined });
    const { router, user: actor } = await renderApp('/reset-password#token=reset-token-123');
    await actor.type(await screen.findByLabelText('New password'), 'a brand new password');
    await actor.type(screen.getByLabelText('Confirm new password'), 'a brand new password');
    expect(router.state.location.hash).toBe('');
    await actor.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('status')).toHaveTextContent('every device was signed out');
    expect(stub.callsTo('POST /auth/password/reset')[0]?.body).toEqual({
      token: 'reset-token-123',
      newPassword: 'a brand new password',
    });
    expect(stub.calls.every((call) => !call.path.includes('reset-token-123'))).toBe(true);
  });

  it('reset: refuses mismatched passwords and reports an invalid token', async () => {
    stubApi({ ...signedOut, 'POST /auth/password/reset': () => problem(400, 'invalid_reset_token') });
    const { user: actor } = await renderApp('/reset-password#token=old');
    await actor.type(await screen.findByLabelText('New password'), 'a brand new password');
    await actor.type(screen.getByLabelText('Confirm new password'), 'something different!');
    await actor.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();

    await actor.clear(screen.getByLabelText('Confirm new password'));
    await actor.type(screen.getByLabelText('Confirm new password'), 'a brand new password');
    await actor.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('reset link is invalid or has expired');
  });

  it('reset: a link without a token explains itself instead of showing a form', async () => {
    stubApi(signedOut);
    await renderApp('/reset-password');
    expect(await screen.findByText(/missing its token/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});

describe('verify email', () => {
  it('reads the token from the fragment, clears it, verifies once and reports success', async () => {
    const stub = stubApi({ ...signedOut, 'POST /auth/email/verify': () => undefined });
    const { router } = await renderApp('/verify-email#token=verify-token-9');
    expect(await screen.findByRole('status')).toHaveTextContent('Your email address is verified.');
    expect(router.state.location.hash).toBe('');
    expect(stub.callsTo('POST /auth/email/verify')).toHaveLength(1);
    expect(stub.callsTo('POST /auth/email/verify')[0]?.body).toEqual({ token: 'verify-token-9' });
  });

  it('shows an invalid or expired token as an error', async () => {
    stubApi({ ...signedOut, 'POST /auth/email/verify': () => problem(400, 'invalid_verification_token') });
    await renderApp('/verify-email#token=bad');
    expect(await screen.findByRole('alert')).toHaveTextContent('verification link is invalid or has expired');
  });

  it('updates the signed-in user so the banner disappears', async () => {
    let verified = false;
    stubApi({
      ...inAcme(),
      'GET /auth/me': () => user({ emailVerified: verified }),
      'POST /auth/email/verify': () => {
        verified = true;
        return undefined;
      },
    });
    await renderApp('/verify-email#token=t');
    expect(await screen.findByText('Your email address is verified.')).toBeInTheDocument();
    expect(screen.queryByText(/to create organizations or accept invitations/)).not.toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it.each(['/login', '/register', '/forgot-password', '/reset-password#token=t', '/verify-email'])(
    'has no axe violations at %s',
    async (path) => {
      stubApi({ ...signedOut, 'POST /auth/email/verify': () => undefined });
      await renderApp(path);
      await screen.findByRole('heading', { level: 1 });
      expect(await axeViolations()).toEqual([]);
    },
  );
});
