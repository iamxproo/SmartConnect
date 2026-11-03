# Architecture decision records

Significant, hard-to-reverse decisions, one file each: `NNNN-short-title.md`, numbered in order. Records are immutable once **Accepted**; change a decision by adding a new record that supersedes the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-npm-workspaces.md) | Monorepo with a single npm workspace root | Accepted (2026-11-02) |
| [0002](0002-event-broker-nats-jetstream.md) | NATS JetStream as the event broker behind the transactional outbox | **Proposed**: spike required (blueprint §4) |
| [0003](0003-web-frontend-stack.md) | Web frontend stack (React, Vite, Tailwind, shadcn/ui, TanStack Query, Zustand, Motion) | Accepted; router: TanStack Router (decided 2026-11-02); GSAP licence open |
| [0004](0004-realtime-gateway.md) | Dedicated stateless real-time gateway (Socket.IO) | **Proposed**; the separate deployable is superseded by [0016](0016-unified-backend.md) |
| [0005](0005-meetings-livekit.md) | Meetings on LiveKit: cloud vs self-hosted | **Proposed**: budget and residency needed |
| [0006](0006-object-storage-and-file-security.md) | Object storage (R2; SeaweedFS locally instead of the archived MinIO) and file security | **Proposed** |
| [0007](0007-job-queues-bullmq.md) | Background jobs: BullMQ on a dedicated `noeviction` Redis | **Proposed** |
| [0008](0008-api-gateway-foundation.md) | API gateway foundation: HTTP pipeline, errors, request ids, CORS, health, OpenAPI | **Proposed**: implemented in Phase 1 Task 2; the separate process is superseded, and the listener, health and OpenAPI are amended, by [0016](0016-unified-backend.md) |
| [0009](0009-identity-and-authentication.md) | Identity and authentication: Ed25519 access tokens, refresh rotation and reuse detection, Argon2id, enumeration-safe flows, gateway auth and rate limiting | **Proposed**: implemented in Phase 1 Task 3 |
| [0010](0010-organizations-and-membership.md) | Organizations, membership, invitations, departments/teams, workspaces/channels; per-request cross-service authorization with the caller's token | **Proposed**: implemented in the night sprint; decisions 3, 4, 6 and 10 amended by [0016](0016-unified-backend.md) (transport only, same rules); decision 1 (organization creation) amended by [0017](0017-self-service-organizations.md) |
| [0011](0011-direct-and-group-conversations.md) | Direct and group conversations: participants-only access, admin-managed groups, history from join, per-organization inbox rooms for realtime | **Proposed**: implemented in Sprint 2 |
| [0012](0012-transactional-email-resend.md) | Transactional email through Resend: one fetch-based transport in the backend kit, per-service notifier adapters, least-privilege keys, tracking off, non-blocking dispatch; durable outbox deferred to ADR 0007 | **Proposed**: transport implemented, no service uses it yet |
| [0013](0013-collaboration-platform-expansion.md) | Platform expansion: threads, reactions, mentions, saved messages; a files service with a local storage driver and a streaming gateway path; federated search; activity derived in messaging; meetings, webhooks and the notifications service blocked on decisions | **Proposed**: implemented in waves |
| [0014](0014-email-gmail-smtp.md) | Transactional email through Gmail SMTP with Nodemailer: STARTTLS, App Password entered by hidden prompt into gitignored `.secrets/smtp.env`, non-blocking dispatch, safe error classification; keeps ADR 0012's architecture | **Proposed** |
| [0015](0015-platform-administration.md) | Platform administration: a `super_admin` platform role separate from organization roles, looked up per request; `/admin/login` on the ordinary login; issued passwords must be replaced; read-only admin APIs guarded in each service; a development-only seed with a hidden password prompt | **Proposed** |
| [0016](0016-unified-backend.md) | Unified backend: one modular NestJS application and one Render Web Service, migrated in stages (one process hosting the existing apps, then internal modules one at a time, then cut-over). Schemas, roles and RLS unchanged; guards scoped per module; Redis pub/sub and Socket.IO behaviour kept; object storage for production files | **Accepted** (2026-11-03); five decisions pending; Phase 1 built and verified locally (2026-11-04), not deployed |
| [0017](0017-self-service-organizations.md) | Self-service organization creation (`ORGANIZATION_CREATION=open\|allowlist`, required in production), a per-person ownership cap and creation rate limits, repeat-safe creation, name and handle rules; Super Admins still create none; invitation email delivery visible to inviters | **Proposed**: implemented and verified locally (2026-11-04), not deployed |
| [0018](0018-r2-file-storage.md) | Cloudflare R2 storage driver for files behind the existing `FileStorage` interface (SigV4 in-house, no SDK; private bucket; uploads staged and sent with their SHA-256; downloads unchanged plus opt-in presigned links); an application storage budget (default 10 GB) counted from the storage itself; provider required in production | **Proposed**: implemented and verified locally against a fake bucket (2026-11-04), not deployed |

Decisions recorded elsewhere before this log existed:
- Database topology, roles, Prisma per service: [../database/architecture.md](../database/architecture.md)
- Tenant isolation with RLS: [../database/tenant-isolation.md](../database/tenant-isolation.md)

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
- Deciders: names

## Context
## Decision
## Consequences
## Alternatives considered
```
