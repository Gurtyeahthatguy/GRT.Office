#!/usr/bin/env bash
# Makes GRT Graphs appear in the desktop's application menu.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$HERE/src-tauri/target/release/grt-graphs"

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
DESKTOP="$APP_DIR/org.grt.graphs.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$BIN_DIR/grt-graphs" "$DESKTOP"
  rm -f "$ICON_DIR"/*/apps/grt-graphs.png
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$APP_DIR" 2>/dev/null
  echo "Removed. Settings, if any, are still at:"
  echo "  ${XDG_CONFIG_HOME:-$HOME/.config}/org.grt.graphs/"
  exit 0
fi

if [[ ! -x "$BINARY" ]]; then
  echo "No release binary at $BINARY" >&2
  echo "Build it first:  npm run build" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$APP_DIR"
install -m 755 "$BINARY" "$BIN_DIR/grt-graphs"

for size in 32x32 128x128; do
  source_icon="$HERE/src-tauri/icons/${size}.png"
  if [[ -f "$source_icon" ]]; then
    mkdir -p "$ICON_DIR/$size/apps"
    install -m 644 "$source_icon" "$ICON_DIR/$size/apps/grt-graphs.png"
  fi
done

# MimeType lists the program as *an* option for PDFs.
cat > "$DESKTOP" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=GRT Graphs
GenericName=Diagram editor
Comment=Draw diagrams and node graphs locally, without leaving traces
Exec=$BIN_DIR/grt-graphs %f
Icon=grt-graphs
Terminal=false
Categories=Office;Graphics;

StartupNotify=true
DESKTOP_EOF

chmod 644 "$DESKTOP"

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APP_DIR" 2>/dev/null
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null

echo "Installed for this user:"
echo "  program   $BIN_DIR/grt-graphs"
echo "  launcher  $DESKTOP"
echo
echo "It should appear in the application menu as \"GRT Graphs\"."
echo "To open a diagram with it: right-click the .grt file, Open With, GRT Graphs."
echo "To undo: $0 --remove"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo
  echo "Note: $BIN_DIR is not on your PATH, so typing 'grt-graphs' in a terminal"
  echo "will not find it. The menu entry works regardless."
fi
