#!/usr/bin/env bash
# No-trace verification of the release binary.
set -uo pipefail

BINARY="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWED_FILE="$HERE/allowed-strings.txt"

if [[ -z "$BINARY" || ! -f "$BINARY" ]]; then
  echo "Usage: $0 <binary-path>" >&2
  exit 2
fi

if ! command -v strings >/dev/null 2>&1; then
  echo "ERROR: 'strings' not available (binutils package)" >&2
  exit 2
fi

echo "Checking: $BINARY"
echo "Size:     $(du -h "$BINARY" | cut -f1)"
echo

FAILED=0

# --- 1. Absolute build paths ----------------------------------------------
# These reveal the user name and filesystem layout of whoever compiled.
echo "[1/4] Absolute paths..."
PATHS=$(strings "$BINARY" | grep -E '(/home/[a-zA-Z0-9._-]+/|/Users/[a-zA-Z0-9._-]+/|[A-Z]:\\Users\\)' | sort -u)
if [[ -n "$PATHS" ]]; then
  echo "  FOUND:"
  echo "$PATHS" | head -20 | sed 's/^/    /'
  FAILED=1
else
  echo "  OK"
fi

# --- 2. Network endpoints -------------------------------------------------
# The program must contain no address it could contact.
echo "[2/4] Network references..."

KNOWN_TLDS='(com|org|net|io|dev|app|edu|gov|mil|int|info|biz|xyz|tv|me|ai|co|uk|de|fr|it|es|nl|se|no|dk|fi|pl|pt|cz|gr|ie|ch|at|be|eu|us|ca|au|nz|ru|cn|jp|kr|tw|hk|sg|in|br|mx|za|il|test|local|localhost|onion)'

ALLOWED_PATTERN=$(grep -vE '^\s*(#|$)' "$ALLOWED_FILE" 2>/dev/null | sed 's/[.[\*^$()+?{|]/\\&/g' | paste -sd '|')

ALL_URLS=$(strings "$BINARY" \
  | grep -Eo 'https?://(localhost|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+)(:[0-9]+)?(/[a-zA-Z0-9./_?=-]*)?' \
  | sort -u)

if [[ -n "$ALLOWED_PATTERN" ]]; then
  ALL_URLS=$(echo "$ALL_URLS" | grep -Ev "^($ALLOWED_PATTERN)" | grep -v '^$')
fi

REAL=$(echo "$ALL_URLS" | grep -Ei "^https?://([a-zA-Z0-9-]+\.)*$KNOWN_TLDS(:[0-9]+)?(/|$)")
FRAGMENTS=$(echo "$ALL_URLS" | grep -Eiv "^https?://([a-zA-Z0-9-]+\.)*$KNOWN_TLDS(:[0-9]+)?(/|$)" | grep -v '^$')

if [[ -n "$REAL" ]]; then
  echo "  FAIL — addresses not in allowed-strings.txt:"
  echo "$REAL" | head -20 | sed 's/^/    /'
  FAILED=1
else
  echo "  OK — no contactable address outside the allow list"
fi

if [[ -n "$FRAGMENTS" ]]; then
  COUNT=$(echo "$FRAGMENTS" | wc -l)
  echo "  REVIEW — $COUNT string(s) with no recognisable TLD (expected: brotli dictionary)"
  echo "$FRAGMENTS" | head -8 | sed 's/^/    /'
  [[ $COUNT -gt 8 ]] && echo "    ... $((COUNT - 8)) more"
fi

# --- 3. Telemetry libraries ----------------------------------------------.
echo "[3/4] Telemetry and crash reporters..."
TELEMETRY=$(strings "$BINARY" \
  | grep -Eio '(sentry|bugsnag|datadog|mixpanel|amplitude|google-analytics|posthog)' \
  | sort -u)
if [[ -n "$TELEMETRY" ]]; then
  echo "  FOUND:"
  echo "$TELEMETRY" | sed 's/^/    /'
  FAILED=1
else
  echo "  OK"
fi

# --- 4. Debug symbols -----------------------------------------------------
# Not an anonymity problem as such, but it bloats the binary and makes
# analysis easier.
echo "[4/4] Debug symbols..."
if command -v file >/dev/null 2>&1; then
  if file "$BINARY" | grep -q 'not stripped'; then
    echo "  WARNING: symbols present — set strip = true"
    FAILED=1
  else
    echo "  OK"
  fi
else
  echo "  SKIPPED ('file' not available)"
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "RESULT: binary is clean."
else
  echo "RESULT: traces found. Do NOT distribute before fixing."
fi

exit $FAILED
