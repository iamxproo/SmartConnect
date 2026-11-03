-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'active',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),
    "permissions" TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'active',
    "title" VARCHAR(120),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email_normalized" VARCHAR(320) NOT NULL,
    "role_id" UUID NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "organizations_slug_live_key" ON "organizations"("slug") WHERE (deleted_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "organization_roles_organization_id_key_key" ON "organization_roles"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "organization_roles_organization_id_id_key" ON "organization_roles"("organization_id", "id");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE INDEX "organization_members_organization_id_role_id_idx" ON "organization_members"("organization_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_status_created_at_idx" ON "organization_invitations"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_pending_email_key" ON "organization_invitations"("organization_id", "email_normalized") WHERE (status = 'pending');

-- CreateIndex
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("occurred_at") WHERE (published_at IS NULL);

-- CreateIndex
CREATE INDEX "outbox_events_published_idx" ON "outbox_events"("published_at") WHERE (published_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- AddForeignKey
ALTER TABLE "organization_roles" ADD CONSTRAINT "organization_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "organization_roles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_role_id_fkey" FOREIGN KEY ("organization_id", "role_id") REFERENCES "organization_roles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Hand-written SQL (Prisma does not model RLS, CHECK constraints, functions or triggers).
-- Tenant isolation design: docs/database/tenant-isolation.md
-- RLS reads app.current_organization_id / app.current_user_id, set per transaction by
-- withTenant() in src/database/client.ts. Unset context ⇒ NULL ⇒ no rows (fail closed).
-- The schema owner (migrator) is exempt (RLS not FORCEd) for migrations and backfills.
-- =============================================================================
-- organizations is keyed by id (it is the tenant itself).
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations"
  USING (id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
-- A signed-in user may additionally READ the organizations, roles and memberships they belong to
-- (organization switcher). Writes still require the matching tenant context.
CREATE POLICY member_read ON "organizations" FOR SELECT
  USING (id IN (SELECT m.organization_id FROM organization_members m
                WHERE m.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND m.status = 'active'));

ALTER TABLE "organization_roles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organization_roles"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "organization_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organization_members"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE "organization_invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organization_invitations"
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
CREATE POLICY self_read ON "organization_members" FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY member_read ON "organization_roles" FOR SELECT
  USING (organization_id IN (SELECT m.organization_id FROM organization_members m
                             WHERE m.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND m.status = 'active'));

-- Invitation acceptance: the invitee has no tenant context yet. Resolves a token hash to the
-- identifiers of a still-valid invitation and nothing else; the service then loads it via withTenant().
CREATE FUNCTION resolve_invitation_token(p_token_hash text)
RETURNS TABLE (organization_id uuid, invitation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.organization_id, i.id
  FROM organization.organization_invitations i
  WHERE i.token_hash = p_token_hash
    AND i.status = 'pending'
    AND i.expires_at > now();
$$;

-- Invariants
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_format_chk" CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE "organization_roles" ADD CONSTRAINT "organization_roles_key_format_chk" CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$');
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_chk" CHECK ((status = 'accepted') = (accepted_at IS NOT NULL));
