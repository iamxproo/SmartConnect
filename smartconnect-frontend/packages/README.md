# Frontend shared packages

Code shared by the web app (and, from Phase 6, the mobile app). Each sub-directory is a workspace (`smartconnect-frontend/packages/*`).

| Package | Purpose |
|---|---|
| [`design-tokens/`](design-tokens/README.md) | Token source of truth → CSS variables + Tailwind theme; WCAG contrast tests |
| [`ui/`](ui/README.md) | Web UI primitives (shadcn/ui conventions, Radix) |

> Do **not** add a `package.json` to this directory itself. A workspace member that contains other members makes npm 10 silently skip installing some dependencies (reproduced during the monorepo setup; [ADR 0001](../../docs/decisions/0001-monorepo-npm-workspaces.md)).
