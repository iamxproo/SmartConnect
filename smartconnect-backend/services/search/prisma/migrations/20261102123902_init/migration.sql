-- CreateEnum
CREATE TYPE "SearchSourceType" AS ENUM ('message', 'file', 'document', 'task', 'channel', 'meeting');

-- CreateTable
CREATE TABLE "search_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_type" "SearchSourceType" NOT NULL,
    "source_id" UUID NOT NULL,
    "workspace_id" UUID,
    "access_scope_ids" UUID[],
    "title" VARCHAR(500),
    "body" TEXT NOT NULL,
    "search_vector" tsvector,
    "source_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_searches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "query" VARCHAR(500) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "query" VARCHAR(500) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "result_count" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_history_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "search_documents_search_vector_idx" ON "search_documents" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "search_documents_access_scope_ids_idx" ON "search_documents" USING GIN ("access_scope_ids");

-- CreateIndex
CREATE UNIQUE INDEX "search_documents_organization_id_source_type_source_id_key" ON "search_documents"("organization_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "saved_searches_organization_id_user_id_idx" ON "saved_searches"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "search_history_organization_id_user_id_created_at_idx" ON "search_history"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "search_history_organization_id_created_at_idx" ON "search_history"("organization_id", "created_at");

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
ALTER TABLE "search_documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "search_documents"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "saved_searches" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "saved_searches"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "search_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "search_history"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
