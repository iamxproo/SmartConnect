-- CreateEnum
CREATE TYPE "DocumentVisibility" AS ENUM ('private', 'workspace', 'organization');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID,
    "owner_user_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "visibility" "DocumentVisibility" NOT NULL DEFAULT 'private',
    "current_version_number" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "author_user_id" UUID NOT NULL,
    "change_summary" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "parent_comment_id" UUID,
    "author_user_id" UUID NOT NULL,
    "body" VARCHAR(10000) NOT NULL,
    "anchor" JSONB,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "document_comments_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "documents_organization_id_workspace_id_updated_at_idx" ON "documents"("organization_id", "workspace_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "documents_organization_id_owner_user_id_updated_at_idx" ON "documents"("organization_id", "owner_user_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "documents_organization_id_id_key" ON "documents"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "document_comments_document_id_created_at_idx" ON "document_comments"("document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_comments_organization_id_id_key" ON "document_comments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "documents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_organization_id_document_id_fkey" FOREIGN KEY ("organization_id", "document_id") REFERENCES "documents"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_organization_id_parent_comment_id_fkey" FOREIGN KEY ("organization_id", "parent_comment_id") REFERENCES "document_comments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "documents"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_versions"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "document_comments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_comments"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Invariants
ALTER TABLE "documents" ADD CONSTRAINT "documents_version_chk" CHECK (current_version_number >= 0);
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_number_chk" CHECK (version_number >= 1);
