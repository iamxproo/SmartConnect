-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('pending_upload', 'scanning', 'available', 'quarantined', 'deleted');

-- CreateEnum
CREATE TYPE "FileContextType" AS ENUM ('message', 'document', 'task', 'meeting_recording', 'workspace');

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "context_type" "FileContextType" NOT NULL,
    "context_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(255) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'pending_upload',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "storage_key" VARCHAR(1024) NOT NULL,
    "mime_type" VARCHAR(255) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "files_organization_id_context_type_context_id_idx" ON "files"("organization_id", "context_type", "context_id");

-- CreateIndex
CREATE INDEX "files_organization_id_uploaded_by_user_id_created_at_idx" ON "files"("organization_id", "uploaded_by_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "files_organization_id_id_key" ON "files"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_storage_key_key" ON "file_versions"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_file_id_version_number_key" ON "file_versions"("file_id", "version_number");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_organization_id_file_id_fkey" FOREIGN KEY ("organization_id", "file_id") REFERENCES "files"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "files"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "file_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "file_versions"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Invariants
ALTER TABLE "files" ADD CONSTRAINT "files_size_chk" CHECK (size_bytes >= 0);
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_size_chk" CHECK (size_bytes >= 0);
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_number_chk" CHECK (version_number >= 1);
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_checksum_chk" CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$');
