# 0017. Self-service organization creation and visible invitation delivery

- Status: **Proposed**: implemented and verified locally (2026-11-04), not deployed. The requirement (anyone eligible can start their company's organization; the allowlist is not a permanent production restriction) is the project owner's; the mechanism below awaits their acceptance.
- Date: 2026-11-04
- Amends: [ADR 0010](0010-organizations-and-membership.md) decision 1 (organization creation). Keeps: [ADR 0015](0015-platform-administration.md) decision 7 (a Super Admin creates no organizations).
- Results: `UNIFIED_BACKEND_PHASE0_REPORT.md`, addendum "Product completion, workstream 1".

## Context

ADR 0010 let only an allowlist of verified addresses (`ORGANIZATION_CREATOR_EMAILS`) create organizations, empty meaning nobody, and expected a platform role to replace it. The product now needs self-service onboarding: a person registers, creates their company's organization, becomes its owner and invites employees by email. Opening creation brings abuse and reliability concerns the allowlist hid: unlimited organizations per account, retries creating duplicates, names that render deceptively, and invitation emails that fail without anyone noticing.

Constraints: no schema, migration, role or RLS change; the RLS rule that a tenant transaction sees exactly one organization stays; the seven-process rollback keeps working.

## Decision

1. **Creation mode.** `ORGANIZATION_CREATION` on the organization service:
   - `open`: any active account with a verified email creates organizations;
   - `allowlist`: only `ORGANIZATION_CREATOR_EMAILS`, verified (ADR 0010's rule).

   It is **required in production** (an explicit choice, like `INVITATION_NOTIFIER`); elsewhere the default stays `allowlist`. In `open` mode the allowlist remains meaningful: its addresses are exempt from the cap below.
2. **Eligibility.** A platform Super Admin is always refused (`organization_creation_not_allowed`), in both modes. An unverified email gets `email_not_verified`. `GET /orgs/creation-eligibility` answers `{ allowed, reason }` so the web app offers creation only where it can succeed. Creating an organization grants the owner role in it and nothing else: no platform role.
3. **Ownership cap.** In `open` mode one person may own at most `ORGANIZATION_MAX_OWNED_PER_USER` live organizations (default 10); the next is refused with `organization_limit_reached`. The gateway also limits `POST /orgs` to 10 per hour per person and 20 per hour per client address.
4. **Repeated requests.** A request repeating one that already created an organization (same handle, same name, created and still owned by the caller) gets that organization back with `200` instead of a second organization or a `409`. This covers a double submit and a retry after a lost response. Anything else with a taken handle stays `409 slug_taken`.
5. **Consistency under concurrency.** One person's creations are serialized by a transaction-scoped advisory lock. The decision (cap, repeat) needs the caller's other organizations, which the tenant context cannot see by design, so the creation runs in one transaction in two phases: first with the user context only (the user-scoped read policies, as `withUser`), then in the new organization's tenant context (as `withTenant`) for the writes (`withUserThenNewTenant`). The organization, its system roles, the owner membership and the outbox events are still written together.
6. **Input rules.** Names need a letter or digit and may not contain control or text-direction override characters (creation and updates). Handles may not be shaped like an id, because web addresses accept a handle or an id. Unknown properties are refused as before, so a body cannot carry a role or owner.
7. **Invitation delivery is visible.** Every invitation answer carries `delivery`: `queued`, `sent`, `failed`, `disabled` or `unknown`. The SMTP notifier reports each message's final outcome through the background mailer's new `onSettled` callback; the dev mailbox counts as sent; the disabled notifier as disabled. The state is kept in memory, bounded, per instance, and keyed to the invitation's current link, so a resend's new email is never confused with the old one. The web app shows it, polls while an email is queued, and never says "sent" for an email that was not. A failed invitation stays usable and is resent from the list.
8. **Invitation lifecycle completions.** `GET …/invitations?status=all` lists every invitation, with `acceptedAt`. Resend also renews an invitation marked expired, unless a newer one for that address is pending (`409 invitation_pending`) or the person has joined meanwhile (`409 already_member`).

## Consequences

- Production must set `ORGANIZATION_CREATION` (the organization service refuses to start without it). Self-service needs `open`.
- Delivery state does not survive a restart and is not shared between instances (then `unknown`). Durable delivery tracking needs columns on `organization_invitations`: a schema change, proposed for approval, not made.
- Removing someone from the allowlist does not remove organizations they created.
- The cap counts organizations owned; a person who hands ownership over may create another.

## Alternatives considered

- **Default production to `open`.** Rejected: a deployment should state who may create organizations.
- **A platform role that grants creation** (ADR 0010's expectation). Rejected for self-service: it would still need someone to grant it.
- **Sending invitation email inside the request and failing the invitation on error.** Rejected: it keeps a request waiting for the mail server (ADR 0012), and a transient failure would lose the invitation instead of letting it be resent.
- **Reading the caller's organizations in a separate `withUser` transaction before the tenant one.** Rejected: the lock would not cover both, so concurrent requests could pass the cap or both miss a repeat.
