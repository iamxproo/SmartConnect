# @smartconnect/backend: the unified backend (ADR 0016, Phase 1)

One Node.js process that hosts the seven existing applications, unchanged, each behind its own internal HTTP boundary:

- the API gateway;
- the realtime gateway;
- the identity, organization, workspace, messaging and files services.

The API gateway owns the only public port, which serves:

- REST under `/api/v1`;
- the health probes `/health/live` and `/health/ready`;
- Socket.IO at `/realtime/socket.io`.

Decision record: [ADR 0016](../../docs/decisions/0016-unified-backend.md). Phase 2 (internal modules instead of loopback HTTP) has **not** started.

## Run it

```sh
make backend-start   # builds everything it needs, then starts the backend on http://127.0.0.1:3000
```

It needs the same things as the per-service targets: `make infra-up` (PostgreSQL and Redis), `make db-migrate` and `make auth-dev-keys`.

**Do not run it together with** `make gateway-start`, `identity-start` or the other per-service targets. They use the same ports, and the backend refuses to start (exit 1) if any of its ports is busy, without touching the other process. The per-service targets still work exactly as before; they are the rollback path.

Locally, as with the per-service targets, it reads:

- each service's `DATABASE_URL` from its generated `smartconnect-backend/services/<service>/.env`;
- `REDIS_URL`, built from `REDIS_PASSWORD` and `REDIS_PORT` in the root `.env`;
- `.secrets/smtp.env` and `.secrets/organization.env`, if they exist;
- the dev signing keys from `.secrets/auth/`.

Nothing is read from local files when `NODE_ENV=production`.

## Ports

| Application | Port (default) | Listens on |
|---|---|---|
| API gateway (public) | `PORT` (3000) | `HOST` (127.0.0.1; `0.0.0.0` in a container) |
| identity | `IDENTITY_INTERNAL_PORT` (3101) | 127.0.0.1 only |
| organization | `ORGANIZATION_INTERNAL_PORT` (3102) | 127.0.0.1 only |
| workspace | `WORKSPACE_INTERNAL_PORT` (3103) | 127.0.0.1 only |
| messaging | `MESSAGING_INTERNAL_PORT` (3104) | 127.0.0.1 only |
| realtime gateway | `REALTIME_INTERNAL_PORT` (3105) | 127.0.0.1 only |
| files | `FILES_INTERNAL_PORT` (3106) | 127.0.0.1 only |

The services keep calling each other over HTTP, exactly as before, now on these loopback ports.

## Environment

Every application receives **only** the variables listed for it in [`src/env.ts`](src/env.ts) (`PASS_THROUGH`), and then validates them with its own `loadConfig()`.

**Per-application names:**

| Unified name | Received by | As |
|---|---|---|
| `PORT`, `HOST`, `TRUST_PROXY_HOPS`, `API_DOCS_ENABLED` | the public API gateway | the same names |
| `<APP>_DATABASE_URL[_FILE]` | that service only (`IDENTITY`, `ORGANIZATION`, `WORKSPACE`, `MESSAGING`, `FILES`) | `DATABASE_URL[_FILE]`, each with the service's own runtime role |
| `<APP>_INTERNAL_PORT` | that application | its internal `PORT` |
| `<APP>_TRUST_PROXY_HOPS`, `<APP>_API_DOCS_ENABLED` (optional) | that application | the same settings; otherwise the application's own default applies |
| `AUTH_JWT_PRIVATE_JWK[_FILE]` | **identity only** | the same |

**Shared values** go to the applications that read them, under their own names:

| Variables | Received by |
|---|---|
| `NODE_ENV`, `LOG_LEVEL`, `ERROR_TYPE_BASE_URL`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE` | all seven |
| `AUTH_JWT_PUBLIC_JWKS[_FILE]` | every application except identity |
| `REDIS_URL`, `REALTIME_EVENTS_CHANNEL` | the applications that read them |
| SMTP and `WEB_APP_URL` | identity and organization |
| `FILES_*` | files (and `FILES_MAX_BYTES` also the gateway) |
| `ORGANIZATION_CREATION`, `ORGANIZATION_CREATOR_EMAILS`, `ORGANIZATION_MAX_OWNED_PER_USER` | organization |

Prefixes are never stripped: `ORGANIZATION_CREATOR_EMAILS` stays `ORGANIZATION_CREATOR_EMAILS`.

**Never set**, or the backend exits 1 before opening any port:

- any `*_SERVICE_URL`: internal URLs are computed on loopback;
- an unprefixed `DATABASE_URL`.

All problems of all seven applications are reported at once, by variable name and never with values.

## Lifecycle

**Start:**

1. Validate all seven configurations.
2. Check every port.
3. Start identity → organization → workspace → files → messaging → realtime → API gateway. Each waits until the previous one answers `/health/ready` with 200.
4. Open the public port last.

If any step fails, everything already started is closed again, and the process exits 1.

**Shutdown:** on the first `SIGTERM` or `SIGINT`, the backend closes the applications in this order:

1. the API gateway and the realtime gateway together;
2. messaging;
3. files;
4. workspace;
5. organization;
6. identity.

The deadline is 25 s; the exit code is 0 when everything closed cleanly. A second signal exits at once. The hosted applications do not install their own signal handlers.

**Logging:** request and error logs carry an `app` field naming the application that wrote them.

## Tests

| Command | What it covers |
|---|---|
| `make backend-test` | Environment views, ports, start and shutdown order, the Socket.IO hand-off, logging (no database) |
| `make db-test` | Includes `tests/integration/platform/unified-backend.test.ts`: the built process against the test database |
| `make e2e-unified` | The full browser suite against this process. `make e2e` still runs the seven-process stack |
