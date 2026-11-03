# Continuous integration

Three GitHub Actions workflows in [`.github/workflows/`](../../.github/workflows/), plus Dependabot. Every check runs a command you can run locally.

## Workflows

| Workflow | Job (status-check name) | Runs on | Checks | Local equivalent |
|---|---|---|---|---|
| `ci.yml` | **Detect projects** | PR, push `main`/`develop` | Which frontend apps exist; writes the job summary | — |
| | **Format & lint** | ″ | Prettier (`format:check`), ESLint type-aware, zero warnings (after `prisma:generate`) | `make format-check lint` |
| | **Backend (schemas, typecheck, unit tests, build)** | ″ | Prisma validate + generate (14), typecheck of every backend workspace (shared packages, services, scripts, API gateway) and of tests, unit tests (no DB), backend-kit, API gateway, identity, organization, workspace and messaging unit tests and realtime gateway tests (in-process, no DB), `tsc` build of every package, service and the gateway | `make prisma-validate prisma-generate typecheck test-unit backend-kit-test gateway-test identity-test organization-test workspace-test messaging-test realtime-test build` |
| | **Frontend web** / **Frontend mobile** | ″, only if the app exists | Frontend packages' `typecheck` + `test` (design-token contrast and drift, UI primitives), then the app's `lint`, `typecheck`, `test`, `build` (required, no `--if-present`) | `make test-frontend`; `npm run <script> --workspace smartconnect-frontend/<app>` |
| `database.yml` | **Migrations, privileges, tenant isolation, backup/restore** | every PR, push `main`/`develop` | Compose stack with ephemeral credentials → bootstrap → migrate → status → drift → database suites (migrations from zero, 28-role privilege model, RLS, backup/restore) **and service integration suites** (identity, organization, workspace, messaging and the gateway in front of them, on the test database; Redis rate-limit store against the CI Redis) | `make db-test` (+ `make db-migrate db-status db-drift`; needs `make infra-up` for Redis) |
| `security.yml` | **npm audit + registry signatures** | PR, push, **weekly (Mon 06:00 UTC)** | Runtime deps fail on **moderate+**; full tree fails on **high+**; all findings printed to the job summary; registry signatures/provenance verified | `make audit` |
| | **Dependency review (PR diff)** | PRs on **public** repos | New/changed dependencies with high+ advisories | — |

Dependabot ([`.github/dependabot.yml`](../../.github/dependabot.yml)) opens weekly grouped update PRs against `develop` for npm, GitHub Actions and the Compose images. It skips major versions that need an evaluation: Prisma, TypeScript, `@types/node`, PostgreSQL, Redis.

## Honesty rules

- **Nothing passes vacuously.**
  - Frontend jobs run only when `smartconnect-frontend/<app>/package.json` exists. Until then they show as **skipped** (grey), and the *Detect projects* summary states "NOT CHECKED, no project exists yet".
  - Required scripts are invoked without `--if-present`, so a missing script fails the job.
  - Unit tests fail if no test files are found.
- **Caveat:** GitHub treats a *skipped* required check as satisfied. Make the frontend jobs required only once the apps exist ([github-repository-setup.md](github-repository-setup.md#2-branch-protection-rulesets)).
- **Dependency review** is skipped on private repositories without GitHub Advanced Security. `npm audit` still runs everywhere.

## Frontend app contract

When `smartconnect-frontend/web` or `smartconnect-frontend/mobile` is scaffolded, its `package.json` must define:

| Script | Expectation |
|---|---|
| `lint` | ESLint with the app's React/React Native rules, `--max-warnings=0` |
| `typecheck` | `tsc --noEmit` |
| `test` | Unit/component tests; must fail when no tests exist |
| `build` | Production build (web bundle; `expo export` for mobile until EAS builds are added) |

Formatting is enforced repository-wide by the *Format & lint* job.

## Security

- **Audit thresholds:** runtime dependencies (`--omit=dev`) fail at **moderate** or higher. The full tree, including dev tooling, fails at **high**.
- **Current finding (2026-11-02):**
  - **What:** 11 *moderate* entries, all from one advisory ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), `minimatch < 11.0.1`, DoS via crafted glob patterns), reachable only through the ESLint toolchain (`minimatch@10.2.6` under `@eslint/config-array ^10.2.4`).
  - **Why it's tolerated:** the fix is a major version outside ESLint's declared range, and our glob patterns come only from our own config. It stays visible in every run's summary, and Dependabot will update ESLint when upstream moves.
- **Override (2026-11-03):**
  - **What:** `@nestjs/platform-express@12.2.0` pins `multer@2.4.0`, which has a *high* advisory ([GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m)).
  - **Fix:** the root `package.json` `overrides` entry pins `multer@2.5.0` for that package only. That is the version NestJS 12.3.2 ships, which was still inside the 7-day release window.
  - **Remove it** when `@nestjs/*` is upgraded to ≥ 12.3.2 ([ADR 0008](../decisions/0008-api-gateway-foundation.md#consequences)).
- **Build order:** `@smartconnect/backend-kit` is consumed compiled. Consumers' `pre*` scripts and the root `prelint` build it first, so no CI step depends on ordering by hand.
- **Supply chain:**
  - Third-party actions are pinned to full commit SHAs (version in a trailing comment) and updated by Dependabot.
  - Workflows default to `contents: read`.
  - The audit job installs with `--ignore-scripts`.
  - `npm audit signatures` verifies registry signatures and provenance attestations.
- **Not covered yet (decisions pending):**
  - Code scanning (CodeQL) and secret scanning / push protection. On private repositories they need GitHub Advanced Security.
  - Container image scanning, until service Dockerfiles exist.

## Secrets

CI needs **no repository secrets**. The database workflow generates throwaway passwords on the runner (`openssl rand`) and discards them with the VM.

## Verification status

The workflows were validated locally on 2026-11-02 (re-checked 2026-11-03 after adding the API gateway, backend-kit and identity steps):
- YAML structure parsed.
- Every `needs:` resolves.
- Every action is SHA-pinned.
- All 41 `run:` blocks pass `bash -n`.
- Ruleset check names match job names.
- Every command they run was executed locally with the results in the PR/phase report.

They have **not yet run on GitHub**: the repository is not linked yet. `actionlint` was not run, because launching its Docker image was not permitted in this environment. Run it once available, with a pinned current release tag:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:<current-release>
```
