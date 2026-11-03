# @smartconnect/realtime-gateway

Stateless Socket.IO gateway ([ADR 0004](../../docs/decisions/0004-realtime-gateway.md), still **Proposed**). It has no database and no schema. Clients connect at `ws://127.0.0.1:3105`, path `/realtime/socket.io`, WebSocket transport only.

Clients subscribe to two kinds of rooms:
- **Channel rooms:** id-only `message.changed` events.
- **Their own conversation inbox per organization:** id-only `conversation.changed` events ([ADR 0011](../../docs/decisions/0011-direct-and-group-conversations.md)).

Services publish these events to Redis after commit. Contract: [docs/api/endpoints.md](../../docs/api/endpoints.md#realtime-realtime-gateway-socketio-adr-0004).

## Run

```bash
REDIS_URL='redis://:<REDIS_PASSWORD from the root .env>@127.0.0.1:6379/0' make realtime-start   # needs the workspace service on :3103
make realtime-test          # in-process sockets; Redis and stack integration run in make db-test
```

Give the messaging service the same `REDIS_URL`, or it publishes nothing. Alternatively, put `REDIS_URL` in a gitignored `.env` in this directory (`npm start` reads it if it exists).

Configuration:
- **Required:** `REDIS_URL` / `_FILE` (the only event source) and `AUTH_JWT_PUBLIC_JWKS` / `_FILE`.
- **`WORKSPACE_SERVICE_URL`** and **`MESSAGING_SERVICE_URL`:** default to `http://127.0.0.1:3103` and `http://127.0.0.1:3104` outside production, and are required in production.
- **`CORS_ALLOWED_ORIGINS`:** exact origins only. Defaults to the Vite dev origins outside production, and is required in production.
- **`REALTIME_EVENTS_CHANNEL`:** `smartconnect:events`, and must match the messaging service.
- **`REAUTHORIZE_INTERVAL_SECONDS`:** 60, range 1–3600.
- **`MAX_CHANNELS_PER_SOCKET`:** 200, range 1–1000. Counts every room: channels and inboxes.
- **`MAX_SOCKETS_PER_USER`:** 10 per instance, range 1–1000. Extra sockets are disconnected right after connecting.
- **Shared variables:** `HOST`, `PORT` (3105) and the other common ones, as in the other services.
- **Health:** `/health/ready` reports not ready until the Redis subscription is live.

## What it enforces (each covered by tests)

- **Authentication:** a socket needs a valid access token in the handshake, and the reason for a refusal is never revealed. The socket is closed when its token expires.
- **Authorization:** each room is joined only after the service that owns it, asked as the socket's user, returns exactly the requested resource:
  - **channel room:** the workspace service must return the requested channel;
  - **inbox:** messaging (`GET /orgs/{o}/conversations/inbox`) must return the requested organization. Its gate checks organization membership and first drops conversation memberships left over from an earlier one.

  Every other answer refuses the join:
  - 404 or 403 gives `not_found`;
  - any other answer (a mismatched or malformed body, or a failing service) gives `unavailable`.

  A socket can only join its **own** inbox: the room key comes from the token, never from the payload.
- **Re-checks:** joined rooms are re-checked every interval. Losing access, or a failed check, removes the socket from the room and emits `unsubscribed` (channels) or `inbox.unsubscribed` (inboxes). A 401, or an unexpected error during the check, disconnects the socket.
- **Conversation recipients:** messaging names them in each event, from the participant list at commit time; the list never reaches clients. A removed participant therefore stops receiving events at once.
- **Content:** events carry identifiers only, and clients fetch content through REST, which authorizes again. Malformed events are dropped, and only their type is logged.
- **Limits:**
  - 30 subscribe attempts per socket per minute;
  - `MAX_CHANNELS_PER_SOCKET` rooms, enforced again after the access check so concurrent subscribes cannot overshoot;
  - `MAX_SOCKETS_PER_USER` open sockets;
  - 4 KiB payloads;
  - browser origins checked against the allow-list.
- **No writes over the socket:** posting stays on REST.

## Limitations

- **Best-effort delivery:** Redis pub/sub is fire-and-forget, so events published while the gateway is disconnected are lost. Nothing is replayed: after a reconnect, clients refetch the newest page of each open channel.
- **Per-instance limits:** rate limits and caps are kept in memory, per instance. There is no per-IP connection limit: set one at the reverse proxy.
- **No coalescing:** re-checks are not shared across sockets that watch the same channel.
- **Not built yet:** typing, presence, read state and notifications.
