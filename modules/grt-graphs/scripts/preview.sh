#!/usr/bin/env bash
# Run this module's interface in an ordinary browser.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$HERE/../../scripts/preview.sh" "$(basename "$HERE")" "${1:-8722}"
