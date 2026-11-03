# Backup and restore

## Objectives

| | Proposal (requires sign-off) |
|---|---|
| RPO (max data loss) | ≤ 5 minutes: continuous WAL archiving |
| RTO (max downtime) | ≤ 1 hour for full-cluster restore |
| Retention | 30 days point-in-time; monthly logical snapshots kept 12 months (encrypted) |
| Drills | Quarterly full restore into an isolated environment, timed against RTO |

Redis holds no durable business data (cache, presence, coordination) and is **not** backed up. AOF only gives warm restarts. Losing it costs a cache warm-up and transient presence.

## Local (development) — implemented and verified

### Backup

```bash
make db-backup                                        # = infrastructure/backup/backup.sh dev
infrastructure/backup/backup.sh test /some/dir        # other target / output root
```

Creates `infrastructure/backup/output/<db>-<UTC timestamp>/` (gitignored; directory and files mode 600):

| File | Content |
|---|---|
| `database.dump` | `pg_dump --format=custom --compress=6`: all 14 schemas, data, ownership, grants, default privileges, RLS policies, functions, triggers |
| `globals.sql` | Roles and attributes, `--no-role-passwords` (credentials are re-provisioned, never backed up) |
| `SHA256SUMS` | Integrity checksums, verified by restore |
| `manifest.txt` | Database, server version, timestamp, TOC entry count |

The script **reads the archive back** (`pg_restore --list`) and fails if its table of contents is empty. It is read-only against the source database.

### Restore

```bash
infrastructure/backup/restore.sh <backup-dir> <new-database-name> [test|dev]   # default target: test
```

1. Verifies `SHA256SUMS` (tampering aborts the restore).
2. Refuses to restore over an existing database, the main database, `postgres` or templates. **Restores always go into a new database.**
3. Applies the bootstrap to the cluster's main database (roles are cluster-wide; idempotent).
4. Creates the new database and immediately revokes `PUBLIC` access (`createdb` copies `template1`'s ACL), then `pg_restore --exit-on-error`. **Any failure from here drops the incomplete database** (`ERR` trap), so a half-restored copy never lingers.
5. Re-applies the bootstrap **to the restored database**. Database ACLs and per-database role settings (`search_path`, timeouts) are not part of a `pg_dump` archive.
6. Prints a verification summary (tables, RLS tables, policies, mis-owned tables).

To *replace* the dev database after a verified restore (destructive, deliberate, manual): stop the services, `ALTER DATABASE smartconnect RENAME TO smartconnect_old`, `ALTER DATABASE <restored> RENAME TO smartconnect`, re-run `make db-bootstrap`, start the services, and drop `smartconnect_old` only after verification.

### Verification performed (2026-11-02)

| Check | Result |
|---|---|
| Automated drill (`tests/integration/database/backup-restore.test.ts`): backup → restore → fingerprint compare of tables + owners, exact row counts of all 96 tables, RLS flags, policy definitions, functions (owner + SECURITY DEFINER), grants, per-database role settings | **Identical** |
| Restored database still denies runtime DDL and enforces RLS (no context: 0 rows; tenant context: own rows) | Pass |
| Restore refuses an existing database name, the main database, and a tampered backup (checksum) | Pass |
| A restore that fails inside `pg_restore` (truncated archive with valid checksums) drops the incomplete database | Pass |
| Backup files mode 600; `globals.sql` contains no password hashes | Pass |
| Manual: `backup.sh dev` of the real dev database (802 TOC entries) restored into a new database on the test instance; tables/policies/RLS/functions/migration history compared | **Match** (96 / 52 / 48 / 4 / same migrations); drill database dropped afterwards |

## Production (required before launch)

Logical dumps are a supplement, not the primary strategy.

1. **Primary: physical backups + WAL archiving (PITR).** Use the managed provider's automated backups with PITR, or self-managed pgBackRest / WAL-G: a daily full backup, continuous WAL archiving to object storage, encryption (AES-256), and a cross-region copy.
2. **Secondary: nightly logical dump** (`pg_dump -Fc`, as above) to object storage with a separate KMS key and lifecycle retention. Useful for single-table recovery and for cross-version migration.
3. **Monitoring:** alert on archive lag, backup job failure and backup age.
4. **Drills:** restore quarterly into an isolated account, run `make db-test`-equivalent verification plus row-count spot checks, and record the duration against the RTO.

### Restore scenarios

| Scenario | Procedure |
|---|---|
| Whole-cluster loss | PITR restore to a new instance → apply `010_bootstrap.sql` (re-asserts privileges) → re-provision role passwords from the secrets manager (`ALTER ROLE … PASSWORD`) → repoint PgBouncer → verify `prisma migrate status` for all services |
| Bad deploy / data corruption at time T | PITR to a new instance at T−ε → extract affected rows with `pg_dump --table`/`COPY` → repair forward in production through the owning service. Never overwrite the live cluster |
| Single tenant data recovery | Restore to a scratch instance; for each service schema export rows `WHERE organization_id = :org` (all tenant tables carry it); re-import through the owning service's migrator role in a maintenance window |
| Accidental single-row deletion | Same as above, scoped by primary key |

After any restore the outbox may contain unpublished events from before the incident. Relays resume from `published_at IS NULL`, and consumers are idempotent (`processed_events`), so replays are safe.
