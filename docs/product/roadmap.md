# SmartConnect delivery roadmap

Source of truth for *what is built when*. The product scope is the blueprint. Architecture: [../architecture/README.md](../architecture/README.md). Gap IDs (G-xx) refer to [blueprint-mapping.md](../architecture/blueprint-mapping.md). Acceptance scenarios (S1–S12) refer to [testing-strategy.md](../devops/testing-strategy.md#critical-acceptance-scenarios-blueprint-9).

Every phase ends only when its exit criteria pass **in CI** (blueprint §11). Planning targets are not verified capacity (§10).

## Status

| Phase | State |
|---|---|
| Foundation (database, monorepo, CI, team workflow) | **Done**: verified locally. Not yet pushed: repository linking pending |
| 0: Engineering readiness | **Done, pending approvals** (this document set) |
| 1: Platform foundation | **In progress**: Task 1 (web frontend foundation) done, see below |
| 2–7 | Not started |

## Phase 0: Engineering readiness

| Item | Deliverable | State |
|---|---|---|
| Preserve database foundation | No schema or migration changes; all 14 services mapped | Done ([blueprint-mapping.md](../architecture/blueprint-mapping.md)) |
| Finalise frontend framework | [ADR 0003](../decisions/0003-web-frontend-stack.md) | Accepted; router choice and GSAP licence open |
| Confirm service boundaries | No new data-owning service; `realtime-gateway` added as a stateless edge ([ADR 0004](../decisions/0004-realtime-gateway.md)) | Proposed |
| API conventions | [api/conventions.md](../api/conventions.md) | Proposed |
| Real-time event conventions | [architecture/realtime.md](../architecture/realtime.md) | Proposed |
| Design system | [architecture/design-system.md](../architecture/design-system.md) | Foundations done; brand identity open |
| Local development and testing workflows | Existing Make/Compose/CI workflows; [testing-strategy.md](../devops/testing-strategy.md) | Done; new services (storage, LiveKit, broker) added in the phase that needs them |
| Infrastructure decisions | Broker [0002](../decisions/0002-event-broker-nats-jetstream.md), meetings [0005](../decisions/0005-meetings-livekit.md), storage [0006](../decisions/0006-object-storage-and-file-security.md), queues [0007](../decisions/0007-job-queues-bullmq.md) | Proposed |

## Phase 1: Platform foundation

- **Scope:** web app shell, API gateway, authentication (registration, login/logout, email verification, password recovery, sessions, devices), organizations, workspaces, profiles and avatars, membership, roles and permissions, guests, departments and teams.
- **Schema:** G-01 departments/teams, G-02 guests, G-03 join requests, G-04 workspace settings, G-05 permission catalogue, G-06 busy status.
- **New components:**
  - `smartconnect-frontend/web` (Vite app with the design-system packages);
  - `api-gateway`, plus NestJS apps for identity, organization and workspace;
  - `packages/api-contracts`;
  - an `e2e.yml` workflow.
- **Task 1, web frontend foundation (done 2026-11-02):** Vite + React + TS app, TanStack Router (decided), design-token package with WCAG contrast tests, shadcn/ui-convention primitives, light/dark/system theme, responsive accessible shell with honest placeholders, loading/empty/error states, 49 frontend tests (11 token, 6 UI primitive, 32 web). See [web README](../../smartconnect-frontend/web/README.md).
- **Task 2, API gateway foundation (done 2026-11-03):** stateless NestJS gateway with no data access, request ids, JSON logs, RFC 9457 errors, global DTO validation, JSON-only bodies, env-based CORS, helmet, liveness/readiness, OpenAPI 3.1 + Swagger UI; 92 gateway tests. Decisions: [ADR 0008](../decisions/0008-api-gateway-foundation.md) (Proposed). See [gateway README](../../smartconnect-backend/api-gateway/README.md).
- **Task 3, identity and authentication foundation (done 2026-11-03):** identity service (NestJS on the existing `identity` schema, no migration).
  - **Accounts:** registration, login, Ed25519 access tokens, refresh-token rotation with reuse detection, logout and logout-all, session listing and revocation, password reset and change.
  - **Gateway:** deny-by-default authentication, Redis token-bucket rate limiting, CSRF Origin check, routing to identity.
  - **Shared code:** the `@smartconnect/backend-kit` package.
  - **Tests:** unit (16 kit, 139 gateway, 25 identity) plus 73 database-backed integration tests.
  - **Not built:** email delivery (no approved provider), email verification, MFA.
  - Decisions: [ADR 0009](../decisions/0009-identity-and-authentication.md) (Proposed).
- **Exit criteria:**
  - Auth flows pass E2E.
  - Permission matrix tests cover owner / admin / member / guest / non-member / other tenant.
  - S2 for organization and workspace resources.
  - Contract tests green.
  - OWASP ZAP baseline clean of high findings.

## Phase 2: Communication core

- **Scope:** public/private channels, DMs and group DMs, threads, reactions, mentions, history, pins, forwarding, drafts, scheduled messages, link previews, real-time delivery, typing, read state, unread counts.
- **Schema:** G-10 sequences (first), G-11, G-12, G-13, G-14, G-15, G-16, G-17. G-19 (delivery states, typing, presence) needs no schema, only the realtime-gateway behaviour in [realtime.md](../architecture/realtime.md).
- **New components:** `realtime-gateway`; outbox relay and consumer library (`packages/`); the broker, if ADR 0002 is approved after its spike.
- **Exit criteria:**
  - Acceptance scenarios: S1 (private channel access), S3 (cross-device persistence and sync), S4 (no duplicates on reconnect).
  - Socket load test meets its target or the gap is recorded.
  - Failure-recovery tests for relay, consumer and gateway restarts.

## Phase 3: Files, notifications, presence, search

- **Scope:** uploads and downloads, previews, storage quotas, scanning, file permissions, in-app / email / push / desktop notifications and preferences, presence, global search with filters.
- **Schema:** G-24 (previews), G-25, G-26 (if approved), G-28.
- **New components:** local S3 store (ADR 0006), ClamAV, media worker (+ queue Redis per ADR 0007), notification delivery workers, search indexer.
- **Exit criteria:**
  - Acceptance scenarios: S5 and S6 (file permissions after sharing, protected downloads), S11 (notification preferences), S12 (search permissions).
  - Upload/download throughput measured.

## Phase 4: Meetings

- **Scope:** 1:1 audio/video calls with ringing and missed calls, group meetings, scheduling and invitations, screen sharing, meeting chat, host and moderator controls, raise hand and reactions, reconnection, recording with consent.
- **Schema:** G-18 meeting conversations, G-21 calls, G-22 settings, G-23 consent.
- **New components:** LiveKit (dev server locally; Cloud for the pilot, per ADR 0005), Egress for recordings.
- **Exit criteria:**
  - Acceptance scenarios: S7 (1:1 calls), S8 (group meetings), S9 (screen sharing on Chromium, Firefox and WebKit, plus the manual OS matrix), S10 (network-interruption recovery).
  - Meeting capacity benchmarked separately from messaging.

## Phase 5: Advanced collaboration

- **Scope:** clips and captions, documents (permissions, templates, versions; collaborative editing as its own milestone), task lists (custom fields, views), workflows (approvals, scheduler), integrations (app directory, bots, incoming/outgoing webhooks), advanced administration (data export, access reviews), OAuth/SSO.
- **Schema:** G-07, G-08, G-24 (captions), G-27, G-29, G-30, G-31, G-32, G-33.
- **Exit criteria:** per-module permission, negative and E2E suites green; webhook SSRF tests.

## Phase 6: Mobile

- **Scope:** React Native + Expo app with authentication, messaging, channels, files, meetings, screen sharing where the platform allows, and push notifications.
- **Preconditions:** stable `packages/api-contracts` (no breaking change for one release); design tokens shared.
- **Exit criteria:** agreed parity matrix (to be defined at phase start) passing on iOS and Android simulators; push delivery verified on devices.

## Phase 7: Production readiness

- **Scope:** full E2E regression, security testing (OWASP ASVS L2 checklist, penetration test), load tests at target with headroom, failure-recovery drills, performance optimisation, backup/restore drill on production-like infrastructure (PITR), observability (metrics, logs, traces, alerts), deployment pipelines, and incident runbooks.
- **Exit criteria:** blueprint §12 definition of complete.

## Approvals needed before Phase 1 starts

| # | Decision | Record |
|---|---|---|
| 1 | Link the existing GitHub repository (URL + `gh auth login`) | [github-repository-setup.md](../devops/github-repository-setup.md) |
| 2 | API conventions | [api/conventions.md](../api/conventions.md) |
| 3 | Router: TanStack Router (recommended) vs React Router; GSAP licence sign-off | [ADR 0003](../decisions/0003-web-frontend-stack.md) |
| 4 | Real-time gateway as a separate deployable | [ADR 0004](../decisions/0004-realtime-gateway.md) |
| 5 | Brand identity inputs (palette, typeface) | [design-system.md](../architecture/design-system.md#open-decisions) |

Needed before later phases:
- **Before Phase 2:** NATS spike + ADR 0002.
- **Before Phase 3:** SeaweedFS instead of MinIO (ADR 0006); external share links (G-26); BullMQ queue Redis (ADR 0007).
- **Before Phase 4:** LiveKit Cloud budget and data residency (ADR 0005).
- **Any time:** message edit history (G-20); hosting provider and recovery objectives.
