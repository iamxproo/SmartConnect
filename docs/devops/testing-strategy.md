# Testing strategy

Blueprint §9 requires unit, integration, API, end-to-end, permission, negative, failure-recovery and (where relevant) performance tests for every module. This document defines what each level means here, which tools are used and where the tests live.

| Level | What it proves | Tooling | Location | Runs in |
|---|---|---|---|---|
| **Unit** | Pure logic and module contracts without I/O | Vitest | `tests/unit/<area>/`; frontend: next to components | `ci.yml` (*Backend*, *Frontend*) |
| **Integration** | A service against real PostgreSQL / Redis / object store / broker | Vitest + the disposable Compose test stack | `tests/integration/<service>/` | `database.yml` (DB); extended per phase |
| **API** | HTTP behaviour of a running NestJS service: status codes, validation, error format, pagination, idempotency ([conventions](../api/conventions.md)) | Vitest + Supertest against the Nest app with a test database | `tests/integration/<service>/api/` | per phase |
| **Contract** | Generated OpenAPI matches the committed contract; web and mobile clients compile against it | OpenAPI diff + `tsc` | `packages/api-contracts` | `ci.yml` |
| **Permission** | Role × resource × action matrices, including guests and cross-tenant attempts. Every *deny* is asserted, not only every *allow* | Vitest, table-driven | `tests/security/<area>/` | `ci.yml` / `database.yml` |
| **Negative** | Invalid input, oversized payloads, replayed requests, expired tokens, revoked sessions | within API and permission suites | — | — |
| **End-to-end (web)** | User journeys through the browser against a full local stack | Playwright (multi-browser; fake media devices for calls) | `tests/e2e/web/` | `e2e.yml` (to be added in Phase 1) |
| **End-to-end (mobile)** | Core journeys on simulators | Decided at Phase 6 (Maestro or Detox) | `tests/e2e/mobile/` | Phase 6 |
| **Failure recovery** | Broker, relay, consumer, gateway and database interruptions; network partitions for real-time and meetings | Toxiproxy between services and dependencies; container kill/restart in the test stack | `tests/integration/resilience/` | nightly |
| **Load / performance** | Capacity targets in blueprint §10 | Artillery (HTTP + Socket.IO engine), LiveKit CLI load tester for meetings, PostgreSQL `pg_stat_statements` | `tests/load/` | on demand + before releases |
| **Security** | Dependencies, secrets, OWASP baseline | `npm audit` + signatures (exists), Dependabot (exists), OWASP ZAP baseline scan against the local stack (Phase 1+) | `.github/workflows/security.yml` | `security.yml` |

Already in place: 14 unit tests, 393 database integration/security tests ([ci.md](ci.md)).

## Rules

1. **A feature is complete only when its tests exist and pass in CI** (blueprint §11). PRs without tests for new behaviour are not approved ([CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done)).
2. Every authorization rule gets a **negative test** proving the denial (including a different tenant and a guest).
3. Tests create their own data (random tenants and users); no test depends on seed data or on another test's state.
4. Integration tests never touch the dev database. They use the disposable test stack.
5. Flaky tests are fixed or quarantined within one working day. Quarantine is tracked as an issue, never silently retried.

## Critical acceptance scenarios (blueprint §9)

Each scenario becomes an automated test in its phase. Status today: **none implemented** (the features do not exist yet). The database-level foundations some of them rely on are already tested.

| # | Scenario | Test levels | Phase | Existing foundation |
|---|---|---|---|---|
| 1 | Cannot read a private channel without membership | Permission (API) + E2E | 2 | Tenant RLS tested; channel membership check is service-level (to build) |
| 2 | Guest cannot access unrelated organization resources | Permission + E2E | 1–2 | Cross-tenant RLS tests (393-test suite) |
| 3 | Messages persist and sync across devices | Integration + E2E (two browser contexts) | 2 | — |
| 4 | Reconnecting does not create duplicates | Integration + failure-recovery (socket drop mid-send) | 2 | Idempotency key `(conversation, sender, client_message_id)` exists |
| 5 | File permissions stay enforced after sharing | Permission + E2E | 3 | — |
| 6 | Unauthorised users cannot download protected files | Permission (presigned URL issuance + expiry) | 3 | — |
| 7 | 1:1 audio and video calls work | E2E (Playwright fake media) + LiveKit integration | 4 | — |
| 8 | Group meetings support multiple participants | E2E + load (LiveKit CLI) | 4 | — |
| 9 | Screen sharing works on supported browsers/OS | E2E (Chromium, Firefox, WebKit) + manual matrix | 4 | — |
| 10 | Meetings recover from network interruption | Failure recovery (Toxiproxy / network emulation) | 4 | — |
| 11 | Notifications respect preferences | Integration + permission | 3 | `notification_preferences` schema |
| 12 | Search respects resource permissions | Permission (search with scope filtering) | 3 | `access_scope_ids` + tenant RLS |

## Capacity tests (blueprint §10): targets are hypotheses until measured

| Measurement | Method | Initial target (to verify) |
|---|---|---|
| Concurrent WebSocket connections | Artillery Socket.IO engine | 1,500 sustained, 3,000 headroom |
| Message throughput and delivery latency | Artillery send + receive timestamps | p95 commit-to-delivery < 300 ms |
| Database query performance | `pg_stat_statements` under load | p95 < 50 ms for hot queries |
| File upload/download throughput | Presigned transfers against the object store | Network-bound; no API bottleneck |
| Meeting capacity | LiveKit load tester, measured **separately** from messaging | 30 rooms × typical size; CPU, memory and network recorded |
