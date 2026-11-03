-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('draft', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "WorkflowTriggerType" AS ENUM ('event', 'schedule', 'webhook', 'manual');

-- CreateEnum
CREATE TYPE "WorkflowExecutionStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "status" "WorkflowStatus" NOT NULL DEFAULT 'draft',
    "active_version_number" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "type" "WorkflowTriggerType" NOT NULL,
    "event_type" VARCHAR(128),
    "cron_expression" VARCHAR(120),
    "timezone" VARCHAR(64),
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_executions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "trigger_id" UUID,
    "status" "WorkflowExecutionStatus" NOT NULL DEFAULT 'queued',
    "trigger_payload" JSONB,
    "result" JSONB,
    "error" VARCHAR(4000),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "workflows_organization_id_status_idx" ON "workflows"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_organization_id_id_key" ON "workflows"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_organization_id_id_key" ON "workflow_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_number_key" ON "workflow_versions"("workflow_id", "version_number");

-- CreateIndex
CREATE INDEX "workflow_triggers_organization_id_type_event_type_idx" ON "workflow_triggers"("organization_id", "type", "event_type");

-- CreateIndex
CREATE INDEX "workflow_triggers_due_idx" ON "workflow_triggers"("next_run_at") WHERE (is_enabled AND next_run_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "workflow_executions_organization_id_workflow_id_created_at_idx" ON "workflow_executions"("organization_id", "workflow_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workflow_executions_active_idx" ON "workflow_executions"("created_at") WHERE (status = 'queued' OR status = 'running');

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_organization_id_workflow_id_fkey" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_organization_id_workflow_id_fkey" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_workflow_id_fkey" FOREIGN KEY ("organization_id", "workflow_id") REFERENCES "workflows"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_workflow_version_id_fkey" FOREIGN KEY ("organization_id", "workflow_version_id") REFERENCES "workflow_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workflows"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "workflow_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workflow_versions"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "workflow_triggers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workflow_triggers"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "workflow_executions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workflow_executions"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Invariants
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_number_chk" CHECK (version_number >= 1);
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_event_chk" CHECK (type <> 'event' OR event_type IS NOT NULL);
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_schedule_chk" CHECK (type <> 'schedule' OR cron_expression IS NOT NULL);
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_attempt_chk" CHECK (attempt >= 1);
