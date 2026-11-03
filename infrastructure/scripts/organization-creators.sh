#!/usr/bin/env bash
# Stores the organization-creator allowlist (ADR 0010 decision 1) in the gitignored .secrets/organization.env, which the
# organization service loads at start next to .secrets/smtp.env. Run it yourself in a terminal: make organization-creators
#
# Only listed addresses whose account email is VERIFIED may create organizations; an empty list means nobody can
# (fail closed). The list you enter replaces the previous one. Other keys already in the file are kept. A value set on
# the command line (ORGANIZATION_CREATOR_EMAILS=… make organization-start) still takes precedence over the file.
set -euo pipefail
set -f # the input is split into words below: never expand it as a glob
umask 077

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$REPO/.secrets"
FILE="$DIR/organization.env"
KEY='ORGANIZATION_CREATOR_EMAILS'

if [ ! -t 0 ]; then
  echo "Run this in an interactive terminal (make organization-creators)." >&2
  exit 1
fi
if ! grep -qxF '.secrets/' "$REPO/.gitignore"; then
  echo ".secrets/ is not listed in .gitignore; refusing to write there." >&2
  exit 1
fi

current=0
if [ -f "$FILE" ]; then
  current="$(grep -E "^$KEY=" "$FILE" | tail -1 | cut -d= -f2- | tr ',' '\n' | grep -c . || true)"
fi
echo "Organization creators currently configured: $current address(es)."
printf 'Email address(es) allowed to create organizations, comma-separated (this replaces the list): '
IFS= read -r input

emails=''
count=0
for raw in $(printf '%s' "$input" | tr ',' ' '); do
  email="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  # Same rule as the organization service's configuration check.
  if ! printf '%s' "$email" | grep -qE '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'; then
    echo "\"$raw\" is not an email address; nothing changed." >&2
    exit 1
  fi
  case ",$emails," in *",$email,"*) continue ;; esac
  emails="${emails:+$emails,}$email"
  count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
  echo "No address entered; nothing changed (an empty list would let nobody create organizations)." >&2
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
tmp="$(mktemp "$DIR/.organization.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  if [ -f "$FILE" ]; then
    grep -vE "^$KEY=" "$FILE" || true
  else
    printf '%s\n' '# SmartConnect organization service settings. LOCAL ONLY, gitignored; written by make organization-creators.'
  fi
  printf '%s=%s\n' "$KEY" "$emails"
} > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$FILE"
trap - EXIT

echo "Saved $count address(es) to .secrets/organization.env (owner-only permissions; gitignored)."
echo "Restart the organization service to apply it: make organization-start"
echo "Each listed account must have a verified email address before it can create an organization."
