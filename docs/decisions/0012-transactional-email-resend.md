# 0012. Transactional email through Resend

- Status: **Proposed**
- Date: 2026-11-03
- Extends:
  - [ADR 0009](0009-identity-and-authentication.md) decision 12: the identity service's `AccountNotifier` port.
  - [ADR 0010](0010-organizations-and-membership.md) decision 6: the organization service's `InvitationNotifier` port.

  This record adds a real delivery path behind both ports. It changes neither port, and it changes nothing else in either record.
- Implemented so far: the shared transport in [`@smartconnect/backend-kit`](../../smartconnect-backend/packages/backend-kit/README.md) (`src/email/`). No service uses it yet.

## Context

- **Today:**
  - ADR 0009 lists "Email delivery" as deferred because there is "no approved provider". Production must run with `ACCOUNT_NOTIFIER=disabled`, so password reset does not work there.
  - ADR 0010 does the same for invitations (`INVITATION_NOTIFIER=disabled`).
  - Locally, both services keep messages in an in-memory `dev-mailbox`.
- **Constraints from ADR 0009** (decision 12) that stay in force:
  - Tokens, passwords, refresh tokens and email addresses are **never logged**.
  - Links carry tokens in the URL **fragment**.
- **Findings of the read-only email audit (2026-11-03):**
  1. **Account-existence oracle:** every email is sent inside the request, after the commit. "Forgot password" sends only for existing accounts, so a slow network call to a provider would reveal which addresses have accounts.
  2. **Lost emails:** a failed send is logged and lost. There is no timeout and no retry.
  3. **Unsafe logging:** the failure log line includes the raw error message, which a provider could fill with the recipient's address.
- **Verified against Resend's API documentation (2026-11-03):**
  - **Request:** `POST https://api.resend.com/emails` with `Authorization: Bearer …`. A `User-Agent` header is required (403 without one). HTTPS only.
  - **Idempotency:** an `Idempotency-Key` header of up to 256 characters, kept for 24 hours.
  - **Errors:** 409 when a key is reused with a different body, or while the first request is still running.
  - **Rate limit:** 10 requests per second per team by default. Exceeding it returns 429, with `retry-after`.
  - **Open and click tracking:** set per domain, and off by default. Click tracking rewrites every link through a tracking subdomain.
  - **API keys:** either `full_access` or `sending_access`. A `sending_access` key can be limited to one domain.
  - **Sending region:** chosen per domain: `us-east-1` (default), `eu-west-1`, `sa-east-1` or `ap-northeast-1`.

## Decision

1. **Provider: Resend** for transactional email only:
   - **Account emails:** verification, password reset, password changed, registration attempt.
   - **Organization emails:** invitations, invitation resends, and later the acceptance notice.

   Marketing and bulk email are out of scope.
2. **One shared transport, built on Node's own `fetch`, with no SDK:**
   - **Location:** `@smartconnect/backend-kit` (`src/email/`), independent of NestJS.
   - **Why not the SDK:** the services need a single endpoint. Raw `fetch` (Node 22) means no new dependency, so no supply-chain surface or version tracking. It also gives full control over:
     - the timeout;
     - redirects, which are never followed, so the key is never sent anywhere else;
     - the `User-Agent`;
     - error classification;
     - what may appear in errors.

     Resend recommends its SDKs for most uses, so this is a deliberate exception, revisited if more endpoints are needed.
   - **Infrastructure only:** the kit gets no templates and no message types.
3. **Ports and adapters stay per service:**
   - `AccountNotifier` (identity) and `InvitationNotifier` (organization) keep their own message types.
   - Each service gets a Resend adapter that renders its own templates and calls the transport.
   - `dev-mailbox` and `disabled` remain. Production chooses `resend` or `disabled` explicitly, and still never `dev-mailbox`.
4. **Keys:**
   - **One Resend API key per service and per environment.** Each key has `sending_access` and is limited to the sending domain: never `full_access`.
   - **Loading:** `RESEND_API_KEY` or `RESEND_API_KEY_FILE`, through the kit's `readSecret` convention.
   - **Never exposed:** keys never appear in logs, errors or configuration problems.
   - **Rotation:** create a new key, deploy it, then delete the old one. Resend never shows a key's value again after creation.
5. **Sender:**
   - `EMAIL_FROM` is required: `address` or `Name <address>`, on a domain verified with Resend.
   - `EMAIL_REPLY_TO` is optional.
   - `RESEND_API_URL` defaults to `https://api.resend.com`. It is overridable only so tests can use a local fake server, and it must be `https` in production.
6. **Links:**
   - Email links keep their tokens in the URL fragment (ADR 0009).
   - **HTTPS only in production:** `WEB_APP_URL` must be `https` there. Today it also accepts `http`; each service's configuration change adds the rule.
7. **Tracking stays off:**
   - Open tracking and click tracking are both **off** for the sending domain.
   - **Click tracking** would rewrite every link, including its `#token=…` fragment, through a tracking redirect: a one-time token would pass through a third party.
   - **Open tracking** adds a tracking pixel, which we have no reason to use.
   - Resend's default is off. The production checklist verifies it, and turning it on needs a new decision.
8. **Domain authentication:**
   - **Subdomain:** send from a dedicated subdomain (for example `mail.<company domain>`), so its reputation is isolated.
   - **SPF and DKIM:** use Resend's records.
   - **DMARC:** start with `p=none` and reporting, then move to `quarantine` or `reject` once reports are clean.
9. **Dispatch is non-blocking, with bounded retries.**
   - **Respond first:** a request responds before the provider is called. This closes the timing oracle on public endpoints (audit finding 1) and keeps provider latency out of request latency.
   - **Retries:** a few attempts, in-process, with exponential backoff and jitter. They apply only to retryable failures, and honour `retry-after`.
   - **Idempotency key:** taken from non-secret data, such as the message kind and the token's hash, or the invitation id and the token's hash. Never the raw token. A retry after a timeout therefore cannot send twice.
   - **Failure logs:** the message kind, a category, the HTTP status and the provider's error name. Never the recipient, key, subject, body, token or the provider's message text.
10. **Error classification** (the transport):

    | Outcome | Category | Retry? |
    |---|---|---|
    | No response: connection refused, reset, DNS | `network` | yes |
    | No response within the timeout | `timeout` | yes |
    | 429 (rate limit or quota) | `rate_limited` | yes, after `retry-after` when given. Quota errors keep failing until the quota resets: callers may read the provider code |
    | 5xx | `provider_error` | yes |
    | 400, 422 | `rejected` | no |
    | 401, 403 (key missing, invalid or restricted; domain not verified; quota) | `unauthorized` | no |
    | 409 `concurrent_idempotent_requests` | `conflict` | yes, with the same key |
    | 409, any other code | `conflict` | no |
    | Any other status, including a success response without a message id | `unexpected_response` | no |
    | Invalid input, caught before sending | `invalid_message` | no |

11. **A durable email outbox is deferred** to the job-queue decision ([ADR 0007](0007-job-queues-bullmq.md), Proposed).
    - ADR 0007 already lists "email provider throttling" as a BullMQ use case. It names database-backed claiming for work that is represented by a database row.
    - **Why waiting is acceptable:** until then, every email that matters can be re-requested by a person: resend verification, request a reset again, resend the invitation.
    - **What can still be lost:** a process crash, or retries running out, loses the email. For the two security notices (password changed, registration attempt), that loss is silent, and it is accepted until the outbox exists.
    - **When the outbox is built:** it stores only the *intent* (for example "send a verification email to user X") and mints a fresh token at send time, as an invitation resend already does. Storing raw tokens for later delivery would undo the hash-only storage of ADR 0009 and ADR 0010.

## Consequences

- Production can send account and invitation emails once both services are configured (later tasks). Until then, nothing changes: no service uses the transport.
- **No new npm dependency.** The transport is one module of about 240 lines, comments included. It is tested against a local fake server and never calls Resend in tests.
- **Lost emails remain possible** (crash or exhausted retries) until ADR 0007 is decided.
- **Abuse protection is not finished:** the API gateway needs limits that are not built yet:
  - invitation resends (today only the general 300/min per user);
  - registration per target address (for the "someone tried to register" email).

  They belong to the service tasks.
- **Templates:**
  - Each service renders its own HTML and plain text.
  - Every value that is not a literal of the template goes through `escapeHtml`.
  - Text a person typed is never turned into a link.

## Needs review before production (open)

1. **Approval of this record and of Resend as a sub-processor.** This needs a data processing agreement: Resend handles recipient addresses, names, organization and role names, and links that carry one-time tokens.
2. **Sending region:** the `us-east-1` default, or `eu-west-1` or another region, depending on where the customers are.
3. **Retention at Resend:** how long email content and logs are kept, and whether that is acceptable for messages that contained (now expired) one-time links.
4. **Domain:** the sending domain or subdomain, and the DMARC rollout.
5. **Plan and quotas:** they must cover registration and invitation peaks, at 10 requests per second per team by default.
6. **Bounces and complaints:** webhook handling for bounces and complaints. Deferred; it needs a public, signature-verified endpoint.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Resend SDK (`resend` package) | One more dependency for one endpoint. Less control over timeout, redirects and error content |
| SMTP (`nodemailer`) against Resend or any provider | Adds a dependency and connection handling. Idempotency and error classification are weaker than with the HTTP API |
| Amazon SES, Postmark, SendGrid | Viable. Resend was proposed by the product owner. The transport is small, so changing providers is local to `src/email/` |
| Self-hosted mail server | Running deliverability and reputation ourselves is out of proportion for transactional email |
| Sending inside the request, as today | The timing oracle and provider latency (audit findings 1 and 2) |
