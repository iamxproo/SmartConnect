# Blueprint → architecture mapping

Phase 0 deliverable: how every module of the product blueprint maps onto the **existing** 14 service schemas, what is missing, and where each gap will be closed. Derived from the live database catalog on 2026-11-02 (54 domain tables, 40 enums).

## Conclusion

**No new data-owning service is needed.** Every blueprint module fits an existing service boundary. The gaps are **additive schema changes** inside existing services (new tables, columns and enum values via forward-only migrations), introduced in the phase that needs them.

What *is* new are stateless runtime components and external infrastructure, none of which owns a database schema:

| Component | Kind | Owns data? | Needed from |
|---|---|---|---|
| `api-gateway` (foundation built in Phase 1 Task 2, [ADR 0008](../decisions/0008-api-gateway-foundation.md)) | Stateless edge: auth, routing, rate limiting, OpenAPI aggregation | No | Phase 1 |
| `realtime-gateway` | Stateless edge: Socket.IO connections, room authorization, fan-out ([ADR 0004](../decisions/0004-realtime-gateway.md)) | No (Redis for ephemeral state) | Phase 2 |
| Service workers | Background processes **of existing services** (outbox relay, delivery, media processing, scheduler) | Their own service's schema | Phase 2+ |
| Event broker | NATS JetStream ([ADR 0002](../decisions/0002-event-broker-nats-jetstream.md), spike pending) | — | Phase 2 |
| Object storage | Cloudflare R2 in production; local S3-compatible store ([ADR 0006](../decisions/0006-object-storage-and-file-security.md)) | — | Phase 3 |
| Media server | LiveKit ([ADR 0005](../decisions/0005-meetings-livekit.md)) | — | Phase 4 |
| Job queue Redis | Dedicated Redis for BullMQ ([ADR 0007](../decisions/0007-job-queues-bullmq.md)) | — | When first needed |

## Capability map

| # | Blueprint capability area | Service(s) | Existing tables | Blueprint modules |
|---|---|---|---|---|
| 1 | Identity and authentication | identity | users, credentials, user_profiles, devices, sessions, verification_tokens | A |
| 2 | Organizations and workspaces | organization, workspace | organizations, workspaces | B |
| 3 | Members and permissions | organization (org roles, members, guests), workspace (workspace/channel roles) | organization_roles, organization_members, organization_invitations, workspace_members, channel_members | §2, B, C |
| 4 | Messaging | messaging | messages, message_threads, message_reactions, message_attachments, message_mentions, message_bookmarks, message_read_states | D |
| 5 | Channels and conversations | workspace (channels: authoritative), messaging (conversations: message streams) | channels, channel_members, conversations, conversation_members | C, D |
| 6 | Notifications and presence | notifications, presence (+ Redis) | notifications, notification_preferences, notification_deliveries, user_statuses | G, A (status) |
| 7 | Meetings and calls | meetings (+ LiveKit) | meetings, meeting_invitations, meeting_participants, meeting_recordings, meeting_events | E |
| 8 | Files and media | files (+ object storage, media workers) | files, file_versions | F, I (media) |
| 9 | Search | search | search_documents, saved_searches, search_history | H |
| 10 | Documents | documents | documents, document_versions, document_comments | J |
| 11 | Tasks and lists | tasks | task_lists, tasks, task_assignees, task_comments | K |
| 12 | Workflows | workflows | workflows, workflow_versions, workflow_triggers, workflow_executions | L |
| 13 | Integrations | integrations | integration_connections, webhooks, webhook_deliveries | N |
| 14 | Audit and administration | administration | audit_logs, security_policies, retention_policies | M |

**Module I (Clips and recordings)** spans three services by design:
- **meetings** owns recordings and consent.
- **files** owns the media bytes, renditions and captions.
- **messaging** shares clips as attachments.

A separate clips service would duplicate the files service's storage and permission logic.

## Gap register

Every gap is closed by an additive migration in the listed service and phase. Status of all items: **open**. Nothing here is implemented yet. IDs are referenced from [the roadmap](../product/roadmap.md).

### Identity, organizations, workspaces, access (Modules A, B, §2)

| ID | Blueprint requirement | Current state | Change (owning service) | Phase |
|---|---|---|---|---|
| G-01 | Departments and teams | Missing | `departments` (hierarchical, org-scoped), `teams`, `team_members` (**organization**) | 1 |
| G-02 | Guests, external collaborators, clients, contractors, temporary members | Org role `guest` and workspace role `guest` exist; no member type, expiry or sponsor | `organization_members.member_type` (member / guest), `guest_category`, `expires_at`, `sponsor_user_id`. Guests see only resources they are explicitly granted (service-level checks) (**organization**, **workspace**) | 1 |
| G-03 | Membership approval / join requests | Invitations only | `membership_requests` (**organization**); `workspace_join_requests` for private workspaces (**workspace**) | 1 |
| G-04 | Workspace settings | No settings column | `workspaces.settings jsonb`, validated by the service (**workspace**) | 1 |
| G-05 | Permission catalogue for custom roles | `organization_roles.permissions text[]` exists; no defined catalogue | Code-defined, versioned permission catalogue validated on write; documented in `docs/api/` (**organization**) | 1 |
| G-06 | Busy status | `Availability` = auto, away, dnd | Add enum value `busy` (**presence**) | 1 |
| G-07 | OAuth / enterprise SSO (later capability) | Missing | `external_identities` (**identity**); org SSO connection config (**organization**) | 5+ |
| G-08 | Bot principals | Missing | Bots are app principals in **integrations** with hashed tokens; no `users` rows (see G-31) | 5 |

### Channels and messaging (Modules C, D, §5)

| ID | Blueprint requirement | Current state | Change (owning service) | Phase |
|---|---|---|---|---|
| G-10 | **Ordering guarantees, reconnection resync, O(1) unread counts** | Messages ordered by `created_at`; no per-conversation sequence | `conversations.last_seq bigint` + `messages.seq bigint`, assigned in the insert transaction, `UNIQUE (conversation_id, seq)`; `message_read_states.last_read_seq bigint`. Unread = `last_seq − last_read_seq` (**messaging**) | 2 (before real-time goes live) |
| G-11 | Department / project / custom channels | `channels.type` = public / private only | `channels.purpose` (general, department, project, custom) + optional `department_id`/`team_id` logical refs (**workspace**) | 2 |
| G-12 | Channel permissions (who can post, invite, @channel, start meetings) | `posting_policy` + channel roles | `channels.settings jsonb` with validated capability overrides. Still no per-user ACL table (**workspace**) | 2 |
| G-13 | Pinned messages | Missing | `message_pins` (conversation, message, pinned_by) (**messaging**) | 2 |
| G-14 | Message forwarding | Missing | `messages.forwarded_from_message_id` (same tenant, composite FK) (**messaging**) | 2 |
| G-15 | Drafts synchronised across devices | Missing | `message_drafts` (user, conversation, thread root) (**messaging**) | 2 |
| G-16 | Scheduled messages | Missing | `scheduled_messages` + claim function for the sender worker (**messaging**) | 2 |
| G-17 | Link previews | Missing | `message_link_previews`; fetched by an unfurl worker behind SSRF egress controls (**messaging**) | 2 |
| G-18 | Meeting chat | `ConversationKind` = channel, direct, group | Add `meeting` conversation kind linked from `meetings.conversation_id` (**messaging**) | 4 |
| G-19 | Delivery/failure states, typing, presence | — | **No schema**: client-side pending/failed + server ack via the existing `client_message_id` key; typing and presence are Redis-only ([realtime.md](realtime.md)) | 2 |
| G-20 | Message edit history | Only `edited_at` | Decision needed: keep history (`message_edits`) for compliance or not. Defaults to *not kept* | Decision |

### Meetings, files, clips (Modules E, F, I)

| ID | Blueprint requirement | Current state | Change (owning service) | Phase |
|---|---|---|---|---|
| G-21 | 1:1 audio/video calls: ringing, accept/reject, missed-call history | `MeetingKind` = instant, scheduled; no call outcomes | `MeetingKind` + `call`; `meetings.media_type` (audio / video); `MeetingStatus` + `ringing`, `missed`, `declined` (**meetings**) | 4 |
| G-22 | Screen-share, waiting room and recording permissions | Missing | `meetings.settings jsonb` (who may share, record, unmute; waiting room) (**meetings**) | 4 |
| G-23 | Recording consent | Recordings exist; no consent record | Consent and notice events in `meeting_events` (`recording_consent_given`, `recording_notice_shown`); recording blocked without them (**meetings**) | 4 |
| G-24 | Previews, thumbnails, transcodes, captions | Missing | `file_renditions` (version, kind, storage_key, status) produced by the media worker (**files**) | 3 (previews), 5 (captions) |
| G-25 | Storage quotas | Missing | `storage_quotas` + usage accounting per organization (**files**) | 3 |
| G-26 | Secure sharing links for external parties | Access derives from the owning context only | `file_share_links` (token hash, expiry, created_by, revocable), only if external links are approved (**files**) | 3 (decision) |
| G-27 | Clips | `FileContextType` has no clip | Add `clip` to `FileContextType` (**files**); `clips` to `RetentionResource` (**administration**) | 5 |

### Search, documents, tasks, workflows, administration, integrations (Modules H, J–N)

| ID | Blueprint requirement | Current state | Change (owning service) | Phase |
|---|---|---|---|---|
| G-28 | User search; date / sender / channel filters | `SearchSourceType` has no `user`; no author/date/container columns | Add `user` source type; `author_user_id`, `occurred_at`, `container_id` + indexes (**search**) | 3 |
| G-29 | Document sharing and editing permissions; templates | Visibility only | `document_permissions` (principal: user / team / workspace; role viewer / commenter / editor); `document_templates` (**documents**) | 5 |
| G-30 | Task custom fields, saved views, list permissions | Missing | `task_custom_fields`, `task_custom_field_values`, `task_views`; `task_lists.visibility` (**tasks**) | 5 |
| G-31 | App directory, custom apps, bots, incoming webhooks | Catalogue is code-defined; outgoing webhooks only | `apps` (org-created apps and bots), `app_tokens` (hashed), `incoming_webhooks` (token hash → target) + a SECURITY DEFINER resolver (**integrations**) | 5 |
| G-32 | Workflow approvals; scheduler | Missing | `workflow_approvals`; `claim_due_workflow_triggers()` / `claim_workflow_executions()` (**workflows**) | 5 |
| G-33 | Data export, access reviews | Missing | `data_exports`, `access_reviews`, `access_review_items` (**administration**) | 5 |

### Already covered: no schema change needed

| Requirement | Where |
|---|---|
| Multi-device sessions, refresh-token rotation and reuse detection | identity.sessions / devices |
| Private-channel membership, channel archiving, announcements | workspace.channel_members, `archived_at`, `posting_policy = admins_only` |
| Threads, reactions, mentions, attachments, saved messages, read cursors | messaging |
| Channel- and conversation-level notification settings, Do Not Disturb, grouping, unread badges | notifications.notification_preferences (`scope_type`), `muted_until`, `group_key`, partial unread index |
| Desktop push | identity.devices (`push_provider = webpush`) |
| Malware-scan states, size/type metadata, versions | files (`status = scanning / quarantined`, versions, checksums) |
| Search permission filtering | search.search_documents.access_scope_ids |
| Org security and retention policies, audit trail | administration |
| Tenant isolation | RLS on all 48 tenant tables ([tenant-isolation.md](../database/tenant-isolation.md)) |

## Rules for closing gaps

1. One gap → one reviewed migration in its owning service, authored with `make db-migration`. New tenant tables ship with RLS (enforced by `make db-test`).
2. No new data-owning service without an ADR showing why no existing boundary fits.
3. Cross-service data needs (e.g. guest scoping across workspace and messaging) are satisfied by events and projections, never cross-schema access.
