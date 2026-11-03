# 0001. Monorepo with a single npm workspace root

- Status: Accepted
- Date: 2026-11-02

## Context

SmartConnect contains a React web app, a React Native/Expo app, 14 NestJS services, shared packages, infrastructure and tests in one repository.

Before this decision there were two independent npm installs: `smartconnect-backend/` (a workspace of the 14 services) and `tests/`. They had two lockfiles and two `node_modules` trees. That left no way to share `packages/*` across tiers, and every tool version had to be kept in sync by hand.

## Decision

One npm workspace root at the repository root, with one `package-lock.json` and one `node_modules`:

```json
"workspaces": [
  "packages/*",
  "smartconnect-backend/services/*",
  "smartconnect-backend/scripts",
  "smartconnect-frontend/web",
  "smartconnect-frontend/mobile",
  "smartconnect-frontend/packages/*",
  "tests"
]
```

- Repository-wide tooling lives at the root: Prettier, ESLint (flat config, type-aware), TypeScript, plus orchestration scripts (`npm run lint | typecheck | build | test:unit | test:db`).
- Every service keeps its own `package.json` with its own exact dependency pins, so it stays independently buildable and deployable.
- **No workspace member may contain another member.** That's why backend-level scripts moved from `smartconnect-backend/package.json` to the `smartconnect-backend/scripts` member, and why `smartconnect-frontend/packages/` must never get a `package.json` itself.
- Frontend apps are listed by explicit path. npm 10 tolerates the path until the app exists.
- Exact version pins everywhere; Dependabot proposes updates.

### Why "no nested members" is a hard rule

With `smartconnect-backend` as a member *and* `smartconnect-backend/services/*` as members, npm 10.9.2:
- recorded `prisma` and `@prisma/client` under each service's `node_modules` in the lockfile, but never wrote them to disk;
- marked their transitive dependencies "extraneous";
- exited 0.

We reproduced this in isolation. Removing the containing member fixed it: Prisma is hoisted and `npm ls` reports nothing extraneous or invalid. Without the rule, every teammate would get a broken install with no error.

## Consequences

- One `npm ci` installs everything. CI caches one lockfile.
- `packages/*` can be consumed by both frontend and backend.
- `node_modules` is hoisted to the root. The database tooling resolves the Prisma CLI from the root (`infrastructure/scripts/lib/db-lib.mjs`).
- `smartconnect-backend/package-lock.json` and `tests/package-lock.json` were removed: superseded, all versions preserved by exact pins.
- Expo officially supports npm workspaces. If React or React Native version conflicts between the web and mobile apps become painful, reconsider pnpm with `node-linker=hoisted` (a new ADR).
- npm's parent-folder workspace selection (`--workspace smartconnect-backend`) selected only one workspace in our tests. CI therefore targets workspaces explicitly per directory.

## Alternatives considered

| Option | Why not now |
|---|---|
| Keep separate installs per tier | No cross-tier sharing; duplicated tooling; three lockfiles to audit |
| pnpm workspaces | Stricter and faster, but adds a tool to every laptop and CI; npm already works with the existing setup. Revisit if the Expo app needs it |
| Turborepo / Nx | Task caching is valuable at larger scale; unnecessary for the current build times (seconds) |
