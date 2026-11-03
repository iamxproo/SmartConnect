#!/bin/sh
# Starts Redis with the password read from a Docker secret.
#  - The password never appears in argv (`ps`) or in the container's environment.
#  - Control is handed to the official docker-entrypoint.sh, which chowns /data and
#    drops privileges to the unprivileged `redis` user before exec'ing redis-server.
set -eu

secret_file=/run/secrets/redis_password
[ -r "$secret_file" ] || { echo "redis: missing secret $secret_file" >&2; exit 1; }
password="$(cat "$secret_file")"
# Non-empty and config-safe: quotes, backslashes or newlines would break (or inject into) the config line.
case "$password" in
  '' | *[!A-Za-z0-9_-]*) echo "redis: REDIS_PASSWORD must be non-empty and contain only [A-Za-z0-9_-]" >&2; exit 1 ;;
esac

umask 077
auth_conf=/tmp/redis-auth.conf
printf 'requirepass "%s"\n' "$password" > "$auth_conf"
unset password
chown redis:redis "$auth_conf"

exec docker-entrypoint.sh redis-server /usr/local/etc/redis/redis.conf --include "$auth_conf"
