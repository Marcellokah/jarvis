#!/usr/bin/env bash
# Store a Jarvis secret in the macOS login Keychain, then read it back and
# verify it landed.
#
#   ./scripts/set-secret.sh ICLOUD_APP_PASSWORD
#   ./scripts/set-secret.sh TELEGRAM_BOT_TOKEN --clipboard
#
# `security add-generic-password` prints nothing on success and exits 0 even
# for an empty or mistyped value — the mistake only surfaces later as a 401.
# This wrapper writes, reads back, compares, and sanity-checks the shape.
# The secret is never echoed and never reaches your shell history.
set -euo pipefail

SERVICE="jarvis"
KEY="${1:-}"

if [[ -z "$KEY" ]]; then
  echo "Usage: $0 <KEY> [--clipboard]" >&2
  echo "  e.g. $0 ICLOUD_APP_PASSWORD" >&2
  exit 64
fi

if [[ "${2:-}" == "--clipboard" ]]; then
  VALUE="$(pbpaste)"
  echo "Reading ${KEY} from the clipboard."
else
  if [[ -t 0 ]]; then
    printf 'Value for %s (input hidden, paste works): ' "$KEY" >&2
    IFS= read -rs VALUE
    echo >&2
  else
    # Piped input: `read` returns non-zero at EOF without a trailing newline,
    # which would abort under `set -e` before the value is ever checked.
    IFS= read -r VALUE || true
  fi
fi

VALUE="${VALUE//$'\n'/}"
VALUE="${VALUE//$'\r'/}"
# Trim surrounding whitespace: a trailing space from a copy-paste is invisible
# and turns into an authentication failure days later.
VALUE="${VALUE#"${VALUE%%[![:space:]]*}"}"
VALUE="${VALUE%"${VALUE##*[![:space:]]}"}"

if [[ -z "$VALUE" ]]; then
  echo "✗ Empty value — nothing stored." >&2
  exit 1
fi

# Shape checks for the mistakes that actually happen.
case "$KEY" in
  ICLOUD_APP_PASSWORD)
    # Apple's format is fixed: four groups of four lowercase letters. Anything
    # else is almost always the primary Apple ID password, which CalDAV rejects
    # outright on a 2FA account — and which should not be sitting in a file or
    # a script's environment in the first place.
    if [[ ! "$VALUE" =~ ^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$ ]]; then
      echo "✗ Not an Apple app-specific password." >&2
      echo "  Expected 19 characters as xxxx-xxxx-xxxx-xxxx (16 lowercase letters)." >&2
      echo "  Got ${#VALUE} characters." >&2
      echo >&2
      echo "  If you entered your normal Apple ID password: that will not work." >&2
      echo "  Two-factor accounts require an app-specific password." >&2
      echo >&2
      echo "  Generate one at appleid.apple.com → Sign-In and Security →" >&2
      echo "  App-Specific Passwords → '+'. Copy it exactly, hyphens included." >&2
      exit 1
    fi ;;
  TELEGRAM_BOT_TOKEN)
    if [[ ! "$VALUE" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; then
      echo "⚠️  Doesn't look like a BotFather token (<digits>:<35+ chars>)." >&2
      echo "    Storing anyway — but if Telegram 401s, this is why." >&2
    fi ;;
esac

security add-generic-password -U -s "$SERVICE" -a "$KEY" -w "$VALUE" 2>/dev/null

READBACK="$(security find-generic-password -s "$SERVICE" -a "$KEY" -w 2>/dev/null || true)"
if [[ "$READBACK" != "$VALUE" ]]; then
  echo "✗ Read-back did not match what was written. Nothing to trust here." >&2
  exit 1
fi

echo "✓ ${KEY} stored and verified (${#VALUE} characters)."
echo "  Verify end to end with: npm run smoke"
