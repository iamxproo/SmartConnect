# Managed PostgreSQL bootstrap (Render)

How to prepare a managed PostgreSQL database, where the provider keeps the superuser, for SmartConnect: 14 schemas, 28 service roles, grants, default privileges and row-level security. This is the same result as the local Docker bootstrap.

- **SQL:** [`infrastructure/compose/postgres/init/010_bootstrap.sql`](../../infrastructure/compose/postgres/init/010_bootstrap.sql). It picks its branch by who runs it.
- **Runner:** [`infrastructure/scripts/db.mjs`](../../infrastructure/scripts/db.mjs) `managed-bootstrap` and `managed-migrate`.
- **Rehearsal:** `make db-rehearse-managed`, which runs on a disposable PostgreSQL 18 container and never touches a provider.
- **Status:** rehearsed locally on PostgreSQL 18.6 (`UNIFIED_BACKEND_PHASE0_REPORT.md`, addendum "Managed PostgreSQL bootstrap"). Not yet run against a real Render database.

## What the administrator must be

The provider's database user, the one in the URL Render shows, must have:

| Requirement | Why | If it is not met |
| --- | --- | --- |
| `LOGIN`, `CREATEROLE` | Creates and administers the 28 service roles. | The bootstrap stops before any change: `needs CREATEROLE`. |
| Owns the target database | Revokes PUBLIC on the database, hardens `public` and gives the migrators `CONNECT`. | The bootstrap stops before any change: `must own database`. |
| No `SUPERUSER` | Otherwise the original (superuser) branch runs. That branch is also correct, but it is not this procedure. | n/a |
| No `BYPASSRLS` or `REPLICATION` (not required) | The administrator is never given to a service. | Not checked: it is the provider's role. |

The service roles must never hold `SUPERUSER`, `REPLICATION` or `BYPASSRLS`; the bootstrap refuses to use one that does. The administrator must not inherit any service role, nor be able to `SET ROLE` to a runtime role. If it can, the bootstrap refuses and names the membership to revoke.

**One SmartConnect environment per PostgreSQL instance.** Role names (`sc_<svc>_app`, `sc_<svc>_migrator`) are cluster-wide, so staging and production cannot share an instance.

## What differs from the superuser bootstrap

| | Superuser (local Docker) | Managed |
| --- | --- | --- |
| Service role attributes | Sets `NOSUPERUSER NOREPLICATION NOBYPASSRLS` explicitly. | PostgreSQL 16+ lets only a role holding those attributes name them, so they are **checked** instead: a role holding one is refused. The other attributes and connection limits (5 per migrator, 25 per runtime role) are set the same way. |
| Schemas, grants on existing objects, default privileges, append-only revokes | Issued as the superuser. | Issued **as the migrator** (`SET LOCAL ROLE`, then `RESET ROLE`), exactly as the owner would issue them. |
| The administrator's membership in service roles | none | `ADMIN` on all 28 (PostgreSQL grants it to the creator). `SET` without `INHERIT` on the 14 migrators. Nothing on runtime roles. `createrole_self_grant` is cleared for the bootstrap's transaction, whatever the provider sets. |
| `postgres` and `template1` | PUBLIC `CONNECT` revoked. | **Not changed**: they belong to the provider (see "Residual" below). |
| `pg_stat_statements` | Created. | Not created by the SQL. `managed-bootstrap` tries it separately and reports "installed" or "skipped". It is optional and not a security control. |

Everything else is identical:
- `REVOKE ALL ON DATABASE … FROM PUBLIC`;
- `public` schema closed;
- schema `USAGE` for the runtime role only;
- DML-only runtime grants;
- functions not executable by PUBLIC;
- `_prisma_migrations` hidden from runtime roles;
- `administration.audit_logs` append-only;
- per-role `search_path`, statement, lock and idle timeouts;
- drift correction on every run.

## Procedure

Run it from a trusted machine with the repository checked out and `npm ci` done. `psql` 16 or later must be on the `PATH`. Nothing below writes into the repository.

1. **Rehearse first:** `make db-rehearse-managed`. It needs Docker and, for the integration suites, `make infra-up` (Redis). Fifteen known failures are expected; see "Residual".
2. **Hand over the administrator's URL without a repository file.** Use the *external* URL with `?sslmode=require` appended. Either:
   - put it in a file outside the repository with mode 600, and point `MANAGED_DATABASE_URL_FILE` at it; or
   - export `MANAGED_DATABASE_URL` in that shell only.

   Do not put it in the repository's `.env`.
3. **Bootstrap and create the service credentials:**
   ```sh
   MANAGED_DATABASE_URL_FILE=/secure/render-admin.url \
     node infrastructure/scripts/db.mjs managed-bootstrap --credentials-file=/secure/smartconnect-render.env
   ```
   - The credentials file must be an absolute path outside the repository; anything else is refused.
   - It receives 28 URLs (mode 600), and its passwords are reused on later runs.
   - Passwords reach the server only as SCRAM verifiers.
   - The command prints the administrator's profile, then checks that every role can sign in. It never prints a password or URL.
4. **Migrate, every service as its own migrator:**
   ```sh
   MANAGED_DATABASE_URL_FILE=/secure/render-admin.url \
     node infrastructure/scripts/db.mjs managed-migrate --credentials-file=/secure/smartconnect-render.env
   ```
   - It runs `prisma migrate deploy` as `sc_<svc>_migrator`, using only that service's `<SVC>_MIGRATION_DATABASE_URL`.
   - The bootstrap then runs again, even if a migration failed, so new objects get their grants.
   - `--service=<svc>` limits it to one service.
5. **Configure the backend:** copy only the runtime URLs into the web service's secret environment. The unified backend reads `IDENTITY_`, `ORGANIZATION_`, `WORKSPACE_`, `MESSAGING_` and `FILES_DATABASE_URL`. Never give a running service a `*_MIGRATION_DATABASE_URL` or the administrator's URL.
6. **After each release that adds migrations:** repeat step 4. `managed-bootstrap` alone is idempotent and corrects privilege drift at any time.

**Rotation:** `managed-bootstrap --rotate` replaces all 28 passwords, and connections using an old password are refused from that moment. Update the backend's secrets straight away; connections already open keep working until they close.

**Security of the administrator's URL:** the administrator administers every service role and can act as every schema owner. Treat its URL as the root credential: store it only in the secret store and the operator's machine.

## Residual: provider databases

PostgreSQL grants PUBLIC `CONNECT` on `postgres` and `template1`. The superuser bootstrap revokes that. A managed administrator cannot, because it does not own those databases.

Consequence: a service role can open a connection to `postgres` or `template1`.
- There it sees the cluster catalog, which it can see from `smartconnect` anyway.
- It has no access to SmartConnect data, which lives only in the database the administrator owns, where PUBLIC holds nothing.
- Its connection limit still applies.

In the security suite, this shows as 15 failing tests. They are kept as failures, not skipped:
- 14 × "runtime role cannot connect to the maintenance database";
- "PUBLIC cannot connect to template1".

To close it, ask the provider to revoke PUBLIC `CONNECT` on those two databases, or record a decision to accept it.
