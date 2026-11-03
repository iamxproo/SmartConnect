# @smartconnect/identity-service

Sole owner of PostgreSQL schema `identity`: accounts, password credentials, sessions with rotating refresh tokens, and password reset. NestJS 12, Prisma 7, runtime role `sc_identity_app` (DML only, identity schema only). Decisions: [ADR 0009](../../../docs/decisions/0009-identity-and-authentication.md) (*Proposed*). Schema: [schema-design.md#identity](../../../docs/database/schema-design.md#identity).

**Status: Phase 1 Task 3, authentication foundation.**
- **Works:**
  - registration and login;
  - refresh-token rotation with reuse detection;
  - logout and logout-all;
  - listing and revoking sessions;
  - password reset and change.
- **Not built yet:**
  - email delivery (see below);
  - email verification;
  - MFA;
  - OAuth/SSO;
  - profiles;
  - session cleanup job.

It is an **internal** service. Clients reach it only through the [API gateway](../../api-gateway/README.md), which authenticates, rate-limits and forwards `/api/v1/auth/*` under the same paths.

## Run it

From the repository root:

```bash
make infra-up db-bootstrap db-migrate prisma-generate   # once: dev database + services/identity/.env (DATABASE_URL)
make auth-dev-keys                                      # once: .secrets/auth/ (gitignored) signing key pair
make identity-start                                     # http://127.0.0.1:3101 (dev database)
make gateway-start                                      # in another terminal: http://127.0.0.1:3000
```

Then, through the gateway:

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple","displayName":"Ada"}'
curl -s -X POST http://127.0.0.1:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple","tokenDelivery":"body"}'
```

Password-reset emails go to the in-memory dev mailbox: `curl http://127.0.0.1:3101/dev/mailbox?to=ada@example.com` (identity service only; the gateway has no route to it).

| Task | Command |
|---|---|
| Unit tests (no database) | `make identity-test` |
| Integration tests (test database, real HTTP, through the gateway too) | `make db-test` (needs `make infra-up` for Redis) |
| Type-check / build | `npm run typecheck` / `npm run build --workspace @smartconnect/identity-service` |
| API docs (development) | http://127.0.0.1:3101/docs |

## API (all under `/api/v1/auth`)

| Route | Auth | Result |
|---|---|---|
| `POST /register` `{email, password, displayName}` | public | `202 {"status":"accepted"}`, **also for an already-registered email** (the owner is notified instead; no enumeration) |
| `POST /login` `{email, password, tokenDelivery?}` | public | `200` access token, plus the refresh token as an HttpOnly cookie (`"cookie"`, default) or in the body (`"body"`, native apps). `401 invalid_credentials` for any failure |
| `POST /refresh` `{refreshToken?}` or cookie | public | `200`, new access and refresh token. `401 invalid_refresh_token`; reuse of a rotated token ends the session |
| `POST /logout` `{refreshToken?}` or cookie | public | `204`, idempotent; clears the cookie |
| `POST /logout-all` | bearer | `204`, ends all of the caller's sessions |
| `GET /sessions?limit&cursor` | bearer | `200 {data, nextCursor}`, the caller's active sessions (`current` marks this one) |
| `DELETE /sessions/{id}` | bearer | `204`; `404` for unknown ids **and other users' sessions** |
| `POST /sessions/revoke-others` | bearer | `204`, keeps the current session |
| `POST /password/forgot` `{email}` | public | `202` always |
| `POST /password/reset` `{token, newPassword}` | public | `204`, ends **every** session; `400 invalid_reset_token` |
| `POST /password/change` `{currentPassword, newPassword}` | bearer | `204`, ends every **other** session; `403 current_password_incorrect`. Clears an issued password's `change_required`, which cannot be re-entered (`422 same_as_current`) |
| `GET /me` | bearer | `200 {id, email, emailVerified, displayName, platformRoles, passwordChangeRequired}` |
| `GET /api/v1/admin/accounts/summary` | bearer, **Super Admin** | `200` account totals. `403 platform_admin_required`, or `403 password_change_required` while the issued password is unchanged |

"Bearer" routes need `Authorization: Bearer <access token>` **and** an active session: logout, revocation and password changes take effect here immediately. Errors are RFC 9457 problem details.

## Configuration

Environment variables, validated at startup (all problems at once, values never echoed). `npm run start` also reads `services/identity/.env`, which `make db-bootstrap` generates and rewrites, so never put other settings there.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` / `_FILE` | **required** | Runtime role `sc_identity_app` |
| `AUTH_JWT_PRIVATE_JWK` / `_FILE` | **required** | Ed25519 private JWK with `kid`. `make identity-start` points `_FILE` at `.secrets/auth/` |
| `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` | `smartconnect-identity` / `smartconnect-api` | Must match the gateway |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | 60–3600 |
| `REFRESH_TOKEN_IDLE_DAYS` / `SESSION_MAX_LIFETIME_DAYS` | `30` / `90` | Sliding idle expiry and its absolute cap |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | 5–1440 |
| `ACCOUNT_NOTIFIER` | `dev-mailbox` outside production | `dev-mailbox`, `smtp` or `disabled`. **Required in production**, where `dev-mailbox` is refused |
| `WEB_APP_URL` | `http://127.0.0.1:5173` | Origin of the web app, for links in emails. **Required in production, and https there** |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` / `_FILE`, `SMTP_FROM` | **required** with `smtp` | Gmail: `smtp.gmail.com`, the account, an app password (spaces are ignored), `SmartConnect <that account>` |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` | `false` = STARTTLS, always required; `true` = TLS from the start (465) |
| `SMTP_REPLY_TO`, `SMTP_TIMEOUT_MS` | none / `15000` | Reply-To address; connection and greeting timeout (1000–60000) |
| `HOST` / `PORT` | `127.0.0.1` / `3101` | Internal service |
| `TRUST_PROXY_HOPS` | `1` | The gateway's `X-Forwarded-For` carries the client address |
| `NODE_ENV`, `LOG_LEVEL`, `API_DOCS_ENABLED`, `ERROR_TYPE_BASE_URL` | as in the gateway | |

## Security properties (each covered by tests)

- **Passwords:**
  - Argon2id (19 MiB, t=2, p=1), NFKC-normalised, 12–128 characters.
  - Outdated hashes are upgraded at login.
  - Unknown accounts still cost one full verification (dummy hash), so login timing does not reveal accounts.
- **Refresh and reset tokens:** 256-bit random, stored only as SHA-256. Reset tokens expire after 30 minutes, are single-use (atomically, even under concurrent requests), and only the newest is valid.
- **Rotation:** one atomic `UPDATE`. Of N concurrent refreshes with the same token exactly one succeeds; the others count as reuse and revoke the session (token family). Clients must single-flight refreshes.
- **Never logged:** passwords, tokens, reset tokens, email addresses. Reuse detection logs session and user ids only.
- **Domain events** go into `identity.outbox_events` in the same transaction, with identifiers only:
  - `identity.user.registered`;
  - `identity.user.password_changed`;
  - `identity.session.revoked` (with reason).
- **Global data, no RLS (by design):** every query is scoped to the authenticated user. The runtime role cannot reach other schemas, and other services' roles cannot read `identity` (tested).

## Platform administration ([ADR 0015](../../../docs/decisions/0015-platform-administration.md))

- **Super Admins** hold `super_admin` in `platform_role_assignments`. `SuperAdminGuard` (`src/admin/`) reads it on every admin request, with the account's status and password state: there is no role in the token, so withdrawing the role or suspending the account takes effect at once. Organization roles (organization service) play no part.
- **Development account:** `make admin-seed` (in your own terminal) creates or resets `admin@smartconnect.localhost`. You type the initial password at a hidden prompt; it is stored as Argon2id with `change_required`, so the first sign-in must replace it (12+ characters). The seed (`smartconnect-backend/scripts/super-admin.ts`) refuses anything but `NODE_ENV=development` and the local development database. Sign in at the web app's `/admin/login`.

## Email delivery

`AccountNotifier` (`src/notifications/account-notifier.ts`) is the boundary for verification and reset links, "someone tried to register with your address" and "your password changed" notices ([ADR 0012](../../../docs/decisions/0012-transactional-email-resend.md)).

- **`smtp`:** `SmtpAccountNotifier` renders the message (`account-templates.ts`, on the kit's branded layout) and queues it in the kit's `BackgroundMailer`; `send` returns at once, so no request waits for the mail server. Delivery is over Nodemailer with mandatory STARTTLS, retried with backoff on transient failures. Logs carry the message kind, attempts and failure category only: never an address, link or token. Queued mail is sent (up to 5 s) on shutdown; it is lost on a crash, and every flow lets the person ask again.
- **Where the settings live:** `npm start` also loads the gitignored `.secrets/smtp.env` at the repository root, because `make db-bootstrap` rewrites this service's `.env`.
- **`disabled`:** messages are dropped and only their kind is logged. Password reset is then **not usable**.
- **`dev-mailbox`:** in-memory, shown at `/dev/mailbox`; development and tests only.

## Structure

```
src/main.ts                       config → logger → Prisma → app → listen; graceful shutdown
src/app.factory.ts / app.module.ts shared HTTP pipeline (@smartconnect/backend-kit), guards, providers
src/config.ts                     environment validation
src/auth/                         controllers, DTOs, AuthService, SessionService, PasswordService,
                                  AccessTokenIssuer, ActiveSessionGuard, refresh cookie, problem factories
src/crypto/                       Argon2id hasher, opaque tokens + SHA-256, email normalisation
src/events/outbox.ts              outbox events
src/notifications/                AccountNotifier port, SmtpAccountNotifier + templates, DevMailbox (development only)
src/database/client.ts            createPrismaClient() (the only place a PrismaClient is built)
test/                             unit tests; integration suites live in tests/integration/identity/
```
