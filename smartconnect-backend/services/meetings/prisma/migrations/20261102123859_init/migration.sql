-- CreateEnum
CREATE TYPE "MeetingKind" AS ENUM ('instant', 'scheduled');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('scheduled', 'live', 'ended', 'cancelled');

-- CreateEnum
CREATE TYPE "MeetingJoinPolicy" AS ENUM ('organization', 'invited', 'link');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('host', 'cohost', 'participant');

-- CreateEnum
CREATE TYPE "InvitationResponse" AS ENUM ('pending', 'accepted', 'declined', 'tentative');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('recording', 'processing', 'ready', 'failed', 'deleted');

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID,
    "channel_id" UUID,
    "conversation_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(5000),
    "kind" "MeetingKind" NOT NULL,
    "status" "MeetingStatus" NOT NULL DEFAULT 'scheduled',
    "join_policy" "MeetingJoinPolicy" NOT NULL DEFAULT 'organization',
    "host_user_id" UUID NOT NULL,
    "scheduled_start_at" TIMESTAMPTZ(3),
    "scheduled_end_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "media_room_id" VARCHAR(128),
    "recording_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_participants" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "invitee_user_id" UUID,
    "invitee_email" VARCHAR(320),
    "invited_by_user_id" UUID NOT NULL,
    "response" "InvitationResponse" NOT NULL DEFAULT 'pending',
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_participants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "user_id" UUID,
    "guest_name" VARCHAR(80),
    "role" "ParticipantRole" NOT NULL DEFAULT 'participant',
    "media_session_id" VARCHAR(128),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_recordings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "file_id" UUID,
    "status" "RecordingStatus" NOT NULL DEFAULT 'recording',
    "started_by_user_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "duration_seconds" INTEGER,
    "size_bytes" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "meeting_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "actor_user_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_events_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "meetings_media_room_id_key" ON "meetings"("media_room_id");

-- CreateIndex
CREATE INDEX "meetings_organization_id_status_scheduled_start_at_idx" ON "meetings"("organization_id", "status", "scheduled_start_at");

-- CreateIndex
CREATE INDEX "meetings_organization_id_channel_id_idx" ON "meetings"("organization_id", "channel_id") WHERE (channel_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "meetings_organization_id_id_key" ON "meetings"("organization_id", "id");

-- CreateIndex
CREATE INDEX "meeting_invitations_organization_id_invitee_user_id_idx" ON "meeting_invitations"("organization_id", "invitee_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_invitations_meeting_id_invitee_user_id_key" ON "meeting_invitations"("meeting_id", "invitee_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_invitations_meeting_id_invitee_email_key" ON "meeting_invitations"("meeting_id", "invitee_email");

-- CreateIndex
CREATE INDEX "meeting_participants_meeting_id_joined_at_idx" ON "meeting_participants"("meeting_id", "joined_at");

-- CreateIndex
CREATE INDEX "meeting_participants_organization_id_user_id_joined_at_idx" ON "meeting_participants"("organization_id", "user_id", "joined_at" DESC);

-- CreateIndex
CREATE INDEX "meeting_recordings_meeting_id_idx" ON "meeting_recordings"("meeting_id");

-- CreateIndex
CREATE INDEX "meeting_recordings_organization_id_created_at_idx" ON "meeting_recordings"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "meeting_events_meeting_id_occurred_at_idx" ON "meeting_events"("meeting_id", "occurred_at");

-- CreateIndex
CREATE INDEX "meeting_events_organization_id_occurred_at_idx" ON "meeting_events"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "meeting_invitations" ADD CONSTRAINT "meeting_invitations_organization_id_meeting_id_fkey" FOREIGN KEY ("organization_id", "meeting_id") REFERENCES "meetings"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_organization_id_meeting_id_fkey" FOREIGN KEY ("organization_id", "meeting_id") REFERENCES "meetings"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_organization_id_meeting_id_fkey" FOREIGN KEY ("organization_id", "meeting_id") REFERENCES "meetings"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_events" ADD CONSTRAINT "meeting_events_organization_id_meeting_id_fkey" FOREIGN KEY ("organization_id", "meeting_id") REFERENCES "meetings"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meetings"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "meeting_invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meeting_invitations"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "meeting_participants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meeting_participants"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "meeting_recordings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meeting_recordings"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "meeting_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meeting_events"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Invariants
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_schedule_order_chk" CHECK (scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at > scheduled_start_at);
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_scheduled_start_chk" CHECK (kind <> 'scheduled' OR scheduled_start_at IS NOT NULL);
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_max_participants_chk" CHECK (max_participants IS NULL OR max_participants > 0);
ALTER TABLE "meeting_invitations" ADD CONSTRAINT "meeting_invitations_invitee_chk" CHECK (invitee_user_id IS NOT NULL OR invitee_email IS NOT NULL);
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_identity_chk" CHECK (user_id IS NOT NULL OR guest_name IS NOT NULL);
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_left_after_join_chk" CHECK (left_at IS NULL OR left_at >= joined_at);
