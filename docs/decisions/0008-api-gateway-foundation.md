# 0008. API gateway foundation: HTTP pipeline, errors, health and API docs

- Status: **Proposed**
- Date: 2026-11-03
- Implemented in: [`smartconnect-backend/api-gateway`](../../smartconnect-backend/api-gateway/README.md) (Phase 1 Task 2)
- Extended by: [ADR 0009](0009-identity-and-authentication.md) (Phase 1 Task 3). Authentication, rate limiting and routing to the identity service are now built; the gateway gained its first secret, `REDIS_URL`, required in production; the HTTP pipeline described here moved into `@smartconnect/backend-kit` unchanged.

## Context

Phase 1 Task 2 builds the first runnable backend process: a stateless NestJS gateway with no data ownership. Two documents already fix most of its HTTP behaviour:
- [api/conventions.md](../api/conventions.md) (*Proposed*): RFC 9457 errors, `X-Request-Id`, the 1 MB body limit, 422 validation, CORS-relevant auth design, OpenAPI 3.1;
- [database architecture](../database/architecture.md): the gateway holds no database credentials.

The gateway follows those as written. This record covers what they leave open, and two clarifications to the conventions that the implementation needed. Everything here is reversible and can be revised before acceptance.

## Decision

### Runtime and configuration

1. **Platform:**
   - NestJS 12 with `@nestjs/platform-express` (Express 5), ESM, compiled with `tsc`.
   - DTO validation with `class-validator` / `class-transformer`. OpenAPI with `@nestjs/swagger`. Security headers with `helmet`.
   - All versions pinned exactly, released at least 7 days earlier, compatible with Node 22.13+.
2. **Configuration:**
   - Environment variables only, parsed by a small typed loader (`src/config/config.ts`), not `@nestjs/config`.
   - Every problem is reported at once and the process exits with code 1.
   - The gateway needs no secrets.
   - **Production refuses to start without an explicit `CORS_ALLOWED_ORIGINS`.**
3. **Network defaults:**
   - Listens on `127.0.0.1:3000`, loopback like the rest of the local stack. Containers set `HOST=0.0.0.0`.
   - `TRUST_PROXY_HOPS` defaults to `0`: no proxy headers are trusted until the deployment topology says how many proxies sit in front.

### Errors and validation

4. **Errors (RFC 9457, per the conventions):**
   - One global exception filter. Express-level handlers cover what happens outside Nest: body-parser failures, and unknown paths outside `/api/v1`, which Nest would otherwise answer with Express's HTML page.
   - Only `ApiProblemException(status, code, detail)` carries a custom `code`/`detail`.
   - Every other 4xx gets the generic, input-free detail for its status.
   - Every 5xx is generic. Its cause is logged with the stack and request id, never returned.
5. **Clarifications to conventions.md** (applied there, Proposed with this record):
   - `type` = `ERROR_TYPE_BASE_URL` + `code` with `_` → `-`, e.g. `https://docs.smartconnect.dev/errors/validation-failed`. The conventions example showed `…/errors/validation` next to `code: validation_failed` without a rule.
   - `instance` (an RFC 9457 standard member) is included: the request path without the query string.
   - The documentation domain is a **placeholder** until error pages are published.
6. **Validation:**
   - A global `ValidationPipe`:
     - rejects unknown properties (not silently stripped) and unknown top-level values;
     - transforms to DTO instances, with **no implicit type conversion**;
     - never echoes submitted values (they may be secrets).
   - Failures return `422 validation_failed` with `errors[{field, code, message}]`.
   - Codes map from class-validator constraints: `required`, `invalid_type`, `too_long`, `too_short`, `too_small`, `too_large`, `invalid_email`, `invalid_uuid`, `invalid_value`, `unknown_field`, `invalid_body`.
   - Paths use dots and indices: `items[1].label`.
7. **Bodies:**
   - JSON only: `application/json` and `application/*+json` (for JSON merge-patch).
   - UTF-8 only, at most 1 MB, and the top level must be an object or array.
   - Failures: `400 malformed_json`, `413 payload_too_large`, `415 unsupported_media_type`. A body with any other content type is rejected before parsing.

### Request handling

8. **Request ids:**
   - **Acceptance rule:** an inbound `X-Request-Id` is kept only if it matches `^[A-Za-z0-9._:-]{8,128}$`, so an edge proxy's id can correlate logs. Anything else is replaced with a random UUID, preventing log and header injection.
   - The id is echoed on every response and appears in problem bodies and request logs.
   - It is held in `AsyncLocalStorage` (`currentRequestId()`), so future service calls and outbox events can propagate it.
   - It is a correlation id, not a security token.
9. **Logging:**
   - Nest's built-in `ConsoleLogger` in JSON mode, one object per line. No extra logging dependency until the log pipeline is chosen.
   - One entry per request: `requestId`, `method`, `path`, `status`, `durationMs`, `aborted`.
   - **Query strings, headers and bodies are never logged.**
   - Levels: 4xx at `warn`, 5xx at `error`, health probes at `debug`.
10. **CORS:**
    - An exact-origin allowlist with `credentials: true`. The conventions put the web refresh token in a cookie on `/api/v1/auth`.
    - `*` and wildcard origins are rejected at startup.
    - Outside production the default is the Vite dev server origins.
    - **Allowed request headers:** `Authorization`, `Content-Type`, `Idempotency-Key`, `If-Match`, `X-Request-Id`, `traceparent`.
    - **Exposed response headers:** `X-Request-Id`, `Location`, `ETag`, `Retry-After`, `RateLimit-*`.
    - Preflight `max-age` is 600 s.
11. **Security headers:**
    - helmet defaults: CSP, HSTS, `nosniff`, frame protection, no `X-Powered-By`.
    - Exception: CSP `upgrade-insecure-requests` is sent only in production. The only HTML the gateway serves is Swagger UI, which runs over plain HTTP on loopback in development.

### Health and API docs

12. **Health:**
    - `GET /health/live` and `GET /health/ready` are **unversioned, outside `/api/v1`**. They are infrastructure probes, not part of the versioned API contract.
    - Bodies are `{"status": …}` only, with `Cache-Control: no-store`.
    - Readiness is `503 not_ready` until bootstrap completes, and again from the start of shutdown, so load balancers drain the instance before the server closes.
    - **No dependency checks yet**, because the gateway has no runtime dependencies. When Redis (rate limiting) and service routing arrive, readiness will include only what the gateway cannot serve without, and will still reveal nothing about it.
13. **OpenAPI:**
    - An OpenAPI **3.1** document is generated from decorators. Swagger UI is at `/docs` and the JSON at `/docs/openapi.json`.
    - **Enabled by default only in development** (`API_DOCS_ENABLED` overrides).
    - **Applied to every operation automatically:**
      - the `X-Request-Id` response header;
      - a `500` problem response.
    - Other problem responses are declared with `@ApiProblemResponses(...)`.
    - Operation ids are `<Controller>_<method>`.
    - Aggregating service specs and `packages/api-contracts` arrive with the first services.

## Deferred (explicitly not decided or built here)

| Item | Why / when |
|---|---|
| Authentication, authorization, sessions | Later Phase 1 tasks |
| Rate limiting (token buckets in Redis, per conventions.md) | Needs the gateway's first Redis client and per-route limits. With the first authenticated routes |
| Routing to services, `traceparent` propagation | No services are exposed yet. `traceparent` is already accepted by CORS |
| Metrics, tracing export, log shipping | With the observability stack (roadmap Phase 7: production readiness, or earlier if needed) |
| Dockerfile, Nginx routing | Out of scope for this task (no Docker/Nginx changes) |

## Consequences

- Every later route inherits validation, errors, request ids, logging, CORS and headers without per-route code.
- Tests build the real pipeline (`createGateway()`, shared with `main.ts`), so behaviour verified in tests is production behaviour.
- **Dependency note:**
  - `@nestjs/platform-express@12.2.0` pins `multer@2.4.0`, affected by [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) (high, DoS in multipart handling). The gateway has no upload routes; files use presigned URLs per [ADR 0006](0006-object-storage-and-file-security.md).
  - NestJS 12.3.2 ships the fix but was released 2026-10-27, inside the 7-day window at implementation time.
  - Until then, a root `overrides` entry scoped to `@nestjs/platform-express` pins `multer@2.5.0` (2026-10-22). That is the version NestJS itself moved to.
  - **Follow-up:** upgrade `@nestjs/*` to ≥ 12.3.2 and remove the override.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Fastify adapter | Slightly faster, but Express is Nest's default with the widest middleware and documentation coverage. Gateway throughput is not the bottleneck at this stage. Revisit with load tests |
| `@nestjs/config` (+ Joi/zod) | Extra dependencies for eight variables. A typed loader with tests is smaller and reports all errors at once |
| `pino` / `nestjs-pino` | Better throughput and redaction, but adds dependencies before a log pipeline exists. The JSON format is compatible, so switching later is local to `logger.ts` |
| `@nestjs/terminus` | Useful once readiness checks real dependencies. Today there are none |
| Health under `/api/v1` | Would version infrastructure probes with the public API, and couple orchestrator configuration to API versions |
| Reflecting any `Origin` with credentials | Equivalent to no CORS protection for cookie-authenticated endpoints |
| Docs always on | Exposes the full API surface in production by default. Teams that want public docs can enable them explicitly |
| Accept any inbound request id / always generate | Any: log/header injection risk. Always generate: loses correlation with the edge proxy |
