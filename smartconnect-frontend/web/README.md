# @smartconnect/web

SmartConnect web application: React 19 + TypeScript + Vite 8, Tailwind CSS v4 on the shared design tokens, shadcn/ui-convention primitives from `@smartconnect/ui`, TanStack Router. Decisions: [ADR 0003](../../docs/decisions/0003-web-frontend-stack.md). Design rules: [design-system.md](../../docs/architecture/design-system.md).

**Status: real client of the API in [docs/api/endpoints.md](../../docs/api/endpoints.md).**
- **Works:**
  - Sign in, register (neutral 202 message), verify email, forgot/reset password, sign out, protected routes with return-to-page, unverified-email banner.
  - Organizations: list, create (a 403 is shown as-is), switcher, permission-aware pages for members (role change, remove, leave), invitations (send, list, resend, revoke), departments, teams and team members.
  - Invitation acceptance (`/invitations/accept#token=…`).
  - Workspaces (list, create, join, leave, switch) and channels (list, create, join, leave, members).
- **Honest placeholders:** channel conversations ("Messaging isn't available yet": no messaging API), direct messages, meetings, files.
- **Not built (API exists):** editing departments, teams, workspaces and organization settings; workspace and channel member management; sessions and password change.

## Running against the backend

`npm run dev` serves the app at http://127.0.0.1:5173 and proxies `/api` to the gateway at `http://127.0.0.1:3000`, so the browser sees one origin. Set `VITE_API_BASE_URL` to use another API origin. The gateway's Origin allow-list must include the dev origin, and the `__Secure-` refresh cookie needs a secure context (`127.0.0.1` and `localhost` qualify in most browsers).

## Commands

From the repository root (one npm workspace; run `make install` first):

| Task | Command |
|---|---|
| Dev server (http://127.0.0.1:5173) | `make web-dev` or `npm run dev --workspace @smartconnect/web` |
| Type-check | `npm run typecheck --workspace @smartconnect/web` |
| Tests (Vitest + Testing Library + axe-core) | `npm run test --workspace @smartconnect/web` |
| Lint (repository ESLint config, React hooks rules) | `npm run lint --workspace @smartconnect/web` |
| Production build | `npm run build --workspace @smartconnect/web` |
| All frontend tests | `make test-frontend` |

## Structure

```
index.html                    loads public/theme-init.js before paint, then src/main.tsx
public/theme-init.js          applies the saved theme pre-paint (external file: strict-CSP friendly)
src/main.tsx                  React root
src/app.tsx                   providers (motion, theme, query, API, auth, toasts) + RouterProvider
src/router.tsx                code-based route tree: `auth` layout (public), `app` layout (guarded), /o/$orgSlugOrId/...
src/routes/                   auth/ (sign-in, register, verify, reset, invitation), org/ (org-scoped pages), pages.tsx
src/components/shell/         AppShell, sidebar (rail + mobile sheet), org + workspace switchers, channel list,
                              account menu, theme menu; navigation.ts = sections
src/components/form/          useForm (validation, 422 mapping, focus), Field, FormDialog
src/components/states/        LoadingState, EmptyState, ErrorState, QueryState
src/components/toast|motion|dialogs|auth   toasts, page/list transitions, ConfirmDialog, resend-verification
src/lib/api/                  fetch client (in-memory token, single-flight refresh incl. Web Locks), ApiError, types
src/lib/queries/              TanStack Query hooks per area; src/lib/auth.tsx = who is signed in
src/lib/theme.tsx             light / dark / system preference
src/lib/sidebar.tsx           collapsed rail + mobile sheet state
src/styles/index.css          Tailwind + tokens + UI primitives styles
src/test/                     test setup, matchMedia control, renderApp + axe, api-stub (fetch double), fixtures
```

## Conventions

- **Colours:**
  - Use token utilities only: `bg-background`, `text-muted-foreground`, `bg-surface-selected`, `border-border`, `ring-ring`.
  - Tailwind's default palette is removed: `bg-red-500` does not compile.
  - Name mapping: [design-tokens README](../packages/design-tokens/README.md).
- **Motion:**
  - CSS transitions for hover/focus/press and Radix menus, sheets and dialogs (token durations, `0ms` under `prefers-reduced-motion`).
  - Motion for React (`motion/react`) for page and list entrances, the sliding nav indicator, sidebar width and toasts. `MotionConfig reducedMotion="user"` is set in `app.tsx`. GSAP is not approved.
- **Routing:**
  - Add a route in `router.tsx` with `staticData: { title }`; the top bar and `document.title` use it.
  - Navigation entries live in `navigation.ts`. Secrets arrive in URL fragments only (`useHashToken`).
- **Tests:** stub `fetch` with `stubApi` (src/test/api-stub.ts); test doubles never live in app code.
- **Accessibility:** each page has one `h1` (the top bar title). New pages need an `axeViolations()` test.
- **Placeholders:** must state what is missing and when it arrives. Never show fake data or working-looking actions.
