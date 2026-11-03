# Schema design

This document holds the *why*: purpose, keys, nullability, index rationale, tenancy, retention and security for each entity. The *exact* columns, types, defaults, constraints and indexes are generated from the live database in [schema-reference.md](schema-reference.md), and diagrams are in [erd.md](erd.md). The source of truth is each service's `smartconnect-backend/services/<svc>/prisma/schema.prisma` plus its migrations.

## Conventions

| Topic | Convention |
|---|---|
| Naming | Tables snake_case plural (`@@map`), columns snake_case (`@map`), Prisma models PascalCase singular |
| Primary keys | `uuid`, generated as **UUIDv7** by Prisma (`@default(uuid(7))`): time-ordered for B-tree locality and keyset pagination. Pure join tables use composite keys of UUIDs (e.g. `message_reactions (message_id, user_id, emoji)`). PostgreSQL 16 has no built-in v7 generator, so raw-SQL inserts must supply ids |
| Tenant key | `organization_id uuid NOT NULL` on **every** tenant table, including children (denormalised), so RLS needs no joins |
| Tenant-safe FKs | Parents expose `UNIQUE (organization_id, id)`. Required **and** optional relations reference `(organization_id, <fk>)`, so a child can never point at another tenant's parent |
| Cross-service references | Plain UUID columns with **no FK**, annotated `→ <service>.<table> (logical)` in the Prisma schema. Kept consistent by events ([relationships.md](relationships.md)) |
| Timestamps | `timestamptz(3)` (ms, matching JavaScript `Date`). Every table has `created_at`; mutable tables have `updated_at` (DB default `now()` + Prisma `@updatedAt`). Append-only logs use `occurred_at` |
| Soft delete | **Only where justified** (restore window, thread/reference integrity, or blob cleanup): users, organizations, workspaces, channels, messages, files, documents, document/task comments, task lists, tasks, workflows, meeting recordings. Membership, join, reaction, bookmark and read-state rows are hard-deleted. Soft-deleted rows are purged by retention jobs |
| Enumerations | PostgreSQL enums for small, stable sets (status, role). Open-ended types (`meeting_events.type`, `notifications.type`, event types) are `varchar` validated by the service |
| JSON | `jsonb` only for schemaless, service-validated payloads (preferences, settings, event payloads, editor documents). Never for data that is filtered or joined |
| Invariants | CHECK constraints in the hand-written migration section (e.g. `conversations_channel_kind_chk`, `webhooks_https_chk`, `messages_body_length_chk`) |
| Secrets | Hashes (SHA-256 for tokens, Argon2id for passwords) or envelope-encrypted `bytea`. Never plaintext |
| Messaging infrastructure | Every schema has `outbox_events` (transactional outbox) and `processed_events` (idempotent consumers) |

## Candidate inventory: decisions

The entity inventory in the brief was treated as candidates. Outcome:

| Candidate | Decision | Rationale |
|---|---|---|
| identity: users, credentials, user_profiles, sessions, devices | **Approved** | |
| identity: user_preferences | **Merged** into `user_profiles.preferences` (jsonb) | Schemaless UI settings, always read with the profile, single writer |
| identity: verification_tokens | **Added** | Email verification, password reset and email change need single-use hashed tokens |
| organization: organizations, members, invitations, roles | **Approved** | |
| workspace: workspaces, workspace_members, channels, channel_members | **Approved** | |
| workspace: channel_permissions | **Deferred** | `channels.posting_policy` + `channel_members.role` + channel `type` cover current needs; a per-channel ACL table adds complexity without a use case |
| messaging: all nine candidates | **Approved** | `message_read_states` is a per-conversation cursor, not per-message receipts |
| presence: presence_sessions | **Rejected (Redis)** | Ephemeral heartbeats (~1,500/min) have no durable value. Redis keys with TTL |
| presence: user_status | **Approved** as `user_statuses` | User-set status is durable |
| meetings: all five candidates | **Approved** | Metadata only; media flows through the SFU |
| files: files, file_versions | **Approved** | |
| files: file_permissions | **Deferred** | Access derives from the owning context (message, document, task); the owner service authorizes and requests a signed URL. Revisit with explicit file sharing |
| notifications: all three candidates | **Approved** | The `notifications` row *is* the in-app delivery; `notification_deliveries` covers push/email |
| search: saved_searches, search_history | **Approved** | |
| search: search_documents | **Added** | Search must not read other schemas; it indexes an event-fed projection with access scopes |
| documents: all three candidates | **Approved** | |
| tasks: all four candidates | **Approved** | |
| workflows: all four candidates | **Approved** | |
| integrations: integrations (catalog) | **Rejected (code registry)** | The provider catalog ships with code; `provider` is a registry key. Avoids a global non-tenant table |
| integrations: integration_connections, webhooks, webhook_deliveries | **Approved** | Webhooks are outgoing only; incoming webhooks deferred (they need a cross-tenant token lookup) |
| administration: audit_logs, security_policies, retention_policies | **Approved** | |
| all schemas: outbox_events, processed_events | **Added** | Transactional outbox + idempotent consumers |

**Totals:** 54 domain tables + 28 messaging-infrastructure tables + 14 `_prisma_migrations` = 96.

Pre-production policy: until the first production deployment, `*_init` migrations may be regenerated (team agreement required). From the first production deployment on, migrations are forward-only ([migrations.md](migrations.md)).

---

## identity

Global, **not tenant-scoped**: one account can belong to many organizations. No RLS; the identity service scopes every query by the authenticated user, and no other role can reach the schema.

#### `users`
- **Purpose:** login identity. **PK:** `id`. **Unique:** `email_normalized` (login lookup).
- **Nullable:** `email_verified_at` (unverified), `last_login_at`, `deleted_at`.
- **Retention:** soft delete. PII (email, profile) is erased after a 30-day grace period; `email_normalized` is replaced by a tombstone so the address can be reused. Other services react to `identity.user.deleted`.
- **Security:** `email_normalized` CHECK forces lowercase. No secrets on this table.

#### `credentials`
- **Purpose:** secret material, separated from `users`. **PK:** `id`. **FK:** `user_id → users` CASCADE. **Unique:** `(user_id, type)`.
- **Security:** `secret` holds an Argon2id hash (password) or an envelope-encrypted TOTP seed. Never selected by default queries.
- **`change_required`:** the password was issued by someone else (the development Super Admin seed, [ADR 0015](../decisions/0015-platform-administration.md)) and must be replaced before platform administration. Cleared by every change or reset. CHECK: only on `type = password`.

#### `platform_role_assignments`
- **Purpose:** who holds a platform-wide role ([ADR 0015](../decisions/0015-platform-administration.md)); `role` is the `PlatformRole` enum (`super_admin`). Separate from per-organization roles. **PK:** `(user_id, role)`. **FK:** `user_id → users` CASCADE.
- **Security:** read on every administration request; never copied into access tokens, so removing a row takes effect at once.

#### `user_profiles`
- **Purpose:** display data + UI preferences (1:1). **PK/FK:** `user_id → users` CASCADE.
- **Nullable:** `full_name`, `avatar_object_key` (public avatar bucket key; avatars are not tenant files).
- **Retention:** erased with the user.

#### `devices`
- **Purpose:** client installations and their push tokens. **FK:** `user_id → users` CASCADE. **Unique:** `push_token`.
- **Index:** `(user_id)` lists a user's devices. **Nullable:** `push_*` (web without push), `revoked_at`.
- **Security:** push tokens are credentials for sending to a device; revoke on logout/uninstall.

#### `sessions`
- **Purpose:** login sessions with rotating refresh tokens. **FKs:** `user_id → users` CASCADE, `device_id → devices` SET NULL.
- **Unique:** `refresh_token_hash`, `previous_refresh_token_hash` (reuse of the previous token signals theft, so the session is revoked).
- **Indexes:** `sessions_active_by_user_idx (user_id) WHERE revoked_at IS NULL` lists active sessions; `(expires_at)` drives the cleanup job.
- **Retention:** delete 30 days after expiry/revocation. **Security:** SHA-256 hashes only; `ip_address`/`user_agent` are PII. CHECK `expires_at > created_at`.

#### `verification_tokens`
- **Purpose:** single-use tokens for email verification, password reset and email change. **Unique:** `token_hash`.
- **Indexes:** `(user_id, purpose)` invalidates older tokens; `(expires_at)` drives cleanup. **CHECK:** `target_email` iff `purpose = email_change`.
- **Retention:** delete 7 days after expiry/consumption.

## organization

The tenant root. RLS on all four tables, plus user-scoped read policies ([tenant-isolation.md](tenant-isolation.md#policies)).

#### `organizations`
- **Purpose:** a tenant. **PK:** `id` (it is the tenant key). **Unique:** `slug` among live organizations (partial `WHERE deleted_at IS NULL`).
- **Retention:** soft delete with a 30-day restore window, then `organization.organization.deleted` triggers a hard purge in every service.
- **Security:** slug CHECK `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.

#### `organization_roles`
- **Purpose:** built-in (`is_system`) and custom roles with permission keys. **FK:** `organization_id → organizations` CASCADE.
- **Unique:** `(organization_id, key)`; `(organization_id, id)` is the target of tenant FKs. **CHECK:** key format.
- **Security:** permission keys are validated by the service. Built-in roles are immutable in the service layer.

#### `organization_members`
- **Purpose:** user ↔ organization membership with a role. **FKs:** `organization_id → organizations` CASCADE; `(organization_id, role_id) → organization_roles` RESTRICT (a role cannot be deleted while assigned).
- **Unique:** `(organization_id, user_id)`. **Indexes:** `(user_id)` answers "my organizations", the one deliberate cross-tenant read; `(organization_id, role_id)`.
- **Retention:** hard delete on leave/removal; history lives in `audit_logs`. The "at least one owner" invariant is enforced by the service.

#### `organization_invitations`
- **Purpose:** email invitations. **FK:** `(organization_id, role_id) → organization_roles` CASCADE.
- **Unique:** `token_hash`; one **pending** invitation per email per organization (partial unique). **Index:** `(organization_id, status, created_at DESC)` for the admin list.
- **Retention:** delete 90 days after acceptance/expiry. **Security:** token stored as SHA-256 only; resolved through `resolve_invitation_token()`. CHECK `accepted_at` iff `status = accepted`.

## workspace

RLS on all tables. Channel membership here is **authoritative** and projected into messaging via events.

#### `workspaces`
- **Purpose:** a team space inside an organization. **Unique:** `(organization_id, id)`; `(organization_id, slug)` among live workspaces.
- **Nullable:** `description`, `archived_at` (read-only), `deleted_at` (soft delete).

#### `workspace_members`
- **FK:** `(organization_id, workspace_id) → workspaces` CASCADE. **Unique:** `(workspace_id, user_id)` (membership check). **Index:** `(organization_id, user_id)` for "my workspaces".

#### `channels`
- **Purpose:** public/private channels. **FK:** `(organization_id, workspace_id) → workspaces` CASCADE.
- **Unique:** `(organization_id, id)`; `(workspace_id, name)` among live channels (also serves "channels in a workspace").
- **CHECK:** name `^[a-z0-9][a-z0-9_-]{0,79}$`. **Security:** private-channel visibility is enforced by the service (membership), not RLS.

#### `channel_members`
- **FK:** `(organization_id, channel_id) → channels` CASCADE. **Unique:** `(channel_id, user_id)`. **Index:** `(organization_id, user_id)`.

## messaging

Highest-volume schema. RLS on all nine tables.

#### `conversations`
- **Purpose:** a message stream: `channel` (mirrors a workspace channel), `direct` (2 users) or `group`.
- **Unique:** `(organization_id, id)`; `channel_id` (one conversation per channel); `(organization_id, direct_key)` (one DM per user pair; `direct_key = "<smallerId>:<largerId>"`).
- **CHECKs:** `channel_id` iff `kind = channel`; `direct_key` iff `kind = direct`.

#### `conversation_members`
- **FK:** `(organization_id, conversation_id) → conversations` CASCADE. **Unique:** `(conversation_id, user_id)`, the per-message authorization check. **Index:** `(organization_id, user_id)` for "my conversations".
- For channel conversations this is a **projection** of `workspace.channel_members`, maintained by events.

#### `messages`
- **Purpose:** messages and thread replies. **FKs:** `(organization_id, conversation_id) → conversations` CASCADE; `(organization_id, thread_root_id) → messages` CASCADE.
- **Unique:** `(organization_id, id)`; `(conversation_id, sender_user_id, client_message_id)` makes client retries idempotent.
- **Indexes:** `messages_timeline_idx (conversation_id, created_at DESC, id DESC) WHERE thread_root_id IS NULL` gives the timeline keyset page. `messages_thread_replies_idx (thread_root_id, created_at) WHERE thread_root_id IS NOT NULL` gives the thread view.
- **Nullable:** `thread_root_id` (top-level), `sender_user_id` (system messages), `client_message_id`, `edited_at`, `deleted_at`.
- **CHECKs:** body ≤ 40,000 chars; not its own thread root; a sender is required unless `type = system`.
- **Retention:** organization policy `messages` (default indefinite). Deletion is soft: the body is scrubbed immediately and the row purged by retention. **Security:** bodies may contain secrets/PII. Never log them; they reach search only with access scopes.

#### `message_threads`
- **Purpose:** thread summary (reply count, last reply, participants), keeping counter updates off `messages`. **PK/FK:** `root_message_id`, composite → `messages` CASCADE (1:1). **Index:** `(conversation_id, last_reply_at DESC)` for the "threads" view.

#### `message_reactions`
- **PK:** `(message_id, user_id, emoji)`, so one row per user per emoji. **FK:** composite → `messages` CASCADE.

#### `message_attachments`
- **FK:** composite → `messages` CASCADE. `file_id → files.files` (logical). **Unique:** `(message_id, file_id)`. **Index:** `(organization_id, file_id)` finds referencing messages when a file is deleted.

#### `message_mentions`
- **Purpose:** the mentions inbox. **Index:** `message_mentions_inbox_idx (organization_id, mentioned_user_id, created_at DESC) WHERE mentioned_user_id IS NOT NULL`.
- **CHECK:** `mentioned_user_id` iff `kind = user` (`@channel`/`@here` are expanded through membership at read time).

#### `message_bookmarks`
- **PK:** `(user_id, message_id)`. **Index:** `(organization_id, user_id, created_at DESC)` for "saved items". Private to the user (service-enforced).

#### `message_read_states`
- **Purpose:** read cursor per (conversation, user): unread counts and mention badges. **PK:** `(conversation_id, user_id)`. **Index:** `(organization_id, user_id)` for all unread states of a user.
- `last_read_message_id` has no FK, so the cursor survives message purges. A separate table because it is written on every read (isolates churn from membership rows).

## presence

#### `user_statuses`
- **Purpose:** user-set status and availability per organization. **PK:** `(organization_id, user_id)`. RLS.
- Live online/offline, connection counts and typing indicators are **Redis** keys with TTL. Expired statuses are treated as cleared on read (no sweeper).

## meetings

Metadata only (10–30 concurrent rooms means low volume). RLS on all tables.

#### `meetings`
- **Unique:** `(organization_id, id)`; `media_room_id` (SFU room). **Indexes:** `(organization_id, status, scheduled_start_at)` for upcoming/live meetings; `(organization_id, channel_id) WHERE channel_id IS NOT NULL` for a channel's meetings.
- **CHECKs:** end after start; `scheduled` requires a start; `max_participants > 0`. **Nullable:** all scheduling and context columns (instant meetings have none).

#### `meeting_invitations`
- **Unique:** `(meeting_id, invitee_user_id)`, `(meeting_id, invitee_email)`. **Index:** `(organization_id, invitee_user_id)` for "my invitations". **CHECK:** user or email present. External emails are PII.

#### `meeting_participants`
- **Purpose:** one row per join session (rejoins create rows), giving accurate attendance. **Indexes:** `(meeting_id, joined_at)`; `(organization_id, user_id, joined_at DESC)` for the user's history.
- **CHECKs:** user or guest name present; `left_at >= joined_at`.

#### `meeting_recordings`
- `file_id → files.files` (logical) once processed. Soft delete; the blob is deleted by the files service via event. Retention: organization policy `meeting_recordings`. Recordings are sensitive personal data.

#### `meeting_events`
- Append-only timeline (joins, leaves, recording/screen-share). **Indexes:** `(meeting_id, occurred_at)`; `(organization_id, occurred_at)` for retention. Default retention 90 days.

## files

#### `files`
- **Purpose:** file metadata (bytes in object storage). `context_type` + `context_id` identify the owning resource in another service (logical).
- **Indexes:** `(organization_id, context_type, context_id)` finds files of a message/document/task; `(organization_id, uploaded_by_user_id, created_at DESC)` gives "my uploads".
- **Security:** status `scanning`/`quarantined` blocks downloads. Downloads only via short-lived signed URLs requested by the owning service after its own authorization. Soft delete; the blob is deleted after the grace period.

#### `file_versions`
- **Unique:** `(file_id, version_number)`, `storage_key` (generated `<org>/<file>/<version>`, never user-supplied, which prevents path tricks). **CHECKs:** sizes ≥ 0, version ≥ 1, checksum is 64 hex chars.

## notifications

#### `notifications`
- **Indexes:** `(organization_id, recipient_user_id, created_at DESC)` for the inbox; `notifications_unread_idx (organization_id, recipient_user_id) WHERE read_at IS NULL` for the badge count. Default retention 90 days.

#### `notification_preferences`
- **Unique:** `(organization_id, user_id, scope_type, scope_id)`. `scope_id` is the organization id for organization scope, so the key never contains NULL.

#### `notification_deliveries`
- **Unique:** `(notification_id, transport)`. **Index:** `notification_deliveries_due_idx (next_attempt_at) WHERE status IN (pending, failed, sending)` is used by `claim_notification_deliveries()`. Leases via `locked_until`. Retention 30 days.

## search

#### `search_documents`
- **Purpose:** event-fed index of searchable resources. **Unique:** `(organization_id, source_type, source_id)` makes upserts idempotent.
- **Indexes:** GIN on `search_vector` (full-text, `simple` config: language-neutral); GIN on `access_scope_ids`.
- **Security:** every query must add `access_scope_ids && <caller's conversation/channel/workspace ids>`. RLS alone would expose private channels inside the tenant. `source_updated_at` drops out-of-order events.

#### `saved_searches`, `search_history`
- Per-user. `search_history` is personal data: default retention 30 days (seeded in the demo tenant's `retention_policies`).

## documents

#### `documents` / `document_versions` / `document_comments`
- `documents` indexes: `(organization_id, workspace_id, updated_at DESC)`, `(organization_id, owner_user_id, updated_at DESC)` for the two listing views. Visibility `private | workspace | organization` is enforced by the service.
- `document_versions`: immutable snapshots, unique `(document_id, version_number)`. Real-time co-editing state (Yjs) is out of scope for this phase.
- `document_comments`: optional composite self-FK for replies; `anchor` jsonb holds the selection range. Soft delete.

## tasks

#### `task_lists` / `tasks` / `task_assignees` / `task_comments`
- `tasks` indexes: `(task_list_id, status, position)` for board/list views; `tasks_open_due_idx (organization_id, due_at) WHERE due_at IS NOT NULL AND completed_at IS NULL` for reminders; `(parent_task_id)` partial for subtasks. CHECKs: not its own parent; `done` requires `completed_at`.
- `position` is a fractional sort key (double precision) that the service renormalises when gaps get too small.
- `task_assignees` PK `(task_id, user_id)`, index `(organization_id, user_id)` for "my tasks".

## workflows

- `workflow_versions` are immutable (new version per change) so every execution is reproducible. Unique `(workflow_id, version_number)`.
- `workflow_triggers`: CHECKs require `event_type` for `event` triggers and `cron_expression` for `schedule` triggers. Index `workflow_triggers_due_idx (next_run_at) WHERE is_enabled AND next_run_at IS NOT NULL` for the scheduler.
- `workflow_executions`: FK to the exact version (RESTRICT, so a version cannot vanish under its history); `trigger_id` has no FK, so history outlives trigger edits. Index `workflow_executions_active_idx` for queued/running. Default retention 30–90 days.

## integrations

- `integration_connections`: unique `(organization_id, provider, external_account_id)`. OAuth tokens only as `credentials_ciphertext` + `credentials_key_id`.
- `webhooks`: CHECK `target_url ~ '^https://'`; SSRF filtering (no private IP ranges) in the service; `failure_count` auto-disables. The signing secret is encrypted.
- `webhook_deliveries`: unique `(webhook_id, event_id)` (idempotent fan-out); due index used by `claim_webhook_deliveries()`. Response bodies truncated to 1 KB. Retention 30 days.

## administration

#### `audit_logs`
- **Purpose:** central, append-only audit trail fed by every service's outbox. **Unique:** `event_id` (idempotent ingestion).
- **Indexes:** `(organization_id, occurred_at DESC)` for the timeline; `(organization_id, resource_type, resource_id, occurred_at)` for a resource's history; `(organization_id, actor_id, occurred_at)` for a user's actions.
- **Nullable:** `organization_id` (NULL = platform-scope event, write-only for tenants), `actor_*`, `resource_id`, `request_id`.
- **Security:** UPDATE/DELETE revoked from the runtime role; trigger blocks UPDATE/TRUNCATE for everyone and DELETE for all but the owner. `metadata` must be redacted (no secrets, no message bodies). **Retention:** organization policy `audit_logs` (recommended ≥ 1 year). Future: monthly partitions and/or export to WORM storage.

#### `security_policies`
- One row per `(organization_id, policy_key)` (authentication, session, password, sharing, ip_allowlist…). `settings` validated against a versioned schema; `version` for optimistic concurrency.

#### `retention_policies`
- One row per `(organization_id, resource_type)`. `retention_days` NULL means indefinite; `legal_hold` suspends purging. CHECK `retention_days >= 1`. Retention jobs in each owning service read the policy (via API/event) and purge per organization.

## Infrastructure tables (every schema)

#### `outbox_events`
- Inserted in the same transaction as the domain change. Indexes: `outbox_events_unpublished_idx (occurred_at) WHERE published_at IS NULL` for the relay; `outbox_events_published_idx (published_at) WHERE published_at IS NOT NULL` for cleanup. Keep published rows 7 days for replay. Not RLS-protected; `organization_id` is routing metadata.

#### `processed_events`
- PK `(event_id, handler)`, inserted in the same transaction as the handler's effects, which makes consumers idempotent. Index `(processed_at)` for cleanup after 14 days.
