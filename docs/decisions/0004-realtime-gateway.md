# 0004. Dedicated real-time gateway

- Status: **Proposed**
- Date: 2026-11-02

## Context

The blueprint requires Socket.IO real-time delivery (§4, §5) for messages, typing, presence, read state, calls and notifications. The scale target is 1,000–1,500 concurrent connections.

Long-lived WebSocket connections scale and fail differently from request/response APIs. They also must never become a second source of truth or a way around authorization.

## Decision

Add one **stateless `realtime-gateway`** deployable (NestJS + Socket.IO) next to `api-gateway`. It holds no database credentials and owns no schema. Conventions: [architecture/realtime.md](../architecture/realtime.md).

- **Inbound:** authenticated sockets (access JWT in the handshake). The server derives room membership from membership data cached in Redis and invalidated by membership events.
- **Outbound:** domain events from the services' outboxes, consumed from the broker ([ADR 0002](0002-event-broker-nats-jetstream.md)), are emitted to rooms. Ephemeral signals (typing, presence) go through Redis only.
- **Writes** (sending messages, reacting) go through the owning service's REST API, not the socket.
- **Scaling:** N instances with the Socket.IO Redis adapter; WebSocket-only transport, so no sticky sessions are needed.

## Consequences

- Socket scaling and deploys are independent of the REST API. A gateway restart loses no data: clients reconnect and resync by sequence number.
- Every real-time path stays auditable and authorised in the owning service.
- One more deployable to operate; mitigated by being stateless and small.
- Depends on the broker decision for durable fan-out. Until NATS is approved, a Phase 2 interim is possible: services publish post-commit fan-out events to Redis, and the outbox still records them for the later relay.

## Alternatives considered

| Option | Why not |
|---|---|
| Socket.IO inside each service | Clients would hold many sockets; cross-service fan-out and authorization would be duplicated |
| Socket.IO inside `api-gateway` | Couples long-lived connection scaling and deploys to request routing |
| Managed real-time SaaS (Ably, Pusher) | Cost per connection and message, data residency, and a second auth model; no clear benefit at this scale |
