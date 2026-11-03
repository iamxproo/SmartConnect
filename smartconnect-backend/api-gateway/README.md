# @smartconnect/api-gateway

Stateless HTTP entry point for SmartConnect (NestJS 12 on Express 5). It **owns no database schema and holds no database credentials** ([database architecture](../../docs/database/architecture.md)). Decisions: [ADR 0008](../../docs/decisions/0008-api-gateway-foundation.md) and [ADR 0009](../../docs/decisions/0009-identity-and-authentication.md) (both *Proposed*). API rules: [conventions.md](../../docs/api/conventions.md). The HTTP pipeline itself lives in [`@smartconnect/backend-kit`](../packages/backend-kit/README.md).

**Status: Phase 1 Task 3.**
- **Works:**
  - the HTTP pipeline: request ids, structured logs, security headers, CORS, JSON-only bodies, DTO validation and RFC 9457 errors;
  - access-token authentication: global and deny-by-default;
  - rate limiting;
  - CSRF Origin checks for cookie requests;
  - routing of `/api/v1/auth/*` to the [identity service](../services/identity/README.md);
  - liveness and readiness endpoints;
  - the OpenAPI document and Swagger UI.
- **Not built yet:**
  - routes for other services (they arrive with those services; none is mocked);
  - authorization beyond "authenticated", which belongs to the owning services;
  - metrics.

## Run it

From the repository root, after `make install`:

```bash
make auth-dev-keys      # once: local signing key pair in .secrets/auth/ (gitignored)
make gateway-start      # build, then start on http://127.0.0.1:3000 (Ctrl-C stops it gracefully)
```

`make gateway-start` sets `AUTH_JWT_PUBLIC_JWKS_FILE=.secrets/auth/jwt-public.jwks.json` unless you set the variable yourself, then runs `npm run build` and `npm run start --workspace @smartconnect/api-gateway`. Auth routes need the identity service too (`make identity-start`). Without it they answer `502`. Locally, rate limits use process memory, so neither Redis nor Docker is needed. Then:

```bash
curl -i http://127.0.0.1:3000/health/live      # 200 {"status":"ok"}
curl -i http://127.0.0.1:3000/health/ready     # 200 {"status":"ready"}
open http://127.0.0.1:3000/docs                # Swagger UI (development only by default)
curl http://127.0.0.1:3000/docs/openapi.json   # OpenAPI 3.1 document
```

| Task | Command |
|---|---|
| Start with rebuild and restart on change | `make gateway-dev` (`tsc --watch` + `node --watch`; no extra dependencies) |
| Tests (no database, Docker or network) | `make gateway-test` or `npm run test --workspace @smartconnect/api-gateway` |
| Type-check (sources and tests) | `npm run typecheck --workspace @smartconnect/api-gateway` |
| Build to `dist/` | `npm run build --workspace @smartconnect/api-gateway` |

`make ci-local` and the CI *Backend* job run the gateway's typecheck, tests and build.

## Configuration

Environment variables, validated at startup. Invalid values stop the process with **every** problem listed (exit code 1). The gateway's only secret is `REDIS_URL` (production). For local overrides, export variables or put them in `smartconnect-backend/api-gateway/.env` (gitignored; read by `npm run start` if it exists; without one, Node prints `.env not found. Continuing without it.`, which is expected).

| Variable | Default | Rules |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `HOST` | `127.0.0.1` | Loopback by default, like the rest of the local stack. Use `0.0.0.0` only inside a container |
| `PORT` | `3000` | 1–65535 |
| `CORS_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` outside production | Comma-separated exact origins (`https://app.example.com`). `*`, wildcards and paths are rejected. **Required in production** |
| `API_DOCS_ENABLED` | `true` in development, otherwise `false` | `true` / `false`. Serves `/docs` and `/docs/openapi.json` |
| `TRUST_PROXY_HOPS` | `0` | 0–10. Number of reverse proxies in front of the gateway (Express `trust proxy`) |
| `LOG_LEVEL` | `log` | `fatal`, `error`, `warn`, `log`, `debug` (includes health probes), `verbose` |
| `ERROR_TYPE_BASE_URL` | `https://docs.smartconnect.dev/errors/` | https URL ending in `/`; prefix of problem `type` URIs. Placeholder domain until error docs are published |
| `AUTH_JWT_PUBLIC_JWKS` / `_FILE` | **required** | The identity service's Ed25519 **public** keys (JWKS). Private key material is rejected |
| `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` | `smartconnect-identity` / `smartconnect-api` | Must match the identity service |
| `IDENTITY_SERVICE_URL` | `http://127.0.0.1:3101` outside production | **Required in production**. http(s), no credentials |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 100–60000; slower upstream answers become `504` |
| `REDIS_URL` / `_FILE` | unset: in-process buckets (development, tests) | **Required in production**, so all instances share rate-limit buckets. `redis://` or `rediss://` |

## Endpoints

| Path | Purpose |
|---|---|
| `GET /health/live` | Liveness: the process is up. `{"status":"ok"}`, `Cache-Control: no-store` |
| `GET /health/ready` | Readiness: accepting traffic. `200 {"status":"ready"}`, or `503` problem `not_ready` while starting or shutting down |
| `GET /docs`, `GET /docs/openapi.json` | Swagger UI and the OpenAPI 3.1 document (only when `API_DOCS_ENABLED`) |
| `/api/v1/auth/*` | Authentication, forwarded to the identity service. Public: `register`, `login`, `refresh`, `logout`, `password/forgot`, `password/reset`. Bearer: `logout-all`, `sessions`, `sessions/{id}`, `sessions/revoke-others`, `password/change` ([details](../services/identity/README.md#api-all-under-apiv1auth)) |
| any other `/api/v1/*` | `404` problem (no route exists yet) |

Health endpoints are unversioned and outside `/api/v1`. They reveal no versions, dependencies or configuration.

## Behaviour every route inherits

| Concern | Behaviour |
|---|---|
| Request id | A valid inbound `X-Request-Id` (8–128 chars of `A-Z a-z 0-9 . _ : -`) is kept; anything else is replaced by a UUID. The id is echoed on every response, in problem bodies and in logs, and is available to handler code via `currentRequestId()` |
| Errors | `application/problem+json` (RFC 9457): `type`, `title`, `status`, `code`, `detail`, `instance`, `requestId`, plus `errors[]` for validation. Throw `ApiProblemException(status, code, detail)` for domain errors. Any other error becomes a generic problem; 5xx causes are logged server-side and never returned |
| Validation | Global `ValidationPipe` → `422 validation_failed` with `errors[{field, code, message}]`. Unknown properties are rejected, not stripped. No implicit type conversion. Submitted values are never echoed |
| Bodies | JSON only (`application/json`, `application/*+json`), UTF-8, max 1 MB, top level object or array. Otherwise: `400 malformed_json`, `413`, `415` |
| Unknown routes | `404` problem everywhere, including outside `/api/v1` |
| CORS | Exact-origin allowlist with credentials. `X-Request-Id`, `Location`, `ETag`, `Retry-After` and `RateLimit-*` are readable cross-origin. Preflight cached 600 s |
| Security headers | helmet defaults (CSP, HSTS, `nosniff`, `frame-ancestors`, no `X-Powered-By`). `upgrade-insecure-requests` only in production, so local Swagger UI works over HTTP |
| Logs | One JSON line per request: `{event:"http_request", requestId, method, path, status, durationMs, aborted}`. No query strings, headers or bodies. 4xx at `warn`, 5xx at `error`, health probes at `debug` |
| Authentication | Global guard, **deny by default**: every route needs `Authorization: Bearer <access token>` unless marked `@Public()`. The guard checks the Ed25519 signature, `at+jwt` type, issuer, audience and expiry. Failures: `401 unauthenticated`, `invalid_token` or `token_expired`, with `WWW-Authenticate` |
| Rate limits | Token buckets per IP, per account (hashed email) or per user. Exceeded: `429` + `Retry-After`; `RateLimit-*` headers on every limited route. Store unreachable: `503 rate_limiter_unavailable` (fail closed). Limits: [ADR 0009](../../docs/decisions/0009-identity-and-authentication.md#decision) |
| Cookie requests (CSRF) | A state-changing request carrying cookies needs an allowed `Origin`, else `403 origin_not_allowed` |
| Routing | **Forwarded:** an allowlist of request headers (never client `X-User-Id`, `X-Organization-Id`, `X-Forwarded-*`, `Host`), only the refresh cookie, the request id, and the client IP as resolved here. **Passed back:** the service's status, body, `Set-Cookie` and caching headers. **Upstream failures:** unreachable → `502`, timeout → `504` |
| Shutdown | SIGTERM/SIGINT: readiness turns `503` and `service_stopping` is logged, then the server closes and the rate-limit store disconnects |

### Adding a route

- Routes are protected by default. Mark public ones `@Public()`, and give every public route `@RateLimit(...)` buckets.
- Forwarded routes call `UpstreamProxy.forward('<service>', req, res)`. Validation and behaviour belong to the service.
- Gateway-native handlers take a DTO class decorated with `class-validator`; nested DTOs need `@ValidateNested()` + `@Type(() => Dto)`.
- Inject with explicit `@Inject(Token)`: the repository's ESLint `consistent-type-imports` rule could otherwise turn a constructor type into a type-only import, and Nest would lose it.
- Document problem responses with `@ApiProblemResponses(404, 422, …)`. `500` and the `X-Request-Id` header are added to every operation automatically.
- Never implement business logic or database access here. The owning service does both.

## Structure

```
src/main.ts                       entry point: config → logger → app → listen; graceful shutdown hooks
src/app.factory.ts                pipeline (backend-kit) + CORS + cookie Origin check + docs; shared with tests
src/app.module.ts                 guards (access token, then rate limit), verifier, proxy, health, root 404
src/config/config.ts              environment validation
src/routes/auth-routes.controller.ts  public/protected auth routes and their rate limits
src/proxy/upstream-proxy.ts       forwarding to services (header allowlist, timeouts)
src/rate-limit/                   token-bucket guard, Redis (Lua) and in-memory stores
src/http/cookie-origin.ts         CSRF Origin check for cookie-carrying requests
scripts/dev.mjs                   dev loop (tsc --watch + node --watch)
test/                             Vitest + supertest + a fake upstream; test/support/probe.module.ts holds TEST-ONLY routes
```

The gateway against the **real** identity service and database, plus the Redis store against real Redis, are tested in `tests/integration/` (`make db-test`).

Tests build the real application through `createGateway()`, the same function `main.ts` uses. They never bind a fixed port or touch anything outside the process. `vitest.config.ts` makes Vitest's transform emit decorator metadata like `tsc` does, and `test/decorator-metadata.test.ts` fails if it ever stops.
