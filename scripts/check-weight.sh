#!/usr/bin/env bash
# Checks a module's release binary and packages against weight-budget.txt.
set -uo pipefail

MODULE="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUDGET="$HERE/weight-budget.txt"

if [[ -z "$MODULE" || ! -d "$ROOT/modules/$MODULE" ]]; then
  echo "Usage: $0 <module>, for example grt-paper" >&2
  exit 2
fi

RELEASE="$ROOT/modules/$MODULE/src-tauri/target/release"
FAILED=0
CHECKED=0

check() {
  local kind="$1" file="$2"
  local limit
  limit=$(awk -v m="$MODULE" -v k="$kind" '$1 == m && $2 == k { print $3 }' "$BUDGET")
  if [[ -z "$limit" ]]; then
    echo "  $kind: no budget in weight-budget.txt"
    FAILED=1
    return
  fi
  local size=$(( $(stat -c%s "$file" 2>/dev/null || stat -f%z "$file") / 1024 ))
  CHECKED=$((CHECKED + 1))
  if (( size > limit )); then
    echo "  $kind: $size KB, over the budget of $limit KB ($(basename "$file"))"
    FAILED=1
  else
    echo "  $kind: $size KB of $limit KB"
  fi
}

echo "Weight of $MODULE"
for binary in "$RELEASE/$MODULE" "$RELEASE/$MODULE.exe"; do
  [[ -f "$binary" ]] && check binary "$binary"
done
for file in "$RELEASE"/bundle/deb/*.deb; do [[ -f "$file" ]] && check deb "$file"; done
for file in "$RELEASE"/bundle/appimage/*.AppImage; do [[ -f "$file" ]] && check appimage "$file"; done
for file in "$RELEASE"/bundle/nsis/*-setup.exe; do [[ -f "$file" ]] && check setup "$file"; done

if (( CHECKED == 0 )); then
  echo "  nothing built to weigh"
  exit 2
fi
if (( FAILED )); then
  echo "RESULT: over budget."
  exit 1
fi
echo "RESULT: within budget."
