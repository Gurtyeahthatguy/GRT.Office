#!/usr/bin/env bash
# Makes GRT Read appear in the desktop's application menu.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$HERE/src-tauri/target/release/grt-read"

BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
DESKTOP="$APP_DIR/org.grt.read.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$BIN_DIR/grt-read" "$DESKTOP"
  rm -f "$ICON_DIR"/*/apps/grt-read.png
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$APP_DIR" 2>/dev/null
  echo "Removed. Settings, if any, are still at:"
  echo "  ${XDG_CONFIG_HOME:-$HOME/.config}/org.grt.read/"
  exit 0
fi

if [[ ! -x "$BINARY" ]]; then
  echo "No release binary at $BINARY" >&2
  echo "Build it first:  npm run build" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$APP_DIR"
install -m 755 "$BINARY" "$BIN_DIR/grt-read"

for size in 32x32 128x128; do
  source_icon="$HERE/src-tauri/icons/${size}.png"
  if [[ -f "$source_icon" ]]; then
    mkdir -p "$ICON_DIR/$size/apps"
    install -m 644 "$source_icon" "$ICON_DIR/$size/apps/grt-read.png"
  fi
done

# MimeType lists the program as *an* option for PDFs.
cat > "$DESKTOP" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=GRT Read
GenericName=PDF Reader
Comment=Read and edit PDF files locally, without leaving traces
Exec=$BIN_DIR/grt-read %f
Icon=grt-read
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;
StartupNotify=true
DESKTOP_EOF

chmod 644 "$DESKTOP"

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APP_DIR" 2>/dev/null
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f -t "$ICON_DIR" 2>/dev/null

echo "Installed for this user:"
echo "  program   $BIN_DIR/grt-read"
echo "  launcher  $DESKTOP"
echo
echo "It should appear in the application menu as \"GRT Read\"."
echo "To open a PDF with it: right-click the file, Open With, GRT Read."
echo "To undo: $0 --remove"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo
  echo "Note: $BIN_DIR is not on your PATH, so typing 'grt-read' in a terminal"
  echo "will not find it. The menu entry works regardless."
fi
