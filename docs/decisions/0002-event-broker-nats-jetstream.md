# 0002. NATS JetStream as the event broker behind the transactional outbox

- Status: **Proposed**. Awaiting approval; nothing has been implemented.
- Date: 2026-11-02

## Context

Every service writes domain events to its own `outbox_events` table in the same transaction as the state change ([database/architecture.md](../database/architecture.md#communication-rules)). Consumers record `(event_id, handler)` in their own `processed_events`. The outbox is the source of truth; the broker is only the transport. Redis is excluded as the durable event source by design.

**Requirements**

| # | Requirement |
|---|---|
| R1 | Durable, at-least-once delivery; survives broker and consumer restarts |
| R2 | **Fan-out**: one event, many consumer services, each with independent progress |
| R3 | **Replay**: a new or recovered consumer can re-read recent history |
| R4 | Retries with back-off and dead-lettering per consumer |
| R5 | Cheap idempotency for relay retries (the relay may publish the same outbox row twice) |
| R6 | Least privilege: a service publishes only its own events and reads only what it consumes |
| R7 | Small operational footprint: a small team; runs on an 8 GB laptop next to PostgreSQL and Redis |
| R8 | First-class Node/TypeScript client |
| R9 | Scale: 1,000–1,500 connected users. Low hundreds of events/s at peak is the design envelope (estimate) |

## How NATS JetStream maps to the outbox

```mermaid
sequenceDiagram
  participant Relay as messaging outbox relay
  participant JS as JetStream stream SC_MESSAGING<br/>(subjects sc.messaging.>)
  participant C1 as consumer "search" (durable, pull)
  participant C2 as consumer "notifications" (durable, pull)
  Relay->>JS: publish sc.messaging.message.created<br/>header Nats-Msg-Id = outbox_events.id
  JS-->>Relay: PubAck (stored; duplicate within window → acknowledged, not stored twice)
  Relay->>Relay: UPDATE outbox_events SET published_at = now()
  C1->>JS: fetch batch (filter sc.messaging.message.*)
  C1->>C1: BEGIN; insert processed_events; apply; COMMIT
  C1->>JS: ack (after commit)
  C2->>JS: fetch (own cursor, independent of C1)
```

| Requirement | JetStream mechanism |
|---|---|
| R1 | Streams persist to disk (file storage). Replication factor 3 in production (Raft); 1 locally |
| R2 | One **durable consumer per consuming service** on the producer's stream, each with its own cursor and filter subjects |
| R3 | Stream retention by age (e.g. `max_age` 7 days, matching outbox retention); consumers can start from a sequence or time |
| R4 | `AckExplicit`, `ack_wait`, `max_deliver`, `backoff`. Reaching `max_deliver` emits an advisory (`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>`) that a DLQ handler stores for inspection |
| R5 | **Publish deduplication**: `Nats-Msg-Id` = outbox event id, so retries within the stream's `duplicate_window` are ignored. This maps one-to-one onto our UUIDv7 event ids. Consumers still dedupe via `processed_events`, because redelivery after an ack timeout is normal |
| R6 | Accounts and users with **subject permissions**: `sc_messaging` may publish `sc.messaging.>` only and use only its own consumers. This mirrors the database role model. TLS + NKEY/JWT authentication |
| R7 | One static Go binary with no external dependencies (no ZooKeeper, no JVM). Monitoring endpoint (`:8222`) and Prometheus exporter. Managed option: Synadia Cloud. Typical idle memory is tens of MB (to be measured in the spike) |
| R8 | Official TypeScript clients: `@nats-io/transport-node` + `@nats-io/jetstream` **3.4.0, Apache-2.0** (verified on npm, 2026-11-02) |
| R9 | Far below JetStream's design range on a single node |

**Subject and stream conventions (proposed):**
- **Subjects:** `sc.<service>.<entity>.<past_tense_verb>`, matching the existing event naming in [relationships.md](../database/relationships.md#event-conventions).
- **Streams:** one per producing service (`SC_<SERVICE>`), so retention, limits and permissions follow service ownership.
- **Headers:** `Nats-Msg-Id`, `sc-organization-id`, `sc-event-version`, `traceparent`. Payloads are never secrets.

## Trade-offs

**For NATS JetStream**
- Best fit for R5: broker-side publish dedupe keyed by our outbox id. Other brokers need a plugin or consumer-side work only.
- Lowest operational weight of the durable options; the same binary covers dev, CI and production.
- Subject-based permissions give the broker the same least-privilege shape as the database.
- Built-in KV and object stores could later serve distributed locks or config without new infrastructure.

**Against / risks**
- **Team familiarity:** less known than Kafka or RabbitMQ. Mitigation: a thin internal library (`publish`, `subscribe`) so service code never touches JetStream APIs directly; a runbook.
- **Ordering:** guaranteed per stream, not per aggregate under parallel consumption. Our consumers are already designed to tolerate reordering across aggregates (relationships.md). Strict per-aggregate ordering, if ever needed, means `max_ack_pending = 1` or subject-partitioned consumers.
- **Ecosystem:** smaller connector ecosystem than Kafka. Analytics or CDC pipelines would need bridges; no such requirement today.
- **Governance:** in 2025 there was a public dispute over NATS's licence and governance. It ended with NATS remaining an Apache-2.0 project under the CNCF. We verified on 2026-11-02 that **nats-server v2.15.2 and `main` are Apache-2.0**. Mitigation: pin versions; keep the broker behind the internal library so a swap is contained; re-check the licence at every major upgrade.
- **Operations:** a JetStream cluster needs persistent volumes and Raft quorum care in production (three nodes, spread across zones). Synadia Cloud removes that at a cost.

## Alternatives considered

| Option | Assessment |
|---|---|
| **RabbitMQ** (quorum queues / streams) | Mature, rich routing, strong ops tooling. Classic queues delete on ack (no replay), so R3 needs the streams feature. Dedupe needs a plugin (R5). Erlang runtime and heavier footprint. **The strongest alternative** if the team already knows it |
| **Apache Kafka** | Industry standard: long retention, huge ecosystem. Operationally heavy (cluster, partitions, rebalancing), ~1 GB+ RAM even for a minimal local broker. Overkill for R9 |
| **Redpanda** | Kafka API in a single binary, lighter than Kafka. The community edition is source-available (BSL), not OSI open source: a licensing consideration |
| **Redis Streams** (existing Redis) | No new infrastructure; consumer groups exist. But our Redis is a bounded cache (`maxmemory` + eviction, AOF everysec), has no broker-side dedupe, and mixing the event log with cache memory pressure undermines R1/R3. Rejected in the database architecture already |
| **Cloud queues** (SNS+SQS, Google Pub/Sub) | Zero ops, durable. Ties us to one cloud before hosting is decided; local parity needs emulators; SQS has no replay. Worth revisiting only if the platform commits to a single cloud with managed services everywhere |
| **PostgreSQL only** (consumers read producers' outboxes) | Violates service ownership: cross-schema reads are blocked by design |

## Recommendation

**Adopt NATS JetStream**, self-hosted in local development and CI, with the production choice (self-managed three-node cluster vs Synadia Cloud) tied to the pending hosting decision.

Conditions:
1. Spike first (≤ 2 days) to measure footprint and validate the dedupe-plus-redelivery semantics with our outbox tables.
2. A licence check at adoption time.
3. All access through the internal library, so the broker remains replaceable.

## Implementation plan (after approval; not started)

1. **Local infrastructure:** `nats` service in Compose: pinned `nats:2.15-alpine` image, JetStream file storage on a named volume, loopback-only ports, a memory limit, per-service users with subject permissions, credentials in gitignored files like the database credentials.
2. **Streams and consumers as code:** versioned definitions applied idempotently by a bootstrap script, mirroring `010_bootstrap.sql`.
3. **Shared libraries** in `packages/`, generic with no domain models:
   - `@smartconnect/event-contracts`: event types and JSON Schemas, versioned.
   - `@smartconnect/outbox`: the relay (batch `FOR UPDATE SKIP LOCKED`, publish with `Nats-Msg-Id`, await PubAck, mark published) and the consumer runner (transaction with `processed_events`, ack after commit, DLQ advisory handling).
4. **Tests:** integration tests against an ephemeral NATS in the test profile. Cover relay crash before/after PubAck, duplicate publish, consumer crash before/after commit, `max_deliver` → DLQ, and permission denials for foreign subjects.
5. **Observability:** consumer lag, redeliveries, DLQ size and outbox backlog (`published_at IS NULL`) as metrics with alerts.
