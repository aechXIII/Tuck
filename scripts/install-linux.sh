#!/usr/bin/env sh
# Install Tuck (x86-64 AppImage) into ~/.local for the current user. No root.
#
#   curl -fsSL https://raw.githubusercontent.com/aechXIii/Tuck/main/scripts/install-linux.sh | sh
#
# Re-run any time to move to the latest release. Uninstall by deleting
# ~/.local/bin/tuck, ~/.local/share/tuck, ~/.local/share/applications/tuck.desktop,
# and ~/.local/share/icons/hicolor/128x128/apps/tuck.png.

set -eu

REPO="aechXIii/Tuck"
FEED="https://github.com/${REPO}/releases/latest/download/latest.json"
ICON_URL="https://raw.githubusercontent.com/${REPO}/main/src-tauri/icons/128x128.png"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$DATA_HOME/tuck"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "install-linux.sh needs '$1'" >&2
    echo "install it and run this again" >&2
    exit 1
  }
}
need curl
need sha256sum
need python3

case "$(uname -m)" in
  x86_64 | amd64) ;;
  *)
    echo "Tuck has an x86-64 Linux build only" >&2
    echo "this machine reports $(uname -m)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Finding the latest Tuck release"
curl -fsSL "$FEED" -o "$tmp/latest.json"
url="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["platforms"]["linux-x86_64"]["url"])' "$tmp/latest.json")"
version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$tmp/latest.json")"
[ -n "$url" ] || {
  echo "could not read the Linux download URL from latest.json" >&2
  echo "the release may still be publishing, so try again shortly" >&2
  exit 1
}
appimage_name="${url##*/}"
sums_url="${url%/*}/SHA256SUMS"

echo "Downloading $appimage_name"
curl -fsSL "$url" -o "$tmp/$appimage_name"
curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS"

echo "Verifying checksum"
(cd "$tmp" && grep " ${appimage_name}\$" SHA256SUMS | sha256sum -c -) || {
  echo "checksum verification failed, nothing was installed" >&2
  echo "run this again to download a fresh copy" >&2
  exit 1
}

mkdir -p "$APP_DIR" "$BIN_DIR" "$DATA_HOME/applications" "$DATA_HOME/icons/hicolor/128x128/apps"
install -m 0755 "$tmp/$appimage_name" "$APP_DIR/Tuck.AppImage"

# preserve runtime errors and forward options such as --appimage-extract-and-run
cat > "$BIN_DIR/tuck" <<EOF
#!/usr/bin/env sh
APPIMAGE="$APP_DIR/Tuck.AppImage"
exec "\$APPIMAGE" "\$@"
EOF
chmod 0755 "$BIN_DIR/tuck"

curl -fsSL "$ICON_URL" -o "$DATA_HOME/icons/hicolor/128x128/apps/tuck.png" || true

cat > "$DATA_HOME/applications/tuck.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Tuck
Comment=Video compressor, cropper, and upscaler
Exec=$BIN_DIR/tuck %F
Icon=tuck
Terminal=false
Categories=AudioVideo;Video;
MimeType=video/mp4;video/x-matroska;video/quicktime;video/webm;
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true
fi

echo
echo "Tuck ${version:-latest} installed to $APP_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Run it with: tuck" ;;
  *) echo "Add $BIN_DIR to your PATH, or run: $BIN_DIR/tuck" ;;
esac
