-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('channel', 'direct', 'group');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('standard', 'system');

-- CreateEnum
CREATE TYPE "MentionKind" AS ENUM ('user', 'channel', 'here');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "workspace_id" UUID,
    "channel_id" UUID,
    "direct_key" VARCHAR(80),
    "title" VARCHAR(120),
    "created_by_user_id" UUID,
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "thread_root_id" UUID,
    "sender_user_id" UUID,
    "type" "MessageType" NOT NULL DEFAULT 'standard',
    "body" TEXT NOT NULL,
    "client_message_id" VARCHAR(64),
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_threads" (
    "root_message_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "last_reply_at" TIMESTAMPTZ(3),
    "participant_user_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_threads_pkey" PRIMARY KEY ("root_message_id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id","user_id","emoji")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_mentions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "kind" "MentionKind" NOT NULL,
    "mentioned_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_bookmarks" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_bookmarks_pkey" PRIMARY KEY ("user_id","message_id")
);

-- CreateTable
CREATE TABLE "message_read_states" (
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_read_message_id" UUID,
    "last_read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unread_mention_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_read_states_pkey" PRIMARY KEY ("conversation_id","user_id")
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
CREATE UNIQUE INDEX "conversations_channel_id_key" ON "conversations"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_id_key" ON "conversations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_direct_key_key" ON "conversations"("organization_id", "direct_key");

-- CreateIndex
CREATE INDEX "conversation_members_organization_id_user_id_idx" ON "conversation_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_members_conversation_id_user_id_key" ON "conversation_members"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "messages_timeline_idx" ON "messages"("conversation_id", "created_at" DESC, "id" DESC) WHERE (thread_root_id IS NULL);

-- CreateIndex
CREATE INDEX "messages_thread_replies_idx" ON "messages"("thread_root_id", "created_at") WHERE (thread_root_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_id_key" ON "messages"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_sender_user_id_client_message_id_key" ON "messages"("conversation_id", "sender_user_id", "client_message_id");

-- CreateIndex
CREATE INDEX "message_threads_conversation_id_last_reply_at_idx" ON "message_threads"("conversation_id", "last_reply_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "message_threads_organization_id_root_message_id_key" ON "message_threads"("organization_id", "root_message_id");

-- CreateIndex
CREATE INDEX "message_attachments_organization_id_file_id_idx" ON "message_attachments"("organization_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_message_id_file_id_key" ON "message_attachments"("message_id", "file_id");

-- CreateIndex
CREATE INDEX "message_mentions_inbox_idx" ON "message_mentions"("organization_id", "mentioned_user_id", "created_at" DESC) WHERE (mentioned_user_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "message_mentions_message_id_kind_mentioned_user_id_key" ON "message_mentions"("message_id", "kind", "mentioned_user_id");

-- CreateIndex
CREATE INDEX "message_bookmarks_organization_id_user_id_created_at_idx" ON "message_bookmarks"("organization_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "message_read_states_organization_id_user_id_idx" ON "message_read_states"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_thread_root_id_fkey" FOREIGN KEY ("organization_id", "thread_root_id") REFERENCES "messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_organization_id_root_message_id_fkey" FOREIGN KEY ("organization_id", "root_message_id") REFERENCES "messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_bookmarks" ADD CONSTRAINT "message_bookmarks_organization_id_message_id_fkey" FOREIGN KEY ("organization_id", "message_id") REFERENCES "messages"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_read_states" ADD CONSTRAINT "message_read_states_organization_id_conversation_id_fkey" FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "conversations"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "conversation_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "conversation_members"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messages"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "message_threads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_threads"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "message_reactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_reactions"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_attachments"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "message_mentions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_mentions"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "message_bookmarks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_bookmarks"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "message_read_states" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_read_states"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Invariants
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_kind_chk" CHECK ((kind = 'channel') = (channel_id IS NOT NULL));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_kind_chk" CHECK ((kind = 'direct') = (direct_key IS NOT NULL));
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_length_chk" CHECK (char_length(body) <= 40000);
ALTER TABLE "messages" ADD CONSTRAINT "messages_not_own_thread_root_chk" CHECK (thread_root_id IS NULL OR thread_root_id <> id);
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_chk" CHECK (type = 'system' OR sender_user_id IS NOT NULL);
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_user_kind_chk" CHECK ((kind = 'user') = (mentioned_user_id IS NOT NULL));
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_reply_count_chk" CHECK (reply_count >= 0);
ALTER TABLE "message_read_states" ADD CONSTRAINT "message_read_states_mentions_chk" CHECK (unread_mention_count >= 0);
