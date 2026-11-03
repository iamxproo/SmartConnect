# 0010. Organizations, membership, invitations and cross-service authorization

- Status: **Proposed**
- Date: 2026-11-03
- Implemented in: organization service (`smartconnect-backend/services/organization`) and workspace service (`smartconnect-backend/services/workspace`), plus identity email verification and gateway routing. Contract: [api/endpoints.md](../api/endpoints.md)

## Context

The product rules:
- SmartConnect is for companies only;
- authorized administrators create organizations;
- employees join by invitation to their email address;
- organization membership does not open private workspaces, teams or channels;
- the backend enforces every boundary.

The schemas for organization and workspace already existed with RLS. No service code existed, and no event broker is approved ([ADR 0002](0002-event-broker-nats-jetstream.md)).

## Decision

1. **Who may create organizations:**
   - A configured allowlist of **verified** email addresses (`ORGANIZATION_CREATOR_EMAILS` on the organization service). Empty means nobody (fail closed).
   - There is no self-service organization creation and no platform-admin concept yet. When one is approved, it replaces the allowlist.
   - The creator becomes the first `owner`.
2. **Roles and permissions:**
   - **Catalogue (G-05):** `organization.update`, `members.invite`, `members.manage`, `workspaces.create`, `departments.manage`, `teams.manage`. Unknown keys grant nothing.
   - **System roles** per organization: `owner` (`*`), `admin` (the whole catalogue), `member` (none).
   - **Owner rules:** only owners grant or remove `owner`. The last owner can neither be demoted nor leave; this is enforced under a row lock, so concurrent demotions cannot leave zero owners.
3. **One authorization gate per service:**
   - **Organization service:** `OrgMemberGuard` resolves the caller's active membership of an active organization inside the tenant's RLS transaction, and enforces `@RequirePermission()`.
   - **Workspace service:** a global guard asks the organization service.
   - **Non-members get 404 everywhere**, so no endpoint is an existence oracle.
4. **Cross-service checks are synchronous API calls that forward the caller's own access token** ("read another service's data through its API", [architecture](../database/architecture.md#communication-rules)):
   - The callee re-verifies the token and answers only what that caller may know. No service credentials exist, and no service can ask "as someone else".
   - Membership is checked on **every request**, so removal from an organization ends workspace access immediately.
   - An unreachable dependency answers **503, never "allowed"**.
   - No caching yet. A Redis cache with a short TTL is a measured follow-up.
5. **Email verification is required** to create an organization and to accept an invitation:
   - Identity sends a verification link at registration, and a completed password reset also verifies the address.
   - Tokens are 256-bit, stored as SHA-256 and single-use.
   - Email links carry tokens in the URL **fragment**, so they never reach server logs.
6. **Invitations:**
   - **Creation:** only by `members.invite`; `owner` invitations only by owners.
   - **Tokens:** 256-bit, stored as SHA-256.
   - **Expiry:** organization setting `invitationExpiryDays`, default 7, range 1–30.
   - **Duplicates:** one pending invitation per address (409 `invitation_pending`); resend instead, which rotates the token so the old link dies.
   - **Revocation:** pending invitations only; idempotent.
   - **Preview:** public, but shows only a hint of the invited address (`a***@example.com`). Tokens travel in request bodies only.
   - **Acceptance:** the caller's verified identity email must equal the invited address (403 `invitation_email_mismatch`, without consuming the token). It is single-use under concurrency and creates the membership in the same transaction.
   - **Unusable invitations:** expired, revoked and used invitations are all `404 invitation_invalid`.
   - **Inviter authority:** an invitation carries its inviter's authority, which is re-checked at acceptance. If the inviter has since been removed, lost `members.invite`, or is no longer an owner for an owner invitation, the invitation is void.
   - **Token binding:** acceptance is bound to the token hash inside the transaction, so a token rotated by a concurrent resend cannot be used.
   - **Delivery:** through an `InvitationNotifier` port (no approved email provider): `dev-mailbox` (development only, `GET /dev/mailbox` on the service) or `disabled` (production must choose explicitly).
7. **Member projection:**
   - `organization_members.display_name` and `email` are copied from identity at join time, so member lists need no cross-service reads. This is an **additive migration**.
   - They go stale if the person changes their name until identity events are consumed (with the event relay).
8. **Departments and teams (G-01, additive migration, RLS):**
   - **Departments** are nested, every member can read them, and `departments.manage` writes them. A department with sub-departments or teams cannot be deleted. Cycles are rejected.
   - **Teams** are public or private; visibility is a required field.
   - **Private teams** are invisible (404, including their member lists) to everyone except their members. That includes owners and `teams.manage` holders: management rights never open private teams.
   - **Leads:** the creator becomes the team's lead. Leads manage plain members only; only team managers who can see the team appoint leads.
   - Only active organization members can join teams, and leaving the organization removes team memberships in the same transaction.
9. **Workspaces and channels:**
   - **Workspaces:**
     - `visibility` is required.
     - **Open** workspaces are visible to and joinable by every organization member.
     - **Private** workspaces are visible only to their members (404 otherwise, even with `*`).
     - Creating one needs `workspaces.create`; the creator becomes admin, and a public `general` default channel is created.
   - **Channels:**
     - `type` is required.
     - **Private** channels are visible only to their members, *including towards workspace admins and organization owners* (admin rights do not expose private content).
     - Workspace guests see only channels they belong to.
   - **Last-admin rules:** last workspace or private-channel admins cannot leave or be demoted. When a workspace admin removes a private channel's sole admin, the longest-standing remaining member is promoted, so the removal does not reveal the channel.
   - All lists are cursor-paginated.

10. **Channel messages (messaging service):**
    - Every request asks the workspace service, as the caller, whether the channel is visible. The messaging service has no admin bypass and no copy of channel membership.
    - **Rights:** reading needs visibility. Posting needs channel membership, and is refused for archived channels. Editing is the sender's alone. Deleting is allowed for the sender or a channel admin (moderation).
    - **Deletion erases the body;** it is not merely hidden.
    - **Idempotency:** `clientMessageId` makes retries safe.
    - **Order:** history is newest first by `(created_at, id)`.
    - **Events:** outbox events carry ids only.
    - **Realtime delivery (Socket.IO)** is not built; clients poll.
11. **Re-invited people start fresh:**
    - The organization service reports when the caller's *current* membership began.
    - The workspace service deletes the caller's workspace and channel memberships that predate it before handling the request.
    - Someone removed and later re-invited does not silently regain private workspaces or channels.

## Consequences

- Every rule above is covered by integration tests on the test database, including an end-to-end suite through the gateway (`tests/integration/{organization,workspace,platform}`).
- Workspace requests cost one extra HTTP call to the organization service; that is acceptable now, and to be measured.
- Removing someone from an organization leaves their `workspace_members` rows in place until the person makes another request in that organization, if ever. The rows are ineffective, because every request re-checks organization membership, and they are pruned on re-invitation (decision 11). Full cleanup follows the `organization.member.removed` event once a relay exists.
- An independent security review (2026-11-03) found several issues; all were fixed with regression tests:
  - private teams visible to team managers (high);
  - re-invite restoring stale memberships, and a team-add racing a member removal (medium);
  - inviter authority not re-checked at acceptance (low–medium);
  - token hash not bound inside the acceptance transaction, and suspended accounts still passing `/auth/me` (low).

## Deferred

- Platform administrator role.
- Guests (G-02).
- Join requests (G-03).
- Workspace settings (G-04).
- Archive and delete endpoints.
- Invitations directly into workspaces or teams.
- Membership caching.
- The event relay and projections.
- Email delivery.
