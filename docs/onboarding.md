# Teammate onboarding

Goal: from a fresh laptop to a running, verified local stack in about 30 minutes, plus where to find the conventions you'll need next.

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker Desktop | recent; ≥ 4 GB memory allocated to the VM | `docker compose version` |
| Node.js | **22 LTS, ≥ 22.13** (see `.nvmrc`) | `node -v` |
| npm | ≥ 10 (bundled with Node 22) | `npm -v` |
| git, make | any recent | `git --version`, `make -v` |
| GitHub CLI (optional) | any recent | `gh auth status` |
| psql client (optional) | 16 | `psql --version` |

Recommended editor: VS Code. Accept the workspace's recommended extensions (ESLint, Prettier, Prisma, EditorConfig, Vitest).

## 2. Get the code

```bash
git clone <repository-url> SmartConnect      # your lead will share the URL and grant access
cd SmartConnect
git switch develop                           # day-to-day work starts from develop
```

## 3. Configure local secrets

```bash
cp .env.example .env
chmod 600 .env
# Replace each "change-me" with a strong, URL-safe value, for example:
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40; echo
```

`.env` is gitignored. Never commit it, share it in chat, or reuse production values. Service database credentials are **not** in `.env`: `make db-bootstrap` generates them per service.

## 4. Install, start and initialise

```bash
make install            # npm ci: every workspace, one lockfile
make infra-up           # PostgreSQL 16 (127.0.0.1:15432) + Redis 7 (127.0.0.1:6379)
make db-bootstrap       # schemas, least-privilege roles, per-service credentials
make db-migrate         # each service's migrations, applied as its migrator role
make prisma-generate    # generate the 14 Prisma clients
make db-seed            # optional demo tenant "Acme Demo"
```

## 5. Verify everything works

```bash
make ci-local           # format, lint, Prisma, typecheck, unit tests, build, dependency audit
make db-test            # recreates the disposable test DB (127.0.0.1:15433) and runs the database + identity suites (needs infra-up for Redis)
make e2e                # browser tests in local Chrome on their own ports (3300-3305, 3309, 5174) and the test DB; not together with db-test
```

Both must pass before your first PR. If something fails, check [Troubleshooting](#troubleshooting) before changing code.

To run the apps locally:
- `make web-dev` (web app, http://127.0.0.1:5173);
- `make auth-dev-keys` once (a local signing key pair in the gitignored `.secrets/auth/`);
- `make identity-start` (identity service on the dev database, http://127.0.0.1:3101);
- `make organization-start` (:3102). Locally, by default, only listed, **verified** emails may create organizations (`ORGANIZATION_CREATION=allowlist`): run `make organization-creators` once in your own terminal. To try self-service onboarding, where any verified account creates its own organization (ADR 0017), start with `ORGANIZATION_CREATION=open` in the environment. It stores the list in the gitignored `.secrets/organization.env`, which survives `make db-bootstrap`;
- `make workspace-start` (:3103) and `make messaging-start` (:3104);
- `make realtime-start` (Socket.IO, :3105). It needs `REDIS_URL`: see [its README](../smartconnect-backend/realtime-gateway/README.md). Give the messaging service the same `REDIS_URL`;
- `make gateway-start` (API gateway, http://127.0.0.1:3000; `curl http://127.0.0.1:3000/health/ready`).

**Or, in one command, the unified backend** ([ADR 0016](decisions/0016-unified-backend.md), Phase 1): `make backend-start` starts all seven applications in one process.
- The public URL is http://127.0.0.1:3000, serving REST and `/realtime/socket.io`.
- The internal applications keep their ports above, on loopback only, so the dev mailboxes are still at :3101 and :3102.
- It reads `REDIS_URL` from the root `.env` and each service's database URL from its generated `.env`. See [its README](../smartconnect-backend/app/README.md).
- Use it **instead of** the per-service targets, not alongside them: it checks its ports first and refuses to start if any is busy.
- `make e2e-unified` runs the browser suite against it.

By default, local emails are not sent. Read them with `curl 'http://127.0.0.1:3101/dev/mailbox?to=you@example.com'` (verification and password reset), or on :3102 for invitations.

To send real emails through Gmail SMTP ([ADR 0014](decisions/0014-email-gmail-smtp.md)):
1. Run `make smtp-credentials` **in your own terminal**. It asks for the Google App Password of `smartconnectcollab@gmail.com` with hidden input, and writes it to the gitignored `.secrets/smtp.env` (owner-only). It also asks whether to switch identity and organization from the dev mailbox to real email.
2. Run `make smtp-check`. It checks the login and sends nothing.
3. Run `make smtp-test-email TO=<an address you choose>`. It sends one test email.
4. Restart `make identity-start` and `make organization-start`. They read `.secrets/smtp.env`.

To go back to the dev mailbox, run `make smtp-credentials` again and answer **N**.

Registration, login and the rest of the auth API are documented in [the identity service README](../smartconnect-backend/services/identity/README.md). The demo users from `make db-seed` have no passwords: register your own.

To use the platform administration panel ([ADR 0015](decisions/0015-platform-administration.md), development only):
1. Run `make admin-seed` **in your own terminal**. It creates or resets the Super Admin `admin@smartconnect.localhost` and asks for its initial password twice, with hidden input. The password is stored only as an Argon2id hash. The seed refuses anything but `NODE_ENV=development` and the local development database.
2. With the identity, organization and gateway services and `make web-dev` running, open http://127.0.0.1:5173/admin/login. The Admin ID is `admin@smartconnect.localhost`.
3. The first sign-in asks you to replace the initial password with your own (12+ characters) before the dashboard opens.

Running `make admin-seed` again resets the password and ends that account's sessions.

## 6. Learn the codebase (first day reading list)

1. [README.md](../README.md): repository map and commands
2. [CONTRIBUTING.md](../CONTRIBUTING.md): branching, commits, PRs, review, definition of done
3. [docs/database/architecture.md](database/architecture.md): service ownership, outbox events, Prisma per service
4. [docs/database/tenant-isolation.md](database/tenant-isolation.md): `withTenant()`, RLS (mandatory reading for backend work)
5. [docs/database/migrations.md](database/migrations.md): how to change a schema safely
6. [docs/devops/ci.md](devops/ci.md): what CI checks and how to run it locally
7. [docs/decisions/](decisions/README.md): architecture decisions and why

## 7. Your first contribution

```bash
git switch develop && git pull
git switch -c chore/<issue>-<short-description>
# ... change, then:
make ci-local
git commit -m "chore(scope): what you did"
git push -u origin HEAD
gh pr create --base develop --fill    # or use the GitHub UI; fill in the PR template
```

## Ground rules you will be held to

- **Tenant data:** query tenant tables only inside `withTenant()`.
- **Data ownership:** never reach another service's schema.
- **Migrations:** only through `make db-migration`, and never edit an applied one.
- **Secrets:** no secrets or real customer data anywhere in git, issues, PRs or chat. Security problems are reported privately ([SECURITY.md](../SECURITY.md)).
- **Dev data:** never delete Docker volumes (`docker compose down -v`) unless you mean to wipe your local data.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Something already listens on 5432 | Expected if you run a local PostgreSQL. SmartConnect uses **15432** |
| `password authentication failed for user "sc_..."` | `make db-bootstrap` (re-provisions service credentials for your volume) |
| `P1001` or connection refused from the Prisma CLI | `make infra-up`; run Prisma via `make` or from inside the service directory |
| `make db-test` says the test instance is not running | It starts it itself; if Docker is low on memory, stop other containers |
| `Cannot find module '../generated/prisma/client.js'` | `make prisma-generate` (generated clients are not committed) |
| `npm ci` errors about the lockfile | Don't hand-edit `package-lock.json`. Run `npm install` at the repository root, then commit the lockfile |
| Lint is slow the first time | Type-aware linting builds TypeScript projects; later runs are faster |

More: [docs/database/README.md#troubleshooting](database/README.md#troubleshooting).
