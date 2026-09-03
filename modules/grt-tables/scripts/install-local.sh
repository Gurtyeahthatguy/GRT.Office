#!/usr/bin/env bash
# Makes GRT Tables appear in the desktop's application menu.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$HERE/src-tauri/target/release/grt-tables"

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
DESKTOP="$APP_DIR/org.grt.tables.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$BIN_DIR/grt-tables" "$DESKTOP"
  rm -f "$ICON_DIR"/*/apps/grt-tables.png
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$APP_DIR" 2>/dev/null
  echo "Removed. Settings, if any, are still at:"
  echo "  ${XDG_CONFIG_HOME:-$HOME/.config}/org.grt.tables/"
  exit 0
fi

if [[ ! -x "$BINARY" ]]; then
  echo "No release binary at $BINARY" >&2
  echo "Build it first:  npm run build" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$APP_DIR"
install -m 755 "$BINARY" "$BIN_DIR/grt-tables"

for size in 32x32 128x128; do
  source_icon="$HERE/src-tauri/icons/${size}.png"
  if [[ -f "$source_icon" ]]; then
    mkdir -p "$ICON_DIR/$size/apps"
    install -m 644 "$source_icon" "$ICON_DIR/$size/apps/grt-tables.png"
  fi
done

# MimeType lists the program as *an* option for PDFs.
cat > "$DESKTOP" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=GRT Tables
GenericName=Database
Comment=A local database that never leaves your machine, and cannot run macros
Exec=$BIN_DIR/grt-tables %f
Icon=grt-tables
Terminal=false
Categories=Office;Database;

StartupNotify=true
DESKTOP_EOF

chmod 644 "$DESKTOP"

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APP_DIR" 2>/dev/null
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null

echo "Installed for this user:"
echo "  program   $BIN_DIR/grt-tables"
echo "  launcher  $DESKTOP"
echo
echo "It should appear in the application menu as \"GRT Tables\"."
echo "To open a database with it: right-click the .sqlite file, Open With, GRT Tables."
echo "To undo: $0 --remove"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo
  echo "Note: $BIN_DIR is not on your PATH, so typing 'grt-tables' in a terminal"
  echo "will not find it. The menu entry works regardless."
fi
