# @smartconnect/organization-service

Sole owner of PostgreSQL schema `organization`. Covers:
- organizations, roles and the permission catalogue;
- members, and invitations with their lifecycle;
- departments and teams.

It is an internal service (port 3102); clients reach it through the [API gateway](../../api-gateway/README.md) under `/api/v1/orgs/**` and `/api/v1/invitations/**`. API: [docs/api/endpoints.md](../../../docs/api/endpoints.md). Decisions: [ADR 0010](../../../docs/decisions/0010-organizations-and-membership.md) (*Proposed*).

## Run

```bash
make auth-dev-keys db-migrate prisma-generate                           # once
make organization-creators     # once, in your terminal: who may create organizations → .secrets/organization.env
make organization-start        # needs identity on :3101
curl 'http://127.0.0.1:3102/dev/mailbox?to=invitee@example.com'          # invitation emails (development only)
```

| Task | Command |
|---|---|
| Unit tests | `make organization-test` |
| Integration tests (test database; real identity service; end to end through the gateway) | `make db-test` |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` / `_FILE` | **required** | Runtime role `sc_organization_app` (`services/organization/.env`, written by `make db-bootstrap`) |
| `AUTH_JWT_PUBLIC_JWKS` / `_FILE` | **required** | The identity service's public keys |
| `ORGANIZATION_CREATOR_EMAILS` | empty (nobody) | **Verified** emails allowed to create organizations. Kept in the gitignored `.secrets/organization.env` (written by `make organization-creators`, loaded by the `start` script after `.secrets/smtp.env`; `make db-bootstrap` never touches it). A value set in the environment takes precedence. The startup log reports only how many there are |
| `IDENTITY_SERVICE_URL` | `http://127.0.0.1:3101` outside production | Used to read the caller's own account (email, verified) |
| `WEB_APP_URL` | `http://127.0.0.1:5173` outside production | Invitation links. **Required in production, and https there** |
| `INVITATION_NOTIFIER` | `dev-mailbox` outside production | `dev-mailbox`, `smtp` or `disabled`. **Required in production**, where `dev-mailbox` is refused |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` / `_FILE`, `SMTP_FROM` | **required** with `smtp` | Gmail: `smtp.gmail.com`, the account, an app password (spaces are ignored), `SmartConnect <that account>` |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` | `false` = STARTTLS, always required; `true` = TLS from the start (465) |
| `SMTP_REPLY_TO`, `SMTP_TIMEOUT_MS` | none / `15000` | Reply-To address; connection and greeting timeout (1000–60000) |

With `smtp`, `SmtpInvitationNotifier` renders the invitation (`src/notifications/invitation-templates.ts`) and queues it in the kit's `BackgroundMailer`: `send` returns at once, delivery is retried with backoff, logs carry the message kind and failure category only, and queued mail is sent (up to 5 s) on shutdown. Organization, role and inviter names are escaped and never become links. `npm start` also loads the gitignored repo-root `.secrets/smtp.env`.
| `HOST`, `PORT`, `TRUST_PROXY_HOPS`, `NODE_ENV`, `LOG_LEVEL`, `API_DOCS_ENABLED`, `ERROR_TYPE_BASE_URL` | `127.0.0.1`, `3102`, `1` | As in the other services |

## What it enforces (each covered by tests)

- **Organization-scoped routes:**
  - Every one passes `OrgMemberGuard`: the caller must be an active member of an active organization. That membership is resolved inside the tenant's RLS transaction.
  - Each handler declares its permission with `@RequirePermission()`.
  - Non-members get 404.
- **Owners:** only owners grant or remove the owner role, and the last owner cannot leave or be demoted (row-locked).
- **Platform administration** ([ADR 0015](../../../docs/decisions/0015-platform-administration.md)): `GET /api/v1/admin/organizations` lists every organization (directory fields and member counts only) for a Super Admin. `SuperAdminGuard` asks the identity service on every request (`/auth/me`: `platformRoles`, `passwordChangeRequired`). The ids come from the SECURITY DEFINER function `platform_organization_ids()`, and each organization is read in its own tenant context. A Super Admin is no member of anything: organization-scoped routes answer 404, and creating an organization still needs the allowlist.
- **Invitations:**
  - Tokens are 256-bit, stored as SHA-256 and single-use, even under concurrency. They expire, can be revoked, and a resend rotates them.
  - Acceptance needs the caller's **verified** email to equal the invited address.
  - Preview shows only a hint of the address.
- **Private teams:** invisible (404, member lists too) to everyone except their members, owners and team managers included. The creator leads the team.
- **Departments:** cycles are rejected, and a department that still has sub-departments or teams cannot be deleted.
- **Domain events:** written to `organization.outbox_events` (ids only): `organization.created`, `organization.member.joined`, `organization.member.removed` and `organization.member.role_changed`.
