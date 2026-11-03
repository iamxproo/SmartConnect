// Code-based TanStack Router route tree (ADR 0003). Public pages sit under the `auth` layout; everything else is
// under `app`, whose guard restores the session (or redirects to sign in). Organization pages live below
// /o/$orgSlugOrId and are only rendered for organizations the caller belongs to.
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from '@/components/shell/app-shell';
import { sections } from '@/components/shell/navigation';
import { RouteErrorState } from '@/components/states/error-state';
import { LoadingState } from '@/components/states/loading-state';
import { createServices, type Services } from '@/lib/services';
import { isSuperAdmin } from '@/lib/admin';
import { safeRedirect } from '@/lib/validation';
import { AdminDashboardPage } from '@/routes/admin/admin-dashboard-page';
import { AdminLayout } from '@/routes/admin/admin-layout';
import { AdminLoginPage } from '@/routes/admin/admin-login-page';
import { AdminPasswordPage } from '@/routes/admin/admin-password-page';
import { AuthLayout } from '@/routes/auth/auth-layout';
import { ForgotPasswordPage } from '@/routes/auth/forgot-password-page';
import { InvitationAcceptPage } from '@/routes/auth/invitation-accept-page';
import { LoginPage } from '@/routes/auth/login-page';
import { RegisterPage } from '@/routes/auth/register-page';
import { ResetPasswordPage } from '@/routes/auth/reset-password-page';
import { VerifyEmailPage } from '@/routes/auth/verify-email-page';
import { AccountLayout } from '@/routes/account/account-layout';
import { PasswordPage } from '@/routes/account/password-page';
import { SessionsPage } from '@/routes/account/sessions-page';
import { CreateOrgPage } from '@/routes/create-org-page';
import { HomePage } from '@/routes/home-page';
import { ChannelPage } from '@/routes/org/channel-page';
import { DepartmentsPage } from '@/routes/org/departments-page';
import { InvitationsPage } from '@/routes/org/invitations-page';
import { MembersPage } from '@/routes/org/members-page';
import { ConversationPage, MessagesEmptyPage, MessagesLayout } from '@/routes/org/messages-page';
import { OrgLayout } from '@/routes/org/org-layout';
import { OverviewPage } from '@/routes/org/overview-page';
import { ActivityPage } from '@/routes/org/activity-page';
import { SavedPage } from '@/routes/org/saved-page';
import { SearchPage } from '@/routes/org/search-page';
import { OrgSettingsPage } from '@/routes/org/settings-page';
import { TeamsPage } from '@/routes/org/teams-page';
import { WorkspaceLayout } from '@/routes/org/workspace-layout';
import { WorkspacePage } from '@/routes/org/workspace-page';
import { WorkspaceSettingsPage } from '@/routes/org/workspace-settings-page';
import { WorkspacesPage } from '@/routes/org/workspaces-page';
import { FilesPage } from '@/routes/org/files-page';
import { NotFoundPage, SectionPlaceholder } from '@/routes/pages';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Shown in the top bar and the document title. */
    title?: string;
  }
}

const rootRoute = createRootRouteWithContext<Services>()({ component: Outlet });

// ---- Public pages --------------------------------------------------------------------------------------------

const authLayout = createRoute({ getParentRoute: () => rootRoute, id: 'auth', component: AuthLayout });

/** Signed-in people have no business on the sign-in pages. */
const guestOnly = async ({ context }: { context: Services }) => {
  if ((await context.auth.initialize()).status === 'authenticated') throw redirect({ to: '/' }); // eslint-disable-line @typescript-eslint/only-throw-error -- the router's redirect protocol
};
/** Pages that work in both states only need to know which state they are in. */
const restoreSession = async ({ context }: { context: Services }) => {
  await context.auth.initialize();
};
const redirectSearch = (search: Record<string, unknown>): { redirect?: string } => ({
  redirect: safeRedirect(search.redirect),
});

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/login',
  staticData: { title: 'Sign in' },
  beforeLoad: guestOnly,
  validateSearch: redirectSearch,
  component: LoginPage,
});
const registerRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/register',
  staticData: { title: 'Create account' },
  beforeLoad: guestOnly,
  validateSearch: redirectSearch,
  component: RegisterPage,
});
const forgotPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/forgot-password',
  staticData: { title: 'Reset password' },
  beforeLoad: guestOnly,
  component: ForgotPasswordPage,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/reset-password',
  staticData: { title: 'Choose a new password' },
  component: ResetPasswordPage,
});
const verifyEmailRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/verify-email',
  staticData: { title: 'Verify email' },
  component: VerifyEmailPage,
});
const acceptInvitationRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/invitations/accept',
  staticData: { title: 'Invitation' },
  beforeLoad: restoreSession,
  component: InvitationAcceptPage,
});

// ---- Platform administration (ADR 0015) ----------------------------------------------------------------------
// Its own sign-in page and layout, outside the organization app shell. These guards only choose what to show: every
// admin API checks the Super Admin role itself.

const adminLoginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/admin/login',
  staticData: { title: 'Platform administration' },
  beforeLoad: async ({ context }) => {
    const state = await context.auth.initialize();
    if (state.status === 'authenticated' && isSuperAdmin(state.user)) throw redirect({ to: '/admin' }); // eslint-disable-line @typescript-eslint/only-throw-error -- the router's redirect protocol
  },
  validateSearch: redirectSearch,
  component: AdminLoginPage,
});

const adminLayout = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminLayout,
  beforeLoad: async ({ context, location }) => {
    const state = await context.auth.initialize();
    if (state.status !== 'authenticated') {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect protocol
      throw redirect({ to: '/admin/login', search: { redirect: location.href } });
    }
    // An issued password must be replaced before anything else (the APIs refuse until then as well).
    if (state.user.passwordChangeRequired && location.pathname !== '/admin/password') {
      throw redirect({ to: '/admin/password' }); // eslint-disable-line @typescript-eslint/only-throw-error -- the router's redirect protocol
    }
  },
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/',
  staticData: { title: 'Platform administration' },
  component: AdminDashboardPage,
});
const adminPasswordRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: 'password',
  staticData: { title: 'Choose your password' },
  component: AdminPasswordPage,
});

// ---- Authenticated pages -------------------------------------------------------------------------------------

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
  beforeLoad: async ({ context, location }) => {
    const state = await context.auth.initialize();
    if (state.status !== 'authenticated') {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect protocol
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    // Only the development Super Admin seed issues passwords (ADR 0015): its first stop is choosing its own.
    if (state.user.passwordChangeRequired) throw redirect({ to: '/admin/password' }); // eslint-disable-line @typescript-eslint/only-throw-error -- the router's redirect protocol
  },
});

const homeRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/',
  staticData: { title: 'Home' },
  component: HomePage,
});
const newOrgRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/organizations/new',
  staticData: { title: 'Create organization' },
  component: CreateOrgPage,
});
const accountRoute = createRoute({ getParentRoute: () => appLayout, path: '/account', component: AccountLayout });
const accountIndexRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect protocol
    throw redirect({ to: '/account/sessions', replace: true });
  },
});
const accountSessionsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: 'sessions',
  staticData: { title: 'Sessions' },
  component: SessionsPage,
});
const accountPasswordRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: 'password',
  staticData: { title: 'Password' },
  component: PasswordPage,
});
const notFoundRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '$',
  staticData: { title: 'Page not found' },
  component: NotFoundPage,
});

const orgRoute = createRoute({ getParentRoute: () => appLayout, path: '/o/$orgSlugOrId', component: OrgLayout });
const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  staticData: { title: 'Overview' },
  component: OverviewPage,
});
const workspacesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'workspaces',
  staticData: { title: 'Workspaces' },
  component: WorkspacesPage,
});
const workspaceRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'w/$workspaceId',
  component: WorkspaceLayout,
});
const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  staticData: { title: 'Workspace' },
  component: WorkspacePage,
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings',
  staticData: { title: 'Workspace settings' },
  component: WorkspaceSettingsPage,
});
/** `?message=<id>` opens the messages around that message (search, activity and saved results link with it). */
const messageSearch = (search: Record<string, unknown>): { message?: string } => ({
  message:
    typeof search.message === 'string' && /^[\w-]{1,64}$/.test(search.message)
      ? search.message.toLowerCase()
      : undefined,
});
const channelRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'c/$channelId',
  staticData: { title: 'Channel' },
  validateSearch: messageSearch,
  component: ChannelPage,
});
const membersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'members',
  staticData: { title: 'Members' },
  component: MembersPage,
});
const invitationsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'invitations',
  staticData: { title: 'Invitations' },
  component: InvitationsPage,
});
const departmentsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'departments',
  staticData: { title: 'Departments' },
  component: DepartmentsPage,
});
const teamsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'teams',
  staticData: { title: 'Teams' },
  component: TeamsPage,
});
const orgSettingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'settings',
  staticData: { title: 'Organization settings' },
  component: OrgSettingsPage,
});
const messagesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'messages',
  staticData: { title: 'Direct messages' },
  component: MessagesLayout,
});
const messagesIndexRoute = createRoute({
  getParentRoute: () => messagesRoute,
  path: '/',
  component: MessagesEmptyPage,
});
const conversationRoute = createRoute({
  getParentRoute: () => messagesRoute,
  path: '$conversationId',
  validateSearch: messageSearch,
  component: ConversationPage,
});
const activityRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'activity',
  staticData: { title: 'Activity' },
  component: ActivityPage,
});
const savedRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'saved',
  staticData: { title: 'Saved messages' },
  component: SavedPage,
});
const searchRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'search',
  staticData: { title: 'Search' },
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim().slice(0, 100) : undefined,
  }),
  component: SearchPage,
});
const meetingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'meetings',
  staticData: { title: sections.meetings.title },
  component: () => <SectionPlaceholder section={sections.meetings} />,
});
const filesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'files',
  staticData: { title: sections.files.title },
  component: FilesPage,
});

export const routeTree = rootRoute.addChildren([
  authLayout.addChildren([
    loginRoute,
    registerRoute,
    forgotPasswordRoute,
    resetPasswordRoute,
    verifyEmailRoute,
    acceptInvitationRoute,
    adminLoginRoute,
  ]),
  adminLayout.addChildren([adminIndexRoute, adminPasswordRoute]),
  appLayout.addChildren([
    homeRoute,
    newOrgRoute,
    accountRoute.addChildren([accountIndexRoute, accountSessionsRoute, accountPasswordRoute]),
    orgRoute.addChildren([
      orgIndexRoute,
      workspacesRoute,
      workspaceRoute.addChildren([workspaceIndexRoute, workspaceSettingsRoute, channelRoute]),
      membersRoute,
      invitationsRoute,
      departmentsRoute,
      teamsRoute,
      orgSettingsRoute,
      messagesRoute.addChildren([messagesIndexRoute, conversationRoute]),
      activityRoute,
      savedRoute,
      searchRoute,
      meetingsRoute,
      filesRoute,
    ]),
    notFoundRoute,
  ]),
]);

export function createAppRouter({ history, services }: { history?: RouterHistory; services?: Services } = {}) {
  return createRouter({
    routeTree,
    history,
    context: services ?? createServices(),
    defaultPreload: 'intent',
    defaultPendingComponent: LoadingState,
    defaultPendingMs: 150,
    defaultPendingMinMs: 0,
    defaultErrorComponent: RouteErrorState,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
