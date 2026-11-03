# 0011. Direct and group conversations

- Status: **Proposed**
- Date: 2026-11-03
- Implemented in: messaging service (`smartconnect-backend/services/messaging`), realtime gateway, API gateway routing, web app. Contract: [api/endpoints.md](../api/endpoints.md)

## Context

The roadmap asks for one-to-one and group conversations inside an organization. The messaging schema already models them:
- `conversations.kind` is `direct` or `group`;
- `direct_key` is unique per user pair;
- `conversation_members`, `messages` and `message_read_states` exist, all with RLS.

Channel messages ([ADR 0010](0010-organizations-and-membership.md) decision 10) take their access from the workspace service. Direct and group conversations have no owner other than messaging, so messaging must decide access itself. No event relay is approved ([ADR 0002](0002-event-broker-nats-jetstream.md)), and the realtime gateway ([ADR 0004](0004-realtime-gateway.md)) is still Proposed.

## Decision

1. **Who can talk to whom:**
   - Any active member of an organization may start a direct conversation with, or create a group with, other active members of the same organization. The organization service is asked as the caller (`GET /orgs/{o}/members?userId=…`).
   - Conversations never span organizations.
   - A direct conversation with yourself is refused (`422 cannot_message_self`).
2. **Every request checks organization membership first:**
   - Messaging asks the organization service `GET /orgs/{o}/me` with the caller's token, on every request, and fails closed (503).
   - Conversation memberships that predate the caller's *current* organization membership are deleted before anything runs, together with their read state. A removed and re-invited person never regains old conversations: this mirrors ADR 0010 decision 11.
   - The same applies to *other* people. Adding someone, opening a direct conversation with them, or posting to one treats their rows from an earlier organization membership as absent: the membership start comes from the organization service's member lookup. They start fresh even before their own first request has pruned them.
3. **Participation is the only way in:**
   - A conversation is visible only to its participants (`conversation_members`). Anyone else, including organization owners and admins, gets **404** on every route, exactly as for a missing id.
   - Channel conversations are never reachable through the conversation routes.
4. **Direct conversations:**
   - There is exactly one per user pair (`direct_key`). `POST …/conversations/direct` is find-or-create, safe under concurrency, and returns 200 or 201.
   - Participants cannot be added or removed, and there is no title.
   - Posting when the other person is no longer an active member answers `409 participant_inactive`.
   - A missing participant row (a pruned re-invited person) is re-added when the conversation is opened again or posted to; that person sees only messages from then on.
5. **Groups:**
   - 3–50 participants, including the creator. The `title` is optional (1–120 characters); without one, clients show participant names.
   - Each participant has a role, `admin` or `member` (additive migration: `conversation_members.role`, default `member`). The creator is `admin`.
   - **Admins** add participants (active organization members only, `409 conversation_full` beyond 50), remove participants, change roles and rename.
   - **Anyone** may leave. When the last admin leaves, the longest-standing remaining participant becomes admin, so a group never loses its last admin and leaving is always possible.
   - Demoting the last admin answers `409 last_admin`.
   - Participant changes take a row lock on the conversation, so concurrent changes serialize.
6. **History starts when you join:** a participant sees only messages created at or after their `joinedAt`. This applies to listing, editing, deleting, read cursors and unread counts. Someone added to a group does not see what was said before they arrived, and someone removed and re-added does not see what was said while they were away.
7. **Messages:**
   - Reading needs participation, and so does posting.
   - Editing is the sender's alone.
   - Deleting is allowed for the sender, or a group admin in groups (moderation). Deletion erases the body.
   - `clientMessageId` makes retries idempotent. History is newest first by `(created_at, id)` with an opaque cursor, as for channels.
8. **Ordering and unread:**
   - **List order:** the conversation list is ordered by `lastActivityAt = lastMessageAt ?? createdAt`, newest first, then by `id`.
   - **Read cursor:** each participant has one read cursor (`message_read_states`): `last_read_message_id` plus `last_read_at`, which holds that message's `created_at`, i.e. the cursor position.
   - **Advancing it:** `POST …/read` only ever moves the cursor forward, and posting moves the sender's cursor to their own message.
   - **`unreadCount`:** counts messages after the cursor and at or after `joinedAt`, sent by others and not deleted. It is capped at 100.
9. **Events:**
   - Outbox events carry ids only: `messaging.conversation.created|updated|participant_added|participant_removed`, plus `messaging.message.created|updated|deleted` with `conversationId` and no channel fields.
   - After commit, messaging publishes one id-only realtime event to Redis, with the recipients it computed from the participant list in the same transaction:

   | Change | Recipients |
   |---|---|
   | Message changes | Current participants |
   | Conversation changes | Participants after the change, plus anyone removed |
   | Read changes | The reader only (their other tabs) |

10. **Realtime: per-organization inbox rooms.** There are no per-conversation rooms.
    - **Subscribing:** a socket sends `inbox.subscribe { organizationId }`. The gateway asks messaging, as the user, `GET /orgs/{o}/conversations/inbox` (with an exact id match), and joins the room `inbox:{organizationId}:{userId}`.
    - That check runs messaging's organization-membership gate. The gate drops memberships left over from an earlier organization membership *before* the socket joins, so a re-invited person's new socket never receives events of their old conversations.
    - **Re-checks:** the room is re-checked like channel rooms, and the gateway emits `inbox.unsubscribed` on loss.
    - **Fan-out:** events go to the inbox rooms of the recipients messaging named. The recipient list itself never reaches clients.
    - **Why no conversation rooms:** recipients are computed from the authoritative participant list at commit time. A removed participant stops receiving events at once, with no re-check delay, and no per-conversation subscribe or authorization round trip exists to attack.

## Consequences

- One extra organization-service call per conversation request, plus one more when posting to a direct conversation; no caching yet, as in ADR 0010.
- Revocation after removal from the organization is immediate for REST. For realtime, the inbox room is revoked at the next re-check (60 s by default). In that window only ids reach the socket, and REST refuses the content.
- People see only history from their join time onward. Product may later want the option "share history when adding someone"; that would be a new decision.
- Without system messages, joins, leaves and renames are visible only in the participant list and title, not in the timeline.
- Messages are ordered by an application-clock timestamp; there is no per-conversation sequence number yet (gap G-10 in [realtime.md](../architecture/realtime.md)).

## Alternatives considered

| Option | Why not |
|---|---|
| Per-conversation socket rooms authorized on subscribe | One authorization round trip per conversation per socket, and removed participants keep receiving ids until the next re-check |
| Any participant may add or remove people | Adding someone exposes future messages to them; an admin role keeps that decision with the group's owners. Leaving stays open to everyone |
| Full history for new participants | Discloses earlier messages to people their senders did not write them for |
| Last admin cannot leave (like workspaces) | People must always be able to leave a conversation; auto-promotion keeps an admin |
