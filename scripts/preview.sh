#!/usr/bin/env bash
# Run a module's interface in an ordinary browser.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="${1:-}"
PORT="${2:-8730}"

if [[ -z "$MODULE" ]]; then
  echo "Usage: $0 <module> [port]" >&2
  echo >&2
  echo "Modules:" >&2
  for dir in "$ROOT"/modules/*/; do
    name="$(basename "$dir")"
    [[ -f "$dir/scripts/preview-stub.js" ]] && echo "  $name" >&2
  done
  exit 2
fi

# Accept both "grid" and "grt-grid".
[[ -d "$ROOT/modules/$MODULE" ]] || MODULE="grt-$MODULE"

MODULE_DIR="$ROOT/modules/$MODULE"
STUB="$MODULE_DIR/scripts/preview-stub.js"

if [[ ! -d "$MODULE_DIR/src" ]]; then
  echo "No module at $MODULE_DIR" >&2
  exit 2
fi

if [[ ! -f "$STUB" ]]; then
  echo "$MODULE has no preview stub at scripts/preview-stub.js" >&2
  exit 2
fi

# The shared core is copied in at build time and is gitignored, so a module
# that has not been built has no core to serve.
if [[ ! -d "$MODULE_DIR/src/js/core" ]]; then
  echo "Syncing the shared core into $MODULE..."
  node "$ROOT/scripts/sync-core.mjs" "modules/$MODULE"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$STUB" "$STAGE/backend-stub.js"

for entry in "$MODULE_DIR"/src/*; do
  name="$(basename "$entry")"
  case "$name" in
    *.html) cp "$entry" "$STAGE/$name" ;;      # copied, because it is patched
    *)      ln -s "$entry" "$STAGE/$name" ;;   # linked, so edits show up live
  esac
done

python3 - "$STAGE" <<'PATCH'
import sys, pathlib, re

stage = pathlib.Path(sys.argv[1])
for page in stage.glob('*.html'):
    text = page.read_text()
    patched = re.sub(
        r'(<script type="module" src="[^"]+"></script>)',
        r'<script src="backend-stub.js"></script>\n    \1',
        text, count=1)
    if patched != text:
        page.write_text(patched)
        print(f"  stubbed {page.name}")
PATCH

echo
echo "Serving $MODULE on http://localhost:$PORT"
echo "The backend is stubbed: nothing is read from or written to disk."
echo "Stylesheets and scripts are linked, so a reload picks up your edits."
echo "Ctrl+C to stop."
python3 -m http.server "$PORT" --directory "$STAGE" >/dev/null
