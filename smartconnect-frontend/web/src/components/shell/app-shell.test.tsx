import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SIDEBAR_STORAGE_KEY } from '@/lib/sidebar';
import { json, problem, stubApi } from '@/test/api-stub';
import { inAcme, signedIn, user } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const desktopSidebar = () => within(screen.getByRole('complementary', { name: 'Sidebar' }));
/** The organization-scoped navigation appears once the caller's organizations have loaded. */
const sidebarReady = () => desktopSidebar().findByRole('link', { name: 'Members' });

describe('application shell', () => {
  it('renders the page landmarks, a skip link and the page title', async () => {
    stubApi(inAcme());
    await renderApp('/o/acme');
    await sidebarReady();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(desktopSidebar().getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(desktopSidebar().getByRole('navigation', { name: 'Secondary' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main');
    expect(document.title).toBe('Overview · SmartConnect');
  });

  it('marks only the current page as active', async () => {
    stubApi(inAcme());
    await renderApp('/o/acme');
    await sidebarReady();
    const nav = within(desktopSidebar().getByRole('navigation', { name: 'Primary' }));
    expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Members' })).not.toHaveAttribute('aria-current');
  });

  it('says plainly which sections are not available yet', async () => {
    stubApi(inAcme());
    await renderApp('/o/acme');
    await sidebarReady();
    const secondary = within(desktopSidebar().getByRole('navigation', { name: 'Secondary' }));
    for (const name of ['Meetings']) {
      expect(secondary.getByRole('link', { name: `${name}, not available yet` })).toBeInTheDocument();
    }
  });

  it('navigates from the sidebar, updates title and active state, and moves focus to the content', async () => {
    stubApi({ ...inAcme(), 'GET /orgs/org-1/members': () => json(200, { data: [], nextCursor: null }) });
    const { user: actor } = await renderApp('/o/acme');
    await actor.click(await sidebarReady());
    expect(await screen.findByRole('heading', { level: 1, name: 'Members' })).toBeInTheDocument();
    expect(document.title).toBe('Members · SmartConnect');
    expect(desktopSidebar().getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('is keyboard operable: Tab reaches the skip link first', async () => {
    stubApi(inAcme());
    const { user: actor } = await renderApp('/o/acme');
    await actor.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });

  it('collapses the desktop sidebar to a rail, keeps labels accessible, and remembers the choice', async () => {
    stubApi(inAcme());
    const { user: actor, unmount } = await renderApp('/o/acme');
    await sidebarReady();
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'app-sidebar');

    await actor.click(toggle);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toHaveAttribute('data-collapsed', 'true');
    expect(desktopSidebar().getByRole('link', { name: 'Direct messages' })).toBeInTheDocument();
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('true');

    unmount();
    await renderApp('/o/acme');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('opens navigation in a focus-trapped sheet on small screens; Escape closes it and restores focus', async () => {
    stubApi(inAcme());
    const { user: actor } = await renderApp('/o/acme');
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    await actor.click(trigger);

    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(sheet).getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    await actor.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('closes the sheet after navigating from it', async () => {
    stubApi(inAcme());
    const { user: actor } = await renderApp('/o/acme');
    await actor.click(screen.getByRole('button', { name: 'Open navigation' }));
    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    await actor.click(within(sheet).getByRole('link', { name: /^Files/ }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Files' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders a not-found page inside the shell for unknown addresses', async () => {
    stubApi(inAcme());
    const { user: actor } = await renderApp('/no-such-page');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    await actor.click(screen.getByRole('link', { name: 'Go to Home' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it.each(['/o/acme', '/o/acme/messages', '/no-such-page'])(
    'has no axe accessibility violations at %s',
    async (path) => {
      stubApi(inAcme());
      await renderApp(path);
      await screen.findByRole('heading', { level: 1 });
      expect(await axeViolations()).toEqual([]);
    },
  );
});

describe('placeholders never pretend to work', () => {
  it('a section without a backend says so and offers nothing to click', async () => {
    stubApi(inAcme());
    await renderApp('/o/acme/meetings');
    expect(
      await screen.findByText(
        'Calls, group meetings and screen sharing arrive in Phase 4. Nothing on this page is functional yet.',
      ),
    ).toBeInTheDocument();
  });
});

describe('account', () => {
  it('shows who is signed in and signs out without remembering the page', async () => {
    const stub = stubApi({ ...inAcme(), 'POST /auth/logout': () => undefined });
    const { router, user: actor } = await renderApp('/o/acme');
    await actor.click(screen.getByRole('button', { name: 'Account menu: Ada Lovelace' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('ada@example.com')).toBeInTheDocument();
    await actor.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(stub.callsTo('POST /auth/logout')).toHaveLength(1);
    expect(router.state.location.search).toEqual({});
  });

  it('sends the person to sign in again, returning to the page, when the session ends', async () => {
    let refreshes = 0;
    stubApi({
      ...inAcme(),
      'POST /auth/refresh': () =>
        refreshes++ === 0
          ? { accessToken: 'a', tokenType: 'Bearer', expiresIn: 900 }
          : problem(401, 'invalid_refresh_token'),
      'GET /orgs/org-1/members': () => problem(401, 'unauthenticated'),
    });
    const { router, user: actor } = await renderApp('/o/acme');
    await actor.click(await sidebarReady());

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: '/o/acme/members' });
  });
});

describe('email verification banner', () => {
  it('asks unverified people to verify and requests a new email without claiming more than the API says', async () => {
    const stub = stubApi({
      ...inAcme(),
      ...signedIn(user({ emailVerified: false })),
      'POST /auth/email/verification': () => json(202, {}),
    });
    const { user: actor } = await renderApp('/o/acme');
    expect(await screen.findByText(/to create organizations or accept invitations/)).toBeInTheDocument();
    await actor.click(screen.getByRole('button', { name: 'Resend verification email' }));
    expect(await screen.findByText('If your address needs verifying, a new email is on its way.')).toBeInTheDocument();
    expect(stub.callsTo('POST /auth/email/verification')).toHaveLength(1);
  });

  it('is absent for verified addresses', async () => {
    stubApi(inAcme());
    await renderApp('/o/acme');
    expect(screen.queryByText(/to create organizations or accept invitations/)).not.toBeInTheDocument();
  });
});
