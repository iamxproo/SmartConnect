#!/usr/bin/env bash
# Stores SmartConnect's Gmail SMTP settings (ADR 0014) in the gitignored .secrets/smtp.env, asking for the Google App
# Password with hidden input. Run it yourself in a terminal: make smtp-credentials
#
# The password is never echoed, logged, written to shell history or passed as a command-line argument (printf and
# read are shell builtins, so it never appears in a process listing). Other keys already in the file are kept.
# The identity and organization services load the file at start (their `start` scripts), because `make db-bootstrap`
# rewrites each service's own .env.
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$REPO/.secrets"
FILE="$DIR/smtp.env"
MANAGED='^(SMTP_(HOST|PORT|SECURE|USER|PASSWORD|PASSWORD_FILE|FROM)|ACCOUNT_NOTIFIER|INVITATION_NOTIFIER)='

if [ ! -t 0 ]; then
  echo "Run this in an interactive terminal (make smtp-credentials): the password is read with hidden input." >&2
  exit 1
fi
if ! grep -qxF '.secrets/' "$REPO/.gitignore"; then
  echo ".secrets/ is not listed in .gitignore; refusing to write a secret there." >&2
  exit 1
fi

printf 'Google App Password for smartconnectcollab@gmail.com (input hidden, spaces are ignored): '
IFS= read -rs password
printf '\n'
password="${password//[[:space:]]/}"
if [ -z "$password" ]; then
  echo "No password entered; nothing changed." >&2
  exit 1
fi
case "$password" in
  *[!A-Za-z0-9]*)
    password=''
    echo "That does not look like a Google App Password (letters only); nothing changed." >&2
    exit 1
    ;;
esac
if [ "${#password}" -ne 16 ]; then
  echo "Note: Google App Passwords usually have 16 letters; this one differs. Continuing." >&2
fi

printf 'Send real email from the identity and organization services (otherwise they keep the dev mailbox)? [y/N] '
read -r enable

mkdir -p "$DIR"
chmod 700 "$DIR"
tmp="$(mktemp "$DIR/.smtp.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  if [ -f "$FILE" ]; then
    grep -vE "$MANAGED" "$FILE" || true
  else
    printf '%s\n' '# SmartConnect SMTP settings (ADR 0014). LOCAL ONLY, gitignored; written by make smtp-credentials.'
  fi
  printf '%s\n' \
    'SMTP_HOST=smtp.gmail.com' \
    'SMTP_PORT=587' \
    'SMTP_SECURE=false' \
    'SMTP_USER=smartconnectcollab@gmail.com' \
    'SMTP_FROM="SmartConnect <smartconnectcollab@gmail.com>"'
  printf 'SMTP_PASSWORD=%s\n' "$password"
  case "$enable" in
    [yY]*) printf '%s\n' 'ACCOUNT_NOTIFIER=smtp' 'INVITATION_NOTIFIER=smtp' ;;
  esac
} > "$tmp"
password=''
chmod 600 "$tmp"
mv -f "$tmp" "$FILE"
trap - EXIT

echo "Saved to .secrets/smtp.env (owner-only permissions; gitignored)."
case "$enable" in
  [yY]*) echo "Real email is ON for identity and organization: restart them (make identity-start, make organization-start)." ;;
  *) echo "Real email is OFF: the services keep the dev mailbox. Re-run and answer y to turn it on." ;;
esac
echo "Next: make smtp-check (login test, sends nothing), then make smtp-test-email TO=<address you choose>."
