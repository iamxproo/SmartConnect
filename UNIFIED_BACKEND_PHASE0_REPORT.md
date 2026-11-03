# SmartConnect: Unified Backend Phase 0 Report

- **Date:** 2026-11-03
- **Phase:** 0 (decisions, documentation, test baseline, CI coverage). **Phase 1 has not started** and starts only on a separate instruction from the project owner.
- **Assessment followed:** [UNIFIED_BACKEND_AUDIT.md](UNIFIED_BACKEND_AUDIT.md) (not modified).
- **Decision record:** [ADR 0016: Unified backend](docs/decisions/0016-unified-backend.md), **Accepted** 2026-11-03.

**Summary:**
- The ADR, documentation and CI change are in place.
- Every suite has a recorded baseline.
- `make ci-local` and `make db-test` pass completely.
- `make e2e` has **one deterministic failure that predates the migration work** (§5.2). It must be resolved, or explicitly accepted, before the Phase 1 gate can pass, because that gate requires a green full browser suite.

---

## 1. Approved decisions

Recorded in ADR 0016, under Decision.

| # | Decision | ADR 0016 |
|---|---|---|
| 1 | Adopt a unified modular NestJS backend: one process and one public HTTP server for REST, health and Socket.IO | Decision 1 |
| 2 | A staged migration, **Phase 1 before Phase 2**, each phase starting only on a separate instruction after the previous gate passes:<br>Phase 1: one process hosts the existing applications.<br>Phase 2: genuine internal modules, one at a time.<br>Phase 3: cut-over to one Render Web Service after validation | Decision 2 |
| 3 | Both targets: one local backend start command **and** one Render backend Web Service | Decision 1 |
| 4 | **Object storage** for production file bytes, not a Render persistent disk | Decision 11 |
| 5 | React + Vite unchanged | Decisions 1 and 10 |
| 6 | Schemas, migrations, RLS policies and separate runtime roles unchanged; one runtime connection per module, never a shared role | Decision 5 |
| 7 | Redis and the existing Socket.IO behaviour kept: Redis pub/sub `smartconnect:events`, path `/realtime/socket.io`, rooms, limits, 60 s re-authorization | Decisions 9 and 10 |
| 8 | The existing microservices and both gateways stay available throughout the migration and the rollback window | Decisions 4 and 12 |
| 9 | Modules only for implemented features; **no modules for the nine schema-only services** | Decision 4 |

ADR 0016 also records the design rules from the audit that the decisions above depend on:
- service guards scoped to their own controllers, never global (audit blocker B1);
- in-process ports with the same checks as the HTTP endpoints they replace;
- the edge behaviour taken over unchanged from the API gateway;
- the acceptance gates for each phase.

## 2. Unresolved decisions (not decided; documented as blockers)

ADR 0016, Pending decisions.

| # | Pending decision | Blocks |
|---|---|---|
| P1 | Object-storage provider and credentials, and the client dependency | Production file storage; Phase 3 |
| P2 | Whether the selected Render PostgreSQL plan or provider supports the full bootstrap: 28 roles with connection limits, RLS, SECURITY DEFINER functions and `ALTER DEFAULT PRIVILEGES` | Phase 3 |
| P3 | Exact migration runner: per-service `prisma migrate deploy` with the migrator credentials kept out of the web service's environment | Phase 3 |
| P4 | Final frontend and API origins, and the custom-domain arrangement that preserves the `Secure; SameSite=Strict; Path=/api/v1/auth` refresh cookie | Phase 3 |
| P5 | Exact length of the rollback window | Retiring `api-gateway`, `realtime-gateway` and the per-service `main.ts` files |

The ADR also lists, without deciding them, items to settle when their phase starts:
- the namespaced variable scheme (Phase 1);
- a types-only `module-contracts` package (Phase 2, audit D9);
- the file transfer path: today's streaming path, or ADR 0006's presigned URLs;
- `TRUST_PROXY_HOPS` on Render;
- the Socket.IO Redis adapter.

## 3. ADR reference and what it changes in earlier records

**[ADR 0016](docs/decisions/0016-unified-backend.md)** is Accepted (2026-11-03). Historical ADRs were **not edited**; ADR 0016 states what changed:

- **[ADR 0004](docs/decisions/0004-realtime-gateway.md)** (realtime gateway)
  - *Superseded:* the separate deployable; the "independent deploys" consequence; the rejection of Socket.IO inside the API gateway.
  - *In force:* token handshake, server-side rooms, REST-only writes, WebSocket-only transport, id-only fan-out, Redis pub/sub.
- **[ADR 0008](docs/decisions/0008-api-gateway-foundation.md)** (API gateway)
  - *Superseded:* the separate process.
  - *Amended:* decision 3 (listener), decision 12 (one health pair, aggregated readiness) and decision 13 (one OpenAPI document).
  - *In force:* decisions 1, 2 and 4–11 (pipeline, errors, validation, body policy, request ids, logging, CORS, headers).
- **[ADR 0010](docs/decisions/0010-organizations-and-membership.md)** (cross-service authorization)
  - *Amended, transport only:* decisions 3, 4, 6 and 10. Workspace's guard becomes scoped to its own controllers; the HTTP calls become in-process ports acting as the verified caller; there will be one merged dev mailbox.
  - *In force:* every business and authorization rule.

The ADR index ([docs/decisions/README.md](docs/decisions/README.md)) gained a row for 0016 and a note on the 0004, 0008 and 0010 rows pointing to it.

## 4. Files changed

All changes are documentation, plus one CI step. Compared with the last commit (`964e89e`):

| File | Change |
|---|---|
| `docs/decisions/0016-unified-backend.md` | **New.** The unified backend ADR |
| `docs/decisions/README.md` | Index row for 0016; pointers on the 0004, 0008 and 0010 rows (status text only) |
| `docs/database/architecture.md` | One summary bullet; a new **Deployment topology** section that separates *Current (implemented)*, *Phase 1 (planned, not built)* and *Final modular monolith (planned, not built)*; one note under Communication rules. No existing statement removed |
| `docs/architecture/README.md` | One index row for the unified backend topology (this index's own rule requires it when an ADR is accepted) |
| `.github/workflows/ci.yml` | One step: files service unit tests (§6) |
| `UNIFIED_BACKEND_PHASE0_REPORT.md` | **New.** This report |

Not changed:
- `UNIFIED_BACKEND_AUDIT.md` (untracked, from the previous task; left as it was).
- Every source file, controller, provider, guard, DTO, schema, migration, role, permission, `.env` file, `.secrets/` entry, Docker or Compose file, and every external service.
- `smartconnect-backend/app` was **not** created.

Working-tree state before editing: branch `main` tracking `personal/main`, clean except the untracked audit, and no stash entries. It is preserved. Nothing was committed, pushed or deployed.

## 5. Baseline test results

All runs were on 2026-11-03 on the local machine, against the code at commit `964e89e` plus the documentation changes above (which only affect the format check). The disposable test PostgreSQL (`127.0.0.1:15433`) and Redis (`:6379`) were used. The development database (`:15432`) was not touched.

### 5.1 Results

| Command | When (local time) | Exit | Files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|---|---|
| `make db-test` | 20:03:53–20:06:11 | 0 | 43 | 891 | **891** | 0 | 0 |
| `make e2e` (full, no `ARGS`) | 20:06:11–20:15:50 (9.2 min of tests) | 2 | 20 specs | 54 | **53** | **1** | 0 |
| `make e2e ARGS='invitations.spec.ts'` (re-run of the failure) | after the full run | 2 | 1 | 1 | 0 | 1 | 0 |
| `make ci-local` | 20:17:44–20:20:20 (load average 4.9) | 0 | see below | 998 | **998** | 0 | 0 |
| `npm run test --workspace smartconnect-backend/services/files` (the new CI step's command) | 20:20:20 | 0 | 7 | 38 | **38** | 0 | 0 |
| `npm audit --omit=dev --audit-level=moderate` (the production check in `security.yml`) | after ci-local | 0 | — | — | 0 vulnerabilities | — | — |

`make ci-local` in detail, all passing:

| Gate | Result |
|---|---|
| `format-check` | Pass (includes the new and changed documents) |
| `lint` | Pass (zero warnings) |
| `prisma-validate` / `prisma-generate` | 14 of 14 schemas valid; 14 clients generated |
| `typecheck` | Pass (0 errors) |
| `test-unit` | 27 tests (2 files) |
| `backend-kit-test` | 131 (8) |
| `gateway-test` | 210 (15) |
| `identity-test` | 39 (7) |
| `organization-test` | 20 (2) |
| `workspace-test` | 11 (3) |
| `messaging-test` | 51 (8) |
| `files-test` | 38 (7) |
| `realtime-test` | 48 (4) |
| `test-frontend` | design tokens 11 (1), UI 8 (1), web **404 (26)** |
| `build` | Pass |
| `audit` (`npm audit --audit-level=high`) | Pass. It reports **11 moderate** advisories, all `minimatch` (GHSA-g3hv-75wg-m249) reached through the ESLint and typescript-eslint **development** toolchain; none are in production dependencies |

### 5.2 Failure that predates the migration

- **Test:** `tests/e2e/invitations.spec.ts:3`, "an admin invites through the UI; the wrong account is refused, the right one lands in the organization".
- **Error:** `strict mode violation: getByText('Invitation sent') resolved to 2 elements`, at line 16. Playwright's substring match finds both:
  - the "Invitation sent" toast;
  - the page description "People join this company only through an invitation **sent** to their email address." (`smartconnect-frontend/web/src/routes/org/invitations-page.tsx:46`).
- **Classification: deterministic, not flaky.** The single-spec re-run failed in the same way. Playwright runs with one worker and no retries.
- **Origin:** the test and the description both arrived in commit `4a352bb`. The failure exists independently of any Phase 0 change.
- **Not fixed,** following this phase's rule against changing behaviour to make the baseline green.
- **Impact:** the rest of that browser scenario (wrong account refused, invited account joins) did not run in the browser. The same rules at API level passed in `make db-test` (`tests/integration/organization/invitations.test.ts`).
- **Suggested resolution, needs approval:** a test-only change to `getByText('Invitation sent', { exact: true })`, which is Playwright's own hint. No application change.

### 5.3 Flaky and environment-dependent behaviour

- **Web suite under heavy load:** earlier today (17:14, before Phase 0, load average 11–23), a `make ci-local` run had 9 timing-sensitive web tests fail in parallel in organization pages; they passed serially (404 of 404). In this baseline, at load average about 5, all 404 passed in parallel. Treat them as **load-sensitive**.
- **Tenant isolation:** earlier today, a notification-claim test in the tenant-isolation suite failed once and passed on re-run (load). It passed in this baseline.
- **Environment needs:**
  - `make db-test` recreates the disposable test PostgreSQL container and needs Redis running.
  - `make e2e` builds everything; it needs the test database, Redis, local Chrome and free ports 3300–3305, 3309 and 5174.
  - The two must not run at the same time. They were run one after the other here, under a lock.
- **Audit:** the result depends on the advisory database on the day it runs.

## 6. CI change

`.github/workflows/ci.yml`, job `backend`: one step added between "Messaging service unit tests" and "Realtime gateway tests":

```yaml
      - name: Files service unit tests
        run: npm run test --workspace smartconnect-backend/services/files
```

- It follows the same convention as the other service steps: the explicit workspace path, without `--if-present`, and the package's own `pretest` builds the backend kit first.
- The job's type-check and build loops already covered `services/files`. Nothing else in CI was restructured.
- **Verified locally:**
  - the YAML parses, and the backend job's test steps now include the files step;
  - Prettier accepts the file;
  - the exact command passes: 38 of 38 in 7 files, with no database, Docker or network, as the job's comment requires.
- **Not verified on GitHub Actions,** because pushing is not allowed in this phase.

## 7. Remaining blockers

| Blocks | Item |
|---|---|
| **Phase 1 gate** | The browser test failure in §5.2: approve the test-only locator fix, or explicitly accept it as a known baseline failure |
| Phase 3 | P1 object-storage provider and credentials; P2 PostgreSQL bootstrap support; P3 migration runner; P4 origins and custom domain |
| Retiring the old deployables | P5 rollback window |
| Phase 2 start | The `module-contracts` package (audit D9), when Phase 2 is instructed |

Follow-ups, not blockers:
- **Stale counts in the database architecture document:** `docs/database/architecture.md` still says "54 domain tables + 42 infrastructure tables = 96", and its ownership table lacks tables added since (the database documentation says 103). Phase 0 changed only the topology statements.
- **Development-toolchain advisories:** the 11 moderate `minimatch` advisories. The suggested `npm audit fix --force` would install an incompatible ESLint, so it must not be applied blindly.

## 8. Confirmation

**No runtime architecture or database behaviour changed in Phase 0.**

- **Code:** no application code, controller, provider, guard, repository, DTO, route, configuration loader or start script was modified, and `smartconnect-backend/app` does not exist. The services, gateways, ports and inter-service HTTP calls are exactly as before.
- **Database:**
  - no schema, migration, role, grant, RLS policy or function was changed;
  - the development database was not used;
  - the only database operation was `make db-test` recreating the disposable test instance, as designed.
- **Configuration and infrastructure:** no `.env` file, secret, Docker or Compose file, Redis setting, Render service or object-storage account was created or changed.
- **Processes:** the browser stack that `make e2e` started on ports 3300–3305, 3309 and 5174 stopped on completion, and those ports are free. Your own Vite server on 5173 was left running. Nothing listened on :3000 during this phase.
- **Version control:** nothing was committed, pushed or deployed.

Phase 0 ends here. **Phase 1 needs a separate instruction from the project owner.**

---

## Addendum: Phase 0.1 (2026-11-03), the invitation browser test

### Root cause

By default, Playwright's `getByText('Invitation sent')` matches a case-insensitive **substring**. On the invitations page it matched two elements:
- the success toast's title, "Invitation sent" (`smartconnect-frontend/web/src/routes/org/invitations-page.tsx:67`);
- the page description, "People join this company only through an invitation **sent** to their email address." (same file, line 46).

Strict mode therefore refused the locator. This was a defect in the test; the application behaved correctly. It was the only use of that locator in `tests/e2e`.

### Change (test only, as approved)

`tests/e2e/invitations.spec.ts`, line 16:

```diff
-  await expect(admin.page.getByText('Invitation sent')).toBeVisible();
+  await expect(admin.page.getByText('Invitation sent', { exact: true })).toBeVisible();
```

### Results

| Command | When | Exit | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|---|
| `make e2e ARGS='invitations.spec.ts'` (targeted) | 20:24:37–20:25:53 | 0 | 1 | **1** | 0 | 0 |
| `make e2e` (full) | 20:25:53–20:41:18 (14.9 min of tests; the baseline took 9.2) | 2 | 54 | **52** | **2** | 0 |
| `make e2e ARGS='accessibility.spec.ts smoke.spec.ts'` (diagnostic re-run of the two failures; nothing changed) | 21:14:18–21:18:00 | 0 | 7 | 7 | 0 | 0 |

The invitation test also passed inside the full run (test 33).

**The full suite did not pass.** Two other tests failed. Both lie outside the changed file, and both had passed in the Phase 0 baseline 25 minutes earlier on identical application code. They were not fixed.

| Test | Failed at | Error | Evidence from the stack logs |
|---|---|---|---|
| `accessibility.spec.ts:9`, dark theme | 20:27:46 | `getByRole('main')` not visible within 10 s. The app shell and sidebar had rendered | No service logged an error at that time. The light-theme variant just before it passed, but took 42.5 s |
| `smoke.spec.ts:3` | 20:40:33 | Test timeout (60 s) during `page.goto('/login')` | From 20:38 to 20:40, organization's `/orgs/:id/me` failed 32 times with Prisma's "Unable to start a transaction in the given time" (500). Workspace and messaging then answered 503 `dependency_unavailable` |

**Classification: intermittent, not deterministic.** Both passed on the diagnostic re-run. During this period other software was competing for CPU (at 21:14: a VS Code renderer at about 127 %, a local MySQL server at about 57 %, iCloud sync), and the full run was about 60 % slower than the baseline.

The evidence points to timing sensitivity under load. One example is organization's database pool being saturated, so that transactions could not start in time. This is **not proven**, and no fix was attempted, as instructed.

### Gate status

**The Phase 1 browser-suite gate is NOT satisfied.** The ambiguous locator is fixed, but the full `make e2e` did not pass in this run. The decision belongs to the project owner:
- re-run the full suite on a quieter machine; or
- approve a separate task to investigate the intermittent failures, starting with organization's pool saturation under load.

### Files changed in Phase 0.1

- `tests/e2e/invitations.spec.ts`: one line, the selector above.
- `UNIFIED_BACKEND_PHASE0_REPORT.md`: this addendum.

### Confirmation

Phase 0.1 changed none of the following: application code, UI text, backend behaviour, test configuration, CI, ADRs, documentation, database files, `.env`, secrets or infrastructure.

- The browser stacks started for these runs stopped on completion.
- The earlier Phase 0 changes and the untracked files are preserved.
- Nothing was committed, pushed or deployed.
- **Phase 1 has not started.**

---

## Addendum: diagnosis of the group-conversation browser failure (2026-11-03)

- **Failure:** `tests/e2e/conversations.spec.ts:62` ("a group: create, rename, add, promote, demote, remove, leave"), at line 90, in the project owner's full run: 53 passed, 1 failed, 21:23–21:37.
- **Evidence:** the original trace and error context (copied before any re-run; the originals are untouched) and that run's service logs.
- **Scope:** diagnosis only. **No fix was applied.**

### Exact failure sequence

Line 90 is reached **before** any rename, add, promote, demote or remove: those steps (lines 95–137) never ran. Times are local (UTC+5:30), from the trace.

| Time | Step |
|---|---|
| 21:29:03–21:29:19 | "Before Hooks": 15.9 s |
| 21:29:19–21:29:44 | Four people (Gina, Hal, Ivy, Jon) registered and joined through the API. Opening their pages took 2.6, 2.8, 2.2 and **8.7 s** |
| 21:29:44–21:29:51 | Ivy, then Gina, open the messages page |
| 21:29:56.8 | Gina creates the group with Hal and Ivy: `POST /conversations/groups` **201**, 1.9 s. Her group heading appears after 7.5 s |
| 21:30:04.9 | Ivy sees the group live and opens it (the click took 5.3 s): `GET /conversations/:id` **200** |
| 21:30:10.4–21:30:18.5 | Hal's `page.goto(url)` takes **8.15 s** to reach `load`. The browser only sent the document request at 21:30:14.1, 3.8 s after the `goto` began; then 157 dev-server modules loaded |
| 21:30:18.9 | The line 90 check starts, 59.1 s into the test |
| **21:30:19.4** | **The 60 s test timeout expires.** The check had run for about **0.5 s, not 10 s**; the "Timeout: 10000ms" in the message is only the configured limit |
| 21:30:24.1–21:30:25.5 | Still loading after the timeout: Hal's `GET /conversations/:id` returns **200** (1.4 s) |
| 21:30:29 | The final page snapshot shows `heading "Launch crew" [level=2]` and "3 people" |

Hal's session start-up was a chain of calls, each waiting for the one before it:
- `POST /auth/refresh` 200, **2.2 s**;
- `GET /auth/me` 200, 0.4 s;
- `GET /orgs` 200, 0.2 s;
- in parallel: `workspaces` 200 (1.3 s), `orgs/:id/me` 200 (1.0 s) and `activity/unread-count` 200 (2.6 s);
- then `conversations` and `conversations/:id`, both 200 (1.4 s).

The heading renders only once `GET /conversations/:id` resolves (`ConversationPage` → `QueryState` → `ConversationView` in `messages-page.tsx`). That happened after the test had already been stopped.

### Was Hal's membership persisted? Yes.

- **Test database** (read-only query): conversation `01a1a223-7e61…` is a `group` titled "Launch crew" with three members: Gina `admin`, Hal `member`, Ivy `member`. All three rows were written in one transaction at 15:59:57.537 UTC (21:29:57.537 local), when the group was created.
- **Hal's API answers:** every call he made returned **200**, or was cancelled when the browser context closed. Messaging answers 404 to non-participants (the same spec's third test checks that), so the 200 confirms he was a participant.
- **No auth or redirect involved:** there was no 4xx, 5xx or redirect for this test's organization, and no console error in any of the test's pages.

### Trace and log findings

1. **Browser contexts are never closed.**
   - `person()` and `newContext()` in `tests/e2e/support/fixtures.ts` create contexts from the worker's shared browser. No helper or spec ever closes them, and `test` is plain `base` with no teardown.
   - With `workers: 1`, every page of every earlier test stays open, logged in and live until the worker restarts. Playwright restarts it only after a failure.
2. **Measured growth.** In a diagnostic run that kept a trace for every test, the number of open contexts rose with each test:
   - 8 → 16 → 20 → … → 88 → 90 → **92** at test 23;
   - test 23 (`collaboration.spec.ts:119`) failed at that point;
   - after the failure the worker restarted and the count fell to 4, then 12.

   The owner's failing test had **104** contexts, because no failure before it had reset the worker.
3. **Leftover pages were active during the failing test.** Of the 104 contexts in its trace, **25 from earlier tests made 184 API requests inside its 90 s window.** Most were the pages' own polling:
   - `activity/unread-count` 70 times;
   - `conversations/:id` and its messages 68 times;
   - channel messages 21 times.

   They also hold Socket.IO subscriptions. The browser-test stack sets `REAUTHORIZE_INTERVAL_SECONDS: '5'` (`tests/e2e/support/stack.ts:120`), so the realtime gateway re-checks every room of every open socket **every 5 s**, 20 at a time. Each check is an HTTP call to messaging or workspace, which in turn calls organization `/orgs/:id/me` (a transaction on a 5-connection pool).
4. **Server errors during the test, none for this test's organization:**
   - at 21:29:09.98–21:29:10.17, **19** organization `GET /orgs/:id/me` returned **500** with "Transaction API error: Unable to start a transaction in the given time" (about 2.4–2.7 s each), all for five **earlier tests'** organizations;
   - those calls arrived through messaging `GET /conversations/inbox`, which only the realtime gateway calls, during re-checks. Messaging then answered **503** 18 times (3.8–4.1 s), and workspace and the channel-messages route answered 503 once each;
   - at 21:29:11.77 the realtime gateway logged `dependency_failed` (a timeout).
5. **Reproduction:**
   - `make e2e ARGS='conversations.spec.ts'` (the spec on its own): **5 of 5 passed**. The group test took 15.1 s; Hal's `goto` took 0.7 s and the heading appeared after 0.4 s, at 8.9 s into the test.
   - The 23 tests that precede it, plus the spec: the group test **passed** in 16.5 s (heading after 1.2 s). In that run the worker had restarted after test 23 failed, so the group test ran without leftover contexts.
   - In the owner's run, the same steps were **7 to 60 times slower**.

### Root cause

**Confirmed:**
- The failure is **not** an authorization, membership, data or routing defect. Hal was a persisted participant and the server allowed him in, and the page rendered the heading late.
- The test ran out of its 60 s budget because every step ran 7–60 times slower than normal.
- The browser-test fixtures never close browser contexts. Open, polling, socket-subscribed pages pile up within a worker; this is measured (8 → 92 within one worker, 104 in the failing test).
- During the failing test, that leftover activity was present and saturated organization's database pool (19 transaction-start failures for earlier tests' organizations).
- The test passes at normal speed whenever no leftover contexts exist.

**Not proven:**
- **That the accumulation is the only cause.** Other software was competing for CPU on the same machine (a VS Code renderer at up to about 127 %, a local MySQL server at about 57 %, iCloud sync, seen at 21:14 and 21:52). Its load during the owner's run at 21:29 cannot be measured now.
- **Which part dominated.** Chrome CPU starvation (the 3.8 s before Hal's document request was even sent, and 8.7 s to open a page) and backend saturation (the 5-second re-check storm through organization's 5-connection pool) both fit the evidence.
- **What the 15.9 s "Before Hooks" was.** It plausibly includes starting tracing on about 100 open contexts, but this was not verified.
- **The earlier `accessibility.spec.ts` dark-theme failure (Phase 0.1).** It happened at test 2, with only about 16 contexts open, so accumulation does not explain it. The Phase 0.1 smoke failure (test 50, during organization pool exhaustion) does fit the pattern.

### Recommended smallest safe fix (not applied; needs approval)

Close every browser context when its test ends. This changes only the test harness: no application, authorization, timeout, retry or sleep change, and the 5 s re-check interval stays.

- **`tests/e2e/support/fixtures.ts`:**
  - record each context created by `newContext()`;
  - turn `test` into `base.extend(...)` with one automatic (`{ auto: true }`) fixture that, after each test, closes the contexts that test created.

  All 20 specs already import `test` from this file, so none of them needs editing.
- **`tests/e2e/smoke.spec.ts:5`** (optional, one line): the only direct `browser.newContext(...)` call. Route it through the same registry, keeping its fixed `X-Forwarded-For` header.

**To verify the fix:**
- a full `make e2e`, preferably twice;
- one run with `--trace on`, to confirm the per-test context count stays flat instead of growing;
- no "Unable to start a transaction" errors in the stack logs;
- a forced failure still produces its trace and screenshot. Contexts must be closed after Playwright has captured the failure artefacts; this needs checking.

### Files that would change if the fix is approved

- `tests/e2e/support/fixtures.ts`: required.
- `tests/e2e/smoke.spec.ts`: optional, one line.
- This report: the verification results.

### Gate status and confirmation

- **The Phase 1 browser-suite gate remains NOT satisfied.**
- **Nothing was changed by this diagnosis:**
  - no application, test, configuration, CI, documentation or database file;
  - no `.env` file, secret or infrastructure.
- **Runs:** the two reproduction runs used the disposable test database and wrote their output to the session's scratch folder, so the owner's original Playwright results stayed in place. The one database query was read-only. Their browser stacks stopped, and ports 3300–3309 and 5174 are free.
- **Version control:** nothing was committed or pushed.

---

## Addendum: browser-context cleanup in the browser tests (2026-11-03)

This implements the fix recommended in the diagnosis above. It is a test-harness change only.

### Files changed

| File | Change |
|---|---|
| `tests/e2e/support/fixtures.ts` | Contexts are tracked per test and closed automatically when the test ends (below) |
| `tests/e2e/smoke.spec.ts` | Line 5: the one direct `browser.newContext(...)` now goes through `newContext(browser, '203.0.113.9')`, with the same fixed `X-Forwarded-For` header |
| `UNIFIED_BACKEND_PHASE0_REPORT.md` | This addendum |

Not changed:
- application code;
- Playwright configuration, timeouts and retries;
- every other spec's workflow and assertions;
- the 5 s re-authorization interval;
- database, pool settings, CI and documentation.

A temporary diagnostic spec was created for one run and then deleted (below). The suite has 20 spec files again.

### How contexts are now managed

- **Tracking per test:** `newContext(browser, address = nextAddress())` asks Playwright for the running test (`test.info()`) and records the new context under that test in a `WeakMap<TestInfo, Set<BrowserContext>>`. Calling it outside a running test throws, so every context belongs to exactly one test.
- **Closed by the test itself:** if a test closes a context on its own, the context's `close` event removes it from the record, so cleanup never touches an already-closed context.
- **Automatic cleanup:** `test` is now `base.extend(...)` with one fixture, `closeContexts`, that is automatic and test-scoped. After each test (passed, failed or timed out), it closes **only that test's** contexts, using `Promise.allSettled` so that one failing close cannot keep the others open.
- **No global sweep:** nothing closes contexts belonging to another test.
- **Coverage:** all 20 specs already import `test` from this file, so they get the cleanup without being edited.
- **Default addresses:** the second parameter is used only when given, so the default address sequence for every other context is unchanged.

### Context creation paths found

All 20 specs were checked.

| Path | Where | Status |
|---|---|---|
| `newContext()` via `person()` | every spec | Covered |
| `newContext()` directly | `auth.spec.ts` ×3, `admin.spec.ts` ×2, `settings.spec.ts` ×2, `responsive.spec.ts`, `accessibility.spec.ts` | Covered |
| `browser.newContext()` directly | `smoke.spec.ts:5` | Moved to the helper |

None of the specs uses Playwright's built-in `page` or `context` fixtures, `browser.newPage()`, `request.newContext()`, or `beforeAll`/`beforeEach` hooks. Pages and each person's API client belong to their context and close with it.

### Verification

All runs used the disposable test database, under the test-DB lock, with output and service logs in the session's scratch folder. Machine load averages were between 4 and 9 throughout.

| Run | Command | Duration | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Static checks | `npm run typecheck --workspace tests`; ESLint and Prettier on both files | — | pass | — | — |
| Temporary diagnostic spec (6 tests) | `make e2e ARGS='zz-context-cleanup-diagnostic.spec.ts'` | 48 s | 4 | 2 (both on purpose) | 0 |
| Relevant specs | `make e2e ARGS='smoke.spec.ts auth.spec.ts settings.spec.ts conversations.spec.ts'` | 1.5 min | **13** | 0 | 0 |
| **Complete suite, run 1** | `make e2e` | 6.9 min | **54** | 0 | 0 |
| **Complete suite, run 2** | `make e2e` | 6.1 min | **54** | 0 | 0 |
| Complete suite, every trace kept | `make e2e ARGS='--trace on'` | 5.4 min | **54** | 0 | 0 |

The same complete suite took 9.2 and 14.9 min earlier today, without the fix.

### Evidence that contexts no longer pile up

- **Direct check in the temporary spec:**
  - right after a test that opened two contexts, the next test found `browser.contexts()` empty (length 0);
  - after a test that closed one context itself and left one open, the next test again found 0.
- **Every test's trace in the traced complete run:**
  - 15 traces with 2 entries, 30 with 4, 6 with 6, and 3 with 8. The maximum is 8, and the count never grows over the run.
  - Each trace holds only that test's own contexts, one per person plus that person's API client. For example, the group-conversation test has 8 (4 people) and the DM test 4 (2 people).
  - Before the fix, the count grew 8 → 92 within one worker in the diagnostic run, and reached 104 in the owner's failing run.

### Backend logs

Transaction-start failures ("Unable to start a transaction in the given time") and 5xx responses, per service:

| Run | organization | workspace | messaging | api-gateway | files, identity | realtime-gateway |
|---|---|---|---|---|---|---|
| Owner's run, no fix | 34 failures / 34 5xx | 0 / 3 | 0 / 34 | 0 / 6 | 0 / 0 | 0 / 0 |
| Phase 0.1 complete run, no fix | 32 / 32 | 4 / 10 | 0 / 28 | 0 / 16 | 0 / 0 | 0 / 1 |
| **Complete run 1, with fix** | **0 / 0** | **0 / 0** | **0 / 0** | **0 / 0** | 0 / 0 | 0 / 0 |
| **Complete run 2, with fix** | **0 / 0** | **0 / 0** | **0 / 0** | **0 / 0** | 0 / 0 | 0 / 0 |
| Traced run, with fix | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 1 |

The realtime gateway's single 5xx is its `GET /health/ready` answering 503 before it has subscribed to Redis, at start-up. That is expected, and the stack waits for readiness.

### Failure artefacts are still kept

The temporary spec failed two tests on purpose, one on an assertion and one on a test timeout (`test.setTimeout(8_000)`). Each kept all three artefacts:
- `trace.zip`, holding the page's DOM snapshots (3–4) and its requests, including `/login`;
- `test-failed-1.png`, a real rendering of the page (the signed-in home page), not a blank or closed page;
- `error-context.md`.

Playwright therefore captures the failure artefacts before the cleanup closes the context. In the assertion test, the page redirected a signed-in person from `/login` to the home page, so the failure came one line earlier than designed. It is still a genuine failure with its artefacts. The diagnostic spec was then deleted.

### Remaining failures and limits

- **No test failed in the three complete runs.** Three green runs are strong evidence, not proof that no intermittent failure remains.
- **Not explained by this fix:** the Phase 0.1 `accessibility.spec.ts` dark-theme failure (at test 2, before many contexts could pile up). It did not recur in these runs.
- **Close errors are not reported:** a context that fails to close during cleanup is ignored silently, by design (`allSettled`), so that the test's own result is not masked.
- **Hooks:** contexts created in a `beforeAll` hook would be recorded under that hook rather than a test. No spec uses such hooks today; a future one would need the same care.

### Gate status

**The browser-suite precondition for the Phase 1 gate is now satisfied** on the current code: the complete `make e2e` passed all 54 tests twice, plus a third, traced run. The Phase 1 gate itself still requires the full browser suite to pass again against the single-process backend once Phase 1 is built.

### Confirmation

- No application code, UI text, backend behaviour, authorization, schema, migration, role or connection-pool setting changed.
- No Playwright configuration, timeout, retry or 5 s re-authorization interval changed, and no `.env` file, secret or infrastructure.
- The earlier working-tree changes and untracked files are preserved, and there are no stash entries.
- The owner's original Playwright results folder was not used and still holds its artefacts.
- Ports 3300–3309 and 5174 are free.
- Nothing was committed, pushed or deployed.
- **Phase 1 has not started.**

---

## Addendum: Phase 1 preflight and implementation plan (2026-11-03, read-only)

Nothing was changed by this preflight except this appended section. No test suite was re-run: no inconsistency was found that needed one.

### 1. Working tree (preserve all of it)

| Item | State |
|---|---|
| Branch / HEAD | `main` at `964e89e` ("Merge remote main into SmartConnect"), tracking `personal/main`, 0 ahead and 0 behind |
| Recent commits | `964e89e` merge; `4a352bb` "strting phase"; `2dfec32` initial commit |
| Staged | Nothing |
| Stash | No entries |
| Modified, tracked (Phase 0) | `.github/workflows/ci.yml` (files tests step), `docs/architecture/README.md`, `docs/database/architecture.md`, `docs/decisions/README.md`, `tests/e2e/invitations.spec.ts` (selector), `tests/e2e/smoke.spec.ts` and `tests/e2e/support/fixtures.ts` (context cleanup): 7 files, +76/−9 lines |
| Untracked (Phase 0) | `UNIFIED_BACKEND_AUDIT.md`, `UNIFIED_BACKEND_PHASE0_REPORT.md`, `docs/decisions/0016-unified-backend.md` |

### 2. Phase 0 verification (read-only)

**Context cleanup** (`tests/e2e/support/fixtures.ts`), confirmed as implemented:
- `newContext()` records each context under `test.info()` in a `WeakMap<TestInfo, Set<BrowserContext>>`, and throws outside a running test.
- A context's `close` event removes it from the record, so already-closed contexts are skipped.
- `test` is `base.extend` with an automatic test-scoped `closeContexts` fixture. After `use()` it closes only that test's contexts, with `Promise.allSettled`.
- Cleanup after a pass, a failure and a timeout was demonstrated by the temporary diagnostic spec. Contexts were 0 at the start of the next test, and the assertion failure and the timeout both kept their trace, screenshot and error context.

**Specs:**
- All 20 specs import `test` from `./support/fixtures.js`.
- The three that also import from `@playwright/test` import only types (`Page` twice, `BrowserContext` once).
- No path bypasses the helper: no `browser.newContext`, `browser.newPage`, `request.newContext`, built-in `page`/`context` fixtures or setup hooks anywhere in `tests/e2e`.
- `smoke.spec.ts` uses `newContext(browser, '203.0.113.9')`.

**Unchanged against HEAD:**
- `REAUTHORIZE_INTERVAL_SECONDS: '5'` (`tests/e2e/support/stack.ts:120`);
- `stack.ts` and `playwright.config.ts`.

**Report:** the Phase 0 addenda contain the actual results: 13/13 relevant specs; 54/54 in each of two complete runs; 54/54 in the traced run; per-test context counts 2–8; zero transaction-start failures and zero 5xx except the realtime gateway's start-up readiness 503.

### 3. Phase 1 scope (from the audit and ADR 0016)

**What Phase 1 does:** one Node.js process hosts the seven existing applications and keeps their internal HTTP boundaries.
- The API gateway stays the only public HTTP entry.
- Socket.IO is reachable on the same public port at `/realtime/socket.io`.
- Internal service URLs point at loopback.
- Service packages, Prisma projects, migrations, schemas, RLS, runtime roles, file storage and the frontend are unchanged.
- The per-service commands stay; `make backend-start` is added.

**What it does not do:** in-process calls, modules, removal of the gateways, or new infrastructure.

### 4. Investigation findings that shape the design

1. **Starting the apps without their standalone `listen()` path.**
   - Every `main.ts` calls `bootstrap()` when it is imported, so the unified app must **not** import `main.ts`.
   - Every factory (`createIdentityApp`, `createOrganizationApp`, `createWorkspaceApp`, `createMessagingApp`, `createFilesApp`, `createGateway`, `createRealtimeGateway`) takes its config, logger and Prisma client and returns an app that is not yet listening. The unified app calls the factories and `listen()` itself.
   - What `main.ts` adds is small: `loadConfig()`, `createJsonLogger()`, `createPrismaClient({ connectionString: config.databaseUrl })`, plus a **local, unexported** `createNotifier()` (SMTP, dev mailbox or disabled) in identity and organization. That part must be reproduced in the app package (decision D2).
   - `createPrismaClient()` falls back to `process.env.DATABASE_URL` if no URL is passed; the unified app must always pass it. No other runtime code reads `process.env` or registers process-wide listeners.
2. **Building against the services.**
   - The seven deployables compile without `declaration`, so `dist/` holds no `.d.ts` and a new package cannot import them with types.
   - The backend kit already emits declarations (`declaration: true`), and that is the model (decision D1).
   - Services' imports resolve from their own folders at run time, exactly as when they run alone. The only shared module is the workspace-linked `@smartconnect/backend-kit`, whose module-level state (`WeakMap`s keyed by request, `AsyncLocalStorage`) is per request, not per process.
3. **Attaching Socket.IO to the public server without changing its path or handshake.**
   - Nest creates each app's `http.Server` in the `NestApplication` constructor, before `listen()`. `RealtimeHub` attaches Socket.IO to the realtime app's own server in `onApplicationBootstrap`.
   - engine.io registers an `upgrade` listener on that server and handles only its own path. Other upgrades are destroyed after `destroyUpgradeTimeout` (1 s).
   - **Design:** the unified app adds one `upgrade` listener to the **gateway's** server. Requests whose URL starts with `/realtime/socket.io/` are handed in process to the realtime server (`realtimeServer.emit('upgrade', req, socket, head)`); any other upgrade is destroyed, as Node does today when a server has no `upgrade` listener.
   - Nothing about Socket.IO changes: path, WebSocket-only transport, origin allowlist (`allowRequest`), token handshake, rooms, limits, the 60 s/5 s re-authorization and payloads. Neither gateway's code changes.
   - Upgrade requests never pass through the gateway's Express middleware, which matches today, where sockets go straight to the realtime gateway.
4. **Internal ports.** They are fixed and configurable (§8), bound to `127.0.0.1` only, the host is never configurable, and every port is checked before anything starts.
   - Ports assigned by the OS (port 0) cannot work: the messaging ↔ files cycle means each app's client URL must be known before the other app is created.
5. **Variables that would clash.**
   - Five different `DATABASE_URL` values, and `PORT`, `HOST`, `TRUST_PROXY_HOPS` and `API_DOCS_ENABLED` per app.
   - Each service's `.env` holds `DATABASE_URL` and `DATABASE_SCHEMA` under the same generic names, so each file must be parsed into that service's own map, never into `process.env`.
   - Simply stripping a prefix would break existing names that already start with a service name: `ORGANIZATION_CREATOR_EMAILS`, `FILES_MAX_BYTES`, `FILES_STORAGE_DIR`, `FILES_MAX_PENDING_PER_USER`, `FILES_MAX_CONCURRENT_UPLOADS_PER_USER`, and every `*_SERVICE_URL`. The mapping must be an **explicit allowlist per app** (§7). Every `loadConfig(env)` already accepts an `env` object, so each service's own validation runs unchanged on its view.
6. **Redis.** Three independent clients stay as they are: the gateway's rate-limit store, messaging's publisher, and realtime's subscriber on `smartconnect:events`. `REDIS_URL` and `REALTIME_EVENTS_CHANNEL` are shared values, so publisher and subscriber cannot diverge. `REDIS_URL` becomes required for the unified start, because realtime requires it (decision D5).
7. **Start-up and shutdown.**
   - Nest's `enableShutdownHooks()` closes its app and then **re-raises the signal with `process.kill`**. Called on seven apps in one process, the first app to close would kill the other six mid-drain. The unified app must handle signals once and close the apps in order (§6).
   - The realtime app is created with `forceCloseConnections`. Upgraded sockets accepted by the gateway's server would keep that server's `close()` waiting, so realtime is closed together with the gateway.
8. **Logging.**
   - Request logs and the error filter use the per-app logger passed to `configureHttpPipeline`, so they can be tagged with the app's name.
   - Twelve classes use Nest's static `new Logger(context)`, and `NestFactory.create({ logger })` replaces that static logger process-wide. Those lines are attributable only by their context names (`UpstreamProxy`, `RealtimePublisher`, `Realtime`, `ServiceClient`, …). This is acceptable for Phase 1 and noted as a limitation.
9. **The browser-test harness.**
   - `stack.ts` starts seven processes, waits on each `/health/ready`, points Vite at the gateway and realtime ports, and reads the identity and organization dev mailboxes directly (`E2E_IDENTITY_URL`, `E2E_ORGANIZATION_URL`).
   - A unified mode starts one process with the same ports: public 3300, internal 3301–3305 and 3309. Mailboxes and health stay reachable on the internal loopback ports, and `WEB_DEV_REALTIME_TARGET` points at the **public** port to exercise the upgrade hand-off.
10. **Rollback.** Everything is additive:
    - the seven start targets, both gateway packages and the default seven-process browser stack stay;
    - the database is shared and unchanged;
    - rolling back means stopping `make backend-start` and running the per-service targets.

### 5. Files Phase 1 will add or modify

**New:**

```text
smartconnect-backend/app/                  @smartconnect/backend (new workspace; no new external dependency)
├── package.json                           depends only on the existing workspace packages
├── tsconfig.json, tsconfig.build.json, vitest.config.ts, README.md
├── src/
│   ├── main.ts                            entry: validate everything → check ports → start in order → handle signals
│   ├── env.ts                             per-app allowlisted environment views; per-service .env files parsed separately
│   ├── ports.ts                           internal port table and the port check
│   ├── compose.ts                         per-app composition, mirroring each main.ts (config, logger, Prisma, notifier)
│   ├── lifecycle.ts                       ordered start with readiness waits and rollback; ordered shutdown with a deadline
│   └── realtime-upgrade.ts                hands /realtime/socket.io/ upgrades from the public server to the realtime app
└── test/                                  env, ports, lifecycle and upgrade unit tests
tests/integration/platform/unified-backend.test.ts   the unified process against the test database (in make db-test)
```

**Modified:**

| File | Change |
|---|---|
| `package.json` (root), `package-lock.json` | Add the workspace `smartconnect-backend/app` (workspace link only) |
| `tsconfig.build.json` in `api-gateway`, `realtime-gateway` and the five active services | `"declaration": true`. Build output gains `.d.ts` files; the JavaScript is unchanged (decision D1) |
| `Makefile` | `backend-start`, `backend-test`, `e2e-unified`; `backend-test` added to `ci-local` |
| `tests/e2e/support/stack.ts` | Opt-in unified mode (`E2E_BACKEND=unified`); the seven-process mode stays the default |
| `.github/workflows/ci.yml` | Add `smartconnect-backend/app/` to the typecheck and build loops, plus a test step (decision D8) |
| `docs/onboarding.md`, `docs/database/architecture.md` (Phase 1 column), this report | Documentation, at completion |

**Not touched:** any service or gateway source file, factory, config loader, Prisma schema or migration, `.env` file, secret, Docker file, the frontend, or ADR 0016.

### 6. Boot and shutdown sequences

**Boot:**
1. **Validate all configs.** Build the seven environment views and run all seven `loadConfig(view)`. If any fail, print every problem from every app at once and exit 1. No port or pool has been opened yet.
2. **Check ports.** Check that all internal ports and the public port are free. If any are busy, list them all and exit 1.
3. **Start in dependency order:** identity → organization → workspace → files → messaging → realtime. For each:
   - create its logger, Prisma client (its own runtime role) and notifier;
   - call its factory;
   - `listen(internalPort, '127.0.0.1')`;
   - wait for its `GET /health/ready` = 200 on loopback (bounded, 60 s);
   - push it onto the "started" stack.
4. **Start the gateway.** Call `createGateway`, attach the `upgrade` hand-off to the realtime server, then `listen(PORT, HOST)`. The public port opens only after every internal app is ready.
5. **Log once:** `backend_started` with start-up time, RSS and ports.

**If any step fails:** close every started app in reverse order (each `app.close()` runs its own shutdown hooks: readiness false, Prisma disconnect, Redis close, mail drain), disconnect a Prisma client created for an app that never started, and exit 1.

**Shutdown:** the first `SIGTERM` or `SIGINT` starts it; a second signal forces exit 1.
1. Gateway and realtime `close()` together: readiness turns false, the public server stops accepting, and sockets are disconnected so upgraded connections cannot hold the gateway open.
2. Then messaging → files → workspace → organization → identity, so that consumers finish before the services they call. Identity and organization flush queued mail (5 s).
3. Hard deadline 25 s, then exit 1 with a log line. Render's own shutdown wait must be checked before Phase 3.
4. Exit 0.

### 7. Variable mapping (proposed; decision D3)

Each app's view contains **only** the variables listed for it. Process-level names win over a service's `.env` file, matching Node's `--env-file` behaviour.

| Variable in the unified environment | Delivered to | As |
|---|---|---|
| `PORT`, `HOST`, `TRUST_PROXY_HOPS`, `API_DOCS_ENABLED` | gateway (public) | same names |
| `IDENTITY_DATABASE_URL[_FILE]`, `ORGANIZATION_DATABASE_URL[_FILE]`, `WORKSPACE_DATABASE_URL[_FILE]`, `MESSAGING_DATABASE_URL[_FILE]`, `FILES_DATABASE_URL[_FILE]` | that service only | `DATABASE_URL[_FILE]`; locally from `services/<svc>/.env` when not set |
| `<SVC>_INTERNAL_PORT` (`IDENTITY`, `ORGANIZATION`, `WORKSPACE`, `MESSAGING`, `REALTIME`, `FILES`) | that app | `PORT` (internal) |
| `<SVC>_TRUST_PROXY_HOPS`, `<SVC>_API_DOCS_ENABLED` (optional) | that app | `TRUST_PROXY_HOPS` (default as today: 1 for services, 0 for realtime), `API_DOCS_ENABLED` |
| `NODE_ENV`, `LOG_LEVEL`, `ERROR_TYPE_BASE_URL`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE` | all seven | same |
| `AUTH_JWT_PUBLIC_JWKS[_FILE]` | gateway, realtime, organization, workspace, messaging, files | same |
| `AUTH_JWT_PRIVATE_JWK[_FILE]`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_IDLE_DAYS`, `SESSION_MAX_LIFETIME_DAYS`, `EMAIL_VERIFICATION_TTL_HOURS`, `PASSWORD_RESET_TTL_MINUTES`, `ACCOUNT_NOTIFIER` | **identity only** | same |
| `ORGANIZATION_CREATOR_EMAILS`, `INVITATION_NOTIFIER` | organization only | same (not prefix-stripped) |
| `WEB_APP_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD[_FILE]`, `SMTP_FROM`, `SMTP_REPLY_TO`, `SMTP_TIMEOUT_MS` | identity, organization | same |
| `CORS_ALLOWED_ORIGINS` | gateway, realtime | same |
| `REDIS_URL[_FILE]` | gateway, realtime, messaging | same |
| `REALTIME_EVENTS_CHANNEL` | realtime, messaging | same |
| `FILES_MAX_BYTES` | gateway, files | same (one value, so the two cannot disagree) |
| `FILES_STORAGE_DIR`, `FILES_MAX_PENDING_PER_USER`, `FILES_MAX_CONCURRENT_UPLOADS_PER_USER` | files only | same (not prefix-stripped) |
| `REAUTHORIZE_INTERVAL_SECONDS`, `MAX_CHANNELS_PER_SOCKET`, `MAX_SOCKETS_PER_USER` | realtime only | same |
| `UPSTREAM_TIMEOUT_MS` | gateway only | same |
| *(computed)* `HOST=127.0.0.1`; `IDENTITY_`, `ORGANIZATION_`, `WORKSPACE_`, `MESSAGING_`, `FILES_SERVICE_URL=http://127.0.0.1:<internal port>` | the apps that read them today | **Not settable.** If any `*_SERVICE_URL` is present in the environment, start-up fails with a config error, so no app can point at a public URL |

`DATABASE_SCHEMA` (present in the service `.env` files) is read by no service config and is not passed on.

### 8. Internal port allocation (proposed; decision D4)

| App | `make backend-start` (local) | Unified browser tests | Render |
|---|---|---|---|
| gateway (public) | `PORT` 3000, `HOST` 127.0.0.1 | 3300 | `HOST=0.0.0.0`, `PORT` from Render |
| identity | 3101 | 3301 | 3101 (loopback) |
| organization | 3102 | 3302 | 3102 |
| workspace | 3103 | 3303 | 3103 |
| messaging | 3104 | 3304 | 3104 |
| realtime | 3105 | 3305 | 3105 |
| files | 3106 | 3309 (3306 is a local MySQL) | 3106 |

Using the existing development defaults keeps the Vite proxies and every `DEV_*_SERVICE_URL` default working unchanged. The trade-off: `make backend-start` and the per-service targets cannot run at the same time. A busy port fails fast with a list, so the project owner's own :3000/:3101/:3102 processes are never disturbed.

### 9. Test strategy

- **Unchanged and still required:** `make ci-local`, `make db-test` (891) and the default seven-process `make e2e` (54). They test the factories and the rollback topology. No service file changes, so they stay valid as they are.
- **New unit tests** (`smartconnect-backend/app/test`):
  - **Variable views:** the private key reaches identity only; each database URL reaches its service only; prefix-like names (`ORGANIZATION_CREATOR_EMAILS`, `FILES_*`) are preserved; a manual `*_SERVICE_URL` is rejected; service `.env` files never enter `process.env`.
  - **Ports:** the port check reports every busy port.
  - **Lifecycle:** a failure in app 4 closes apps 3→1; the shutdown order; a second signal; the deadline.
  - **Upgrade hand-off:** with two real HTTP servers and `socket.io-client` (already in the tree, at the same version), a socket connects through the public server, and other upgrade paths are destroyed.
- **New integration test** (in `make db-test`): boot the built unified process against the test database, then check:
  - public `/health/ready` is 200;
  - registration, login and `/auth/me` go through the public port, with the refresh-cookie attributes unchanged;
  - CORS and rate-limit headers are present;
  - internal ports are bound to `127.0.0.1` only;
  - a socket connects through the public port and receives `message.changed` after a message is posted;
  - `SIGTERM` gives exit 0 within the deadline.
- **Browser tests:** `make e2e-unified` (the full 54 tests against the single process) must pass **twice**, and the default `make e2e` must still pass once, to keep the rollback path proven.

### 10. Baseline metrics to capture (before and after)

| Metric | Seven-process baseline (task T0) | Unified (task T11) |
|---|---|---|
| Memory | RSS of each of the 7 processes after start-up and after a full browser run (`ps`), and their sum | `process.memoryUsage()` (RSS, heap) at `backend_started` and after the full browser run |
| Start-up time | Each process from spawn to `/health/ready` 200 | Spawn to `backend_started` |
| Database connections | `pg_stat_activity` per role (`usename`) and state, sampled idle and during the browser run (test database, read-only) | The same |
| Redis clients | `CLIENT LIST` count (read-only) | The same |
| Browser suite | Duration and pass, fail and skip counts | The same |

Expectation, to be verified: database connections are unchanged (five runtime roles with pools of 5, at most 25).

### 11. Risks

- **Blast radius:** one uncaught exception or memory exhaustion stops all seven apps. This is accepted in ADR 0016 consequences; memory is measured at T11.
- **Prisma memory:** five Prisma clients and seven Nest apps in one process; the footprint is unknown until T11.
- **Static logger attribution** (finding 8).
- **Composition drift:** the duplicated composition in `compose.ts` could drift from each `main.ts` (decision D2). Mitigated by unit tests on notifier selection and by the integration test.
- **Secret co-location:** identity's signing key and all five runtime database credentials share one process. The environment views stop any *config* from seeing another app's secrets, but not code in the same process (decision D7).
- **Two topologies to keep green** throughout the rollback window.
- **Shared test database:** suites using it must keep being serialized.

### 12. Decisions that need the project owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Emit TypeScript declarations from the seven deployables' build configs (output only, JavaScript unchanged). ADR 0016 says Phase 1 hosts them "unchanged" | Approve. The alternative, compiling service sources a second time inside the app package, duplicates build output and is fragile |
| D2 | Reproduce `main.ts` composition (including identity's and organization's `createNotifier`) in the app package, rather than refactoring service `main.ts` files | Duplicate, to keep services unchanged, and cover it with tests |
| D3 | The variable scheme in §7, including rejecting any manual `*_SERVICE_URL` | Approve |
| D4 | Internal ports = the existing dev defaults (§8), so `backend-start` and per-service starts exclude each other | Approve |
| D5 | The local `backend-start` needs `REDIS_URL`: derive it in the Make target from the root `.env` (as the browser-test harness does, never printed), or require it in the shell as `realtime-start` does | Derive it, read in-process |
| D6 | Readiness: the public port opens only after all internal apps are ready; after that, public readiness stays the gateway's own, as today. Aggregated readiness is Phase 2 (ADR 0016 decision 8) | Approve |
| D7 | Acknowledge secret co-location in one process (inherent in the approved unified backend) | Acknowledge |
| D8 | Add the app package to CI typecheck, build and tests (a `ci.yml` change) | Approve |

Still pending from ADR 0016, for Phase 3: P1–P5, and `TRUST_PROXY_HOPS` on Render.

### 13. Sequential implementation tasks

Each task is independently verifiable. Stop at the first failure.

| # | Task | Verification |
|---|---|---|
| T0 | Capture the seven-process baseline (§10) during one default `make e2e`. No code change | Metrics recorded in this report |
| T1 | (D1) `"declaration": true` in the seven `tsconfig.build.json` files | `make build` and `make typecheck` pass; `.d.ts` present; emitted `.js` unchanged (compared before and after); `make ci-local` passes |
| T2 | Scaffold `smartconnect-backend/app` (package, tsconfigs, root workspace entry, lockfile link) with a `main.ts` that validates nothing yet | Builds, lints, typechecks; `npm ls` shows no new external package |
| T3 | `env.ts` plus unit tests (§7) | New unit tests pass; the private key reaches identity only |
| T4 | `ports.ts` plus unit tests | A busy port is reported; nothing binds before validation |
| T5 | `compose.ts` (D2) plus notifier-selection tests | Tests pass; composition matches each `main.ts` |
| T6 | `lifecycle.ts` (ordered start with readiness waits and rollback; shutdown with deadline; single signal handler; no `enableShutdownHooks`) plus tests with fake apps | Failure and shutdown-order tests pass |
| T7 | `realtime-upgrade.ts` plus the two-server test | A socket connects through the public server; other upgrade paths are destroyed |
| T8 | `main.ts` wiring and `make backend-start` (D4, D5), verified on the test database and test ports, never the dev database | `/health/ready` 200 on the public port; `SIGTERM` gives exit 0; a busy port gives a clean exit 1 with nothing left listening |
| T9 | Integration test (§9) in `make db-test` | `make db-test` passes: 891 plus the new tests |
| T10 | Unified mode in `stack.ts` and `make e2e-unified` | `make e2e-unified` passes 54/54 **twice**; the default `make e2e` passes 54/54 |
| T11 | Unified metrics (§10), compared with T0 | Recorded; no unexplained increase in database connections |
| T12 | CI (D8) and documentation (onboarding, the Phase 1 column of the database architecture document, this report) | `make ci-local` passes; CI YAML parses; docs formatted |

**Phase 1 gate (ADR 0016 decision 13):** T0–T12 complete; every existing suite unchanged and green; the full browser suite green against the single process; memory, connections and start-up time measured.

### Status

- **Preflight complete. Phase 1 has not started.**
- No code, configuration, environment, secret, database or infrastructure was changed.
- No suite was re-run.
- Nothing was committed.
- Waiting for the project owner's review of decisions D1–D8 before any task.

---

## Addendum: Phase 1 task T0, the seven-process baseline (2026-11-03)

**Approval:** the project owner approved decisions D1–D8 and authorized T0 only.

**T0 as defined in the preflight (§13):** capture the seven-process baseline (§10) during one default `make e2e`, with no code change. Verification: the metrics are recorded in this report.

### Method

- **Before:** Git state was identical to the preflight's (7 modified, 3 untracked, nothing staged, no stash). The test-DB lock and ports 3300–3309 and 5174 were free; the database and Redis containers were healthy.
- **Commands:**
  1. `make build` (22:54:42), so compiling stays outside the measured window;
  2. `E2E_OUTPUT_DIR=<scratch>/t0-results E2E_LOG_DIR=<scratch>/t0-logs make e2e` (22:55:03–23:00:38), under the test-DB lock.

  This is the default seven-process stack on ports 3300–3305 and 3309, against the disposable test database.
- **Sampler:** a read-only script in the session's scratch folder (not in the repository), running beside the suite:
  - **Start-up:** each process's spawn is when it first appears as a `node dist/main.js` process (`pgrep`, every 200 ms); ready is its first `GET /health/ready` 200 (every 200 ms); the PID comes from `lsof` on its port.
  - **Memory:** RSS for the seven PIDs via `ps`, every 3 s, 95 samples each.
  - **PostgreSQL:** connections by role and state from `pg_stat_activity` on the test instance, every 6 s, 49 samples during the run. The query ran through `docker exec` with the container's own credentials, and nothing was printed.
  - **Redis:** client count from `CLIENT LIST`, every 30 s, with `REDISCLI_AUTH` read **inside** the container from its own secret file. The password never appeared on a command line or in output.
- **Machine conditions:** load average 3.4 at the start and 5.2 at the end. 9.2 GB of 10 GB swap was in use (heavy memory pressure).

### Results

**Browser suite:** `make e2e` exit 0: **54 passed, 0 failed, 0 skipped**, in 5.2 min.

**Service logs for the run:**
- zero "Unable to start a transaction" failures in every service;
- zero 5xx in organization, workspace, messaging, files, identity and the API gateway;
- the realtime gateway's only 5xx is `GET /health/ready` answering 503 at start-up, before it has subscribed to Redis. That is expected.

**Start-up time** (spawn to first `/health/ready` 200):

| Process | Port | Start-up |
|---|---|---|
| identity | 3301 | 0.94 s (first process; cold caches) |
| organization | 3302 | 0.26 s |
| workspace | 3303 | 0.29 s |
| messaging | 3304 | 0.51 s |
| realtime-gateway | 3305 | 0.51 s |
| files | 3309 | 0.56 s |
| api-gateway | 3300 | 0.44 s |
| **Whole stack**, first spawn to all seven ready | — | **5.79 s**. The harness starts each process only after the previous one is ready; the per-process times add up to 3.51 s |

**Memory** (RSS, MB):

| Process | After start-up | Peak during the run | Last sample before the stack stopped |
|---|---|---|---|
| identity | 45.2 | 115.7 | 80.6 |
| organization | 44.3 | 97.6 | 66.6 |
| workspace | 51.9 | 90.5 | 56.7 |
| messaging | 51.8 | 112.8 | 63.9 |
| realtime-gateway | 46.8 | 80.3 | 39.5 |
| files | 126.2 | 126.2 | 17.7 |
| api-gateway | 138.8 | 138.8 | 52.7 |
| **Seven processes** | **504.9** | **761.9** (sum of each process's own peak, an upper bound); **504.9** peak total in any single sample | **377.7** |

**PostgreSQL connections** (test instance):

| Runtime role | Idle, right after start-up | Maximum during the run | Maximum `active` |
|---|---|---|---|
| `sc_identity_app` | 1 | 5 | 0 |
| `sc_organization_app` | 2 | 5 | 1 |
| `sc_workspace_app` | 2 | 5 | 0 |
| `sc_messaging_app` | 1 | 5 | 1 |
| `sc_files_app` | 1 | 2 | 0 |
| **All `sc_` roles** | **7** | **19** (largest total in any one sample) | — |

There were 0 connections before the stack started and 0 after it stopped. Each service's pool is capped at 5 (`createPrismaClient`), and each role's connection limit is 25; four of the five roles reached their pool cap.

**Redis clients:** 1 before the stack, 3 during the run (4 in one sample at 22:56:13), and 1 after. The "1" is the sampler's own `redis-cli` connection, so the stack's application clients are **2**: messaging's publisher and realtime's subscriber. The extra client in one sample was transient and is not identified. In this stack the API gateway has no `REDIS_URL` and uses its in-memory rate-limit store, as in development; a production gateway adds one more Redis client.

### Limits of these measurements

- **Start-up precision:** about ±0.2–0.4 s, because both spawn and ready are polled every 200 ms.
- **RSS under memory pressure:** macOS compresses and swaps idle pages, so a process's RSS falls while it sits idle (files dropped from 126 to 12–18 MB). The *after start-up* and *peak* figures are the useful ones; the *last* figures understate the true footprint.
  - Recommendation for T11: record macOS's physical footprint (`/usr/bin/footprint`, which counts compressed memory) at the same moments, for both topologies. That needs one more seven-process run with the same sampler plus `footprint`, if the project owner wants that sturdier comparison.
- **Same conditions for T11:** the comparison must use the same sampler, the same machine and similar load, with the same gateway rate-limit setting (in-memory, as in this stack).

### Files changed by T0

- `UNIFIED_BACKEND_PHASE0_REPORT.md`: this appended section only.
- No repository code, configuration, test or documentation file changed; the sampler and summary scripts live only in the session's scratch folder.
- The working tree is otherwise exactly as before T0.

### Confirmation and status

- No application code, configuration, schema, migration, role, RLS, data, `.env` file, secret or infrastructure changed.
- Nothing was rebuilt in Docker, committed, pushed or deployed.
- The only database activity: the suite used the disposable test instance as designed, and the sampler's queries were read-only.
- The browser stack stopped on completion: ports 3300–3309 and 5174 are free and the lock is released. The project owner's Vite server on 5173 was not touched.
- **T0 is complete. T1 has not started.** Waiting for the project owner's next instruction.

---

## Addendum: Phase 1 complete, the unified single-process backend (2026-11-04)

**T1 and T2** were accepted earlier: declarations in all seven packages with all 510 JavaScript files byte-identical, the `RepliesPage` export, and the workspace scaffold. **T3–T12** are below.

### 1. What was built

`smartconnect-backend/app` (`@smartconnect/backend`) is one Node.js process that hosts the seven existing applications, unchanged, through their existing factories:
- the API gateway;
- the identity, organization, workspace, messaging and files services;
- the realtime gateway.

**Public entry:** the API gateway owns the only public port, which serves REST (`/api/v1`), health (`/health/*`) and Socket.IO (`/realtime/socket.io`).

**Internal boundaries:** the applications keep calling each other over their existing HTTP interfaces, on fixed loopback ports. This is **not** a modular monolith: no in-process calls, no modules, nothing removed.

**Composition (D2):** `src/compose.ts` reproduces each `main.ts` exactly:
- a database client with that service's own runtime role;
- for identity and organization, the email notifier, copied line for line;
- the existing factory, then `listen`.

The service `main.ts` files are unchanged and not imported, because importing one starts that service on its own. Nest's `enableShutdownHooks()` is not used either: it re-raises the signal and would kill the process after the first application closed.

### 2. Files

**New:**

| File | Purpose |
|---|---|
| `smartconnect-backend/app/src/apps.ts` | Applications, prefixes, ports, start order, shutdown groups |
| `smartconnect-backend/app/src/env.ts` | Per-application environment views (D3) |
| `smartconnect-backend/app/src/compose.ts` | The seven starters (D2) |
| `smartconnect-backend/app/src/backend.ts` | Validation, ordered start with rollback, ordered shutdown |
| `smartconnect-backend/app/src/lifecycle.ts` | Readiness waits, grouped close, the once-only deadline, the signal handler |
| `smartconnect-backend/app/src/ports.ts` | The port check before start-up (D4) |
| `smartconnect-backend/app/src/realtime-upgrade.ts` | The Socket.IO hand-off |
| `smartconnect-backend/app/src/logger.ts` | Per-application JSON logger |
| `smartconnect-backend/app/src/main.ts` | Entry point; replaces the T2 scaffold |
| `smartconnect-backend/app/test/*.test.ts` | 7 files, 39 tests |
| `smartconnect-backend/app/vitest.config.ts`, `smartconnect-backend/app/README.md` | Test configuration; package documentation |
| `tests/integration/platform/unified-backend.test.ts` | 8 tests: the built process against the test database |

**Modified:**

| File | Change |
|---|---|
| `smartconnect-backend/app/package.json`, `tsconfig.json` | Scripts (`build:deps` before `build`, `typecheck` and `test`), dependencies, test include |
| `package-lock.json` | The new package's dependency entries only. The external package set is identical: 950 before and after |
| `Makefile` | `backend-start`, `backend-test`, `e2e-unified`; `backend-test` added to `ci-local` |
| `tests/e2e/support/stack.ts` | Opt-in unified mode (`E2E_BACKEND=unified`), derived from the same per-service table |
| `tests/package.json` | `pretest:db` also builds the unified backend |
| `.github/workflows/ci.yml` | The app added to the backend job's typecheck and build loops, plus a "Unified backend tests" step (D8). Every existing step is unchanged |
| `docs/onboarding.md`, `docs/database/architecture.md`, `docs/decisions/0016-unified-backend.md` (status line), `docs/decisions/README.md`, `docs/architecture/README.md` | Phase 1 documented as built locally and not deployed |

**Not touched:**
- any service or gateway source file (beyond T1's `RepliesPage` export), factory, config loader or `main.ts`;
- Prisma schemas and migrations, `.env` files, secrets, Docker, the frontend, CI's database job.

**No new external dependency:** the app uses `@nestjs/common` 12.2.0, `reflect-metadata` 0.2.2, `socket.io` / `socket.io-client` 4.8.4 and `vitest` 5.0.5, all already in the tree at those versions.

### 3. Environment mapping (D3, D5, D7)

Each application receives **only** its own list of variables (`PASS_THROUGH` in `env.ts`). Its own `loadConfig()` then validates that view, unchanged.

| Unified name | Received by | As |
|---|---|---|
| `PORT`, `HOST`, `TRUST_PROXY_HOPS`, `API_DOCS_ENABLED` | the public API gateway | the same names |
| `<APP>_DATABASE_URL[_FILE]` (`IDENTITY`, `ORGANIZATION`, `WORKSPACE`, `MESSAGING`, `FILES`) | that service only | `DATABASE_URL[_FILE]`, each with its own runtime role |
| `<APP>_INTERNAL_PORT` | that application | its internal `PORT` |
| `<APP>_TRUST_PROXY_HOPS`, `<APP>_API_DOCS_ENABLED` | that application | otherwise the application's own default applies |
| `AUTH_JWT_PRIVATE_JWK[_FILE]` | **identity only** | the same |
| `ORGANIZATION_CREATOR_EMAILS`; `FILES_MAX_BYTES` and the other `FILES_*` | organization; files (`FILES_MAX_BYTES` also the gateway) | the same names. **Never prefix-stripped** |
| SMTP and `WEB_APP_URL` | identity, organization | the same |
| `REDIS_URL[_FILE]` | gateway, realtime, messaging | the same |
| *(computed)* `HOST=127.0.0.1` and every `*_SERVICE_URL` for the internal applications | the applications that read them | **not settable** |

**Rejected before anything starts:** any supplied `*_SERVICE_URL`, an unprefixed `DATABASE_URL`, and invalid or duplicate ports. All problems of all applications are reported at once, by name and never with values.

**Local development only** (never when `NODE_ENV=production`):
- each service's `DATABASE_URL` comes from its generated `services/<svc>/.env`; nothing else is taken from that file;
- `REDIS_URL` is built from `REDIS_PASSWORD` and `REDIS_PORT` in the root `.env` (D5).

### 4. Internal ports (D4)

| Application | Default (`make backend-start`) | Unified browser tests | Binding |
|---|---|---|---|
| API gateway (public) | `PORT` 3000 | 3300 | `HOST` (127.0.0.1 locally; `0.0.0.0` in a container) |
| identity, organization, workspace, messaging, realtime | 3101, 3102, 3103, 3104, 3105 | 3301–3305 | **127.0.0.1 only** |
| files | 3106 | 3309 | **127.0.0.1 only** |

Every port is checked first. A port that answers on loopback, or can't be bound, makes the backend exit 1 before anything starts, listing the busy ports. Another process's port is never touched. `make backend-start` and the per-service `*-start` targets therefore exclude each other.

### 5. Start-up and shutdown

**Start-up:**
1. Validate all seven configurations.
2. Check all seven ports.
3. Start identity → organization → workspace → files → messaging → realtime → API gateway. Each application must answer `GET /health/ready` with 200 before the next one starts (D6).
4. The public listener opens last, only after every internal application is ready.

If anything fails (a factory, a `listen`, a 60 s readiness timeout), everything this process started is closed again in shutdown order, and the process exits 1.

**Shutdown:**
1. The process installs one SIGTERM/SIGINT handler.
2. Close the API gateway and the realtime gateway together. The public server can't finish closing while it holds upgraded sockets, which only realtime can end.
3. Then messaging → files → workspace → organization → identity, so consumers finish before the services they call.
4. Deadline 25 s; exit 0 when everything closed cleanly.

**Idempotent:** every call returns the same shutdown.

**Signals:** a duplicate signal within 1 s is ignored, and a later second signal exits at once with 1. A terminal's Ctrl-C reaches both npm and node, and npm forwards it. Without that 1 s rule, every Ctrl-C under `make backend-start` would have skipped the graceful shutdown. This was found and fixed during verification (§7.4).

### 6. Socket.IO on the public server

The realtime gateway still attaches Socket.IO to its own (internal) HTTP server. The unified process adds one `upgrade` listener to the API gateway's public server:
- requests whose URL starts with `/realtime/socket.io/` (the gateway's own `SOCKET_PATH`, imported from it) are handed to the realtime server **inside the process**;
- every other upgrade is destroyed.

The realtime gateway's own checks therefore still decide: origin allowlist, token handshake, payload limit, rooms and re-authorization. Redis pub/sub (`smartconnect:events`) is unchanged, and no Socket.IO adapter was added. The frontend is unchanged too: its same-origin `/realtime/socket.io` now reaches the public port.

### 7. Verification

#### 7.1 Results

All on 2026-11-03/04, locally, against the disposable test database (`:15433`) and the shared Redis. The **final** set ran on the final code.

| Suite | Command | Result |
|---|---|---|
| Unified backend unit tests | `make backend-test` | **39/39** in 7 files |
| CI gates | `make ci-local` | First run (code before the final signal-handler fix): **exit 0, 1,034 tests**. On the final code: every gate passed (§7.2) |
| Database and integration | `make db-test` | 899/899 in 44 files (891 existing + 8 new). Final code: 897/899 once (§7.2), then **899/899** on the full re-run |
| `make backend-start` itself | Against the test database, ports 3340–3346 (never the dev database) | Built and ready in 18.7 s; all 7 `/health/ready` 200; `REDIS_URL` derived (D5); terminal-style SIGINT to the process group → `backend_stopped` in order, no forced exit, all ports freed |
| Seven-process browser suite (rollback topology) | `make e2e` | 54/54 (5.7 min), and **54/54 again on the final code** (5.6 min) |
| **Unified browser suite** | `make e2e-unified` | **54/54 and 54/54, twice in a row** (6.7 and 5.5 min); on the final code **54/54 and 54/54 twice in a row** again (5.1 and 5.1 min). No skipped or flaky tests |

#### 7.2 Failures on the final code (all intermittent, all outside Phase 1's code)

**`make ci-local`, twice:**
- Each run stopped at `test-frontend` with 2 of the web app's 404 tests failing, under load averages of 20–21. They were **different tests each time**: `conversations` "pages with the cursor" and `messages` "loads older messages…", then `search` "highlights matches…" and `workspaces` "joins a public channel".
- The web app has **no changes** against HEAD.
- On its own, the web suite passed 404/404 in parallel and 404/404 serially.
- `make test-frontend build audit` then passed (11 + 8 + 404 tests, build, and the same 11 moderate advisories).
- Every gate before `test-frontend` passed in both runs: format, lint, Prisma, typecheck, unit 27, kit 131, gateway 210, identity 39, organization 20, workspace 11, messaging 51, files 38, realtime 48, unified backend 39.
- This matches the load-sensitive web tests already recorded in §5.3.

**`make db-test`, once:**
- 2 tests in `security/database/tenant-isolation.test.ts`, "notifications: cross-tenant work claiming", failed. It is the same intermittent notification-claim test seen earlier in this session.
- Phase 1 changes nothing in notifications or the database. The full re-run passed 899/899.

#### 7.3 What the new tests cover

| # | Area | Where |
|---|---|---|
| 1 | Configuration allowlists | `app/test/env.test.ts`: no view holds anything outside its list |
| 2 | Secret isolation | `env.test.ts`, `backend-config.test.ts`: the signing key is in identity's view and identity's configuration only; each database URL is in its own service only; SMTP reaches identity and organization only; Redis reaches gateway, realtime and messaging only |
| 3 | Conflicting variables | `env.test.ts`: `PORT`/`HOST`/`TRUST_PROXY_HOPS`/`API_DOCS_ENABLED`; prefix-like names; rejected `*_SERVICE_URL` and `DATABASE_URL`; port rules |
| 4 | Start-up order | `backend-lifecycle.test.ts` |
| 5 | Readiness gating | `backend-lifecycle.test.ts`: the public listener opens after every internal application is ready |
| 6 | Port collisions | `ports.test.ts`, and the integration test: a second backend exits 1 while the first stays healthy |
| 7 | Partial start-up failure clean-up | `backend-lifecycle.test.ts`: a failing start, and a readiness timeout |
| 8 | Graceful shutdown | `backend-lifecycle.test.ts`; integration (`SIGTERM` → exit 0, order, ports released); `make backend-start` (SIGINT to the process group) |
| 9 | Shutdown idempotency and deadline | `backend-lifecycle.test.ts`, `lifecycle.test.ts` (including the signal handler) |
| 10 | Internal HTTP calls | Integration: organization → identity, workspace → organization, messaging → workspace, and realtime → workspace on subscribe |
| 11 | Socket.IO upgrade hand-off | `realtime-upgrade.test.ts` and the integration test (public port; bad token and foreign origin refused; other upgrade paths refused) |
| 12 | Authentication and authorization parity | Integration: 401 with problem JSON; outsiders get 404 through every service; the full browser suite twice |
| 13 | Redis pub/sub | Integration: `message.changed` reaches a socket on the public port after a REST post; browser realtime tests |
| 14 | Public REST parity | Integration: auth flows, refresh-cookie attributes, CORS, `RateLimit-*`, request ids, 404 problems; the full browser suite |
| 15 | Health and readiness | Integration: every `/health/ready`; unit: gating and timeouts |

Also covered: the logger (the `app` field; Nest's process-wide logger left untagged) and **no credentials in logs**. The integration test scans the whole log for the signing key, the five database passwords and the Redis password.

#### 7.4 Problem found and fixed during verification

The first signal handler treated any second signal as "exit now". Under `make backend-start`, a terminal's Ctrl-C reaches both npm and node, and npm forwards it, so node gets SIGINT twice at once and the graceful shutdown would be skipped.
- **Fix:** a duplicate within 1 s is ignored (`createSignalHandler`, 3 new tests).
- **Verified:** with a real `make backend-start` and SIGINT to the whole process group, no forced exit occurred and the shutdown completed in order.

### 8. Performance against T0

All runs used the same sampler, on the same machine, under similar load (averages 5–9, about 9 GB of swap in use). The table shows the final runs.

| Metric | T0, seven processes | Seven processes, final run | **Unified, final run 1 / run 2** |
|---|---|---|---|
| Processes | 7 | 7 | **1** |
| Start-up (first spawn → all ready) | 5.79 s | 5.04 s | **1.35 s / 1.34 s** |
| RSS right after start-up (sum) | 504.9 MB | 537.3 MB | **263.8 / 260.2 MB** |
| RSS, peak simultaneous total | 504.9 MB | 537.3 MB | **263.8 / 260.2 MB** |
| macOS physical footprint after start-up (sum) | not measured | 1,011 MB | **299 / 300 MB** |
| Physical footprint, peak | not measured | 1,011 MB simultaneous (1,047 MB sum of per-process peaks) | **299 / 300 MB** |
| Idle database connections | 7 | 7 | **5 / 5** |
| Peak database connections | 19 | 19 | **19 / 19** |
| Peak per role (identity, organization, workspace, messaging, files) | 5, 5, 5, 5, 2 | 5, 5, 5, 5, 2 | **5, 5, 5, 5, 1** |
| Redis clients (excluding the sampler) | 2 | 2 | **3** |
| Browser suite duration | 5.2 min | 5.6 min | **5.1 / 5.1 min** |
| Transaction-start failures; unexpected 5xx | 0; 0 | 0; 0 | **0; 0** |

**Memory and start-up:**
- One process needs about a third of the physical footprint of seven: roughly 300 MB against roughly 1,010 MB, because seven Node runtimes and seven Nest bootstraps become one of each.
- It starts about four times faster.
- RSS figures are distorted by macOS memory compression on this machine; the footprint figures are the sturdier comparison.

**Database:**
- Pools were not changed.
- The same five runtime roles were in use, each separately, with the same per-role peaks (at most 5, the pool cap). Peak total connections are unchanged.

**Redis, one more client:** in unified mode the gateway receives `REDIS_URL`, as every application that reads it does (D3), so its rate limits use the Redis store as in production. In the seven-process test stack the gateway has no `REDIS_URL` and uses its in-memory store. This is the only material difference, and it is intended.

**Backend logs:**
- Both topologies log one start-up `GET /health/ready` 503 per Redis-dependent application before Redis connects.
- Both show the same pre-existing gateway warning `upstream_failed: files, socket hang up` (1–2 per run in every run since Phase 0).
- No other 5xx and no transaction-start failure in any run.

### 9. Security checks

- **Separate credentials (D7):** each service's view and configuration holds only its own database URL (unit tests). At run time, `pg_stat_activity` shows the five distinct runtime roles in use. No migrator variable is on any list, so migrator credentials can't reach the process.
- **Signing key:** only in identity's view and configuration (unit tests). Inside the shared process, `process.env` itself is shared, as accepted in D7.
- **Loopback only:** the internal listeners are bound to 127.0.0.1, confirmed with `lsof` on the running process. Their host can't be configured.
- **Internal URLs** can't be redirected: a supplied `*_SERVICE_URL` is rejected.
- **No credentials** in logs or in configuration errors (integration and unit tests).
- **Unchanged checks:** Socket.IO origin and token checks, gateway authentication, CORS, the cookie-origin check, body and upload limits, and rate limits are all the existing code.

### 10. Remaining issues and limits

- **CI changes** are verified locally (the YAML parses; the same commands pass), not on GitHub Actions, because nothing was pushed.
- **Load-sensitive tests** (pre-existing): web tests under heavy load, and the notification-claim test. They prevented an uninterrupted `ci-local` on the final code (§7.2). Worth a separate task.
- **Logging:** request and error logs carry `app`. Lines from Nest's process-wide logger carry no `app` field (by design, never a wrong one); their context names them.
- **Not exercised on the development database:** `make backend-start` was run only against the test database, as the verification policy requires.
- **Blast radius:** one process means one crash stops all seven applications. This was accepted in ADR 0016, and its health probe is the same.
- **Still pending for Phase 3:** P1–P5 (storage provider, PostgreSQL bootstrap support, migration runner, origins, rollback window), `TRUST_PROXY_HOPS` on Render, and the Render deployment itself.
- **Rollback is intact:** the seven-process topology is unchanged and passed 54/54 on the final code. Every per-service `*-start` target still works. The database is shared and unchanged.

### 11. Confirmation

- **Database:** no schema, migration, role, RLS, connection-pool or real-data change. Only the disposable test instance was used; the development database was not used.
- **Configuration and infrastructure:** no `.env` file or secret was modified (local secrets were only read by the normal start paths). No Docker rebuild and no deployment.
- **Version control:** no commit and no push. HEAD is still `964e89e`, there are no stash entries, and all earlier working-tree changes are preserved.
- **Processes:** everything started for verification has stopped; every port used is free. The project owner's Vite server on 5173 was not touched.
- **Phase 1 is complete locally. Phase 2 has not started.** Waiting for the project owner's review.

## Addendum: MVP stabilization and 30-user readiness (2026-11-04)

**Scope:** the existing product on the Phase 1 unified backend (`make backend-start`), with the seven-process topology kept as the rollback option. **Not started:** Phase 2 (the modular monolith) and any deployment.

**Short answer:** at a realistic pace, 30 simultaneous signed-in users across 5 organizations worked without a single error, in 5 of 5 rounds. At a stress pace (about 45 requests/s, several times what 30 people chatting produce) on this laptop, 2 of 5 rounds logged database transaction-start timeouts, which reached users as 5xx in one round. That is a capacity-margin finding, not a 30-user blocker (§8.3). What blocks a production MVP is infrastructure and decisions, not code defects found here (§10).

### 1. Initial baseline (WS1)

| Item | State at the start |
|---|---|
| Git | Branch `main`, HEAD `964e89e`, level with `personal/main`. 21 modified tracked files and 25 untracked files (the Phase 0/1 work), nothing staged, no stash |
| Environment files (names only) | Root `.env`; per-service `services/<svc>/.env` and `.env.migration`; `.secrets/smtp.env`, `.secrets/organization.env`. No values were read into this report |
| Development database | `127.0.0.1:15432/smartconnect`, container `smartconnect-postgres`, one runtime role per service |
| Test database | `127.0.0.1:15433/smartconnect_test`, container `smartconnect-postgres-test` (tmpfs, disposable), a separate container |
| Production | No production credentials exist on this machine; nothing here can reach a production database |
| Ports | 3000 and 3101–3106 free; 5173 is the project owner's Vite (left alone) |
| Tests | The Phase 1 final state (§7 of the Phase 1 addendum); no code had changed since |

### 2. Unified backend on the development database (WS2)

`make backend-start` was run against the **development** database with its existing configuration, and verified **without creating data**. All **30 of 30** checks passed:

- Built and ready in 21.5 s (`startupMs` 1,586, RSS 301 MB). All seven `/health/ready` and the public `/health/ready` and `/health/live` answered 200.
- Gateway → identity (read-only): `GET /auth/me` without a token gives 401 problem+json, with no stack or internals in the body. A forged token on the admin route gives 401 `invalid_token`. Login for an unknown account gives 401 `invalid_credentials` and carries `RateLimit-*` headers.
- Gateway → organization (read-only): an invitation preview with an unknown token gives 404 `invitation_invalid`.
- `GET /orgs` without a token gives 401. Malformed JSON gives 400 `malformed_json`, with no internals.
- Internal routes are not public: `/dev/mailbox`, `/api/v1/dev/mailbox`, `/api/v1/internal` and `/api/v1/health/ready` all give 404 on the public port.
- CORS: the dev web origin is allowed and a foreign origin refused.
- Socket.IO on the public port: no token, a forged token and a foreign origin are each refused. A WebSocket upgrade on any other path is refused.
- A terminal-style SIGINT shut the applications down in order, with no forced exit, and released every port. The log contains none of the 8 credential values checked.
- The only 5xx were the start-up readiness probes before Redis connected (as in Phase 1).

**Writes:** none to the development database (a failed login only reads). The only state touched was the gateway's expiring rate-limit counters in the local Redis.

**Not run on the development database, deliberately:** registering, signing in, sending messages, uploading. They would create persistent records in the development data, which the assignment forbids. Every one of those flows ran on the test database instead, through the same unified process (§3, §6, §7).

### 3. User journeys (WS3)

"Verified" means a passing automated test in the final run (§6) exercises the journey end to end. Integration tests (`tests/integration`) run the built services against the test database; browser tests (`tests/e2e`) run real Chrome against the whole stack, in both topologies; the load test (§7) adds each journey under concurrency.

| Journey | Status | Evidence | Gaps |
|---|---|---|---|
| Registration and email verification | Verified | `identity/registration-login` (9), `identity/email-verification` (7), `e2e/auth`, load test (25 per round) | Real SMTP delivery not verified (dev mailbox) |
| Login, session, refresh, logout | Verified | `identity/sessions` (12), `identity/token-lifecycle` (10, rotation and reuse detection); load test: refresh under load, browser reload restores the session, the refresh token is refused (401) after logout | — |
| Password recovery | Verified with the dev mailbox | `identity/password` (12), `identity/smtp-notifications` (7, the real notifier over a capturing transport) | Real SMTP delivery not verified |
| Unauthorized access | Verified | 401 problem+json throughout; §2 on the dev database | — |
| Organization creation | **Partial** | `organization/organizations` (11), `e2e/organizations` | Only allowlisted creators (`ORGANIZATION_CREATOR_EMAILS`); no open self-service |
| Owner permissions, roles | Verified | `organization/structure` (6), `organization/invitations` ("restricts invitation management to members.invite, and owner invitations to owners") | — |
| Invite, accept, verified identity | Verified | `organization/invitations` (14): single-use link to the invited address, verified email required, a different account refused, exactly-once under concurrency, expiry, revoke, resend; load test (25 per round) | — |
| Join | Verified | Only through an accepted invitation; there is no join-by-email route | — |
| Removal | Verified | "answers 404 to people who are not members of the organization, and after removal"; workspace and messaging removal tests | — |
| Multiple memberships | Verified | `e2e/organizations` "someone in two organizations switches between them and sees each one's own data"; files "never serves a file through another organization, even to someone in both" | — |
| Workspaces, channels, channel membership, permissions | Verified | `workspace/workspaces` (18), `workspace/channels` (22), `workspace/security` (11), `e2e/workspaces`, `e2e/channels` | — |
| DMs, groups, send/receive, replies, reactions, history | Verified | `messaging/conversations` (39), `messaging/threads` (13), `messaging/reactions` (12), `messaging/messages` (16), `e2e/conversations`, `e2e/messaging`, `e2e/collaboration`; load test | — |
| Read state, unread, activity | Verified | `messaging/read-state` (6), `messaging/activity` (13), `e2e/activity`; load test | — |
| Realtime | Verified | `realtime/message-events` (5), `realtime/conversation-events` (5), browser realtime tests; load test: every delivery to every online recipient checked | — |
| Files: upload, download, attachment visibility | Verified | `files/files` (16), `messaging/attachments` (15), `e2e/files`, `e2e/attachments`; load test: 25 uploads per round, each downloaded by another member and checksummed | — |
| Files: isolation, unauthorized access, limits, failures | Verified | `files/security` (11), `files/hardening` (10): 413, 415, 422, quotas, cross-organization 404, fail-closed 503 | — |
| Files: persistent storage | **Partial** | Local filesystem (`FILES_STORAGE_DIR`) only | Production object storage is P1, undecided |
| Super Admin sign-in, platform access | Verified | `identity/super-admin` (8): issued password must be replaced, 403 for other accounts, 401 anonymous, withdrawal effective at once; `e2e/admin` | Production granting procedure undecided (dev seed only) |
| Super Admin organization and account listing | Verified (read-only) | `organization/platform-admin` (6): every organization through a narrow definer function; `GET /admin/accounts/summary` | No organization management, no user listing |
| Super Admin cross-organization restriction | Verified | "gives the Super Admin no access to an organization's own routes, and no organization-creation right" | — |

### 4. Security and tenant isolation (WS4)

**No isolation or authorization defect was found.** Each required check, with its evidence:

| Requirement | Result | Evidence |
|---|---|---|
| Cross-organization isolation | Holds | RLS suite `security/database/tenant-isolation` (22) and roles suite (19); every service answers 404 to non-members; load test: 50 cross-organization probes per round (channel history and file download) all 404 under load |
| No joining by arbitrary email | Holds | Membership only through an invitation token sent to the invited address |
| Invitations need acceptance and verified identity | Holds | Verified email required; a different account is refused and the invitation stays usable for the right one |
| Owners cannot become Super Admin | Holds | `platform-admin`: an owner gets no platform access; `e2e/admin`: an owner is refused at `/admin/login` and by the admin API. The role is written only by the dev seed script (`smartconnect-backend/scripts/super-admin.ts`) |
| Normal users cannot reach admin routes | Holds | 403 for authenticated non-admins, 401 anonymous; a forged token gives 401 (§2) |
| API authorization matches the frontend | Holds | The UI's restrictions are backed by the same checks server-side (integration suites call the API directly, without the UI) |
| Files protected | Holds | Uploader, or whoever messaging says can see an attaching message; everything else 404; fails closed (503) when messaging cannot answer |
| Internal services not public | Holds | Internal listeners bound to 127.0.0.1 (Phase 1, `lsof`); dev mailboxes and internal paths give 404 publicly (§2) |
| No sensitive data in logs or errors | Holds | Phase 1 integration credential scan; §2 dev-database scan; all load-test backend logs contain no email addresses, bearer tokens, JWTs or passwords; error bodies carry no stack |

**Privileged inspection of private content:** no such capability exists. The Super Admin reads counts and the organization list only, and is denied every organization route. There is therefore no path to private DMs or files to put under an audit policy. Building one later needs that explicit, auditable policy first.

**Fail-closed under load:** when a deciding service could not answer in time (§8.3), callers got 503 rather than access, and the realtime gateway evicted the room rather than keep delivering. That is the intended behaviour.

### 5. Fixes (WS5, WS8)

| # | Problem | Root cause (proven) | Fix | Verification |
|---|---|---|---|---|
| F1 | Intermittent `db-test` failure: 2 tests in "notifications: cross-tenant work claiming" | Prisma fills `next_attempt_at` from the **host** clock (`@default(now())`), while the claim compares it with the **database** clock (`next_attempt_at <= now()`). The Docker database runs about 3.5 ms behind the host, so a delivery claimed right after creation was sometimes not yet due. Reproduced on the test instance: 13–27 % of immediate claims missed with the default, 0 % with an explicit past due time | The test sets an explicit due time one minute in the past (`tests/security/database/tenant-isolation.test.ts`, 12 lines). No assertion weakened, no timeout added. Product behaviour is unaffected: a worker claims such a delivery on its next poll | 5 of 5 targeted runs, and the final `make db-test` (§6) |
| F2 | The 2 intermittent web tests (`test-frontend` under heavy load) | **Not proven**, so not fixed. Experiment with a fixed background load: default 7 workers passed 404/404 at load averages 19 and 36; 3 workers passed 404/404 at 26 and failed 1 test at 52. Fewer workers did not help, so worker contention is not the cause. Most likely timing under CPU contention (Testing Library's 1 s `findBy` default) | None. Raising timeouts without proof is excluded by the assignment | Classified and left as a known load-sensitive flake |
| F3 | (In the new load test) the history lookup of a message sent from the browser sometimes ran before the message was stored | The composer shows a message at once as "sending"; it is stored when its POST answers | The test now polls the history until the message is there (with a deadline) and records both times | Rounds 2–11 |
| F4 | (In the new load test) deliveries counted as missed after the gateway evicted a room | The gateway fails closed when a re-check cannot be answered and tells the client (`unsubscribed` / `inbox.unsubscribed`); the web app resubscribes with backoff and refetches (`lib/realtime.ts`). The load client did not | The load client behaves like the web app and must find everything it missed in the history afterwards | Rounds 8–11 |

**No product code changed in this assignment.** No proven critical or high-priority product defect was found. The transaction-start timeouts under stress (§8.3) need a design decision, not a bug fix (§11).

### 6. Exact test counts (final runs, on the final code)

All on 2026-11-04, each run **once, in sequence, and passed the first time**. No test was skipped, retried or reported flaky. Afterwards only the load test's log check changed (it now also reads the seven services' logs); format, lint and typecheck were re-run on it and pass, and rounds 12–13 ran it.

| Suite | Command | Result | Time |
|---|---|---|---|
| CI gates | `make ci-local` | **Exit 0.** Format, lint, Prisma validate and generate, typecheck, then unit 27, backend kit 131, API gateway 210, identity 39, organization 20, workspace 11, messaging 51, files 38, realtime 48, unified backend 39, design tokens 11, UI 8, web **404** (**1,037 tests**), build, and audit (the same 11 moderate advisories; the gate fails only on high) | 260 s |
| Database and integration | `make db-test` | **899/899** in 44 files, including F1's two notification-claim tests | 152 s |
| Browser, seven processes (rollback topology) | `make e2e` | **54/54** | 5.4 min |
| Browser, unified backend | `make e2e-unified` | **54/54** | 5.0 min |
| 30 simultaneous users | `make load-30` | Final test: **6/6 rounds passed** (rounds 8–13: 3 realistic and 1 stress on the unified backend, 2 stress on seven processes); all 13 rounds in §7.2 | 2.1–3.3 min each |

The two load-sensitive web tests (F2) did not fail in this `ci-local` run (load average about 11); that is not evidence they are fixed.

### 7. 30 simultaneous users (WS6)

#### 7.1 The test

`make load-30` (`tests/load/thirty-users.spec.ts`, `tests/load/support/load-client.ts`, `tests/load/playwright.config.ts`; documented in `tests/load/README.md`). It runs the **unified backend** on the disposable **test database**, started by the existing browser-test global setup (ports 3300–3305 and 3309, Vite 5174).

**Who (the mix, and why):** 5 organizations × 6 people = **30 signed-in users with 30 simultaneous realtime connections**.
- In each organization, the **owner is a real Chrome session**: signed in through the web app's API, in the channel through the UI, using the page's own Socket.IO connection.
- The **5 members are API + Socket.IO clients**, through the same public port, each with its own client address (X-Forwarded-For, trusted only by the test gateway), so the per-IP rate limits stay on.
- Five browsers prove the real UI path under load (composer → server → members' sockets; members' messages → the open channel). Twenty-five API clients make 30 concurrent users repeatable on an 8 GB laptop that cannot run 30 Chrome instances alongside the backend, database and Vite.

**What everybody does:**
- **Setup**, all organizations at once: register, verify (dev mailbox), sign in, create the organization and workspace, invite, accept, join, open a group and three direct conversations per organization.
- **Concurrently**, per member, 10 iterations of: a channel message, history, a read marker, a reaction, a thread reply on every other iteration, a group message, a direct message, a conversation read marker, the conversation list and the unread count.
  - Once per member: a file of 32–256 KB uploaded and attached to a message, downloaded by another member and compared byte for byte (SHA-256), and refused (404) to a member of another organization.
  - Once per member: another organization's channel, refused (404).
  - Once per member: a token refresh.
  - For 9 of the 25 members: a deliberate disconnect, a refresh, a reconnect, and a check that every channel message sent while away is in the history.
- **Per owner:** 4 messages from the composer, each seen by every online member's socket; and 4 member messages, each watched arriving in the open channel.
- **Finally:** every session still valid, each browser reloaded (the session is restored from the refresh cookie), every member signs out, and the old refresh token is refused.
- **Every realtime delivery to every online recipient is checked.** A miss fails the test, as does any unexpected status, any 5xx, any socket, reconnect, catch-up or checksum failure, and any error line in the backend log.

**Pace:** `LOAD_THINK_MS` is the mean pause between a person's actions.
- **Stress pace:** 375 ms (the default), with the browser tests' 5 s socket re-check.
- **Realistic pace:** 3,000 ms, with the production 60 s re-check (`E2E_REAUTHORIZE_INTERVAL_SECONDS=60`; the only change to the shared browser stack is that this value can now be set).

Each round makes about 2,920 requests and about 2,350 checked deliveries. The stress pace is about 45 requests/s from 25 members, far more than 30 people chatting produce.

#### 7.2 Results, every round

**Final test (rounds 8–13), all passed.** Rounds 12 and 13 ran the last version, whose backend-log check also reads the seven services' own logs; for round 11 those logs were checked separately, with the same result (no error lines).

| Round | Topology, pace | Requests (unexpected; 5xx) | Deliveries | Request p50 / p95 / p99 | Delivery p50 / p95 / p99 | Concurrent phase | Load-avg peak |
|---|---|---|---|---|---|---|---|
| 8 | Unified, realistic | 2,922 (0; 0) | 2,359 / 2,359 | 47 / 452 / 1,583 ms | 54 / 561 / 2,258 ms | 146 s | 10.3 |
| 9 | Unified, realistic | 2,922 (0; 0) | 2,357 / 2,357 | 128 / 845 / 2,174 ms | 166 / 895 / 4,148 ms | 165 s | 21.9 |
| 10 | Unified, stress | 2,926 (0; 0) | 2,343 / 2,343 | 632 / 1,490 / 1,809 ms | 811 / 1,672 / 1,969 ms | 93 s | 14.2 |
| 11 | **Seven processes**, stress | 2,922 (0; 0) | 2,346 / 2,346 | 571 / 1,347 / 1,656 ms | 814 / 1,610 / 1,948 ms | 84 s | 18.4 |
| 12 | **Seven processes**, stress | 2,920 (0; 0) | 2,339 / 2,339 | 476 / 1,251 / 2,378 ms | 671 / 1,596 / 3,268 ms | 78 s | 16.3 |
| 13 | Unified, realistic | 2,920 (0; 0) | 2,360 / 2,360 | 49 / 288 / 521 ms | 58 / 405 / 568 ms | 143 s | 12.3 |

In each of these rounds:
- 30/30 sessions were established. All 34 member socket subscriptions succeeded (25 initial plus 9 reconnects); the 5 browsers' own connections are shown by their deliveries in both directions.
- 9/9 reconnects succeeded, with every message sent while away found in the history.
- 25/25 files matched their checksum, and 75 expected 4xx were answered correctly (50 isolation probes, 25 refused refresh tokens).
- There were no evictions.

**Earlier rounds** (the same product code; earlier versions of the test):

| Round | Topology, pace | Outcome | Requests (unexpected; 5xx) | Request p50 / p95 / p99 |
|---|---|---|---|---|
| 1 | Unified, stress | Failed: test defect F3 (10 lookups). Product: 2,278 / 2,278 real deliveries, 0 errors | 2,898 (0; 0) | 364 / 851 / 1,187 ms |
| 2 | Unified, stress | **Passed** | 2,930 (0; 0) | 343 / 808 / 1,092 ms |
| 3 | Unified, stress | Failed on the backend-log check: 1 transaction-start timeout in organization; the 503 it caused went to a browser's background notification-preferences request. Clients of the test saw no error | 2,924 (0; 0) | 522 / 1,198 / 1,615 ms |
| 4 | Unified, realistic | **Passed** | 2,921 (0; 0) | 53 / 299 / 480 ms |
| 5 | Unified, realistic | **Passed** | 2,920 (0; 0) | 89 / 637 / 1,198 ms |
| 6 | Unified, stress (load avg 20) | **Failed: 5 user-visible 5xx** (1 × 500, 4 × 503). 17 transaction-start timeouts (§8.3). 195 deliveries missed while evicted rooms were not resubscribed (test defect F4; the web app recovers) | 2,923 (5; 5) | 692 / 1,832 / 2,606 ms |
| 7 | Seven processes, stress | Invalid for realtime: the load client still used the public port for Socket.IO, which only the unified backend serves. REST: 0 errors | 2,924 (0; 0) | 614 / 1,497 / 2,046 ms |

**Realtime latency by kind** (round 8, realistic): channel p50 58 ms / p95 459 ms; group 44 / 285 ms; direct 52 / 469 ms; composer → members' sockets 222 / 1,228 ms; member → owner's open channel, as seen by Playwright, 212 / 1,946 ms.

### 8. Performance

#### 8.1 Resources (unified backend, final rounds)

| Measure | Round 8 (realistic) | Round 9 (realistic) | Round 10 (stress) | Round 11, seven processes (stress) |
|---|---|---|---|---|
| CPU, concurrent phase, mean / peak | 34 % / 93 % | 45 % / 112 % | 73 % / 129 % | 110 % / 213 % (sum of 7) |
| RSS peak | 377 MB | 336 MB | 344 MB | 526 MB (sum) |
| macOS footprint: all signed in → after the concurrent phase | 256 → 573 MB | 296 → 568 MB | 325 → 603 MB | 862 → 1,325 MB (sum) |
| PostgreSQL sessions, peak (per role) | 20 (5, 5, 5, 5, 3) | 20 (5, 5, 5, 5, 3) | 21 (5 each) | 20 (5 each) |
| Backend → Redis connections | 3 | 3 | 3 | 2 |
| Inbound connections on the public port, peak | 65 | 62 | 69 | 36 (sockets on the realtime port) |
| Transaction-start failures; 5xx | 0; 0 | 0; 0 | 0; 0 | 0; 0 |

The identity, organization, workspace and messaging pools are at their cap of 5 throughout the concurrent phase, in both topologies. Footprint grows by 270–320 MB during the concurrent phase of every unified round (460 MB for the seven processes together), while RSS falls back after it (macOS compresses and swaps). Footprint was not measured after teardown, so these runs cannot tell heap growth from a leak; see §12.

**Machine:** an 8-core (4 performance + 4 efficiency), 8 GB laptop with about 9.4 GB of swap in use. Unrelated processes (iCloud sync, VS Code, Spotlight, Docker Desktop) kept the load average at 8–22 throughout. Chrome, Vite, PostgreSQL and the test runner shared the same machine. Absolute latencies are therefore pessimistic, and only comparisons between rounds on this machine are meaningful.

#### 8.2 Unified against seven processes

At the same stress pace, latency is about the same (round 10 against rounds 11 and 12: request p95 1,490 against 1,347 and 1,251 ms; delivery p95 1,672 against 1,610 and 1,596 ms). The unified backend used about two thirds of the CPU and less than half the memory. **The single process is not the bottleneck here;** the per-service database pools and the machine are.

#### 8.3 Finding P-1: transaction-start timeouts under stress (medium)

- **What:** in 2 of the 5 unified stress rounds (3 and 6), a service could not get a database connection within Prisma's 2 s `maxWait` ("Unable to start a transaction in the given time").
  - The services affected were organization (`GET /orgs/:id/me`), messaging (`/conversations/inbox`, channel history) and, through them, workspace.
  - In round 6, 5 of 2,923 requests (0.17 %) reached users as 500/503, including one failed message send. The web app shows it as failed, and its retry reuses the same `clientMessageId`, so a retry cannot duplicate.
  - Realtime re-checks that failed evicted rooms; the web app resubscribes and refetches.
  - None in the 5 realistic rounds (4, 5, 8, 9, 13), in unified stress rounds 2 and 10, or in the seven-process stress rounds 11 and 12.
- **Why (from the code):**
  - Every tenant request makes each service involved check the organization membership again over HTTP, with the caller's token and no cache: messaging and files call `organization /orgs/:id/me`, and workspace calls it too. A channel post therefore costs at least two organization transactions besides its own.
  - Every open socket is re-checked on a timer; the browser tests use 5 s, production 60 s.
  - Each service's pool is fixed at 5 connections (`createPrismaClient`, `maxConnections = 5`; no setting), while each runtime role may open 25 (`CONNECTION LIMIT 25`).
  - At the stress pace and a load average of 15–20, the organization and messaging pools stay saturated, and a wait sometimes passes 2 s.
- **Impact for the MVP:** none observed at a realistic pace; it is the headroom limit, reached at several times the traffic of 30 people. It fails closed.
- **Not changed, because each option is a decision:**
  - (a) Make pool sizes configurable per service, or raise them. This uses more of the database's connection budget, which P2 (the Render PostgreSQL plan) has to allow for.
  - (b) A short-lived membership cache, or fewer repeated membership checks. This trades how quickly a removal takes effect for load, so it is a security decision.
  - (c) A longer `maxWait`. This hides the queue rather than removing it.

### 9. Capability matrix (WS7)

| # | Capability | Class | Evidence and notes |
|---|---|---|---|
| 1 | Self-service organization creation | **Partial** | Works for allowlisted creators only (`ORGANIZATION_CREATOR_EMAILS`, organization service config). Open sign-up-and-create is not enabled |
| 2 | Email invitations | **Implemented and verified** (dev mailbox); real delivery **requires external infrastructure** | Full invitation flow verified (§3). The SMTP notifier exists; delivery through a real SMTP provider has not been verified in this assignment |
| 3 | 1:1 messaging | **Implemented and verified** | Integration, browser and load tests |
| 4 | Group messaging | **Implemented and verified** | Integration, browser and load tests |
| 5 | Audio calls | **Not implemented**; **requires external infrastructure** | No WebRTC or media code. ADR 0005 (`docs/decisions/0005-meetings-livekit.md`) plans LiveKit |
| 6 | Video calls | **Not implemented**; **requires external infrastructure** | As 5 |
| 7 | Group meetings | **Not implemented**; **requires external infrastructure** | The `meetings` service has a Prisma schema and migrations only (no application code). The web app's Meetings entry is a "not available yet" placeholder (`navigation.ts`, "Phase 4") |
| 8 | Files and persistent storage | **Partial** | Upload, download, attachments, limits and isolation verified. Storage is the local filesystem; production object storage (P1) is undecided, and a Render instance's local disk does not persist across deploys unless a persistent disk is attached |
| 9 | Presence | **Not implemented** | The `presence` service has a schema and migrations only; the realtime gateway states "there is no typing or presence yet" |
| 10 | Meeting status | **Not implemented** | Depends on 7 and 9 |
| 11 | Central Super Admin | **Implemented and verified** | Sign-in, forced password change, platform authorization, no organization access (§3). Granting in production is undecided (dev seed script only) |
| 12 | Super Admin organization management and status dashboard | **Partial** | Read-only: account summary and organization list (`GET /admin/accounts/summary`, `GET /admin/organizations`). No organization management (suspend, edit, delete), no user listing, no system-status view |
| 13 | Super Admin sending messages into any organization | **Not implemented** | Deliberately: the Super Admin is denied every organization route. Building it needs a product and privacy decision (and §4's audit policy if it would expose content) |

**Implemented but failing:** none.

### 10. Critical blockers

**For a local or controlled 30-user MVP of the existing features:** none found in the code.

**For a production MVP** (each needs a decision, credentials or infrastructure, and so stops here):

| # | Blocker | Needs |
|---|---|---|
| B1 | Persistent file storage (P1): files live on the local disk, which a Render instance loses on redeploy (unless a persistent disk is attached, which also pins the service to one instance) | Choice of object-storage provider, credentials, and a client dependency |
| B2 | PostgreSQL bootstrap on the target (P2): 28 roles with connection limits, RLS, SECURITY DEFINER functions, default privileges | Confirmation that the chosen plan supports them |
| B3 | Migration runner (P3), origins and refresh-cookie domain (P4), `TRUST_PROXY_HOPS` on Render, the deployment itself | Phase 3 decisions and deployment authorization |
| B4 | Real email delivery: verification, password reset and invitations go through SMTP, never verified with a real provider here | SMTP provider credentials and a test address the owner provides |
| B5 | Production Super Admin granting: the role is written only by the dev seed script | A decided, audited procedure |

**Product scope, not blockers for a chat MVP:** audio and video calls, meetings and presence (not implemented), Super Admin management and messaging (§9).

### 11. Remaining work before deployment

1. Decide and implement B1–B5 (Phase 3), then deploy behind the existing health probe. Keep the seven-process rollback until P5's window ends.
2. Decide P-1's option (§8.3) before raising the user target: configurable pool sizes within the connection budget, and/or fewer repeated membership checks.
3. Re-run `make load-30` on the target infrastructure (realistic and stress pace), plus a longer soak to settle the memory question in §8.1.
4. Verify real SMTP delivery end to end with an address the owner provides.
5. Stabilise the load-sensitive web tests (F2) in a separate task, starting with a reproduction at a known load, not with higher timeouts.
6. Run the CI changes on GitHub Actions (only verified locally; nothing was pushed).

### 12. Not tested

- Any authenticated flow on the **development** database (deliberately: it would create real records). Covered on the test database.
- Production infrastructure: Render, a managed PostgreSQL, object storage, TLS, the real domain and cookie policy, a reverse proxy in front of Socket.IO.
- Real SMTP delivery (verification, reset, invitation emails).
- More than 30 users, more than one backend instance, the 1,000–1,500-user target, long soaks (the longest concurrent phase was 165 s), memory growth over hours.
- 30 real browsers at once (5 real browsers + 25 API/Socket.IO clients, as documented in §7.1).
- Mobile clients and browsers other than Chrome.
- Very large files (the load test used 32–256 KB; the limits are covered by integration tests), slow or lossy networks.
- The load client's eviction handling under real evictions (no evictions occurred in rounds 8–11); the web app's own recovery is covered by `lib/realtime.test.ts`.
- Audio, video, meetings and presence (not implemented).
- The seven-process stack under realistic pace (only stress-pace comparison runs).

### 13. Files changed in this assignment

| File | Change |
|---|---|
| `tests/security/database/tenant-isolation.test.ts` | F1: explicit due time for the claimed deliveries |
| `tests/load/thirty-users.spec.ts`, `tests/load/support/load-client.ts`, `tests/load/playwright.config.ts` | New: the 30-user test |
| `tests/load/README.md` | Replaces the "planned, intentionally empty" note with the test's documentation |
| `tests/e2e/support/stack.ts` | `REAUTHORIZE_INTERVAL_SECONDS` can be set with `E2E_REAUTHORIZE_INTERVAL_SECONDS` (default unchanged: 5) |
| `Makefile` | `load-30` target |
| `UNIFIED_BACKEND_PHASE0_REPORT.md` | This addendum |

### 14. Confirmation

- **Database:** no schema, migration, role, RLS or connection-pool change, and no production data. The development database was used read-only (§2). Everything else ran on the disposable test instance, with data created by the tests themselves; each suite re-provisions that instance.
- **Configuration and infrastructure:** no `.env` file or secret was modified (local secrets were only read by the normal start paths, never printed). No Docker rebuild and no deployment.
- **Version control:** no commit and no push, and no destructive Git operation.
  - HEAD is still `964e89e`; there are no stash entries and nothing is staged.
  - 23 modified tracked files: the 21 from the start, plus `tests/load/README.md` and `tests/security/database/tenant-isolation.test.ts`. `Makefile` and `tests/e2e/support/stack.ts` were already modified and changed further.
  - 28 untracked files: the 25 from the start, plus the 3 load-test files. All earlier work is preserved.
- **Product:** no product source, frontend or service changed; no service deleted; no feature removed.
- **Processes:** everything started for verification has stopped. Ports 3000, 3101–3106, 3300–3309, 3320–3326 and 5174 are free, and the project owner's Vite on 5173 was not touched. The per-round load results (`load-30-results.json`) and logs are outside the repository.
- **No Phase 2 and no deployment.** Waiting for the project owner's review.

## Addendum: Product completion, workstream 1: self-service organizations and employee invitations (2026-11-04)

**Outcome:** a person can now register, create their company's organization, become its owner, invite employees by email and work with them in direct messages, groups and workspaces. All of it runs through the UI and is verified end to end in a real browser on both backend topologies. The creator allowlist is no longer the only production option.

**Constraints held:**
- No schema, migration, role or RLS change.
- No public contract broken; the changes are additions and one new 200 case.
- No `.env`, secret, Docker, deployment, commit or Phase 2 work.
- No email was sent outside the machine.

The decision record is [ADR 0017](docs/decisions/0017-self-service-organizations.md): **Proposed**, awaiting the project owner's acceptance.

### 1. Existing behaviour (audit, workstream A)

| Area | What existed | Limitation found |
|---|---|---|
| Registration and verification (identity) | `202` for new and existing addresses (enumeration-safe), verification email with a fragment-token link, resend, `/auth/me` reporting `emailVerified` and `platformRoles` | None for this workstream |
| Organization creation | `POST /orgs` for verified emails on `ORGANIZATION_CREATOR_EMAILS` only (empty = nobody). One transaction: organization, system roles (owner, admin, member), owner membership, outbox events. `409 slug_taken` | **L1** allowlist-only, so production cannot self-serve. **L2** no creation rate limit (only the general 300/min) and no per-account cap. **L3** a retry after a lost response gets `409` for an organization the caller just created. **L4** names accept control and text-direction override characters; handles may be shaped like an id, while web addresses accept a handle or an id |
| Invitations | 256-bit random tokens, stored as SHA-256, fragment links, single use, expiry per organization (1–30 days, default 7), `409` for a pending duplicate or an existing member, resend rotates the token, idempotent revoke, acceptance only by the **verified** account with the invited address, the inviter's authority re-checked at acceptance, exactly-once under concurrency, only owners invite owners | **L5** delivery is invisible: an invitation looks the same whether its email was sent, failed, was dropped (queue full) or delivery is off, and the UI always says "Invitation sent". **L6** Resend is offered for expired invitations but refused (`409`) when the row was marked expired. **L7** the list's "All" filter shows only pending invitations (the empty filter falls back to the API default). **L8** accepted and revoked invitations are shown as "expired <date>" |
| Roles and permissions | Code-defined catalogue; owner `*`, admin all, member none; only owners grant or remove the owner role; last-owner protection | None |
| Email | Dev mailbox (in memory; `GET /dev/mailbox` on the internal port only, refused in production); SMTP via the kit's background mailer (3 attempts, backoff); `disabled`; logs carry kind and failure category only, never addresses, links or tokens | Covered by L5 |
| Frontend | Register, verify, sign-in; home empty state; create page; invitations page; accept page with an in-memory detour through sign-in or registration | **L9** copy says companies are created by authorized administrators only. **L10** no guidance after creating an organization (a new one has no workspace; channels need one) |
| Tests | Integration: organizations 11, invitations 14, platform-admin 6, smtp-invitations 5. Browser: invitations, organizations | No coverage of self-service, caps, repeats or delivery state |

### 2. Changes implemented

**Organization service:**
- **Creation mode (L1):**
  - `ORGANIZATION_CREATION`: `open` (any active account with a verified email) or `allowlist` (ADR 0010's rule).
  - Required in production; the default elsewhere stays `allowlist`.
  - In `open` mode, allowlisted addresses are exempt from the cap.
  - A platform Super Admin is refused in both modes (ADR 0015 decision 7 kept). Creating an organization grants its owner role and nothing else.
  - The policy is in `src/organizations/creation-policy.ts`.
- **Ownership cap (L2):** `ORGANIZATION_MAX_OWNED_PER_USER` (default 10) live organizations owned per person in `open` mode; the next gets `403 organization_limit_reached`.
- **Repeat-safe creation (L3):** the same request again (same handle and name, created and still owned by the caller) returns that organization with `200`. Any other use of a taken handle stays `409 slug_taken`.
- **Consistency under concurrency:**
  - One person's creations are serialized by a transaction-scoped advisory lock, the pattern the files and messaging caps already use.
  - The decision needs the caller's other organizations, which a tenant transaction cannot see. That is a deliberate earlier security fix (`20261102131200_scope_user_read_policies`), found by a probe during this work and **left unchanged**.
  - The creation therefore runs as one transaction in two phases. It first runs with the user context only (the user-scoped read policies, as `withUser`), then in the new organization's tenant context for the writes (as `withTenant`). The helper is `withUserThenNewTenant` in `src/database/client.ts`.
  - Organization, roles, owner membership and outbox events are still written together.
- **Input rules (L4):**
  - Names need a letter or digit, with no control or text-direction characters, on create and update.
  - Handles may not be shaped like an id.
  - Unknown body properties are refused as before, so no role or owner can be smuggled in.
- **Invitation delivery state (L5):**
  - Every invitation answer has `delivery`: `queued`, `sent`, `failed`, `disabled` or `unknown`.
  - SMTP reports each message's final outcome through the mailer's new `onSettled`; the dev mailbox counts as `sent`, the disabled notifier as `disabled`.
  - The state is in memory, bounded (10,000), per instance, and keyed to the invitation's current link: a late outcome for a link a resend replaced is ignored.
  - A failed invitation stays valid and is resent.
- **Invitation lifecycle (L6, L7):**
  - `status=all`.
  - `acceptedAt` in answers.
  - Resend also renews an invitation marked expired, unless a newer one for that address is pending (`409 invitation_pending`) or the person has joined meanwhile (`409 already_member`).

**Backend kit:** `BackgroundMailer.enqueue(kind, message, onSettled?)`.
- The optional callback is told `sent` or `failed` exactly once: after the last attempt, or at once when the queue is full.
- A throwing callback is ignored.
- The identity service's call is unchanged.

**API gateway:** `POST /orgs` gets its own limits, 10 per hour per person and 20 per hour per client address, and is documented in the gateway's OpenAPI. Every other route is unchanged.

**Unified backend:** `ORGANIZATION_CREATION` and `ORGANIZATION_MAX_OWNED_PER_USER` are passed to the organization application only, under their own names.

**Browser-test stack:** the organization service runs with `ORGANIZATION_CREATION=open`, as production is meant to. The founders stay allowlisted, which exempts them from the cap.

### 3. API changes (all additive except one new 200 case)

| Endpoint | Change |
|---|---|
| `GET /api/v1/orgs/creation-eligibility` | **New.** `→ { allowed, reason: null \| not_allowed \| email_not_verified \| limit_reached }` |
| `POST /api/v1/orgs` | Who may call it depends on `ORGANIZATION_CREATION`. New refusals: `403 email_not_verified` (previously `organization_creation_not_allowed` for an unverified allowlisted address) and `403 organization_limit_reached`. New `200` for a repeated request. Name and handle rules tightened. Gateway `429` limits |
| `GET /api/v1/orgs/{orgId}/invitations` | `status=all` accepted |
| `Invitation` (all invitation answers) | New fields `acceptedAt` and `delivery` |
| `POST /api/v1/orgs/{orgId}/invitations/{id}/resend` | Also renews invitations marked expired (`409 invitation_pending` / `409 already_member` when it cannot) |

Documented in `docs/api/endpoints.md`.

### 4. Frontend changes (existing design system and components; no unrelated screen changed)

| Screen | Change |
|---|---|
| Home, no organization | Asks the server first. If allowed: "Create your organization" with the create button. If unverified: "Verify your email to get started" with the resend button. If creation is the administrators' (`allowlist` mode): the invitation explanation, without a dead-end link. If the server cannot say: the link, and the server decides |
| Create organization | Explains that the creator becomes the owner and invites employees next. Shows why creation is not possible (unverified, not allowed, limit) with the button off. Continues to the overview |
| Organization overview | **Get started**, for people who can take the steps: "Invite your team" (done once anyone else has joined; one two-row request, made only for inviters) and "Create a workspace" (done once one exists). Gone when both are done; not shown, and nothing fetched for it, for members who can do neither |
| Invitations | "All" really lists all (L7). The status line says expires, expired, accepted on a date, or revoked (L8). Pending invitations show where the email stands ("Email sent", "Sending email…", "Email couldn't be sent", "Email not sent (delivery is off)"), and the list refreshes while an email is queued. The send and resend toasts never say "sent" for an email that was not. Resend works for expired invitations (L6) |
| Register | Copy: create your company's organization, or join through an invitation |
| Errors | Wording for `organization_limit_reached`, `invitation_not_pending`, `owner_required`, and an updated `organization_creation_not_allowed` |

### 5. Invitation lifecycle (as implemented now)

1. **Invite:** a holder of `members.invite` invites an address with a role.
   - Only owners can grant owner (`403 owner_required`).
   - An existing member gives `409 already_member`; a pending invitation for the address gives `409 invitation_pending`.
   - A 256-bit token is generated, only its SHA-256 is stored, and the expiry follows the organization's setting.
2. **Email:** sent after the commit, with the token only in the link's URL fragment. The answer says `delivery`; a failure is logged by kind and category only and never undoes the invitation.
3. **Preview:** `POST /invitations/preview` (public, rate-limited) shows the organization, role and a hint of the address.
4. **Accept:** requires a signed-in account whose email is **verified** and **equal to the invited address**.
   - Anyone else: `403 invitation_email_mismatch`. Unverified: `403 email_not_verified`. Unknown, expired, revoked or used token: `404 invitation_invalid`.
   - The inviter must still hold the authority to invite.
   - Exactly one request flips pending to accepted, and the membership with the invited role is created in the same transaction.
5. **Resend:** new token and expiry, and the old link dies. Works for pending and expired invitations; accepted or revoked ones give `409`.
6. **Revoke:** pending only; idempotent.
7. **Status:** pending, accepted (with `acceptedAt`), revoked, or expired (also lazily, once past expiry), listed by status or all.

### 6. Security verification

| Requirement | Verified by |
|---|---|
| Creator becomes owner; no platform role | `self-service.test.ts`: owner membership and the system roles; `/auth/me` `platformRoles: []`; `/admin/organizations` gives `403 platform_admin_required` |
| No duplicate or inconsistent creation | The same: 4 concurrent creates with a cap of 2 give exactly 2× `201` and 2× `403 organization_limit_reached`. A concurrent double submit gives `201` + `200` with one id and one organization. A retry gives `200` with the same id. A different name or another person with the same handle gives `409` |
| Unverified and Super Admin creators refused | The same, in both modes (`email_not_verified`; `organization_creation_not_allowed` for a seeded Super Admin even in `open` mode) |
| Role escalation | Unknown body fields (`role`, `platformRoles`, `createdByUserId`) refused with `422`. Only owners invite owners (an admin gets `403 owner_required`). A member cannot invite, change roles or remove the owner (`403`); owner-role and last-owner rules as before (`organizations.test.ts`) |
| Duplicate, expired, invalid, wrong-email and unverified invitations, revocation | `self-service.test.ts` and the existing `invitations.test.ts`: `409 invitation_pending` and `already_member`; an expired invitation shown as such, renewed only when allowed; an unknown token gives `404`; a different verified account gives `403 invitation_email_mismatch`; the invited but unverified account gives `403 email_not_verified` until verified; a spent token gives `404`; revoked stays revoked |
| Organization isolation | Unchanged RLS (no migration). The creation's two phases each see exactly what `withUser` and `withTenant` see. Existing isolation suites, and the browser suite in both topologies |
| Super Admin access | `platform-admin.test.ts` unchanged and passing |
| Tokens never in logs | The new suites check the capturing logger for the queued messages' tokens and the failed invitation's address; existing SMTP suites as before |
| DMs, groups and workspaces after joining | `e2e/onboarding.spec.ts`: a DM in both directions, live, and a workspace channel. Groups: the existing `e2e/conversations.spec.ts` |

### 7. Exact test results

All on 2026-11-04, on the final code, locally, against the disposable test database (`:15433`).

| Suite | Command | Result |
|---|---|---|
| CI gates | `make ci-local` | **Exit 0, first run.** Format, lint, Prisma, typecheck; unit 27; backend kit **133** (+2); API gateway **211** (+1); identity 39; organization **27** (+7); workspace 11; messaging 51; files 38; realtime 48; unified backend 39 (assertions extended); design tokens 11; UI 8; web **413** (+9). **1,056 tests**; build; audit (the same 11 moderate advisories, below the gate) |
| Database and integration | `make db-test` | **912/912** in 45 files: 899 existing + 13 in the new `self-service.test.ts` |
| Organization integration, during development | `vitest … integration/organization` | 55/55 (6 files) |
| Browser, seven processes (rollback topology) | `make e2e` | First run 54/55: `auth.spec.ts` expected the old landing heading (see below). After that expectation was updated, **55/55** |
| Browser, unified backend | `make e2e-unified` | First run 54/55 (the same `auth.spec.ts` expectation). Second run 54/55: `states.spec.ts` "a failing message history shows an inline error; Try again recovers" timed out (below). Then `states.spec.ts` ×3 gave 9/9, and the full suite **55/55** |
| New browser journey alone | `make e2e-unified ARGS=onboarding.spec.ts` | 1/1 (41 s). An earlier attempt failed in the **test**: it reloaded the page mid-journey, which drops the in-memory invitation token by design; the test now opens the verification email in a second tab, as a mail client does |
| 30 simultaneous users, realistic pace (the stack now runs `open`) | `make load-30 LOAD_THINK_MS=3000 E2E_REAUTHORIZE_INTERVAL_SECONDS=60` | **Passed**: 2,918 requests, 0 unexpected, 0 5xx; 2,358/2,358 deliveries; request p50 / p95 / p99 56 / 347 / 563 ms |

**About the two browser failures:**
- **`auth.spec.ts`:** caused by this workstream. After signing in, a newly verified person with no organization now sees "Create your organization" instead of "You're not part of a company yet", because the browser stack runs self-service. The expectation was changed to the new heading: the same check, not a weaker one.
- **`states.spec.ts`:** not caused by this workstream; it touches none of the changed code.
  - Its screenshot shows the history recovered by itself: a background refetch won the race between the test's visibility check and its click, the "Try again" button disappeared, and the click waited until the timeout.
  - The test's own comments describe this race class, and it passed 9/9 when repeated and in the final full run.
  - Recorded as an existing intermittent timing race; the test was not changed.

### 8. Remaining production email requirements

No real email was sent; delivery through a real provider is **not verified**. To send for real, both the identity service (verification, password reset) and the organization service (invitations) need:

| Variable | Value |
|---|---|
| `ACCOUNT_NOTIFIER` (identity), `INVITATION_NOTIFIER` (organization) | `smtp`. Required in production; `dev-mailbox` is refused there |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (`false` = STARTTLS) | The provider's server |
| `SMTP_USER`, `SMTP_PASSWORD` (or `SMTP_PASSWORD_FILE`) | Provider credentials: a secret, never in the repository |
| `SMTP_FROM`, optional `SMTP_REPLY_TO`, `SMTP_TIMEOUT_MS` | Sender identity |
| `WEB_APP_URL` | The public https address of the web app: email links are built from it |
| `ORGANIZATION_CREATION` | `open` for self-service. Required in production |

On the unified backend these go to identity and organization only (`smartconnect-backend/app/src/env.ts`); its `start` script also reads the gitignored `.secrets/smtp.env` and `.secrets/organization.env`. Verifying delivery needs the provider's credentials and the owner's authorization to send to an address they provide.

**Durable delivery state (optional, needs approval):** `delivery` is kept in memory per instance (`unknown` after a restart or on another instance). Keeping it durably needs columns on `organization.organization_invitations` (for example the last send time and the outcome). That is a schema change and was not made.

### 9. Remaining infrastructure dependencies

- **Email:** a transactional email provider, its credentials, and SPF/DKIM for the sending domain.
- **Phase 3 items from ADR 0016:** P1 object storage for files; P2 PostgreSQL bootstrap support (28 roles with connection limits, RLS, SECURITY DEFINER functions); P3 the migration runner; P4 origins and the refresh-cookie domain; `TRUST_PROXY_HOPS` on Render. All are unchanged by this workstream.
- **Gateway rate limits:** they share Redis across instances in unified mode; a single instance keeps them in memory otherwise.
- **Abuse controls beyond limits and caps** (CAPTCHA, disposable-address screening, review of new organizations): not implemented. A product decision if open sign-up is public.

### 10. Files

**New:**
- `smartconnect-backend/services/organization/src/organizations/creation-policy.ts`
- `docs/decisions/0017-self-service-organizations.md`
- `tests/integration/organization/self-service.test.ts` (13 tests)
- `tests/e2e/onboarding.spec.ts` (1 test)

**Modified:**
- organization service: `config.ts`, `database/client.ts`, `organizations/{organizations.service,organizations.controller,dto}.ts`, `invitations/{invitations.service,dto}.ts`, `notifications/invitation-notifier.ts`, `app.module.ts`, `main.ts`, `test/unit.test.ts`, `README.md`
- backend kit: `email/background-mailer.ts` and its test
- API gateway: `routes/tenant-routes.controller.ts`, `test/tenant-routes.test.ts`, `test/openapi.test.ts`
- unified backend: `src/env.ts`, `test/env.test.ts`, `test/backend-config.test.ts`, `README.md`
- web: `lib/api/{types,messages}.ts`, `lib/queries/orgs.ts`, `routes/{home-page,create-org-page}.tsx`, `routes/org/{overview-page,invitations-page}.tsx`, `routes/auth/register-page.tsx`, `routes/org/{org,directory}.test.tsx`
- tests: `tests/integration/organization/support/platform.ts`, `tests/e2e/support/stack.ts`, and `tests/e2e/auth.spec.ts` (its post-sign-in heading is now "Create your organization", since the stack runs self-service; same check)
- docs: `docs/api/endpoints.md`, `docs/decisions/README.md`, `docs/onboarding.md`

**Removed:** nothing. A temporary RLS probe test was written, used and deleted.

### 11. Confirmation

- **Database:** no migration, schema, role or RLS change; the RLS rule that a tenant transaction sees one organization is unchanged and relied on. No production data; only the disposable test database was used.
- **Configuration and infrastructure:** no `.env` file or secret was modified; no Docker rebuild; no deployment; no email sent outside the machine (dev mailboxes and capturing fakes only).
- **Version control:** no commit, push or destructive Git operation.
  - HEAD is still `964e89e`; no stash entries; nothing staged.
  - 53 modified tracked files: the 23 before this workstream, plus 30.
  - 32 untracked: the 28 before, plus 4 new.
  - All earlier work is preserved.
- **Architecture:** the seven-process rollback topology still works (55/55), the unified backend too (55/55). Phase 2 has not started.
- **Processes:** everything started for verification has stopped; ports 3000, 3101–3106, 3300–3309, 3320–3326 and 5174 are free, and the project owner's Vite on 5173 was not touched.
- **Workstream 1 is complete locally.** The next workstream has not been started.

## Addendum: Workstream 2: cloud file storage (Cloudflare R2) (2026-11-04)

**Outcome:** the files service can now keep file bytes in a **private Cloudflare R2 bucket** through R2's S3-compatible API.
- **Unchanged:** the Files API, authorization and organization isolation, the upload and download behaviour, the metadata and its PostgreSQL schema, and the unified backend. Local filesystem storage remains the default outside production and needs no credentials.
- **Tests:** verified against a fake private bucket that checks every signature. **No real R2 account, bucket or credentials** were created or used.
- **Decision record:** [ADR 0018](docs/decisions/0018-r2-file-storage.md), **Proposed**.

**Constraints held:**
- No schema, migration, role or RLS change.
- No new dependency.
- No `.env` or secret change, no Docker rebuild, no deployment, no commit.

### 1. What existed (Stage 1)

| Part | Found |
|---|---|
| Abstraction | `FileStorage` (`src/storage/file-storage.ts`) with `stage` (receive a stream under limits, hash it, not yet readable), `StagedObject.promote(key)` / `discard()`, `get`, `delete`, `sweepStaging`; one implementation, `LocalFileStorage`, under `FILES_STORAGE_DIR` (default `<repo>/.local/files`, **required in production**) |
| Upload | `POST …/files` declares a name and an exact size (25 MiB maximum, at most 20 pending per person). `PUT …/content` streams into `<dir>/.tmp`; the transfer is aborted the moment it exceeds the declaration. Content type from magic bytes, SHA-256 computed. A database claim (`pending_upload` to `available`, one winner), then `promote` renames into `<dir>/<org>/<file>/<version>`; on failure the file is retired |
| Download | `GET …/content`: the uploader, or anyone messaging says can see an attaching message; then the bytes are streamed with `nosniff`, a sandbox CSP, `private, no-store`, and inline only for four image types. The gateway streams it and forwards only a fixed list of response headers (no `Location`) |
| Delete | The row is marked deleted, then the objects are removed (a failure is logged) |
| Metadata | `files.files` and `files.file_versions` (`storage_key` "<org>/<file>/<version>", size, SHA-256) under RLS. No per-tenant or global usage counter exists, and RLS gives the service no cross-tenant view |
| Web app | `fetch(…/content)` with the bearer token, read as a blob; upload by XHR PUT with progress |

### 2. Architecture (Stages 2–4)

```
Browser ──bearer──▶ API gateway ──▶ files service ── authorization (membership, uploader / attachment check)
                                      │
                                      ├─ FileStorage  ◀── chosen by FILES_STORAGE_PROVIDER
                                      │    ├─ LocalFileStorage   <dir>/<org>/<file>/<version>        (default)
                                      │    └─ R2FileStorage      PUT/GET/HEAD/DELETE/ListObjectsV2, SigV4
                                      │                          https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
                                      └─ StorageBudget  (usage from the storage itself + in-flight reservations)
```

- **Interface** (`file-storage.ts`):
  - unchanged: `stage`, `get`, `delete`, `sweepStaging`;
  - new: `head` (existence and size), `usage` (stored bytes and objects), optional `signedReadUrl`;
  - `promote(key, { contentType })`;
  - one key validator (`assertStorageKey`) used by both drivers;
  - one error type for provider failures (`StorageUnavailableError` with a loggable category).
- **Staging** (`staging.ts`): the exact streaming, limit, sniffing and hashing code of the local driver, extracted unchanged, now shared by both drivers.
- **R2 driver** (`r2-file-storage.ts`):
  - `promote` PUTs the staged file with `Content-Length`, the detected `Content-Type` and `x-amz-content-sha256` set to its SHA-256 (R2 rejects a body that does not match), then deletes the staged copy;
  - `get` streams R2's response body to the client without buffering;
  - `delete` treats "already gone" as done;
  - `usage` pages through `ListObjectsV2`;
  - keep-alive connections are closed on shutdown.
- **SigV4** (`s3-signature.ts`): header signing and presigned URLs on `node:crypto` only.
- **Selection** (`app.module.ts` `createStorage`): from the configuration. The unified backend and the seven-process `main.ts` need no change; both build the app from the same configuration.
- **Service:**
  - **Declare:** budget check.
  - **Upload:** reserve the declared size → stage → claim → promote → commit the reservation. On any failure the reservation is released and the file retired.
  - **Download:** unchanged, with a storage failure mapped to 503.
  - **Delete:** credits the budget.
  - **New `downloadUrl`.**

### 3. Configuration (files service; passed by the unified backend to the files application only)

| Variable | Default | Meaning |
|---|---|---|
| `FILES_STORAGE_PROVIDER` | `local` outside production | `local` or `r2`. **Required in production** |
| `FILES_STORAGE_DIR` | `<repo>/.local/files` outside production | The local driver's directory; required in production with `local` |
| `FILES_R2_ENDPOINT` | none | `https://<account id>.r2.cloudflarestorage.com`. Production: an R2 host (`*.r2.cloudflarestorage.com`, including jurisdiction hosts), https, no path, query or credentials. Outside production also a loopback `http://` (local fakes) |
| `FILES_R2_BUCKET` | none | Private bucket, 3–63 lowercase letters, digits or hyphens |
| `FILES_R2_ACCESS_KEY_ID` | none | R2 API token's access key id |
| `FILES_R2_SECRET_ACCESS_KEY` / `_FILE` | none | **Secret.** Never in the repository, logs, errors or the web app; problems name the variable, never the value |
| `FILES_R2_REGION` | `auto` | R2 uses `auto` |
| `FILES_R2_TIMEOUT_MS` | 30000 | Per request (connection and idle socket) |
| `FILES_STAGING_DIR` | `<os tmpdir>/smartconnect-files-staging` | Where the R2 driver stages uploads |
| `FILES_STORAGE_BUDGET_BYTES` | 10000000000 | Application budget for all stored bytes |
| `FILES_STORAGE_USAGE_SCAN_SECONDS` | 900 | How often the stored total is re-counted (60–86400) |
| `FILES_SIGNED_URL_TTL_SECONDS` | 60 | Presigned link lifetime (10–600) |
| `FILES_MAX_BYTES` | 25 MiB | Unchanged per-file maximum |

### 4. Security controls (Stage 3)

| Requirement | How |
|---|---|
| Private bucket | Every request is signed with the service's key; the fake bucket, like R2, refuses anything unsigned (tested: a direct GET of a known key gives 403) |
| Credentials never reach the frontend | Only the files service holds them; the web app still talks only to `…/content`; the unified backend gives the R2 variables to the files application only (tested) |
| Authorization before download access | `…/content` and `…/download-url` run the same `readable()` check (uploader, or messaging-confirmed attachment viewer) before any byte or link. Others, other organizations and the same person on another organization's path get 404 (tested) |
| Short-lived signed URLs | Presigned GET, 60 s by default (600 s maximum), signed for one key plus the response type, disposition and `private, no-store`. Tampering with the key, a header or the expiry gives `SignatureDoesNotMatch`; an old link gives "Request has expired" (tested). The answer is `private, no-store` with `Referrer-Policy: no-referrer` |
| Cross-organization access | Keys start with the organization id; RLS and the membership guard are unchanged; cross-organization probes give 404 with R2 (tested) |
| Key validation, no traversal | `assertStorageKey` accepts only `<uuid>/<uuid>/<1-999999999>`, checked before any filesystem path or request is built (tested with `..`, version 0, extra segments, upper case, empty) |
| Size and type rules | Unchanged: declared size ≤ 25 MiB (422), content larger than declared is aborted (413) **before anything is sent to R2** (tested: no PUT), type from magic bytes |
| No secrets or signed URLs in logs | Errors carry the operation, status and S3 error code only; the service logs a category and a file id. Tests scan the logs for the secret, `X-Amz-Signature` and `Credential=` |
| Guessable keys cannot bypass authorization | Keys are not secrets: without the service's credentials or a link it signed, R2 refuses (tested) |
| No silent provider switch | One driver per configuration; no fallback; the production endpoint must be an R2 host over https (tested: AWS, look-alike and http endpoints refused) |

### 5. Free-tier safeguards (Stage 5)

- **Budget:** `FILES_STORAGE_BUDGET_BYTES`, default **10,000,000,000 bytes**, the smaller reading of R2's "10 GB" (if R2 counts GiB, this leaves 0.74 GB of headroom).
  - A declaration (`POST`) and an upload (`PUT`) that would pass it get **`507 storage_quota_exceeded`**. Uploads in flight are reserved, so parallel uploads cannot pass it together within one instance.
  - The total comes from the storage itself: R2 `ListObjectsV2` (what R2 stores and bills), at startup and every 15 minutes, plus this process's uploads and deletions between scans.
  - It errs on the safe side: uploads during a scan are counted on top of it, deletions during a scan are subtracted at the next one, and **while the total is unknown (for example refused credentials) every upload is refused with 503**, never let through.
- **Per-file limit:** 25 MiB, unchanged.
- **Duplicate uploads:**
  - A file's content is accepted once (`409 already_uploaded`), and each version is written to R2 exactly once, after the database claim (tested: one PUT per file).
  - Identical content uploaded as separate files is stored separately: deduplicating by content would need reference counting.
- **Provider errors:**
  - Network errors, timeouts, 429 and 5xx are retried twice (200 ms, then 800 ms), then answered `503 storage_unavailable` with `Retry-After: 30`.
  - Refused credentials are logged by category.
  - A failed upload is retired; a failed delete leaves the object (logged, still counted).
- **Not a billing cap:** the budget is an application guard. It is **not** a provider-side spending limit: other writers to the bucket, R2's own accounting, and operation charges (Class A and B) are outside it.
- **Accurate cross-instance enforcement needs approval:**
  - With one instance (the unified backend), the budget is exact between scans. With several instances, each knows only its own uploads until the next scan.
  - Exact enforcement needs a database total across organizations, which RLS does not give the service today. That would be a narrow SECURITY DEFINER function `files.storage_usage_bytes()` returning the sum of `size_bytes` over non-deleted versions (or a counter table maintained in the upload and delete transactions), checked under an advisory lock.
  - **That is a migration: not made, approval requested.**
- **A per-organization quota** is possible today without database changes (a sum under that organization's RLS context), but was not built: it is a product decision (the size per organization).

### 6. Files changed

**New:**
- `smartconnect-backend/services/files/src/storage/`: `r2-file-storage.ts`, `s3-signature.ts`, `staging.ts`, `storage-budget.ts`
- `smartconnect-backend/services/files/test/`: `s3-signature.test.ts` (7), `r2-file-storage.test.ts` (10), `storage-budget.test.ts` (4), `fake-r2.ts` (test-only fake bucket)
- `tests/integration/files/r2-storage.test.ts` (8)
- `docs/decisions/0018-r2-file-storage.md`

**Modified:**
- files service:
  - `src/storage/file-storage.ts` (interface, key validator, error type)
  - `src/storage/local-file-storage.ts` (shared staging; `head`, `usage`)
  - `src/config.ts`
  - `src/app.module.ts` (driver selection, budget, shutdown)
  - `src/files/files.service.ts` (budget, 503 mapping, `downloadUrl`)
  - `src/files/files.controller.ts` (`GET …/download-url`; shared header helpers)
  - `src/files/dto.ts`
  - `src/main.ts` (startup log names the provider)
  - `test/config.test.ts` (+6; the production requirements now include the provider)
  - `test/local-file-storage.test.ts` (+1)
  - `README.md`
- unified backend: `src/env.ts` (the R2 variables go to files only), `test/env.test.ts` (+1)
- web: `lib/api/messages.ts` (wording for `storage_quota_exceeded` and `storage_unavailable`)
- docs: `docs/api/endpoints.md`, `docs/decisions/README.md`

**Not changed:**
- the API gateway: `…/download-url` is JSON through the existing files route and its limits;
- the frontend's upload and download code; the database; the e2e stack (local driver).

### 7. Tests

All on 2026-11-04, on the final code, locally. The integration and browser suites ran against the disposable test database; R2 always meant the fake bucket on 127.0.0.1.

**New tests (Stage 6), 36 in all:**

| Required test | Where |
|---|---|
| Upload | `r2-file-storage.test.ts` (PUT with SHA-256, staged copy removed); `r2-storage.test.ts` (through the API: org-scoped key, detected type recorded) |
| Download authorization | `r2-storage.test.ts`: uploader yes; another member no until messaging confirms an attachment; another organization no; signed link only after the same check |
| Delete | Driver (delete, delete twice) and API (object gone, file 404) |
| Missing object | Driver (`StorageNotFoundError`, `head` undefined) and API (lost at the provider gives 404 and a logged `file_object_missing`) |
| Invalid credentials | Driver (wrong secret gives `SignatureDoesNotMatch`, wrong key id gives `InvalidAccessKeyId`: category `credentials`, the secret never in the message) and API (startup scan fails by category; every declaration refused with 503; the secret never in the logs; nothing stored) |
| Provider outage | Driver (2 transient 503s then success = 3 PUTs; outage gives `provider_error`; reset gives `unreachable`; hang gives `timeout`) and API (upload 503 with `Retry-After`, file retired; download 503; recovery) |
| Expired signed URLs | Driver and API: a link past its lifetime gives 403 "Request has expired" |
| Tampered signed URLs | Another key, another content type or a longer expiry gives `SignatureDoesNotMatch` |
| Cross-organization access | API: 404 for another organization's member, on either path |
| Invalid object keys | Driver: traversal, version 0, extra segment, upper case, empty: refused before any request |
| File size limits | API: 25 MiB + 1 gives 422; more than declared gives 413 **with no PUT to the bucket**; a second upload gives 409 with exactly one PUT |
| Storage quota | `storage-budget.test.ts` (507, reservations, commit and release once, removals, safe side during a scan, 503 while unknown, recovery) and API (pre-existing bucket bytes counted at startup; 507 at declaration and at upload; space freed by deletion) |
| Signer correctness | `s3-signature.test.ts`: the AWS SigV4 test suite's get-vanilla, the S3 header-signed GET, PUT, lifecycle and list examples, and the S3 presigned-URL example, all matching the published signatures |
| Configuration | `config.test.ts` (+6: defaults; R2 settings and secret; missing settings named without values; only R2 endpoints in production; loopback fakes outside production only; bounds); unified backend `env.test.ts` (+1: R2 credentials reach the files application only) |

**Suites:**

| Suite | Command | Result |
|---|---|---|
| Files unit tests | `npm run test --workspace @smartconnect/files-service` | **66/66** (38 before + 28) |
| Files integration | `vitest … integration/files` | **45/45** (37 before + 8) |
| Database and integration | `make db-test` | **920/920** in 46 files (912 + 8) |
| CI gates | `make ci-local` | No single uninterrupted run (below). Every gate passed on the final code: format, lint, Prisma, typecheck; unit 27, backend kit 133, API gateway 211, identity 39, organization 27, workspace 11, messaging 51, files **66**, realtime 48, unified backend **40**, design tokens 11, UI 8, web 413 (**1,085 tests**); build; audit (the same 11 moderate advisories, below the gate) |
| Browser, seven processes | `make e2e` | **55/55** (local driver, unchanged behaviour) |
| Browser, unified backend | `make e2e-unified` | **55/55** |
| 30 simultaneous users, realistic pace | `make load-30 LOAD_THINK_MS=3000 E2E_REAUTHORIZE_INTERVAL_SECONDS=60` | **Passed**: 2,920 requests, 0 unexpected, 0 5xx, 2,357/2,357 deliveries, 25 file checksums; request p50 / p95 / p99 68 / 363 / 576 ms |

**`ci-local` in detail:**
- **First run:** stopped at the API gateway (210/211). "rate-limits activity and its unread count (one budget) per user" expected the 130th request to be refused and it was allowed.
  - The limiter is a token bucket refilling at 2 tokens per second; when the run's timing puts the first refill exactly on the last request, that request is allowed.
  - This workstream does not touch the gateway. The file passed 34/34 six times in a row afterwards and 211/211 in the second run.
  - A deterministic fix would give the test's store a fixed clock (the store already accepts one). Not changed here: outside this workstream.
- **Second run:** every gate up to and including the unified backend passed. The web suite failed 1 of 413 ("loads older messages through nextCursor…"), one of the load-sensitive web tests already recorded (MVP addendum, F2), with the machine's **load average at 113** from unrelated processes.
- **Then:** once the load fell below 10, `make test-frontend build audit` passed (11 + 8 + **413**, build, audit). The web app's only change in this workstream is two error messages.

### 8. Remaining limitations

- **Not tried against a real R2 bucket.** The fake implements the S3 subset used, verifies signatures with the signer that matches AWS's published examples, and enforces presigned expiry. To check on the first real connection (step 7 below):
  - R2's acceptance of the presigned response-header overrides;
  - R2's `ListObjectsV2` paging;
  - R2's error codes.
- **Budget:** exact for one instance between scans; several instances need the approved database total (§5).
- **Deletion failures:** objects whose deletion failed during an outage stay in the bucket, are logged (`file_object_delete_failed`) and keep counting; there is no automatic clean-up or orphan sweep (an orphan sweep comparing the listing with the database would need a cross-tenant database view, so approval).
- **Signed links:** not used by the web app. Using them from the browser needs bucket CORS for the web origin, and the app would read a cross-origin body.
- **Staging:** needs local temporary disk: 25 MiB per upload in flight, at most 3 per person per instance. Ephemeral disk on Render is enough.
- **Downloads:** they pass through the backend, which uses its bandwidth (R2 egress itself is free).
- **No malware scanning** (unchanged).

### 9. Connecting a real R2 bucket (exact steps; none done here)

1. **Create the bucket.**
   - In the Cloudflare dashboard: R2 → Create bucket, for example `smartconnect-files`, with automatic location (or a jurisdiction if required).
   - Leave **public access off**: no `r2.dev` subdomain, no custom domain.
2. **Create an R2 API token.**
   - In R2 → Manage R2 API tokens → Create API token: **Object Read & Write**, applied to **that bucket only**, with an expiry if the organization's policy wants one.
   - Copy the **Access Key ID** and **Secret Access Key**; the secret is shown once. Note the **S3 endpoint**, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (`.eu.` in it for an EU-jurisdiction bucket).
3. **Store the secret.** Put it in the deployment's secret store (a Render secret environment variable or secret file), never in the repository, `.env` files or chat.
4. **Configure the backend:**
   - `FILES_STORAGE_PROVIDER=r2`
   - `FILES_R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `FILES_R2_BUCKET=smartconnect-files`
   - `FILES_R2_ACCESS_KEY_ID=<access key id>`
   - `FILES_R2_SECRET_ACCESS_KEY=<secret>` (or `FILES_R2_SECRET_ACCESS_KEY_FILE`)
   - Recommended: `FILES_STORAGE_BUDGET_BYTES=9000000000` for headroom below the free 10 GB.
5. **Start and check the log.**
   - `storage_usage` with `provider: "r2"`, `objects` and `usedBytes` means the credentials and bucket work.
   - `storage_usage_scan_failed` with `category: "credentials"` means a wrong token, secret or bucket; uploads are then refused with 503 until it is fixed.
6. **Smoke test in the app:** upload a file, open it, delete it. In the R2 dashboard, the object appears as `<org id>/<file id>/1` and disappears after the delete.
7. **First-connection checks:**
   - `GET …/files/{id}/download-url` gives a link that downloads the file with its name;
   - the same link fails after 60 s;
   - an unsigned `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/smartconnect-files/<key>` gives 403.
8. **Billing safeguards at Cloudflare.** R2 has no built-in spending cap; set billing notifications in the Cloudflare account. The application budget does not replace them.
9. **Optional, later:** a CORS rule for the web origin, only if the web app is changed to use signed links directly.
10. **Rollback:** `FILES_STORAGE_PROVIDER=local` with a `FILES_STORAGE_DIR` restores local storage. Files stored in R2 are then not readable until switched back; nothing migrates objects automatically.

### 10. Confirmation

- **No real R2 account, bucket or credentials:** nothing was created, bought or connected. Every R2 request went to the fake bucket on 127.0.0.1, with test-only credentials that exist only in the test file.
- **Database:** no migration, schema, role or RLS change. Only the disposable test database was used.
- **Configuration and infrastructure:** no `.env` file or secret was modified; no Docker rebuild; no deployment.
- **Dependencies:** none added; SigV4 is built on `node:crypto`.
- **Local storage:** the local driver stays the default outside production. Its behaviour is unchanged (its existing tests pass unchanged), and local development and every test suite run without credentials.
- **Version control:** no commit, push or destructive Git operation.
  - HEAD is still `964e89e`; no stash entries; nothing staged.
  - 64 modified tracked files: the 53 before this workstream, plus 11.
  - 42 untracked: the 32 before, plus 10 new.
  - All earlier work is preserved.
- **Processes:** everything started for verification has stopped; ports 3000, 3101–3106, 3300–3309, 3320–3326 and 5174 are free, and the project owner's Vite on 5173 was not touched.
- **Workstream 2 is complete locally. Stopping for review;** the next workstream has not been started.
