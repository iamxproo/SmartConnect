#!/usr/bin/env bash
# Logical backup of a SmartConnect PostgreSQL database (local development and restore drills).
# Production uses continuous WAL archiving + base backups (PITR): docs/database/backup-and-restore.md.
#
#   infrastructure/backup/backup.sh [dev|test] [output-root]
#
# Writes <output-root>/<database>-<UTC timestamp>/ containing:
#   database.dump  pg_dump custom-format archive (schemas, data, ownership, grants, RLS policies)
#   globals.sql    roles and role attributes, WITHOUT passwords (credentials are re-provisioned)
#   SHA256SUMS     integrity checksums, verified by restore.sh
#   manifest.txt   provenance
# Backups contain production-grade personal data: files are created mode 600 and the default output
# directory is gitignored. Prints the backup directory path on success.
set -euo pipefail

target="${1:-dev}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# Reads KEY=VALUE from .env the way Compose does: last occurrence wins, CR and surrounding quotes removed.
env_value() {
  grep -E "^$1=" "$repo_root/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" || true
}

case "$target" in
  dev)
    container=smartconnect-postgres
    user="$(env_value POSTGRES_USER)"; db="$(env_value POSTGRES_DB)" ;;
  test)
    container=smartconnect-postgres-test
    user="$(env_value POSTGRES_TEST_USER)"; user="${user:-smartconnect_test_admin}"
    db="$(env_value POSTGRES_TEST_DB)"; db="${db:-smartconnect_test}" ;;
  *)
    echo "usage: $0 [dev|test] [output-root]" >&2; exit 2 ;;
esac
[[ -n "$user" && -n "$db" ]] || { echo "backup: database/user not configured in .env" >&2; exit 1; }

out_root="${2:-$repo_root/infrastructure/backup/output}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$out_root/${db}-${stamp}"
umask 077
mkdir -p "$dir"

docker exec "$container" pg_dump -U "$user" -d "$db" --format=custom --compress=6 > "$dir/database.dump"
docker exec "$container" pg_dumpall -U "$user" --globals-only --no-role-passwords > "$dir/globals.sql"

# A backup is only a backup once it has been read back: list the archive's table of contents.
toc_entries="$(docker exec -i "$container" pg_restore --list < "$dir/database.dump" | grep -cvE '^;|^$')"
[[ "$toc_entries" -gt 0 ]] || { echo "backup: archive table of contents is empty" >&2; exit 1; }

server_version="$(docker exec "$container" psql -XAt -U "$user" -d "$db" -c 'show server_version')"
(cd "$dir" && shasum -a 256 database.dump globals.sql > SHA256SUMS)
cat > "$dir/manifest.txt" <<EOF
database=$db
target=$target
created_at_utc=$stamp
server_version=$server_version
format=pg_dump custom (compress=6)
toc_entries=$toc_entries
EOF

echo "$dir"
