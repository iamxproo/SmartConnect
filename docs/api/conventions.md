# API conventions

Status: **Proposed for Phase 1**. Binding for every SmartConnect HTTP API once approved. Web and mobile consume the same contracts.

## Shape

| Topic | Convention |
|---|---|
| Style | REST over HTTPS, JSON (`application/json; charset=utf-8`). Commands that are not CRUD use sub-resources (`POST /calls/{id}/accept`) |
| Base path | `/api/v1/…`, routed by `api-gateway` to the owning service |
| Health | `GET /health/live`, `GET /health/ready`: unversioned infrastructure probes outside `/api/v1`, body `{"status": …}` only ([ADR 0008](../decisions/0008-api-gateway-foundation.md)) |
| Tenant scope | `/api/v1/orgs/{organizationId}/…` for all tenant data. The gateway authenticates; the service verifies membership and only then calls `withTenant()`. The tenant never comes from the request body |
| Paths | Plural nouns, kebab-case: `/orgs/{orgId}/workspaces/{workspaceId}/channels` |
| JSON fields | camelCase. ids are UUIDv7 strings; timestamps ISO-8601 UTC with milliseconds (`2026-11-02T13:45:12.345Z`); enums lowercase snake_case strings |
| Nulls | Omit unknown optional fields on input; responses include fields with `null` explicitly when absent |

## Methods and status codes

| | |
|---|---|
| `GET` | 200; 404 for missing **or not authorised** (no existence oracle for other tenants' or private resources) |
| `POST` (create) | 201 + `Location`; 200 when an idempotent replay returns the original result |
| `PATCH` | 200 with the updated resource (partial update; JSON merge semantics) |
| `PUT` | Only for full replacement of settings-style resources |
| `DELETE` | 204; idempotent |
| Errors | 400 malformed, 401 unauthenticated, 403 authenticated but not allowed on a *visible* resource, 404, 409 conflict / version mismatch, 413 payload too large, 415, 422 validation, 429 rate limited, 5xx never leak internals |

## Errors: RFC 9457 problem details

```json
{
  "type": "https://docs.smartconnect.dev/errors/validation-failed",
  "title": "Request validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "2 validation errors",
  "instance": "/api/v1/orgs/…/channels",
  "requestId": "0f9d2c4e-8a51-4c4f-9a8e-4f6f0f3b6a1d",
  "errors": [{ "field": "name", "code": "too_long", "message": "Must be at most 80 characters" }]
}
```

Content type `application/problem+json`. `code` is the stable, machine-readable identifier clients branch on. Messages are human-readable and may change. Never include stack traces, SQL or another tenant's identifiers.

Clarified by [ADR 0008](../decisions/0008-api-gateway-foundation.md) (Proposed):
- `type` is the error-docs base URL + `code` with `_` replaced by `-`.
- `instance` is the request path without the query string.
- `errors[].field` uses dots and indices (`items[1].label`); `(body)` means the whole body.
- Framework 4xx and every 5xx carry a generic `detail` that never echoes input or internals.

## Pagination, filtering, sorting

- **Cursor pagination everywhere:** `?limit=50&cursor=<opaque>` → `{ "data": [...], "nextCursor": "…" | null }`. Default 50, maximum 100. Cursors are opaque (base64url of the keyset) and not stable across API versions.
- **Message history** uses the per-conversation sequence: `?beforeSeq=` / `?afterSeq=` ([realtime.md](../architecture/realtime.md)).
- **Filters** are explicit query parameters (`?status=open&assigneeId=…`). Sorting is `?sort=createdAt` / `?sort=-createdAt`, restricted to indexed fields.

## Idempotency and concurrency

- `POST` endpoints that create resources accept `Idempotency-Key` (UUID). The server stores `(key, user, endpoint) → response` for 24 h; a replay returns the original response, and reuse with a different body returns 409. Messages use the existing `clientMessageId` (unique per conversation and sender) for the same guarantee.
- **Optimistic concurrency:** mutable resources expose `version` (integer) or an `ETag`. Writes send `If-Match`, and a mismatch returns 409.

## Authentication and sessions

| Client | Mechanism |
|---|---|
| Web | Short-lived **access token** (JWT, 15 min, held in memory only) in `Authorization: Bearer`. **Refresh token** in an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie, rotated on every use (identity.sessions with reuse detection) |
| Mobile | Same tokens; refresh token in the OS secure store (Keychain / Keystore) |
| Bots / apps (Phase 5) | Scoped API tokens, stored hashed (G-31) |

- **CSRF:**
  - API calls carry a bearer token, which browsers do not attach automatically, so they are not CSRF-exposed.
  - The cookie-authenticated refresh/logout endpoints are protected by `SameSite=Strict` **and** an `Origin` allow-list check.
- **XSS hygiene:**
  - No tokens in `localStorage`.
  - Strict CSP on the web app.
  - Message and document content is rendered from a sanitised Markdown/ProseMirror AST, never raw HTML.
- **Revocation:**
  - Revoking a session invalidates its refresh token immediately.
  - Access tokens expire within 15 min.
  - The realtime gateway drops sockets of revoked sessions on the `identity.session.revoked` event.

**As implemented** ([ADR 0009](../decisions/0009-identity-and-authentication.md), Proposed). Endpoints: [identity service README](../../smartconnect-backend/services/identity/README.md#api-all-under-apiv1auth).
- **Access token:**
  - Ed25519-signed JWT (`typ: at+jwt`) with claims `sub`, `sid`, `jti`, `iat`, `exp`, issuer and audience.
  - Only the identity service can sign it; the gateway and services verify with its public keys.
- **Refresh cookie:** named `__Secure-sc_refresh`. Web clients get it with `tokenDelivery: "cookie"` (the default); native apps send `"body"` and receive the token in the response.
- **Rotation and reuse:** reuse of a rotated refresh token ends the session. Clients must single-flight refreshes, including across browser tabs.
- **Deviation from "201 + Location":** `POST /api/v1/auth/register` answers **`202 {"status":"accepted"}` for new and already-registered emails alike**, so registration cannot reveal accounts. `password/forgot` also always answers 202, and login failures are one generic `401 invalid_credentials`.
- **CSRF:** the Origin allow-list check is enforced by the gateway for every state-changing request that carries cookies (`403 origin_not_allowed`).

## Authorization

- Every request is authorised server-side, in the owning service. Frontend checks are for UX only.
- Order: **authenticated → org member (active, not expired guest) → resource-level role/permission → action**. RLS (`withTenant`) is the last line of defence, not the authorization mechanism.
- Guests: deny by default; allowed only on explicitly granted workspaces, channels, meetings and files (G-02).
- Responses never reveal the existence of resources the caller cannot see (use 404).

## Validation and limits

- Validate at the boundary (NestJS pipes with DTO schemas): reject unknown properties, enforce lengths matching the database CHECK constraints (e.g. message body ≤ 40,000 chars), normalise emails, and validate UUIDs before querying.
- Request body limit: 1 MB by default. Files never pass through the API; they use presigned uploads ([ADR 0006](../decisions/0006-object-storage-and-file-security.md)).
- Outbound fetches (link previews, webhooks) go through the SSRF-guarded egress client: deny private, link-local and metadata ranges, re-check after DNS resolution, cap redirects and size.

## Rate limiting

Token buckets in Redis (keys with TTL) per IP, per user and per organization at the gateway, plus tighter per-endpoint limits (login, invitations, message send, search). Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; a 429 includes `Retry-After`.

Implemented for the authentication endpoints:
- Buckets are per IP, per account (hashed email, applied to unknown emails too) and per user. Limits: [ADR 0009](../decisions/0009-identity-and-authentication.md#decision).
- Bucket keys are hashed.
- If the store is unavailable, limited routes answer `503` (fail closed).

## Versioning and contracts

- URI major version (`/api/v1`). Within a version, only additive changes are allowed (new fields or endpoints, new enum values that clients must tolerate).
- Breaking changes → `/api/v2` route. The old version is announced with `Deprecation` / `Sunset` headers and runs for at least one mobile release cycle.
- **OpenAPI 3.1** is generated per service from NestJS decorators and aggregated by the gateway. Typed clients for web and mobile are generated into `packages/api-contracts`, the single source of truth for both apps. CI fails if the generated contract differs from the committed one without a version note.

## Observability headers

- Every response carries `X-Request-Id`, propagated to logs, audit records and outbox events. An inbound `X-Request-Id` is kept only if it matches `^[A-Za-z0-9._:-]{8,128}$`; otherwise the gateway generates one ([ADR 0008](../decisions/0008-api-gateway-foundation.md)).
- W3C `traceparent` is accepted and propagated.

## Outgoing webhooks

Signed with HMAC-SHA256 over `timestamp + "." + body`, sent as `SmartConnect-Signature: t=<unix>,v1=<hex>`. Receivers reject timestamps older than 5 minutes.
