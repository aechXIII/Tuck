#!/usr/bin/env bash
# Build the native Linux x86_64 AppImage.
#
# Prerequisites: Linux x86_64, Python 3.10+ with venv support, Node/npm,
# Rust/Cargo, the Tauri Linux system dependencies, CMake, NASM, pkg-config, a
# native C/C++ compiler, the GStreamer 1.0 tools and base/good/bad/libav plugin
# packages (bundled into the AppImage for editor preview playback), and network
# access for the pinned Python and FFmpeg source inputs. AppImage builds may
# also require FUSE to run the resulting artifact on the build host.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

python_bin="${PYTHON:-python3}"
clean=false

if [[ "${1:-}" == "--clean" ]]; then
  clean=true
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--clean]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "build-linux.sh must run on Linux." >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "amd64" ]]; then
  echo "build-linux.sh builds only x86_64 AppImages." >&2
  exit 1
fi
for command in "$python_bin" npm cargo xvfb-run xwininfo cmake gcc g++ make nasm mksquashfs \
  pkg-config gst-inspect-1.0; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command was not found on PATH." >&2
    exit 1
  fi
done

# bundleMediaFramework copies the host's GStreamer plugins into the AppImage.
# Without a working autoaudiosink the packaged editor cannot play a preview, so
# fail here instead of shipping a silent, black player.
if ! gst-inspect-1.0 autoaudiosink >/dev/null 2>&1; then
  echo "GStreamer autoaudiosink is missing. Install the gstreamer1.0 base, good, bad, and libav plugin packages." >&2
  exit 1
fi

if "$clean"; then
  rm -rf build/linux-sidecar-venv build/linux-sidecar-pyinstaller dist/linux \
    packaging/staging/linux src-tauri/target/release/bundle/appimage
fi

"$python_bin" scripts/build_linux.py --python "$python_bin"

if [[ ! -x packaging/staging/linux/app/tuck-sidecar ]]; then
  echo "packaging/staging/linux/app/tuck-sidecar is missing or not executable." >&2
  exit 1
fi

echo "==> Building the Tauri Linux AppImage"
# emit the signed updater artifacts only when a signing key is present. a local
# build without one still succeeds, it just skips the .sig / updater package
tauri_updater_args=()
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "    signing key present -> emitting updater artifacts"
  tauri_updater_args=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
fi
npm run tauri build -- --bundles appimage "${tauri_updater_args[@]}"

appimage="$(find src-tauri/target/release/bundle/appimage -maxdepth 1 -type f -name '*.AppImage' -print | sort | tail -n 1)"
if [[ -z "$appimage" ]]; then
  echo "No AppImage found under src-tauri/target/release/bundle/appimage." >&2
  exit 1
fi

# The app forces WebKit's portable renderer (see platform::prepare_runtime_environment),
# but the GTK deployment can still bundle an older libwayland-client than the host
# Mesa stack. Drop it so anything that does reach Wayland/EGL uses one ABI.
echo "==> Removing the bundled Wayland client library"
appimage_work="$(mktemp -d -t tuck-appimage-wayland-XXXXXX)"
trap 'rm -rf "$appimage_work"' EXIT
(
  cd "$appimage_work"
  "$root/$appimage" --appimage-extract >/dev/null
)
bundled_wayland_client="$appimage_work/squashfs-root/usr/lib/libwayland-client.so.0"
if [[ ! -e "$bundled_wayland_client" ]]; then
  echo "The AppImage did not contain the expected bundled libwayland-client.so.0." >&2
  exit 1
fi
rm -f "$bundled_wayland_client"
appimage_offset="$("$root/$appimage" --appimage-offset)"
rebuilt_appimage="$appimage_work/Tuck.AppImage"
head -c "$appimage_offset" "$appimage" > "$rebuilt_appimage"
mksquashfs "$appimage_work/squashfs-root" "$appimage_work/payload.squashfs" \
  -noappend -comp zstd -Xcompression-level 19 >/dev/null
cat "$appimage_work/payload.squashfs" >> "$rebuilt_appimage"
chmod +x "$rebuilt_appimage"
mv "$rebuilt_appimage" "$appimage"

# The Wayland strip rewrites the AppImage payload, so any signature Tauri wrote
# during the build no longer matches. Re-sign the final bytes.
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "==> Re-signing the AppImage after the Wayland-client strip"
  npm run tauri signer sign -- "$appimage"
fi

echo "==> Verifying the AppImage"
"$python_bin" scripts/verify_package.py --platform linux --artifact "$appimage"

echo "==> Starting the AppImage GUI"
xvfb-run -a "$python_bin" scripts/smoke_appimage_gui.py --artifact "$appimage"

echo "==> Running the packaged sidecar smoke test"
"$python_bin" scripts/smoke_packaged.py --platform linux --artifact "$appimage"

sha256sum "$appimage"
echo "OK  $appimage"
