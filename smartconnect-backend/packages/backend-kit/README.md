# @smartconnect/backend-kit

Shared **infrastructure** for SmartConnect's NestJS processes: the API gateway and the services. It holds no data models and no business logic; those stay in the owning service. Decisions: [ADR 0008](../../../docs/decisions/0008-api-gateway-foundation.md) (HTTP foundation), [ADR 0009](../../../docs/decisions/0009-identity-and-authentication.md) (access tokens).

| Module | Provides |
|---|---|
| `http/pipeline` | `configureHttpPipeline(app, options)`: request id → JSON request log → helmet → optional CORS → JSON-only, 1 MB bodies → global validation → RFC 9457 errors → `/api/v1` prefix |
| `http/*` | Problem details (`ApiProblemException`, filter, `buildProblem`), request context (`currentRequestId()`), validation pipe, body policy, root 404 handler |
| `auth/*` | `AccessTokenVerifier` (Ed25519 JWTs, `at+jwt`), `parsePublicJwks`, global `AccessTokenGuard` (deny by default), `@Public()`, `@CurrentPrincipal()`, cookie/issuer constants |
| `health/health` | `HealthController` (`/health/live`, `/health/ready`), `ReadinessState`, `READINESS_CHECKS` for dependencies |
| `openapi/*` | `buildOpenApiDocument`, `setupOpenApi`, `@ApiProblemResponses()`, bearer scheme `BEARER_AUTH` |
| `config/env` | Building blocks for fail-fast config loaders: `readSecret` (`NAME` or `NAME_FILE`), integer/boolean/URL parsing, `ConfigError` |
| `email/*` | `ResendTransport` ([ADR 0012](../../../docs/decisions/0012-transactional-email-resend.md), Proposed): one `fetch` call to Resend with a timeout, `Idempotency-Key` and `EmailDeliveryError` (a category, a retry flag, the status and a sanitized provider code; never the key, recipient, content or provider message). Also `parseResendConfig` (`RESEND_API_KEY`/`_FILE`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `RESEND_API_URL`, `EMAIL_TIMEOUT_MS`) and `escapeHtml`. No service uses it yet |
| `email/smtp-transport`, `email/background-mailer`, `email/layout` | The SMTP path ([ADR 0012](../../../docs/decisions/0012-transactional-email-resend.md)). `parseSmtpConfig` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`/`_FILE`, `SMTP_FROM`, `SMTP_REPLY_TO`, `SMTP_TIMEOUT_MS`); `SmtpTransport` (Nodemailer, STARTTLS mandatory, pooled, same safe `EmailDeliveryError`, `verify()`, `close()`); `BackgroundMailer` (`enqueue` returns at once; bounded concurrency and queue, retries transient failures with backoff, logs kind and delivery facts only, `drain`/`close`); `renderEmail` (branded HTML + text, escaped, one http(s) action). Shared types (`EmailMessage`, `EmailTransport`, `EmailDeliveryError`) live in `email/delivery` |
| `logger` | `createJsonLogger(level)` (Nest's ConsoleLogger in JSON mode) |

## Using it

Consumers import the **compiled** package: `"@smartconnect/backend-kit": "0.0.0"` in `dependencies`. Their `prebuild`, `pretypecheck` and `pretest` scripts run `npm run build --workspace @smartconnect/backend-kit`, as does the root `prelint`, so the build order is never a manual step.

```ts
configureHttpPipeline(app, { logger, errorTypeBaseUrl, trustProxyHops, bodyLimitBytes, production });
// providers: { provide: ACCESS_TOKEN_VERIFIER, useValue: new AccessTokenVerifier(jwks, { issuer, audience }) },
//            { provide: APP_GUARD, useClass: AccessTokenGuard }
```

Every route is then protected unless marked `@Public()`. Handlers read the caller with `@CurrentPrincipal()`, never from request bodies or headers.

## Commands

`npm run build | typecheck | test --workspace @smartconnect/backend-kit` (or `make backend-kit-test`). The gateway's and identity service's suites exercise the pipeline end to end.
