#!/usr/bin/env bash
set -euo pipefail

app="${1:-}"
if [[ -z "$app" ]]; then
  echo "Usage: $0 grt-paper   (or any other GRT program installed from its .deb)" >&2
  exit 2
fi
if ! sudo grep -q "^$app (enforce)" /sys/kernel/security/apparmor/profiles; then
  echo "$app has no profile loaded in enforce mode: install its .deb first." >&2
  exit 1
fi

since="$(date '+%Y-%m-%d %H:%M:%S')"
echo "Starting $app under its profile. Print once to a printer and once to a file"
echo "in Documents, then close the program."
"$app" >/dev/null 2>&1 || true

denied="$(sudo journalctl -k --since "$since" --no-pager | grep 'apparmor="DENIED"' | grep "profile=\"$app\"" || true)"
if [[ -z "$denied" ]]; then
  echo "Nothing was refused."
else
  echo "Refused while it ran:"
  echo "$denied" | sed -E 's/.*operation="([^"]*)".*name="([^"]*)".*requested_mask="([^"]*)".*/  \1 \3 \2/' | sort | uniq -c
fi
