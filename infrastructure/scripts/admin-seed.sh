#!/usr/bin/env bash
# Creates or resets the DEVELOPMENT Super Admin (ADR 0015), asking for its initial password with hidden input.
# Run it yourself in a terminal: make admin-seed
#
# The password is never echoed, logged, written to shell history or a file, or passed as a command-line argument:
# printf and read are shell builtins, and it reaches the seed (smartconnect-backend/scripts/seed-super-admin.ts) on
# stdin. It is stored only as an Argon2id hash, marked "must be changed at the first sign-in". The seed refuses
# anything but NODE_ENV=development (or unset) and the local development database.
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

if [ ! -t 0 ]; then
  echo "Run this in an interactive terminal (make admin-seed): the password is read with hidden input." >&2
  exit 1
fi
case "${NODE_ENV-development}" in
  development) ;;
  *)
    echo "Refusing: the Super Admin seed is for development only (NODE_ENV=${NODE_ENV})." >&2
    exit 1
    ;;
esac

echo "Development Super Admin: admin@smartconnect.localhost (local database only)."
printf 'Initial password (input hidden, at least 8 characters; you will replace it at the first sign-in): '
IFS= read -rs password
printf '\n'
printf 'Repeat it: '
IFS= read -rs again
printf '\n'
if [ "$password" != "$again" ]; then
  password=''
  again=''
  echo "The two entries differ; nothing changed." >&2
  exit 1
fi
again=''
if [ "${#password}" -lt 8 ]; then
  password=''
  echo "At least 8 characters, please; nothing changed." >&2
  exit 1
fi

cd "$REPO"
printf '%s' "$password" | npm run --silent db:seed-super-admin --workspace @smartconnect/backend-scripts
password=''
