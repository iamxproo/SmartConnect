# 0014. Transactional email through Gmail SMTP (Nodemailer)

- Status: **Proposed**
- Date: 2026-11-03
- Relation to [ADR 0012](0012-transactional-email-resend.md) (Resend, Proposed):
  - The product owner chose Gmail SMTP for SmartConnect's email.
  - This record keeps ADR 0012's architecture (ports, non-blocking dispatch, error classification, safe logging, tracking off, HTTPS links) and changes only the transport.
  - If this record is approved, it supersedes ADR 0012's choice of provider. The fetch-based Resend transport stays in the kit, unused, so that provider can return without new code.
- Extends: [ADR 0009](0009-identity-and-authentication.md) decision 12 (`AccountNotifier`) and [ADR 0010](0010-organizations-and-membership.md) decision 6 (`InvitationNotifier`).

## Context

**Emails the platform sends today, through the dev mailbox or nothing:**

| Service | Emails |
|---|---|
| Identity | Email verification (at registration and on request), password reset, password changed, "someone tried to register with your email" |
| Organization | Invitations and invitation resends |

**What does not exist:**
- No OTP feature exists: no one-time codes are issued anywhere.
- No email is sent when an invitation is accepted.

The tokens are already sound (ADR 0009, ADR 0010):
- 256-bit random;
- stored only as SHA-256;
- single-use through atomic claims;
- expiring;
- carried in URL fragments.

## Decision

1. **Account and transport:**
   - Gmail SMTP for the account `smartconnectcollab@gmail.com`: `smtp.gmail.com:587` with **STARTTLS required** (`SMTP_SECURE=false` with `requireTLS`, TLS 1.2 or later).
   - The sender is `SmartConnect <smartconnectcollab@gmail.com>`, the authenticated account, as Gmail requires.
   - Authentication uses a **Google App Password**. It needs 2-Step Verification on the account.
2. **Library:** Nodemailer `10.2.1`, pinned exactly in `@smartconnect/backend-kit`. It is MIT-0, has no dependencies, and bundles its own types.
   - The product owner asked for it.
   - Version 10.3.1 was 5 days old, under the project's 7-day minimum, so 10.2.1 was chosen.
3. **Shared transport in the kit (`src/email/`):**
   - `parseSmtpConfig`, `SmtpTransport` (pooled, 2 connections, finite timeouts) and `BackgroundMailer`;
   - a branded `renderEmail` layout, with HTML and plain text, all values escaped, and no remote images or tracking.
   - Each service keeps its own port and templates: `SmtpAccountNotifier` and `SmtpInvitationNotifier`.
4. **Dispatch never blocks a request.** `enqueue()` returns at once.
   - **Why:** for "forgot password", an SMTP round trip only for existing accounts would reveal which addresses have accounts (audit finding).
   - **Retries:** only for failures where the message was certainly not accepted (connection, authentication phase, 4xx before DATA), with backoff.
   - **No retries after DATA:** a failure during or after DATA is not retried, to avoid duplicate emails.
   - **Concurrency:** bounded, with a bounded queue.
   - **On shutdown:** the queue is drained for up to 5 s.
5. **Configuration:**
   - **Variables:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` (or `SMTP_PASSWORD_FILE`) and `SMTP_FROM`, plus optional `SMTP_REPLY_TO` and `SMTP_TIMEOUT_MS`.
   - **Switching it on:** `ACCOUNT_NOTIFIER=smtp` and `INVITATION_NOTIFIER=smtp`. Development keeps the dev mailbox unless asked, and production must choose `smtp` or `disabled` explicitly.
   - **Production links:** `WEB_APP_URL` must be `https`.
   - **Where the settings live locally:** in the gitignored `.secrets/smtp.env`, loaded by the identity and organization `start` scripts. Not in the services' own `.env` files, because `make db-bootstrap` rewrites those.
6. **Secrets:**
   - The App Password is entered only through `make smtp-credentials`, a hidden `read -s` prompt in the person's own terminal.
   - It is never echoed, logged, passed as a command-line argument or put in shell history.
   - It is written only to `.secrets/smtp.env`, with mode 600, inside a directory with mode 700.
   - No credential appears in source, docs, tests or `.env.example`.
   - **Errors** carry a category, the SMTP reply code and a sanitized Nodemailer code. Never the server's reply text, recipients, subjects or bodies.
7. **Verification:**
   - Automated tests use a local fake SMTP server and mock transports only.
   - `make smtp-check` verifies login without sending.
   - `make smtp-test-email TO=…` sends one email, only to an address the person names.

## Consequences

- Email works locally once `make smtp-credentials` has run. Production still needs the open points below.
- **No DNS work is needed.** The sender is a `gmail.com` address, so SPF, DKIM and DMARC are Google's, and no sending domain is configured.
- **Open and click tracking:** do not exist on this path. No pixels, no rewritten links.
- **Lost emails:** an email can still be lost on a crash or after its retries run out. Every important flow can be re-requested by a person, so a durable outbox stays deferred to [ADR 0007](0007-job-queues-bullmq.md).
- **Bounce handling:** none. Bounces go to the Gmail inbox.

## Open points (review before production)

1. **Gmail limits:** Gmail is a personal mailbox, not a transactional service. Google enforces per-account daily sending limits and may suspend accounts that send many emails to non-existent addresses. Check the current limits for the account type before relying on it, and consider a Google Workspace SMTP relay or a transactional provider (ADR 0012) for production volume.
2. **App Password policy:** whether App Passwords stay available for this account type, and who holds and rotates the password.
3. **Data processing:** Google processes recipient addresses and email content.
4. **Development safety:** with real email turned on locally, registrations with made-up addresses produce bounces against the account. Keep the dev mailbox for routine development and the browser tests; they never load `.secrets/smtp.env`.
