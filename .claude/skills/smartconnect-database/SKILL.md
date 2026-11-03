---
name: smartconnect-database
description: Use for any SmartConnect database work — changing a service's Prisma schema, adding tables or migrations, writing queries in a backend service, touching roles/privileges/RLS, Docker Compose Postgres/Redis, backups, or the database tests. Encodes the ownership, tenant-isolation and migration rules that tests enforce.
---

# SmartConnect database rules

Read `docs/database/README.md` first; details live in the linked docs. These rules are enforced by
`make db-test` (393 checks) — breaking one fails the build.

## Topology
- Monorepo: ONE npm workspace at the repo root (`make install` = `npm ci`). Never add a `package.json` to a directory that
  contains other workspaces (npm 10 silently skips deps — see docs/decisions/0001-monorepo-npm-workspaces.md).
- One PostgreSQL 16 database `smartconnect`, 14 schemas, one per service in
  `smartconnect-backend/services/<svc>/`. Service list source of truth: `services` array in
  `infrastructure/compose/postgres/init/010_bootstrap.sql` (also `SERVICES` in `infrastructure/scripts/lib/db-lib.mjs`).
- Roles per service: `sc_<svc>_migrator` (owns the schema, runs migrations) and `sc_<svc>_app` (runtime, DML only, RLS applies).
- Dev Postgres is `127.0.0.1:15432` (NOT 5432 — a Homebrew Postgres owns that). Test instance `127.0.0.1:15433` (tmpfs, disposable).

## Never
- Never query or reference another service's schema; use its API or its events (outbox). Privileges make cross-schema SQL fail anyway.
- Never create a shared Prisma schema/client package.
- Never run `prisma db push`, `prisma migrate reset` or `prisma migrate dev` against the dev database.
- Never edit an applied migration. Never delete Docker volumes (`down -v`) or the dev database.
- Never put credentials in tracked files. Service creds are generated into gitignored `services/<svc>/.env` (runtime) and `.env.migration` (CLI only).
- Never give the runtime service the migrator credentials or the admin account.

## Schema conventions (Prisma 7.10.1, pinned)
- PK `id String @id @default(uuid(7)) @db.Uuid`; snake_case via `@map`/`@@map`; timestamps `@db.Timestamptz(3)`;
  `updatedAt DateTime @default(now()) @updatedAt`.
- Tenant tables: `organizationId String @map("organization_id") @db.Uuid` (NOT NULL), parents add
  `@@unique([organizationId, id])`, relations are composite:
  `@relation(fields: [organizationId, parentId], references: [organizationId, id], onDelete: Cascade)` — also for optional relations.
- Cross-service references: plain UUID column, no relation, comment `/// → <service>.<table> (logical)`.
- Partial-index predicates (`where: raw(...)`): use `=`, `OR`, `IS [NOT] NULL` only — `IN (...)` causes permanent drift.
- Soft delete only where justified (see docs/database/schema-design.md#conventions).

## Changing a schema
1. Edit `services/<svc>/prisma/schema.prisma`; `npx prisma format && npx prisma validate` in that directory.
2. `make test-db-up` then `make db-migration SERVICE=<svc> NAME=<snake_case>` (diffs in a shadow DB on the test instance; wraps SQL in BEGIN/COMMIT because Prisma migrations are not atomic).
3. For every NEW tenant table, append ABOVE the final `COMMIT;`:
   ```sql
   ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "<table>"
     USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
     WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
   ```
   Do not reference role names in migrations (grants come from default privileges).
4. `make db-test` (fresh instance, all suites) → `make db-migrate` → `make db-drift` → `make prisma-generate && make typecheck`
   → `make db-docs` (regenerates erd.md + schema-reference.md) → `make ci-local` before pushing.

## Writing service code
- Build clients only via `src/database/client.ts` (`createPrismaClient()`).
- Every tenant query runs inside `withTenant(prisma, { organizationId, userId }, tx => ...)`; the ids come from the
  authenticated request after the membership check, never from the request body. Outside it, tenant tables return nothing.
- RLS isolates tenants only; membership/permission checks inside a tenant (private channels, document visibility) are service code.
- `create()` uses RETURNING, which must pass the SELECT policy — rows the caller cannot read (platform audit events) use `createMany()`.
- Cross-tenant work (queues) only through narrow SECURITY DEFINER functions (`SET search_path = pg_catalog, pg_temp`, qualified names, ids-only results), e.g. `notifications.claim_notification_deliveries()`.
- Durable events: insert into the service's own `outbox_events` in the same transaction; consumers record `processed_events`.
- Redis: cache/ephemeral only; every cache key needs a TTL (`volatile-lru`).
