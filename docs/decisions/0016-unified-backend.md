# 0016. Unified backend: one modular NestJS application, migrated in stages

- Status: **Accepted** (2026-11-03) by the project owner, for the decisions under [Decision](#decision). The items under [Pending decisions](#pending-decisions-blockers) are **not** decided by this record.
- Date: 2026-11-03
- Assessment: [UNIFIED_BACKEND_AUDIT.md](../../UNIFIED_BACKEND_AUDIT.md) (read-only audit, 2026-11-03)
- Supersedes in part: [ADR 0004](0004-realtime-gateway.md) and [ADR 0008](0008-api-gateway-foundation.md). Amends: [ADR 0010](0010-organizations-and-membership.md). Details in [Superseded and amended parts](#superseded-and-amended-parts-of-earlier-records).
- Implementation status:
  - Phase 0 complete.
  - **Phase 1 built and verified locally (2026-11-04):** `smartconnect-backend/app`, `make backend-start`. Results are in `UNIFIED_BACKEND_PHASE0_REPORT.md`.
  - Not deployed. Phases 2 and 3 have not started.

## Context

**What runs today:**
- Seven NestJS processes:
  - `api-gateway` (:3000);
  - `realtime-gateway` (:3105);
  - the identity, organization, workspace, messaging and files services (:3101–:3104, :3106).
- They call each other over HTTP, forwarding the caller's own access token.
- Nine more service directories (administration, documents, integrations, meetings, notifications, presence, search, tasks, workflows) contain only a Prisma schema and its migrations: no application, no routes.

**What the project owner wants:**
- One backend that starts locally with one command.
- One backend that deploys as **one Render Web Service**.
- No change to what users see, and no change to the database or its security model.

**What the audit found:**
- **Feasible without database change:**
  - every service is already a dynamic Nest module with an injectable factory;
  - every config loader accepts an `env` object;
  - every public route is under `/api/v1`, and the socket path is `/realtime/socket.io`.
- **A single-step merge is unsafe (audit §10):**
  - four services register their own guards as global `APP_GUARD`s, which Nest would apply to every module's routes (B1);
  - environment variable names collide (B2);
  - health, dev-mailbox, not-found and docs routes are duplicated (B3);
  - the gateway's forwarding routes use the same paths as the service routes (B4);
  - messaging and files call each other (B5);
  - file bytes live on local disk (B6);
  - Render exposes one public port (B7).
- **Render constraints** (read 2026-11-03):
  - all public traffic, WebSocket upgrades included, reaches one port;
  - a persistent disk limits a service to one instance and removes zero-downtime deploys.

## Decision

### Target and strategy

1. **One modular NestJS backend.** The unified backend:
   - runs as one Node.js process with one public HTTP server, which serves the REST API (`/api/v1/…`), the health probes (`/health/live`, `/health/ready`) and Socket.IO (`/realtime/socket.io`);
   - starts locally with **one command** and deploys as **one Render Web Service**;
   - leaves the React + Vite frontend unchanged.
2. **A staged migration. Each phase starts only on a separate instruction from the project owner, and only after the previous phase's gate has passed.**

   | Phase | What happens | What does not change |
   |---|---|---|
   | 0 | This record, documentation, a recorded test baseline, files tests in CI | Any runtime code |
   | 1 | **One process hosts the existing applications.** Every existing `create<Svc>App` factory runs unchanged on an internal loopback port. The gateway runs on the public port. The realtime hub attaches to the public HTTP server | Service code, routes, guards, internal HTTP calls |
   | 2 | **Genuine internal NestJS modules, one at a time**, leaves first: identity, organization, workspace, then messaging and files together, then realtime. Finally the loopback layer is retired | Public routes, error codes, authorization rules |
   | 3 | **Cut-over to one Render Web Service** after validation on staging | Database, roles, the old deployables (kept for rollback) |

### Packages

3. **`smartconnect-backend/app` (`@smartconnect/backend`) will be the single deployable.** It is created in Phase 1, not by this record. It composes the service packages and owns only cross-cutting concerns:
   - one configuration loader that maps namespaced variables onto each module's own `loadConfig(env)`;
   - the edge layer taken over from `api-gateway`;
   - one health pair and one OpenAPI document;
   - the realtime hub taken over from `realtime-gateway`;
   - in non-production environments, one merged dev mailbox.

   It holds no business logic and no data model.
4. **Existing service packages stay where they are.**
   - No service is moved, renamed, merged or deleted.
   - Each keeps its package, Prisma project, migrations, `.env` files, `app.factory.ts`, `main.ts` and tests.
   - In Phase 1 they are hosted unchanged. In Phase 2 each gains a feature module next to its existing `AppModule`.
   - **The existing microservices and both gateways remain runnable on their own throughout the migration and the rollback window.**
   - Modules are created only for implemented features. **The nine schema-only services get no modules**; their schemas and migrations keep being applied unchanged.

### Data and security

5. **Database ownership does not change.**
   - The 14 schemas, the 24 migrations, every RLS policy, the SECURITY DEFINER functions and the 28 roles stay as they are.
   - The unified process holds **one runtime connection per module**, each with that module's own `sc_<svc>_app` role (five today). It never uses a shared or more privileged role.
   - Migrator credentials never reach the runtime.
   - SQL across schemas remains forbidden; privileges keep making it fail.
   - Each service keeps its own Prisma project and generated client.
6. **Authentication and authorization are preserved exactly.**
   - Identity remains the only issuer of Ed25519 access tokens. Everything else verifies them with the public JWKS.
   - Tokens keep carrying identifiers only. Roles, permissions, memberships and platform roles are still looked up on each request.
   - The kit's `AccessTokenGuard` is registered **once**, globally, with `@Public()` as the only opt-out.
   - **Every service-specific guard is scoped to its own controllers with `@UseGuards`, never global:** identity `ActiveSessionGuard`, workspace and files `OrgMembershipGuard`, messaging `AccessGuard`. The order inside each module stays as it is.
   - Unchanged semantics:
     - session revocation is checked immediately on identity's routes, and wherever `/auth/me` is consulted today;
     - non-members get 404;
     - a failed dependency check never grants access;
     - the Super Admin guards keep working as they do now (ADR 0015).
7. **Modules call each other in process, as the caller (Phase 2).**
   - Each `ServiceClient` call is replaced by an in-process port that performs **the same checks** as the HTTP endpoint it replaces: same guard logic, same RLS context, same error codes.
   - A port acts only for the verified principal of the current request or socket. There are still no service credentials, and no module can ask "as someone else".
   - The caller-side classes (`IdentityClient`, `OrganizationDirectory`, `ChannelDirectory`, `FileDirectory`, `AttachmentAccess`, the realtime directories) keep their method signatures.
   - The HTTP path for a call is removed only after parity tests pass.
   - In Phase 1 the calls stay HTTP, but go to the **internal loopback ports and never to the public port**, so they do not consume users' rate-limit buckets.
   - Membership is still checked on every request. This record adds no caching.

### Edge and realtime

8. **The API gateway and the realtime gateway are consolidated into the app's edge layer.** Their behaviour moves unchanged:
   - token verification;
   - per-route rate-limit buckets (Redis in production, as now);
   - the exact-origin CORS allowlist;
   - the origin check for requests that carry cookies;
   - the JSON-only body policy and 1 MB limit;
   - the upload checks on the two file-content routes (411, 413, 415);
   - request ids and security headers.

   On top of that:
   - Public paths, methods, status codes and problem codes stay the same.
   - The headers the gateway used to drop are checked with a parity test before any module serves its routes directly.
   - There is one health pair; readiness aggregates every module's checks and still reveals nothing about them.
   - There is one OpenAPI document.
9. **Redis pub/sub is preserved.**
   - After a commit, messaging keeps publishing id-only events to `smartconnect:events`, and the realtime hub keeps subscribing. The hop is not replaced by an in-process emitter: it keeps today's behaviour and lets more than one instance deliver events.
   - Redis stays a bounded cache (`volatile-lru`). Rate limits and fan-out remain its only uses; this record adds none.
10. **Socket.IO is served from the same public HTTP server.** Nothing else about it changes:
    - path `/realtime/socket.io`;
    - WebSocket-only transport;
    - origin allowlist;
    - token in the handshake;
    - rooms `channel:{id}` and `inbox:{org}:{user}`;
    - the existing limits;
    - re-authorization every 60 s as the socket's own user;
    - the `message.changed` and `conversation.changed` payloads.

    The frontend's same-origin defaults keep working; `VITE_API_BASE_URL` and `VITE_REALTIME_URL` remain the overrides.

### Files

11. **Object storage is the selected production direction for file bytes, not a Render persistent disk.**
    - The files service's existing `FileStorage` interface is the seam. `LocalFileStorage` remains for development and tests until an object-storage driver is approved.
    - The provider, its credentials and the client dependency are **pending** (below).
    - This record does not choose between today's streamed upload and download path ([ADR 0013](0013-collaboration-platform-expansion.md)) and the presigned-URL design in [ADR 0006](0006-object-storage-and-file-security.md).

### Migration, rollback and gates

12. **Migration and rollback:**
    - Every step is one reviewable change.
    - Because the database and roles do not change, the old and new topologies run against the **same schemas with the same credentials**, so a rollback needs no data migration.
    - Rolling back means starting the separate services and gateways again (locally, the existing `make <name>-start` targets) and pointing traffic back at them.
    - The old deployables are retired only after the rollback window, whose length is pending.
13. **Testing and acceptance gates.** Any failure stops the migration at that step.

    | Gate | Must pass |
    |---|---|
    | Phase 0 | Baseline recorded honestly (`UNIFIED_BACKEND_PHASE0_REPORT.md`); files service tests run in CI |
    | Phase 1 | Every existing suite unchanged and green (`make ci-local`, `make db-test`, full `make e2e`); the full browser suite also green against the single process; memory, database connections and startup time measured |
    | Each Phase 2 step | The module's suites; parity tests for authorization (same answers as the HTTP endpoint), response headers and the route table; the full suite |
    | Phase 3 | The full browser suite against staging; Render's health check on `/health/ready`; no pending decision below left open |

## Superseded and amended parts of earlier records

The earlier records are not edited; this section is the authoritative statement of what changed.

| Record | Superseded or amended | Still in force |
|---|---|---|
| [ADR 0004](0004-realtime-gateway.md) (Proposed) | **Superseded:** "one stateless `realtime-gateway` *deployable* next to `api-gateway`"; the consequence "socket scaling and deploys are independent of the REST API"; the rejection of "Socket.IO inside `api-gateway`", which is now adopted in the unified app, accepting that REST and sockets restart together | Sockets authenticated with the access token; rooms derived server-side; writes over REST only; ephemeral signals in Redis only; WebSocket-only transport; id-only fan-out; Redis pub/sub as the interim event path pending [ADR 0002](0002-event-broker-nats-jetstream.md). ADR 0004's Socket.IO Redis adapter was never implemented; this record keeps the implemented mechanism (every instance subscribes) and does not decide the adapter |
| [ADR 0008](0008-api-gateway-foundation.md) (Proposed) | **Superseded:** the gateway as a separate runnable process (Context). **Amended:** decision 3, because the listener is the unified app's (`HOST`/`PORT`; on Render, `0.0.0.0` and the port Render supplies); decision 12, with one health pair for the app whose readiness aggregates module checks; decision 13, with one OpenAPI document for the app | Decisions 1, 2 and 4–11: platform, configuration style, RFC 9457 errors, validation, body policy, request ids, logging, CORS, security headers |
| [ADR 0010](0010-organizations-and-membership.md) (Proposed) | **Amended:** decision 3, because workspace's guard becomes scoped to workspace's controllers and asks the organization *module*; decision 4, where the transport changes from HTTP calls forwarding the caller's token to in-process ports acting as the verified caller (Phase 2; Phase 1 keeps HTTP on loopback); decision 6, with one merged dev mailbox in the app, never in production; decision 10, where channel access is asked of the workspace *module*. The consequence "one extra HTTP call" disappears after Phase 2 | Every business rule (decisions 1, 2, 5–9, 11) and every rule of decision 4: re-check on every request, answer only what the caller may know, no service credentials, fail closed, no caching yet |

Not affected:
- [ADR 0009](0009-identity-and-authentication.md): authentication is unchanged. The gateway's rate-limit buckets move with the edge layer, unchanged.
- ADRs 0011, 0013 and 0015: their behaviour is unchanged.

The topology statement in [database/architecture.md](../database/architecture.md#deployment-topology) is updated by this record.

## Pending decisions (blockers)

None of these is decided here. Each blocks the step named.

| # | Pending decision | Blocks |
|---|---|---|
| P1 | **Object-storage provider and credentials** (and the client dependency) | Production file storage; Phase 3 |
| P2 | **Whether the chosen PostgreSQL provider and plan support the full bootstrap:** 28 roles with connection limits, RLS, SECURITY DEFINER functions and `ALTER DEFAULT PRIVILEGES`, applied by an administrative role | Phase 3 |
| P3 | **The migration runner:** how each service's `prisma migrate deploy` runs with its migrator credentials while keeping them out of the web service's environment | Phase 3 |
| P4 | **The final frontend and API origins and the custom-domain arrangement** that keep the `Secure; SameSite=Strict; Path=/api/v1/auth` refresh cookie working | Phase 3 |
| P5 | **The length of the rollback window** | Retiring `api-gateway`, `realtime-gateway` and the per-service `main.ts` files |

Also not decided here, and to be settled when the phase that needs them starts:
- the namespaced variable scheme (Phase 1);
- a types-only `module-contracts` package for the ports (Phase 2, audit D9);
- the file transfer path (decision 11);
- `TRUST_PROXY_HOPS` on Render;
- the Socket.IO Redis adapter;
- anything in ADRs 0002, 0005, 0006 and 0007 that is still Proposed.

## Consequences

**Benefits:**
- One command locally and one service to deploy.
- After Phase 2, there are no internal HTTP hops: the 502, 504 and network-caused 503 failures between services disappear, and each request does less work.
- No data migration, so either topology can be rolled back to at any time.

**Costs:**
- **Larger blast radius:** a crash or memory exhaustion stops authentication, messaging, files and realtime together. Every deploy drops all sockets, and clients reconnect and refetch, as designed. Scaling is all-or-nothing.
- **Two topologies during the migration:** they must both stay green until the rollback window ends.
- **Test harness rewrites in Phase 2:** the fake neighbour services and the seven-process browser stack must be rewritten module by module. Tests that expect a 503 when a dependency is down need a new seam.

## Alternatives considered

| Option | Why not |
|---|---|
| Merge everything in one step | Unsafe: global guards would answer 404 or 403 on other modules' routes and delete rows during their requests, and routes collide (audit B1–B4) |
| Keep seven separate Render services | Does not meet the project owner's objective of one backend web service |
| Stop after Phase 1 | Keeps the internal HTTP hops and seven HTTP pipelines in one process. It remains a possible stopping point, but it is not the approved target |
| One shared database role for the whole app | Needs new grants and ends the privilege-enforced schema ownership that the tests check |
| A Render persistent disk for files | One instance only, downtime on every deploy, no free plan; the project owner chose object storage |
| An in-process emitter instead of Redis pub/sub | Changes today's behaviour and removes the ability to scale out |
