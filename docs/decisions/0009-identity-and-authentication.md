# 0009. Identity and authentication foundation

- Status: **Proposed**
- Date: 2026-11-03
- Implemented in: [identity service](../../smartconnect-backend/services/identity/README.md), [API gateway](../../smartconnect-backend/api-gateway/README.md), [`@smartconnect/backend-kit`](../../smartconnect-backend/packages/backend-kit/README.md) (Phase 1 Task 3)
- Extends: [ADR 0008](0008-api-gateway-foundation.md) (gateway authentication, rate limiting, routing and its first secret)

## Context

The identity schema already existed, migrated and tested:
- `users` and `credentials`, with Argon2id fixed by the schema docs;
- `sessions`, storing SHA-256 hashes of the current and previous refresh token, designed for rotation and reuse detection;
- `verification_tokens`, single-use, hashed and expiring;
- `outbox_events`.

[conventions.md](../api/conventions.md) fixes the client-facing shape:
- a 15-minute JWT access token held in memory;
- a rotating refresh token: an `HttpOnly; Secure; SameSite=Strict` cookie on `/api/v1/auth` for web, the OS secure store for mobile;
- an Origin check on cookie endpoints;
- Redis token buckets at the gateway.

No application code existed. This record covers what those documents leave open. **No schema change was needed: no migration.**

## Decision

### Tokens

1. **Access tokens:**
   - JWT signed with **Ed25519 (JWS `EdDSA`)**, header `typ: at+jwt` (RFC 9068), `kid` for rotation.
   - Claims: `sub` (user), `sid` (session), `jti`, `iat`, `exp`, plus issuer and audience. Identifiers only: no email, roles or tenant.
   - Default lifetime 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`, 60–3600).
   - **Asymmetric on purpose:** only the identity service holds the private key. The gateway and future services verify with the public JWKS, so a compromised verifier cannot mint tokens.
   - **Verification** accepts only `EdDSA` and `at+jwt` with the configured issuer and audience. It requires `sub`, `sid`, `jti`, `iat` and `exp`, with UUID subject and session ids. `alg: none`, HS256 keyed with the public key, foreign keys and other token types are rejected (tested).
   - Library: [`jose`](https://github.com/panva/jose) 6.2.13, which has zero dependencies and provenance.
2. **Key distribution:**
   - The private JWK is passed as `AUTH_JWT_PRIVATE_JWK` or `AUTH_JWT_PRIVATE_JWK_FILE`; the public JWKS as `AUTH_JWT_PUBLIC_JWKS` or `_FILE`.
   - Secrets managers and Kubernetes mount files. No defaults exist.
   - Locally, `make auth-dev-keys` writes owner-only files to the gitignored `.secrets/auth/`.
   - Verifier configuration **rejects private key material**.
   - **Rotation:** publish the new public key, switch the signer, and drop the old key after one access-token lifetime.
3. **Refresh tokens:**
   - 256-bit random, base64url. Only the SHA-256 is stored.
   - **A session is the token family.** Each refresh atomically replaces the current hash and keeps the previous one, in a single `UPDATE … WHERE refresh_token_hash = $presented AND not revoked AND not expired`.
   - **Reuse detection is strict:** presenting a session's *previous* token revokes the session (`refresh_token_reuse`). That includes the losers of concurrent refreshes with the same token: exactly one succeeds, tested with 8 in parallel.
   - Clients must therefore serialise refreshes, for example a single-flight refresh shared across browser tabs. This follows the OAuth 2.0 Security BCP. A grace window was rejected: it would need the new token stored retrievably, or would let a thief race the owner.
4. **Session lifetime:**
   - Sliding idle expiry of 30 days (`REFRESH_TOKEN_IDLE_DAYS`) with an absolute cap of 90 days from login (`SESSION_MAX_LIFETIME_DAYS`).
   - Both are enforced in the rotation statement.
5. **Token delivery:**
   - `tokenDelivery: "cookie"` (default, web) sets `__Secure-sc_refresh` with `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. The token is **never** in the body.
   - `"body"` (native apps) returns it in the body and sets no cookie.
   - Refresh and logout read a body token first, then the cookie, and answer in the same mode.

### Credentials and accounts

6. **Passwords:**
   - Argon2id, m = 19 MiB, t = 2, p = 1 (OWASP), via [`@node-rs/argon2`](https://github.com/napi-rs/node-rs) 2.2.2: prebuilt binaries, no install script, provenance.
   - Inputs are NFKC-normalised.
   - Policy: 12 to 128 characters, no composition rules (NIST SP 800-63B).
   - Hashes with outdated parameters are upgraded on the next successful login.
   - Concurrency is bounded by libuv's thread pool (4 × 19 MiB).
7. **Enumeration resistance:**
   - **Registration** answers `202 {"status":"accepted"}` for new and already-registered emails alike. It hashes the password either way, creates nothing for a taken address, and notifies the address's owner instead. This **deviates from "201 + Location"** in the conventions, deliberately.
   - **Login** returns one `401 invalid_credentials` for an unknown email, a wrong password and an inactive account. Unknown accounts get a full Argon2 verification against a dummy hash, so timing matches.
   - **Password-reset requests** always answer `202`.
   - **Rate-limit buckets** keyed by email also apply to unknown emails.
8. **Password reset:**
   - A 256-bit token, stored as SHA-256 in `verification_tokens`, valid 30 minutes (`PASSWORD_RESET_TTL_MINUTES`).
   - Only the newest token per user is valid.
   - Single use is enforced atomically, even under concurrent requests (tested).
   - The new password is validated before the token is consumed.
   - A reset ends **every** session.
   - A password **change** requires the current password and ends every session **except the caller's**.

### Sessions, integration and abuse

9. **Session revocation and checks:**
   - Each revocation is a single `UPDATE … RETURNING` and writes an `identity.session.revoked` outbox event per session. Reasons: `logout`, `logout_all`, `revoked_by_user`, `revoked_others`, `refresh_token_reuse`, `password_changed`, `password_reset`, `account_inactive`.
   - The identity service's own protected routes also require the token's **session** to be active, so logout and revocation take effect there immediately.
   - Elsewhere, access tokens stay valid until they expire (≤ 15 min), as conventions.md states. The realtime gateway will consume `identity.session.revoked`.
10. **Gateway integration:**
    - Routing is an explicit route table (`AuthRoutesController`). Each route is `@Public()` or protected, with its own rate limits, and is forwarded to the identity service.
    - **Deny by default:** the access-token guard is global, so a new gateway route is protected unless it is marked public.
    - **Forwarded:** an allowlist of request headers only. Client-supplied identity, tenant or routing headers (`X-User-Id`, `X-Organization-Id`, `X-Forwarded-*`, `Host`) never reach a service.
    - **Cookies:** only the refresh cookie is passed on.
    - **Set by the gateway:** the resolved client IP (`X-Forwarded-For`) and the request id. The identity service trusts exactly one proxy hop.
    - **Failures:** unreachable upstream → 502, timeout → 504.
    - **CSRF:** a state-changing request that carries cookies must have an allowed `Origin` (403 `origin_not_allowed`), in addition to `SameSite=Strict`.
11. **Brute force and abuse (rate limiting):**
    - Token buckets at the gateway, keyed by client IP, by email address (hashed), or by authenticated user. One atomic Lua script on Redis, timed by the Redis clock.
    - **Keys are hashed:** Redis never holds IPs or emails, and every key has a TTL.
    - **Production requires `REDIS_URL`**, so buckets are shared by all instances. Development and tests use a bounded in-process store.
    - **Fails closed:** if the store is unreachable, rate-limited routes answer 503 rather than run unprotected.
    - Limits:

    | Route | Buckets |
    |---|---|
    | register | 10/h per IP |
    | login | 20/10 min per IP, 10/15 min per account |
    | refresh, logout | 60/min per IP |
    | password/forgot | 10/h per IP, 3/h per account |
    | password/reset | 20/h per IP |
    | sessions, logout-all | 60/min per user |
    | password/change | 5/15 min per user |

12. **Account emails:** no approved email integration exists, so the identity service has an `AccountNotifier` port.
    - **`disabled`:** production must choose it explicitly. It drops messages and logs only their kind.
    - **`dev-mailbox`:** development and tests only, refused in production. It keeps messages in memory and shows them at `GET /dev/mailbox` on the identity service itself, which the gateway does not route.
    - **Never logged:** reset tokens, passwords, refresh tokens or email addresses.
13. **Shared backend kit:** the gateway's HTTP foundation (ADR 0008) moved into `@smartconnect/backend-kit`, together with access-token verification and the guard and decorators (`@Public()`, `@CurrentPrincipal()`). The identity service and future services reuse it. It is **infrastructure only**: no data models and no business logic.
14. **Ports and trust:** the identity service listens on `127.0.0.1:3101` and is internal: no CORS, not browser-facing. Its runtime role is `sc_identity_app` (DML only, identity schema only).

## Deferred (explicitly not built here)

| Item | Why / when |
|---|---|
| Email delivery | No approved provider. Implement `AccountNotifier`; until then production password reset is non-functional (by explicit `ACCOUNT_NOTIFIER=disabled`) |
| Email verification flow, MFA (TOTP), OAuth/SSO | Not approved for this task. The schema already has `verification_tokens.email_verification` and `credentials.totp` |
| Breached-password check (k-anonymity) | Needs an external dependency decision |
| Session cleanup job (retention: delete 30 days after expiry/revocation) | With the first scheduled-job infrastructure (ADR 0007) |
| Full refresh-token history | Only one previous token per session is kept: replay of a token two or more rotations old is rejected but not detected as theft. Detection beyond that would need a new table |
| Per-user cap on concurrent sessions | Sessions grow only through successful logins, which are rate-limited |
| Device registration (`devices`, push tokens) | Notifications phase |
| Gateway OpenAPI aggregation of service schemas | The gateway documents the auth operations; request/response schemas come from the identity service's own document |
| Dev seed users with passwords | `make db-seed` users have no credentials. Register users through the API |

## Consequences

- No database change; all behaviour lives in the identity service and is covered by unit tests plus database-backed integration suites (`make db-test`), including the gateway in front of the real service.
- The gateway now needs the public JWKS everywhere and `REDIS_URL` in production. The identity service needs `DATABASE_URL` and the private key; it fails fast without them.
- Web clients must single-flight refreshes (strict reuse detection).
- Access tokens are not instantly revocable outside the identity service (≤ 15 min), as conventions.md already accepted.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| HS256 shared secret | Every verifier could mint tokens; one leaked service compromises all |
| RS256 / ES256 | Larger keys and signatures than Ed25519 for no benefit here; ES256 needs careful nonce handling |
| Opaque access tokens with introspection | A network call per request at the gateway; JWTs keep it stateless as ADR 0008 requires |
| Grace window for concurrent refreshes | Weakens theft detection (see 3) |
| bcrypt / scrypt | Argon2id is the documented schema decision and the current OWASP first choice |
| `argon2` (node-argon2) | Runs an install script (`node-gyp-build`); `@node-rs/argon2` ships prebuilt binaries without one |
| Account lockout counters in `users` | Enables targeted lockout DoS and needs a migration; per-account rate-limit buckets cover unknown emails too |
| Rate limiting in the identity service | Conventions put it at the gateway; the gateway also rejects floods before they reach the service |
| `ioredis` | `@redis/client` (official) is smaller and sufficient |
| Copying the gateway pipeline into the identity service | Two diverging copies for every future service |
