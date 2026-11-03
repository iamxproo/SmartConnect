-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('active', 'disabled', 'error', 'revoked');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'sending', 'succeeded', 'failed', 'abandoned');

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'active',
    "display_name" VARCHAR(120),
    "external_account_id" VARCHAR(255),
    "scopes" TEXT[],
    "credentials_ciphertext" BYTEA,
    "credentials_key_id" VARCHAR(255),
    "config" JSONB NOT NULL DEFAULT '{}',
    "installed_by_user_id" UUID NOT NULL,
    "last_synced_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "target_url" VARCHAR(2048) NOT NULL,
    "event_types" TEXT[],
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_key_id" VARCHAR(255) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "response_status" SMALLINT,
    "response_body_excerpt" VARCHAR(1024),
    "last_error" VARCHAR(1000),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "integration_connections_organization_id_id_key" ON "integration_connections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_organization_id_provider_external_a_key" ON "integration_connections"("organization_id", "provider", "external_account_id");

-- CreateIndex
CREATE INDEX "webhooks_organization_id_is_enabled_idx" ON "webhooks"("organization_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_organization_id_id_key" ON "webhooks"("organization_id", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_id_created_at_idx" ON "webhook_deliveries"("webhook_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries"("next_attempt_at") WHERE (status = 'pending' OR status = 'failed' OR status = 'sending');

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhook_id_event_id_key" ON "webhook_deliveries"("webhook_id", "event_id");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "integration_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_webhook_id_fkey" FOREIGN KEY ("organization_id", "webhook_id") REFERENCES "webhooks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_connections"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhooks"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Cross-tenant work claiming for delivery workers: the ONLY way the runtime role can see due rows of
-- every organization. Returns identifiers only; the worker then loads and processes each row inside
-- withTenant(organization_id). Leases make a crashed worker's claims reclaimable; SKIP LOCKED lets
-- several workers run concurrently. SECURITY DEFINER = runs as the schema owner (exempt from RLS).
CREATE FUNCTION claim_webhook_deliveries(p_batch_size integer, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (organization_id uuid, delivery_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT d.id
    FROM integrations.webhook_deliveries d
    WHERE d.next_attempt_at <= now()
      AND (d.status IN ('pending', 'failed') OR (d.status = 'sending' AND d.locked_until < now()))
    ORDER BY d.next_attempt_at
    LIMIT LEAST(GREATEST(p_batch_size, 1), 500)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE integrations.webhook_deliveries d
  SET status = 'sending',
      locked_until = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 5), 900)),
      attempt_count = d.attempt_count + 1,
      updated_at = now()
  FROM due
  WHERE d.id = due.id
  RETURNING d.organization_id, d.id;
$$;

-- Invariants
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_https_chk" CHECK (target_url ~ '^https://');
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_failure_count_chk" CHECK (failure_count >= 0);
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_attempts_chk" CHECK (attempt_count >= 0);
