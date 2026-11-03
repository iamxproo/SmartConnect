# SmartConnect database

PostgreSQL 16 + Redis 7 foundation for SmartConnect's 14 backend services: one database, one schema per service, least-privilege roles, row-level-security tenant isolation, per-service Prisma 7 projects and migrations.

**Status (2026-11-02):** foundation implemented and verified locally. 14 schemas and 28 roles are bootstrapped. 96 tables are migrated on the dev database. The automated suite passes 393/393 against a freshly created test instance. The first application service, **identity** (Phase 1 Task 3), runs on its schema unchanged ([ADR 0009](../decisions/0009-identity-and-authentication.md)); the other services' NestJS modules are not built yet. See [What's next](#whats-next).

## Documents

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | Topology, service ownership, communication rules (outbox), Prisma architecture, capacity, local vs production, open decisions |
| [schema-design.md](schema-design.md) | Conventions, decisions on every candidate entity, per-entity purpose/keys/indexes/tenancy/retention/security |
| [relationships.md](relationships.md) | Foreign-key policy, cross-service logical references, events, deletion cascades |
| [erd.md](erd.md) | Mermaid ERDs, **generated** from the live catalog |
| [schema-reference.md](schema-reference.md) | Every table, column, constraint, index and policy, **generated** |
| [security.md](security.md) | Role model, privileges, authentication, secrets, credential rotation, findings, production checklist |
| [tenant-isolation.md](tenant-isolation.md) | Isolation layers, `withTenant()`, RLS policies, sanctioned cross-tenant operations, rules for new tables |
| [migrations.md](migrations.md) | Rules, authoring workflow, tooling, destructive changes, production execution, failure recovery, seed, verified Prisma 7.10 behaviours |
| [backup-and-restore.md](backup-and-restore.md) | Objectives, local scripts, verified drills, production PITR strategy, restore scenarios |

## Local setup

Prerequisites: Docker Desktop, Node.js ≥ 22.12, `make`. Run everything from the repository root.

```bash
cp .env.example .env              # first time only; set strong URL-safe passwords; chmod 600 .env
make infra-up                     # PostgreSQL 16 + Redis 7, waits until healthy
make install                      # npm ci at the repository root (one workspace, one lockfile)
make db-bootstrap                 # schemas, roles, privileges + per-service credentials (idempotent)
make db-migrate                   # apply every service's migrations (as its migrator role)
make prisma-generate              # generate the 14 Prisma clients
make db-seed                      # optional: demo tenant "Acme Demo"

make test-db-up                   # disposable test PostgreSQL (needed for db-migration / db-drift / db-test)
make db-test                      # full verification against a fresh test instance (~60 s)
```

`make help` lists every target. None of them deletes volumes or the dev database.

### Endpoints

| | Address | Credentials |
|---|---|---|
| PostgreSQL (dev, persistent volume) | `127.0.0.1:15432` / db `smartconnect` | Services: `smartconnect-backend/services/<svc>/.env` (`DATABASE_URL`). Admin: `.env` |
| PostgreSQL (test, tmpfs, `--profile test`) | `127.0.0.1:15433` / db `smartconnect_test` | `.env` (`POSTGRES_TEST_*`); service roles get ephemeral passwords per run |
| Redis | `127.0.0.1:6379` | `.env` (`REDIS_PASSWORD`) |

**Why 15432 and not 5432?** A Homebrew `postgresql@16` service on this Mac owns `localhost:5432`. Clients connecting there reach that server, not SmartConnect. All ports bind to loopback only.

### Repository layout

```
infrastructure/compose/docker-compose.yml          dev Postgres, Redis, test Postgres (profile "test")
infrastructure/compose/postgres/init/010_bootstrap.sql   schemas, roles, privileges (idempotent)
infrastructure/compose/redis/{redis.conf,entrypoint.sh}
infrastructure/scripts/db.mjs                      bootstrap | migrate | status | new-migration | check-drift | rehearse
infrastructure/scripts/db-docs.mjs                 regenerates erd.md + schema-reference.md
infrastructure/backup/{backup.sh,restore.sh}
smartconnect-backend/services/<svc>/
  prisma/schema.prisma, prisma/migrations/         owned by the service
  prisma.config.ts                                 CLI config (migrator credentials)
  src/database/client.ts                           createPrismaClient(), withTenant()
  .env / .env.migration                            generated credentials (gitignored, mode 600)
smartconnect-backend/scripts/seed-dev.ts
tests/integration/database/, tests/security/database/
```

## Common tasks

| Task | Command |
|---|---|
| Change a schema | Edit `schema.prisma` → `make db-migration SERVICE=<svc> NAME=<name>` → review → `make db-test` → `make db-migrate` ([guide](migrations.md#daily-workflow)) |
| Migration status / drift | `make db-status` / `make db-drift` |
| Rotate credentials | `make db-rotate SERVICE=<svc\|all> [ROLE=app\|migrator]`, then restart the service |
| Back up dev | `make db-backup` |
| Restore drill | `infrastructure/backup/restore.sh <dir> <new_db> test` |
| Regenerate ERD/reference | `node infrastructure/scripts/db-docs.mjs` |
| psql as admin | `docker exec -it smartconnect-postgres psql -U smartconnect_admin -d smartconnect` |
| psql as a service | `psql "$(grep ^DATABASE_URL smartconnect-backend/services/messaging/.env \| cut -d= -f2- \| cut -d'?' -f1)"` (libpq rejects Prisma's `?schema=`; the role's `search_path` already points at its schema) |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `password authentication failed` for `sc_*` roles | Credentials not provisioned on this volume. Run `make db-bootstrap` (keeps existing passwords; re-applies verifiers) |
| Connected to `localhost:5432` but tables are missing | That's the Homebrew server. Use port **15432** |
| `ports are not available … 15432` | Another process holds the port: `lsof -nP -iTCP:15432 -sTCP:LISTEN` |
| `permission denied for schema X` from a service | Working as designed: a service may only touch its own schema. Use the owning service's API or events |
| Query returns no rows but data exists | Missing tenant context: wrap the query in `withTenant()` ([tenant-isolation.md](tenant-isolation.md)) |
| `new row violates row-level security policy` | Writing a row whose `organization_id` differs from the context, or using `create()` (RETURNING) for a platform audit event |
| `prisma migrate deploy` → `P3009` failed migration | [Failed migration recovery](migrations.md#failed-migration-recovery) |
| `make db-migration` / `db-drift` says the test instance isn't running | `make test-db-up` |
| `P1001` from the Prisma CLI | Run CLI commands from the service directory (so `.env.migration` loads) or via `make` |
| Init script changes have no effect | `docker-entrypoint-initdb.d` only runs on an **empty** data directory. Existing volumes use `make db-bootstrap` |
| Redis `OOM command not allowed` | Keys without TTL filled `maxmemory`; every cache key must have a TTL |

## What's next

1. Decide the event broker, then build the outbox relay and consumer library (shared *infrastructure* code, not shared data models).
2. Scaffold the NestJS services around `src/database/client.ts`: request-scoped tenant context after the membership guard ([tenant-isolation.md](tenant-isolation.md#tenant-context)).
3. Add claim functions for the workflow scheduler; implement retention jobs per service.
4. Initialise git, push, and enable `.github/workflows/database.yml` in CI.
5. Production: managed PostgreSQL + PgBouncer + secrets manager + PITR ([security.md](security.md#production-hardening-checklist)).
