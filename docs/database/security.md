# Database security

Least privilege, enforced by PostgreSQL and verified by the automated suite (`tests/security/database/`).

## Principles

1. **Services never use the admin account.** `smartconnect_admin` (superuser) is used only to apply the bootstrap. On a managed database without a superuser (Render), the provider's administrator (CREATEROLE, owner of the database) applies it instead, with the same result; see [../runbooks/managed-postgres-bootstrap.md](../runbooks/managed-postgres-bootstrap.md).
2. **Runtime and migration credentials are separate roles and separate files.**
3. **Runtime roles own nothing and create nothing.** They get USAGE on one schema and DML on its tables, nothing more.
4. **Every privilege is granted explicitly, and the bootstrap re-asserts the model on every run**: role attributes, memberships, database and schema ACLs, and the grants on every *existing* table, sequence and routine (any other grantee is stripped). Manual drift is reverted, and this is tested by injecting stray grants. `make db-migrate` re-runs it even when a migration fails.
5. **Defaults fail closed.** New roles have no password (cannot log in). RLS with no tenant context returns no rows. New tables get privileges only if the migrator created them.

## Role model

For each of the 14 services (`<svc>` = schema name):

| | `sc_<svc>_migrator` | `sc_<svc>_app` |
|---|---|---|
| Purpose | Owns schema `<svc>` and every object in it; runs `prisma migrate deploy` | Runtime role used by the NestJS service |
| Attributes | LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, NOINHERIT, CONNECTION LIMIT 5 | Same attributes, CONNECTION LIMIT 25 |
| Database | CONNECT only (no CREATE: cannot create schemas; no TEMPORARY) | CONNECT only |
| Own schema | Owner (all DDL) | USAGE |
| Own tables | Owner | SELECT, INSERT, UPDATE, DELETE (no TRUNCATE, no DDL), via default privileges |
| `_prisma_migrations` | Owner | **No access** |
| `administration.audit_logs` | Owner (DELETE allowed for retention purge; UPDATE/TRUNCATE blocked by trigger) | SELECT, INSERT only |
| Functions in own schema | Owner | EXECUTE (revoked from PUBLIC) |
| Other schemas, `public` | Nothing | Nothing |
| Row-level security | Exempt as table owner (RLS is not FORCEd), for migrations and backfills | **Subject to RLS** |
| Session defaults | `search_path=<svc>`, `lock_timeout=10s`, `idle_in_transaction_session_timeout=5min` | `search_path=<svc>`, `statement_timeout=15s`, `lock_timeout=5s`, `idle_in_transaction_session_timeout=30s` |
| Role memberships | None (bootstrap revokes any) | None |

Also enforced:
- `REVOKE ALL ON DATABASE smartconnect FROM PUBLIC` and `REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC`.
- `REVOKE ALL ON SCHEMA public FROM PUBLIC`. The `public` schema holds no application objects; `pg_stat_statements` lives there for superuser use only.
- `ALTER DEFAULT PRIVILEGES FOR ROLE sc_<svc>_migrator …`: tables get DML for the runtime role, sequences get USAGE/SELECT, and functions get EXECUTE for the runtime role only (revoked from PUBLIC).
- The append-only list in the bootstrap (`administration.audit_logs`) revokes UPDATE/DELETE/TRUNCATE from the runtime role.

**Why the migrator does not need database CREATE:** schemas are pre-created by the bootstrap and owned by the migrator. Prisma's `CREATE SCHEMA IF NOT EXISTS` would fail without database CREATE, even when the schema exists. `make db-migration` never emits it for existing schemas and guards it when it does ([migrations.md](migrations.md#prisma-710-behaviours-verified)).

### Where it is implemented

| File | Responsibility |
|---|---|
| [`infrastructure/compose/postgres/init/010_bootstrap.sql`](../../infrastructure/compose/postgres/init/010_bootstrap.sql) | Schemas, roles, attributes, grants, default privileges, session defaults, drift correction. Idempotent, database-name agnostic |
| [`infrastructure/scripts/db.mjs`](../../infrastructure/scripts/db.mjs) `bootstrap` | Applies the SQL, provisions passwords as SCRAM verifiers, writes per-service credential files (mode 600), verifies all 28 logins |
| Each service's `prisma/migrations/*_init/migration.sql` (hand-written section) | RLS policies, CHECK constraints, SECURITY DEFINER functions, audit immutability trigger |
| [`tests/security/database/`](../../tests/security/database/) | Catalog assertions and attempted violations for every role |

## Authentication

- `password_encryption = scram-sha-256`. Every service role stores a SCRAM-SHA-256 verifier (asserted by tests).
- **Plaintext passwords never reach the server.** `db.mjs` computes the RFC 5802/7677 verifier client-side and sends `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$4096:…'`. Passwords can therefore not appear in server logs, `pg_stat_activity` or `log_statement` output.
- Generated passwords: 30 random bytes, base64url (40 characters, 240 bits).
- Inside the container, `pg_hba.conf` (image default on the existing volume) trusts the local unix socket. Only processes inside the container can reach it, and `docker exec` access already implies root. TCP from anywhere requires SCRAM. Fresh volumes are initialised with `--auth-host=scram-sha-256`, so even in-container TCP needs a password.
- Production: `hostssl … scram-sha-256` only, `sslmode=verify-full` in every connection string, no `trust` lines.
- **Logs never contain bind parameters:** `log_parameter_max_length=0` (and `_on_error=0`), so slow-query logging (`log_min_duration_statement=500ms`) cannot leak token hashes, emails or message bodies (tested).

## Secrets handling

| Secret | Local location | Never |
|---|---|---|
| PostgreSQL admin, test-admin and Redis passwords | Repository-root `.env` (gitignored, mode 600). Injected into containers as **Compose secrets** (`/run/secrets/*`), so they are absent from `docker inspect` (verified by test) | In compose files, images, logs, docs |
| Service runtime credentials | `smartconnect-backend/services/<svc>/.env` (gitignored, mode 600) | In `.env.migration` or in the admin `.env` |
| Service migrator credentials | `smartconnect-backend/services/<svc>/.env.migration` (gitignored, mode 600), read only by `prisma.config.ts` | Loaded by the NestJS process |

Credential files are written atomically: a temp file is created exclusively with mode 600 (never following a planted symlink), then renamed over the target. `db.mjs` stages the files, changes the passwords in PostgreSQL, and publishes the files last, so a failure can never leave a role with a password that no file holds.
| Backups | `infrastructure/backup/output/` (gitignored, mode 600). `globals.sql` is dumped `--no-role-passwords` (verified: 0 hashes) | Committed or shared unencrypted |

The repository is not yet under git. `.gitignore` is in place so `git init` cannot accidentally stage secrets. Run `git status --ignored` after initialising to confirm.

**Production:** store every credential in a secrets manager, one secret per role. Inject the runtime secret only into the service's Deployment and the migrator secret only into its migration Job. Enable secret-access audit logging.

## Credential rotation

### Local development

```bash
make db-rotate SERVICE=messaging             # both roles of one service
make db-rotate SERVICE=messaging ROLE=app    # runtime role only
make db-rotate SERVICE=all                   # every service role
```

This generates new passwords, applies the verifiers, rewrites the service's `.env` / `.env.migration` and re-verifies every login. Restart affected services afterwards: existing connections stay open until then.

Admin password (local): `POSTGRES_PASSWORD` is only read when a data directory is first initialised, so change the role itself with `docker exec -it smartconnect-postgres psql -U smartconnect_admin -d smartconnect -c '\password smartconnect_admin'` (`\password` hashes client-side), then store the same value in `.env`. Redis password: update `REDIS_PASSWORD` in `.env`, then `docker compose -f infrastructure/compose/docker-compose.yml --env-file .env up -d --force-recreate redis`. Compose does not reliably detect a changed secret value on its own. AOF data is kept.

### Production (zero-downtime)

PostgreSQL validates the password only when a connection is opened, so established pool connections survive a password change. Recommended procedure per role:

1. Generate the new password in the secrets manager as a new **pending** version.
2. Apply it: `ALTER ROLE sc_<svc>_app PASSWORD '<SCRAM verifier>'` (compute the verifier client-side as `db.mjs` does, or use `psql \password`, which also hashes client-side).
3. Promote the secret version and perform a rolling restart of the service. New connections use the new password; old ones drain.
4. Confirm `pg_stat_activity` shows connections from new pods only, then retire the old version.

The window between steps 2 and 3 is the only exposure. A pod that opens a *new* connection with the old password during it fails and retries. For strict zero-failure rotation, use **dual roles** (`sc_<svc>_app_a` / `_b` as members of a NOLOGIN `sc_<svc>_runtime` group that holds the grants) and alternate between them. That is a planned enhancement and is not implemented. Rotate at least every 90 days, and immediately on suspected exposure or staff offboarding. Set `VALID UNTIL` on break-glass admin credentials.

## SECURITY DEFINER functions

They are the **only** sanctioned way for a runtime role to act across tenants. Rules (all current functions comply):
- Fixed `SET search_path = pg_catalog, pg_temp`, and fully schema-qualified object names.
- Return identifiers only, never row contents. The caller then loads data inside `withTenant()`.
- Clamp every numeric input (batch size ≤ 500, lease 5–900 s).
- EXECUTE granted to the owning service's runtime role only.

| Function | Purpose |
|---|---|
| `organization.resolve_invitation_token(text)` | Invitee has no tenant context yet. Returns `(organization_id, invitation_id)` for a valid, unexpired, pending token hash. It is an oracle on its input, so **invitation tokens must be ≥ 128 bits from a CSPRNG** (service requirement) and the accept endpoint must be rate-limited |
| `notifications.claim_notification_deliveries(int, int)` | Workers lease due deliveries across tenants (`FOR UPDATE SKIP LOCKED`). Never re-claims a delivery after 20 attempts (poison-message ceiling) |
| `integrations.claim_webhook_deliveries(int, int)` | Same pattern and ceiling for outgoing webhooks |
| `organization.platform_organization_ids(int, uuid)`, `organization.platform_organization_count()` | Platform administration ([ADR 0015](../decisions/0015-platform-administration.md)): organization ids, newest first, at most 101 per call (a page of 100 plus one), and the total. Deleted organizations excluded. The service's `SuperAdminGuard` decides who may call them; each organization is then read in `withTenant()` |

## Data protection

- **Tokens are stored as SHA-256 hashes only**: refresh tokens, invitation tokens, verification tokens. Passwords are Argon2id hashes in `identity.credentials`, kept apart from `users`.
- **Third-party secrets** (`integration_connections.credentials_ciphertext`, `webhooks.secret_ciphertext`) are envelope-encrypted by the service: AES-256-GCM data keys wrapped by a KMS key, with the key id stored alongside. The database never sees plaintext. Implementing the KMS integration is the integrations service's responsibility (not yet built).
- **Audit logs** are append-only (grants + trigger). `metadata` must have secrets and message bodies redacted before ingestion.
- **PII inventory** (for retention and erasure): `identity.users.email*`, `user_profiles.*`, `sessions.ip_address`, `sessions.user_agent`, `audit_logs.actor_ip`, `audit_logs.actor_user_agent`, message and document bodies, `search_history.query`, `meeting_invitations.invitee_email`, `organization_invitations.email_normalized`.
- Encryption at rest: provider-managed in production. The local Docker volume is not encrypted beyond FileVault.

## Redis

Password authentication (`requirepass`, injected from a Docker secret by `entrypoint.sh`, so it is absent from argv and container env). Runs as the unprivileged `redis` user. Loopback-only port. `maxmemory 256mb` with `volatile-lru`. Every cache key **must** carry a TTL; keys without one are never evicted. Production: TLS plus one ACL user per service, restricted to its key prefix (`~<svc>:*`) and without `@dangerous` commands.

## Security findings from this phase

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | PostgreSQL and Redis published on `0.0.0.0` and `::`, reachable from the LAN | High | **Fixed**: loopback-only bindings (verified by test) |
| 2 | A Homebrew `postgresql@16` on the host owns `127.0.0.1:5432`. Under the old binding, `localhost:5432` clients reached the Homebrew server, **not** the SmartConnect container | High (correctness) | **Mitigated**: SmartConnect moved to 15432/15433. Stopping the Homebrew service is a human decision |
| 3 | Only a superuser existed; applications would have used it | High | **Fixed**: 28 least-privilege roles |
| 4 | `PUBLIC` had CONNECT/TEMP on the database and USAGE on `public` | Medium | **Fixed** |
| 5 | Redis ran as root (`sh -c` command bypassed the image's privilege drop); password in the healthcheck argv; no `exec`, so no graceful shutdown | Medium | **Fixed**: entrypoint wrapper, `REDISCLI_AUTH`, `exec`, runs as `redis` |
| 6 | Secrets visible via `docker inspect` (environment variables) | Low | **Fixed**: Compose secrets |
| 7 | `.env` world-readable (644) and no `.gitignore` | Medium | **Fixed**: 600 + `.gitignore` |
| 8 | Data checksums off on the existing local volume | Low (local) | Accepted locally; on for fresh volumes; required in production |
| 9 | Unbounded Redis memory with `noeviction` | Low | **Fixed**: 256 MB, `volatile-lru` |
| 10 | Connection budget (14 × 10 pool) exceeded `max_connections` | Medium | **Fixed**: default pool 5, role connection limits |

**Independent security review** (separate reviewer, after implementation). Each finding was re-verified before acting on it:

| # | Finding | Severity | Status |
|---|---|---|---|
| R1 | Organization user-scoped read policies also applied *inside* a tenant context: `withTenant(A, U)` saw U's memberships, roles and orgs in other tenants (reproduced: 2 orgs visible instead of 1) | Medium | **Fixed**: migration `scope_user_read_policies` (policies apply only without a tenant context) + regression test |
| R2 | Slow-query logging wrote full bind parameters (`log_parameter_max_length = -1`, reproduced) | Medium | **Fixed**: `log_parameter_max_length=0` + test |
| R3 | Bootstrap only set *default* privileges, so manual grants on existing objects survived; a failed `make db-migrate` skipped privilege re-assertion | Medium | **Fixed**: per-schema grant reset + `finally` re-assertion + test |
| R4 | Claim functions re-claimed failing deliveries forever | Medium | **Fixed**: migrations `cap_claim_attempts` (ceiling 20) + test |
| R5 | Credential files: mode applied only on create; DB updated before files written | Low–Medium | **Fixed**: exclusive temp file + atomic rename, staged before the DB change |
| R6 | A failed restore left a half-restored database open to `PUBLIC`; `template1` connectable by `PUBLIC` | Low | **Fixed**: lock-down right after `createdb`, `ERR` trap drops the database, `template1` CONNECT revoked + tests |
| R7 | Backup scripts parsed `.env` without stripping quotes/CR; Redis entrypoint accepted an empty or config-unsafe password | Low | **Fixed** |
| R8 | `withTenant()` threw synchronously for bad ids | Low | **Fixed**: `async`; rejects instead |
| R9 | `outbox_events` has no RLS | Design decision | **Kept**: the relay must read every tenant's events as this same role, so a definer function would hand the same data to the same role. Only relay code may touch the table. Revisit when the relay is designed |
| R10 | Tenant GUCs are forgeable through SQL injection; audit `event_id` / platform rows insertable by a compromised runtime role | Inherent | Documented: RLS defends against application bugs, not a compromised role or SQL injection. Parameterised queries are mandatory |
| R11 | Global unique keys (`conversations.channel_id`, `meetings.media_room_id`, `file_versions.storage_key`) can reveal existence via unique-violation errors | Low | Accepted: needs guessing 74 random bits of a UUIDv7 / server-generated key |
| R12 | `webhooks_https_chk` allows internal hosts; local backups unencrypted and checksums are not signatures | Low | Documented: SSRF egress filtering in the delivery worker; production backups encrypted + access-controlled ([backup-and-restore.md](backup-and-restore.md)) |
| R13 | Managed databases: PUBLIC keeps `CONNECT` on the provider's `postgres` and `template1`, which a non-owner administrator cannot revoke | Low | **Open, provider-dependent**: no SmartConnect data there, and the 15 tests that check it fail rather than being skipped. Ask the provider, or accept it ([runbook](../runbooks/managed-postgres-bootstrap.md#residual-provider-databases)) |

## Production hardening checklist

- [ ] Managed PostgreSQL 16, private networking, TLS enforced (`hostssl`, `verify-full`), encryption at rest
- [ ] Bootstrap SQL applied by the pipeline's admin role (managed: [runbook](../runbooks/managed-postgres-bootstrap.md)). Admin credentials are never given to services
- [ ] One secret per role in the secrets manager; migrator secrets only in migration jobs
- [ ] PgBouncer (transaction mode) between services and PostgreSQL
- [ ] `log_connections`, `log_disconnections` and pgAudit (DDL + role changes) enabled; logs shipped to the SIEM
- [ ] Rotation schedule (≤ 90 days) and offboarding runbook
- [ ] PITR backups plus quarterly restore drills ([backup-and-restore.md](backup-and-restore.md))
- [ ] Redis: TLS, per-service ACL users, no persistence of sensitive data
