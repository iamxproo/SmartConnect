-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('all', 'mentions', 'none');

-- CreateEnum
CREATE TYPE "NotificationScope" AS ENUM ('organization', 'workspace', 'channel', 'conversation');

-- CreateEnum
CREATE TYPE "DeliveryTransport" AS ENUM ('push', 'email');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "type" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000),
    "resource_type" VARCHAR(64),
    "resource_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "group_key" VARCHAR(128),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope_type" "NotificationScope" NOT NULL,
    "scope_id" UUID NOT NULL,
    "level" "NotificationLevel" NOT NULL DEFAULT 'all',
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "muted_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "transport" "DeliveryTransport" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "provider_message_id" VARCHAR(255),
    "last_error" VARCHAR(1000),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "event_version" SMALLINT NOT NULL DEFAULT 1,
    "organization_id" UUID,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(2000),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "handler" VARCHAR(128) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE INDEX "notifications_organization_id_recipient_user_id_created_at_idx" ON "notifications"("organization_id", "recipient_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_unread_idx" ON "notifications"("organization_id", "recipient_user_id") WHERE (read_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organization_id_id_key" ON "notifications"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_organization_id_user_id_scope_type_key" ON "notification_preferences"("organization_id", "user_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries"("next_attempt_at") WHERE (status = 'pending' OR status = 'failed' OR status = 'sending');

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_transport_key" ON "notification_deliveries"("notification_id", "transport");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_organization_id_notification_id_fkey" FOREIGN KEY ("organization_id", "notification_id") REFERENCES "notifications"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_preferences"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_deliveries"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Cross-tenant work claiming for delivery workers: the ONLY way the runtime role can see due rows of
-- every organization. Returns identifiers only; the worker then loads and processes each row inside
-- withTenant(organization_id). Leases make a crashed worker's claims reclaimable; SKIP LOCKED lets
-- several workers run concurrently. SECURITY DEFINER = runs as the schema owner (exempt from RLS).
CREATE FUNCTION claim_notification_deliveries(p_batch_size integer, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (organization_id uuid, delivery_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT d.id
    FROM notifications.notification_deliveries d
    WHERE d.next_attempt_at <= now()
      AND (d.status IN ('pending', 'failed') OR (d.status = 'sending' AND d.locked_until < now()))
    ORDER BY d.next_attempt_at
    LIMIT LEAST(GREATEST(p_batch_size, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE notifications.notification_deliveries d
  SET status = 'sending',
      locked_until = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 5), 900)),
      attempt_count = d.attempt_count + 1,
      updated_at = now()
  FROM due
  WHERE d.id = due.id
  RETURNING d.organization_id, d.id;
$$;

-- Invariants
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_chk" CHECK (attempt_count >= 0);
