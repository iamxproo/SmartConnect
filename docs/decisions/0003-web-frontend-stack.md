# 0003. Web frontend stack

- Status: **Accepted** (stack mandated by the product blueprint §4). Router decided 2026-11-02 (TanStack Router, by the project owner); GSAP licence still open.
- Date: 2026-11-02

## Decision

| Concern | Choice | Version checked 2026-11-02 | Licence |
|---|---|---|---|
| UI library | React | 19.3.1 | MIT |
| Language | TypeScript (monorepo pin) | 6.0.3 | Apache-2.0 |
| Build / dev server | Vite (single-page app; no SSR: the product is behind login) | 8.3.5 | MIT |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) with design tokens as CSS variables | 4.3.3 | MIT |
| Components | shadcn/ui (copied into the repo, built on Radix primitives); owned and themed by us | n/a (generator) | MIT |
| Server state | TanStack Query | 5.105.2 | MIT |
| Client state | Zustand, only for cross-component UI state (layout, composer drafts before sync, call UI) | 5.0.16 | MIT |
| Animation | Motion for React (`motion`, import from `motion/react`) by default; GSAP only for complex timelines or scroll-driven effects | 14.9.0 / 3.15.0 | MIT / **GSAP Standard "no charge" licence** |
| Real-time | `socket.io-client` | 4.8.4 | MIT |
| Meetings UI | `livekit-client` + `@livekit/components-react` | 2.23.0 / 2.9.24 | Apache-2.0 |
| Unit and component tests | Vitest + Testing Library + MSW | 5.0.5 / 16.3.3 / 3.0.3 | MIT |
| End-to-end tests | Playwright | 1.64.1 | Apache-2.0 |

Placement: `smartconnect-frontend/web` (workspace). Shared design tokens and React primitives go in `smartconnect-frontend/packages/*`, and API types in `packages/api-contracts` (generated from OpenAPI, [api/conventions.md](../api/conventions.md#versioning-and-contracts)).

## Sub-decisions

1. **Router: decided — TanStack Router** (owner decision, 2026-11-02; `@tanstack/react-router` 1.170.46, code-based routes, no codegen plugin). Implemented in Phase 1 Task 1 (`smartconnect-frontend/web/src/router.tsx`). The options as evaluated:
   - TanStack Router has type-safe routes and **typed, validated search params**. Search params carry a lot of state here: open thread, search filters, meeting panel.
   - It integrates with TanStack Query loaders.
   - React Router (8.5.1) is the more widely known alternative.
   - Both are MIT; versions checked: TanStack Router 1.170.46, React Router 8.5.1.
2. **GSAP licence acceptance (open).**
   - GSAP is free for commercial use but **not open source**. Its Standard licence restricts use in tools that compete with Webflow's visual builder, which SmartConnect is not.
   - It needs a one-time legal/owner sign-off. Until then, all animation uses Motion.

### Implementation notes (Phase 1 Task 1)

- **Not yet installed:** TanStack Query, Zustand and Motion. The shell fetches no data, its layout state fits a small React context, and its transitions are CSS on design tokens. Each is added with the first feature that needs it.
- **jsdom pinned to 29.1.1** (root `overrides`). jsdom 30 requires Node ≥ 22.22, while the repository supports Node ≥ 22.13. Revisit when the minimum Node version is raised.
- **Vite 8 uses Rolldown.** Vendor code is split into `react`, `router` and `vendor` chunks for long-term caching (`vite.config.ts`).

## Consequences

- One language and toolchain across web, mobile (later) and backend; the shared ESLint/Prettier/TypeScript config applies.
- The frontend CI contract activates when `smartconnect-frontend/web/package.json` exists: `lint`, `typecheck`, `test`, `build` ([devops/ci.md](../devops/ci.md#frontend-app-contract)).
- **Mobile (Phase 6)** reuses tokens, API contracts and the query layer. Expo (58.0.22) and React Native (0.88.1) versions are re-evaluated when Phase 6 starts. Do not pin them now.

## Alternatives considered

| Option | Why not |
|---|---|
| Next.js / Remix | SSR and server components add an extra runtime and deployment surface for an authenticated SPA with no SEO need. Vite is simpler and faster to iterate |
| Redux Toolkit | TanStack Query covers server state; Zustand covers the small remaining client state with less ceremony |
| A component library with its own styling runtime (MUI, Chakra) | shadcn/ui + Tailwind gives full ownership of components and tokens, which the custom design system needs |
