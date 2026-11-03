# SmartConnect

Team communication and collaboration platform: messaging, channels, meetings, files, documents, tasks and workflows. It's built as a TypeScript monorepo:
- a React web app and a React Native/Expo mobile app;
- 14 NestJS microservices with one shared PostgreSQL 16 server, a schema per service, least-privilege roles and row-level-security tenant isolation;
- Redis 7 for caching and real-time fan-out.

> **Status:** foundation done and verified locally (database, monorepo, CI, team workflow). **Phase 1 in progress:** web frontend, API gateway, identity and authentication, and (night sprint) organizations, invitations, departments and teams, workspaces and channels: see [docs/implementation-progress.md](docs/implementation-progress.md). No product features yet. Roadmap: [docs/product/roadmap.md](docs/product/roadmap.md).

## Repository layout

| Path | Contents |
|---|---|
| [`smartconnect-frontend/`](smartconnect-frontend/) | `web/` (React + Vite + TanStack Router: **shell foundation**), `packages/design-tokens` and `packages/ui` (shared), `mobile/` (*Phase 6*) |
| [`smartconnect-backend/`](smartconnect-backend/) | `services/<14 services>`: each owns its Prisma schema, migrations and DB access module; `services/identity` also runs the **authentication API**. `api-gateway/` (NestJS: HTTP foundation, auth, rate limiting, routing), `packages/backend-kit` (shared NestJS infrastructure), `scripts/` (dev seed) |
| [`packages/`](packages/) | Cross-tier shared libraries (event contracts, API types, configs). *Planned* |
| [`infrastructure/`](infrastructure/) | Docker Compose (PostgreSQL, Redis, test DB), database bootstrap SQL, tooling scripts, backup/restore |
| [`tests/`](tests/) | Unit, database integration and security suites; e2e/load *planned* |
| [`docs/`](docs/README.md) | Architecture, database, decisions (ADRs), DevOps, onboarding |
| [`.github/`](.github/) | CI workflows, Dependabot, PR/issue templates, CODEOWNERS template, branch rulesets |

## Quick start

Prerequisites: Docker Desktop, Node.js 22 (≥ 22.13), make.

```bash
cp .env.example .env && chmod 600 .env    # then replace every "change-me"
make install                              # one npm workspace, one lockfile
make infra-up                             # PostgreSQL 127.0.0.1:15432, Redis 127.0.0.1:6379
make db-bootstrap && make db-migrate && make prisma-generate
make ci-local                             # same gates as CI (except the database suites)
make db-test                              # database suites on a disposable test instance
```

Run the apps:
- `make web-dev` (http://127.0.0.1:5173);
- `make auth-dev-keys`, then `make identity-start` (http://127.0.0.1:3101);
- `make gateway-start` (http://127.0.0.1:3000, API docs at `/docs`).

Full walkthrough: **[docs/onboarding.md](docs/onboarding.md)**. All commands: `make help`.

## Working on SmartConnect

- How we branch, commit, review and merge: [CONTRIBUTING.md](CONTRIBUTING.md)
- What CI checks and how to run it locally: [docs/devops/ci.md](docs/devops/ci.md)
- Database rules every backend change must follow: [docs/database/README.md](docs/database/README.md)
- Reporting vulnerabilities: [SECURITY.md](SECURITY.md)
