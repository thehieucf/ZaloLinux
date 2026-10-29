#!/bin/bash
# Install the patched Zalo (app/, built by tools/patch.py) with its Electron
# runtime for the current user: no root needed.
# usage: tools/install.sh [--uninstall]
# env: PREFIX (default ~/.local)
#
# Data stays where Zalo keeps it: ~/.config/ZaloData. Uninstalling removes
# the program only, never that data.
set -euo pipefail
cd "$(dirname "$0")/.."

prefix=${PREFIX:-$HOME/.local}
dest=$prefix/share/zalo-native
launcher=$prefix/bin/zalo
desktop=$prefix/share/applications/zalo.desktop
icon=$prefix/share/icons/hicolor/512x512/apps/zalo.png

if [ "${1:-}" = --uninstall ]; then
  rm -rf "$dest"
  rm -f "$launcher" "$desktop" "$icon" "$HOME/.config/autostart/zalo.desktop"
  echo "removed Zalo from $prefix (data in ~/.config/ZaloData kept)"
  exit 0
fi

[ -f app/package.json ] || { echo "app/ missing: run tools/patch.py extract/asar app first" >&2; exit 1; }
[ -x runtime/electron/electron ] || { echo "runtime/electron missing" >&2; exit 1; }

mkdir -p "$(dirname "$dest")" "$(dirname "$launcher")" "$(dirname "$desktop")" "$(dirname "$icon")"
# Copy into a fresh tree, then swap, so a running Zalo keeps its files.
rm -rf "$dest.new"
mkdir -p "$dest.new"
cp -a runtime/electron "$dest.new/electron"
cp -a app "$dest.new/app"
rm -rf "$dest.old"
if [ -d "$dest" ]; then mv "$dest" "$dest.old"; fi
mv "$dest.new" "$dest"
rm -rf "$dest.old"

cat >"$launcher" <<EOF
#!/bin/sh
# Zalo (native Linux port). Installed by ZaloLinux tools/install.sh.
unset ELECTRON_RUN_AS_NODE
export ZALO_LAUNCHER="$launcher"
exec "$dest/electron/electron" --no-sandbox "$dest/app" "\$@"
EOF
chmod +x "$launcher"

install -m 644 app/pc-dist/favicon-512x512.png "$icon"

cat >"$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Zalo
Comment=Zalo - Nhắn gửi yêu thương
Exec=$launcher %U
Icon=zalo
Terminal=false
Categories=Network;InstantMessaging;Chat;
StartupWMClass=Zalo
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$desktop")" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q "$prefix/share/icons/hicolor" 2>/dev/null || true

echo "installed: $launcher → $dest"
