# @smartconnect/messaging-service

Sole owner of PostgreSQL schema `messaging`. Channel messages, plus direct and group conversations (ADR 0011). It is an internal service (port 3104); clients reach it through the [API gateway](../../api-gateway/README.md) under `/api/v1/orgs/{orgId}/workspaces/{wsId}/channels/{chId}/messages`. API: [docs/api/endpoints.md](../../../docs/api/endpoints.md#channel-messages-workspaceswsidchannelschidmessages). Conversations: `/api/v1/orgs/{orgId}/conversations`, see [docs/api/endpoints.md](../../../docs/api/endpoints.md#conversations-direct-and-group-orgsorgidconversations). Decisions: [ADR 0010](../../../docs/decisions/0010-organizations-and-membership.md) §10, [ADR 0011](../../../docs/decisions/0011-direct-and-group-conversations.md).

## Run

```bash
make messaging-start        # needs the workspace service on :3103 and the organization service on :3102
make messaging-test         # unit tests; integration suites run in make db-test
```

Configuration:
- **Required:** `DATABASE_URL` (runtime role `sc_messaging_app`) and `AUTH_JWT_PUBLIC_JWKS` / `_FILE`.
- **`WORKSPACE_SERVICE_URL`:** defaults to `http://127.0.0.1:3103` outside production, and is required in production.
- **`ORGANIZATION_SERVICE_URL`:** defaults to `http://127.0.0.1:3102` outside production, and is required in production.
- **`FILES_SERVICE_URL`:** defaults to `http://127.0.0.1:3106` outside production, and is required in production. Asked, as the caller, whether a file may be attached to a message.
- **`REDIS_URL` / `_FILE` (optional):** without it, no realtime events are published. `REALTIME_EVENTS_CHANNEL` defaults to `smartconnect:events` and must match the [realtime gateway](../../realtime-gateway/README.md).
- **Shared variables:** `HOST`, `PORT` (3104), `TRUST_PROXY_HOPS` (1) and the other common ones, as in the other services.

## What it enforces (each covered by tests)

- **Channel visibility** is asked of the workspace service on every request, as the caller. An invisible channel is 404 on every route, with nothing written. An unreachable workspace service is 503.
- **Who may do what:**
  - Posting requires channel membership (403 `not_a_channel_member`), and archived channels refuse posts (409).
  - Only the sender edits a message.
  - The sender or a channel admin deletes it, and deletion erases the body.
- **Message ids** are always constrained to the channel's conversation: ids from other channels or organizations answer 404.
- **Retries:** `clientMessageId` makes them safe, including under concurrency.
- **Paging:** newest first, with a keyset cursor.
- **Privacy:** message bodies and tokens are never logged. Outbox events carry ids only.
- **Realtime:** after commit, it publishes id-only `created`, `updated` and `deleted` events to Redis. Publishing is best effort: a failure is logged and never fails the request. The durable record is the outbox.
- **Access dispatch (fail closed):** routes with `:channelId` ask the workspace service; routes marked `@OrganizationScoped()` (conversations) ask the organization service `GET /orgs/{o}/me` as the caller (503 when unreachable); every other route is refused.
- **Conversations are participants-only:** anyone else, organization owners included, gets 404 exactly as for a missing id, and channel conversations are unreachable through these routes. Conversation memberships (and read cursors) that predate the caller's current organization membership are deleted before the request runs, so a removed and re-invited person never regains old conversations.
- **Direct:** one per user pair (`direct_key`), find-or-create safe under concurrency (`createMany skipDuplicates`, re-read). No self-conversations (422), the other person must be an active member (422 on open, 409 `participant_inactive` on post).
- **Groups:** 3 to 50 participants; admins add, remove, rename and change roles; anyone leaves; the longest-standing member is promoted when the last admin leaves; demoting the last admin is 409. Participant changes run under `SELECT … FOR UPDATE` on the conversation row, so concurrent changes serialize.
- **History from join:** every message query (list, edit, delete, read cursor, unread count) filters `created_at >= joinedAt` of the caller, both from the application clock.
- **Read cursor:** `POST …/read` only moves forward; posting moves the sender's cursor. `unreadCount` is a capped (100) count subquery in the same statement as the list page, no N+1.
- **Events:** outbox rows `messaging.conversation.created|updated|participant_added|participant_removed` and `messaging.message.*` (with `conversationId`, no channel fields), ids only. After commit one `conversation.changed` event goes to Redis with `change` (`message.created|updated|deleted`, `conversation.updated`, `read`) and the computed `recipientUserIds`; the recipients never reach clients.
- **Not built yet:** threads, reactions, mentions, attachments, system messages.
