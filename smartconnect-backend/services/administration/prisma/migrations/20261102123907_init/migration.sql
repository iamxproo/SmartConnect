-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'service', 'system', 'api_key');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'failure', 'denied');

-- CreateEnum
CREATE TYPE "RetentionResource" AS ENUM ('messages', 'files', 'meeting_recordings', 'meeting_events', 'notifications', 'search_history', 'webhook_deliveries', 'workflow_executions', 'audit_logs');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "event_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "source_service" VARCHAR(32) NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "actor_ip" INET,
    "actor_user_agent" VARCHAR(512),
    "action" VARCHAR(128) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" UUID,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'success',
    "request_id" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_key" VARCHAR(64) NOT NULL,
    "settings" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "resource_type" "RetentionResource" NOT NULL,
    "retention_days" INTEGER,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "audit_logs_event_id_key" ON "audit_logs"("event_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_occurred_at_idx" ON "audit_logs"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_occurr_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_actor_id_occurred_at_idx" ON "audit_logs"("organization_id", "actor_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "security_policies_organization_id_policy_key_key" ON "security_policies"("organization_id", "policy_key");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_organization_id_resource_type_key" ON "retention_policies"("organization_id", "resource_type");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
-- audit_logs: tenants read their own events; inserts must match the tenant context, except
-- platform-scope events (organization_id NULL), which are written with no tenant context.
-- There is deliberately NO update/delete policy.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON "audit_logs" FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
CREATE POLICY tenant_insert ON "audit_logs" FOR INSERT
  WITH CHECK (organization_id IS NOT DISTINCT FROM NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "security_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "security_policies"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "retention_policies"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Append-only enforcement independent of grants: nobody may UPDATE or TRUNCATE; only the schema
-- owner may DELETE (retention purge job). The bootstrap additionally revokes UPDATE/DELETE from
-- sc_administration_app, so the runtime role gets "permission denied".
CREATE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: % denied for role %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- Invariants
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_days_chk" CHECK (retention_days IS NULL OR retention_days >= 1);
ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_version_chk" CHECK (version >= 1);
