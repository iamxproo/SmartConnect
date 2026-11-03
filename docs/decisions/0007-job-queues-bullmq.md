# 0007. Background jobs: BullMQ on a dedicated Redis

- Status: **Proposed**
- Date: 2026-11-02

## Context

The blueprint allows BullMQ "where useful" (`bullmq` 6.5.3, MIT, verified 2026-11-02). Candidate uses:
- media processing (scan, thumbnails, transcodes);
- link-preview fetching;
- email sending;
- delayed jobs (scheduled messages, reminders).

**Conflict found:** BullMQ requires Redis `maxmemory-policy noeviction`, because evicted keys would silently lose jobs. The existing Redis is deliberately a bounded **cache** (`maxmemory 256mb`, `volatile-lru`). Both cannot be true on one instance: the policy is instance-wide.

## Decision

1. **Use the simplest durable mechanism per job type.**
   - **Domain events between services:** transactional outbox → broker ([ADR 0002](0002-event-broker-nats-jetstream.md)). Never BullMQ.
   - **Work already represented by a database row** (notification deliveries, webhook deliveries, scheduled messages, workflow executions): database-backed claiming with `FOR UPDATE SKIP LOCKED` SECURITY DEFINER functions. This pattern already exists, is tenant-safe and needs no extra infrastructure.
   - **CPU-bound or rate-limited task processing with retries** (media pipeline, email provider throttling): **BullMQ**.
2. When BullMQ is first needed, add a **separate Redis instance for queues**: `noeviction`, AOF `everysec`, its own password and memory limit, never used as a cache. The cache Redis stays `volatile-lru`.
3. **Job payloads carry identifiers** (`organizationId`, resource id), never content or secrets. Workers load data inside `withTenant()`.

## Consequences

- No silent job loss from cache eviction; no change to the existing Redis.
- One more container in local development, only when the first BullMQ consumer lands (expected Phase 3: media pipeline).
- Two queueing mechanisms coexist with a clear rule for choosing between them (above).
