# Real-time communication conventions

Status: **Proposed for Phase 2**. Implements blueprint §5: persistent messages, reliable delivery, acknowledgements, reconnection without duplicates, ordering, typing, presence, read receipts, unread counts, event authorization, and cross-device sync. Component decision: [ADR 0004](../decisions/0004-realtime-gateway.md).

## Principles

1. **PostgreSQL is the source of truth; sockets are a notification channel.** A client that missed socket events can always rebuild exact state from the REST API.
2. **Writes go through HTTP; reads arrive by socket.**
   - Sending a message is an idempotent `POST`, which gets validation, rate limiting, authorization and retries from the normal API path.
   - The socket delivers what happened.
3. **Every ordered stream has a sequence number.** Gaps are detectable and repairable.
4. **Clients never choose what they may hear.** The server joins sockets to rooms after authorising them.
5. **Redis holds only ephemeral state** (presence, typing, socket fan-out). Durable events flow through the transactional outbox.

## Delivery path

```mermaid
sequenceDiagram
  participant C as Client (device A)
  participant API as messaging service
  participant DB as messaging schema
  participant RG as realtime-gateway (N instances)
  participant D as Other devices / members
  C->>API: POST /orgs/{org}/conversations/{id}/messages {clientMessageId, body}
  API->>DB: BEGIN; seq = last_seq + 1; insert message; insert outbox; COMMIT
  API-->>C: 201 {id, seq, createdAt}   (ack → "sent")
  DB-->>RG: outbox relay → broker → message.created
  RG->>D: emit to room conversation:{id}
  RG->>C: emit to room user:{author} (other tabs/devices)
```

- **Ack:** the `201` (or the `200` idempotent replay) *is* the delivery acknowledgement. The client state machine is `pending → sent → failed` (after bounded retries with the same `clientMessageId`; the user can retry manually).
- **Duplicate prevention:**
  - Retries reuse `clientMessageId`, so the existing unique key `(conversation_id, sender_user_id, client_message_id)` turns them into a replay.
  - Clients also dedupe incoming events by message `id`.
- **Ordering:** `messages.seq` is assigned in the inserting transaction from `conversations.last_seq` (gap G-10). Clients render by `seq` and never by arrival order.
- **Latency budget (target, to be verified by load tests):** p95 < 300 ms from commit to delivery on the same region. If the outbox → broker hop cannot meet it, the service additionally publishes a best-effort fan-out after commit. The outbox remains the guaranteed path.

## Connection and authorization

| Aspect | Convention |
|---|---|
| Transport | Socket.IO v4 over WebSocket. Long-polling fallback disabled in production (avoids sticky sessions); enabled only if a supported network requires it |
| Handshake | `auth: { token: <access JWT> }`. Expired tokens are rejected with `auth_expired`; the client refreshes and reconnects. Sockets of revoked sessions are disconnected on `identity.session.revoked` |
| Rooms | `user:{userId}` (all of a user's devices), `conversation:{id}`, `workspace:{id}` (channel-list changes), `meeting:{id}` |
| Joining | On connect and on membership change, the gateway joins the socket to rooms derived from **server-side** membership (messaging/workspace membership, cached in Redis, invalidated by membership events). A client may request a focused subscription (`conversation.subscribe`); the gateway authorises it the same way |
| Revocation | `*.member.removed` events remove the user's sockets from the affected rooms immediately |
| Tenancy | Every event carries `orgId`. A socket only joins rooms of organizations the user belongs to, and of guest-granted resources |

## Event conventions

Server → client events: `<domain>.<entity>.<past-tense-verb>` (e.g. `message.created`, `message.updated`, `reaction.added`, `channel.member_added`, `call.ringing`). Envelope:

```json
{ "id": "<event uuidv7>", "type": "message.created", "v": 1, "orgId": "…", "occurredAt": "…",
  "conversationId": "…", "seq": 1042, "data": { … } }
```

- Client → server socket messages are limited to **ephemeral** signals (`typing.start`, `typing.stop`, `presence.heartbeat`, `conversation.subscribe`, `conversation.read`) and use Socket.IO acknowledgements.
- Payloads carry what a member of the room may see. Private content is never broadcast to wider rooms.
- Event types are versioned (`v`). Additive changes keep the version; clients ignore unknown fields and event types.

## Reconnection and cross-device sync

1. The client keeps `lastSeq` per conversation it has loaded.
2. On reconnect, the gateway sends `sync.state`: the latest `seq` of the user's conversations with activity since the client's `since` timestamp.
3. For each conversation where `latest > lastSeq`, the client fetches `GET …/messages?afterSeq=<lastSeq>` (paged) and merges by `seq`. Duplicates are impossible because both the socket and the API identify messages by `id` and `seq`.
4. Edits, deletes and reactions are delivered as events and also reflected in the REST representation (`updatedAt`), so a resync fetches current state.

## Ephemeral signals (Redis only, never persisted)

| Signal | Rule |
|---|---|
| Typing | Client sends `typing.start` at most every 3 s while typing. Server keeps a 6 s TTL key and broadcasts start/stop to `conversation:{id}`, excluding the sender |
| Presence | Each device heartbeats every 30 s; a key per (user, device) with a 75 s TTL. A user is online if any device key exists; `busy` / `away` / `dnd` come from presence.user_statuses (G-06). Changes fan out only to users sharing a workspace, coalesced to at most one update per user per 5 s |
| Active speaker, raised hands, in-call reactions | LiveKit data channels and participant metadata; not through the gateway |

## Read state and unread counts

- `conversation.read { conversationId, seq }` is debounced (≤ 1 per 2 s per conversation). It updates `message_read_states` monotonically (`last_read_seq = max(...)`) and emits `conversation.read` to `user:{userId}`, which syncs the badge across the user's devices.
- Unread count = `conversations.last_seq − message_read_states.last_read_seq` (O(1)). Mention badges use `unread_mention_count`.
- **Read receipts:** per-recipient "seen by" is shown for direct and small group conversations only (≤ 10 members), from the members' read cursors. No per-message receipt rows.

## Limits and protection

- Maximum event payload 64 KB.
- Per-socket rate limits on client signals.
- At most 10 concurrent sockets per user.
- Idle sockets are closed after 2 missed heartbeats.
- The gateway validates every client signal against a schema and drops unknown event names.

## Scaling

The gateway is stateless; N instances share rooms through the Socket.IO Redis adapter (`@socket.io/redis-adapter` 8.3.0, MIT, verified 2026-11-02). Capacity target: 1,500 concurrent connections (×2 headroom). Measured with Artillery's Socket.IO engine in Phase 2 ([testing strategy](../devops/testing-strategy.md)).
