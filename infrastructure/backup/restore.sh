#!/usr/bin/env bash
# Restores a backup produced by backup.sh into a NEW database. Never overwrites an existing database.
#
#   infrastructure/backup/restore.sh <backup-dir> <new-database-name> [test|dev]
#
# Steps: verify checksums → ensure roles exist (bootstrap on the cluster's main database) → create the
# new database → pg_restore (ownership, grants, default privileges and RLS policies come from the
# archive) → re-apply the bootstrap to the restored database (database ACLs and per-database role
# settings are not part of a pg_dump archive) → print a verification summary.
# Default target is the disposable TEST instance; restore drills should run there.
set -euo pipefail

die() { echo "restore: $*" >&2; exit 1; }
[[ $# -ge 2 ]] || die "usage: $0 <backup-dir> <new-database-name> [test|dev]"
dir="$1"; new_db="$2"; target="${3:-test}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
bootstrap_sql="$repo_root/infrastructure/compose/postgres/init/010_bootstrap.sql"
# Reads KEY=VALUE from .env the way Compose does: last occurrence wins, CR and surrounding quotes removed.
env_value() {
  grep -E "^$1=" "$repo_root/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" || true
}

case "$target" in
  test)
    container=smartconnect-postgres-test
    user="$(env_value POSTGRES_TEST_USER)"; user="${user:-smartconnect_test_admin}"
    main_db="$(env_value POSTGRES_TEST_DB)"; main_db="${main_db:-smartconnect_test}" ;;
  dev)
    container=smartconnect-postgres
    user="$(env_value POSTGRES_USER)"; main_db="$(env_value POSTGRES_DB)" ;;
  *) die "target must be test or dev" ;;
esac

[[ "$new_db" =~ ^[a-z][a-z0-9_]{2,62}$ ]] || die "invalid database name: $new_db"
[[ "$new_db" != "$main_db" && "$new_db" != postgres && "$new_db" != template* ]] || die "refusing to restore over $new_db"
[[ -f "$dir/database.dump" && -f "$dir/SHA256SUMS" ]] || die "$dir is not a backup directory"
(cd "$dir" && shasum -a 256 -c --quiet SHA256SUMS) || die "checksum verification failed"

psql_admin() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U "$user" "$@"; }

exists="$(psql_admin -At -d postgres -c "select 1 from pg_database where datname = '$new_db'")"
[[ -z "$exists" ]] || die "database $new_db already exists — restore never overwrites"

psql_admin -d "$main_db" < "$bootstrap_sql"                 # roles are cluster-wide; idempotent
docker exec "$container" createdb -U "$user" "$new_db"
# Any failure from here on drops the incomplete database instead of leaving it half-restored.
trap 'echo "restore: failed — dropping incomplete database $new_db" >&2
      psql_admin -d postgres -c "DROP DATABASE IF EXISTS \"$new_db\" WITH (FORCE)" >/dev/null' ERR
# createdb copies template1's ACL (PUBLIC may CONNECT/TEMP): lock it down before restoring any data.
psql_admin -d postgres -c "REVOKE ALL ON DATABASE \"$new_db\" FROM PUBLIC"
docker exec -i "$container" pg_restore -U "$user" -d "$new_db" --exit-on-error < "$dir/database.dump"
psql_admin -d "$new_db" < "$bootstrap_sql"
trap - ERR

psql_admin -At -d "$new_db" <<'SQL'
select 'tables=' || count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema', 'public');
select 'rls_tables=' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relrowsecurity and n.nspname not in ('pg_catalog', 'information_schema');
select 'policies=' || count(*) from pg_policies;
select 'misowned_tables=' || count(*) from pg_tables
  where schemaname not in ('pg_catalog', 'information_schema', 'public') and tableowner <> 'sc_' || schemaname || '_migrator';
SQL
echo "restored=$new_db"
