#!/usr/bin/env bash
# Build the static, position-independent libraries the native player links on Linux, natively on
# Ubuntu 22.04: decode-only FFmpeg with dav1d and VAAPI, and libplacebo with its OpenGL backend.
set -euo pipefail
if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <source-dir> <new-build-dir> <output-dir> <jobs>" >&2
  exit 2
fi
source_dir=$(realpath "$1")
build_dir=$(realpath -m "$2")
output_dir=$(realpath -m "$3")
jobs=$4
prefix="$output_dir"
for tool in gcc make nasm pkg-config meson ninja python3 patch; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
rm -rf "$build_dir" "$output_dir"
mkdir -p "$build_dir" "$prefix"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=
export SOURCE_DATE_EPOCH=1741737600
export LC_ALL=C
# Ubuntu 22.04's meson builds dav1d, libdrm and libva exactly as for the export FFmpeg; it is
# older than libplacebo needs, so libplacebo uses the locked release from source
placebo_meson=(python3 "$source_dir/meson-1.11.2/meson.py")

meson setup "$build_dir/dav1d" "$source_dir/dav1d-1.5.1" \
  --prefix "$prefix" --libdir lib --buildtype release --default-library static \
  -Db_pic=true -Denable_tools=false -Denable_tests=false
ninja -C "$build_dir/dav1d" -j "$jobs" install

# the VAAPI loader links statically, like in the export FFmpeg; the host's GPU driver is loaded
# at run time from the usual driver folders
meson setup "$build_dir/libdrm" "$source_dir/libdrm-2.4.124" \
  --prefix "$prefix" --libdir lib --buildtype release --default-library static \
  -Db_pic=true -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled \
  -Dnouveau=disabled -Dvmwgfx=disabled -Domap=disabled -Dexynos=disabled \
  -Dfreedreno=disabled -Dtegra=disabled -Dvc4=disabled -Detnaviv=disabled \
  -Dcairo-tests=disabled -Dman-pages=disabled -Dvalgrind=disabled -Dtests=false
ninja -C "$build_dir/libdrm" -j "$jobs" install

libva="$build_dir/libva-src"
cp -a "$source_dir/libva-2.24.1" "$libva"
# upstream hardcodes shared targets, so use its default-library selection instead
sed -i \
  -e 's/^libva = shared_library(/libva = library(/' \
  -e 's/^  libva_drm = shared_library(/  libva_drm = library(/' \
  "$libva/va/meson.build"
meson setup "$build_dir/libva" "$libva" \
  --prefix "$prefix" --libdir lib --sysconfdir /etc \
  --buildtype release --default-library static -Db_pic=true \
  -Dwith_x11=no -Dwith_wayland=no -Dwith_glx=no -Ddisable_drm=false \
  -Ddriverdir=/usr/lib/x86_64-linux-gnu/dri:/usr/lib/dri:/usr/lib64/dri
ninja -C "$build_dir/libva" -j "$jobs" install

# decode only, plus the few filters that change the sound's speed without its pitch: the player
# never encodes, and leaving encoders and other filters out keeps it LGPL and small.
# libdrm lets VAAPI frames go to OpenGL as DMA-BUFs without a copy through system memory.
mkdir -p "$build_dir/ffmpeg"
pushd "$build_dir/ffmpeg" >/dev/null
"$source_dir/ffmpeg-7.1.1/configure" \
  --prefix="$prefix" --enable-pic --disable-autodetect \
  --enable-static --disable-shared --disable-debug --disable-doc --disable-programs \
  --disable-encoders --disable-muxers --disable-filters \
  --enable-filter=abuffer,abuffersink,aformat,aresample,atempo --disable-avdevice \
  --disable-devices --disable-network --disable-swscale --disable-postproc \
  --enable-libdav1d --enable-vaapi --enable-libdrm --enable-zlib \
  --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib"
make -j "$jobs"
make install
popd >/dev/null

placebo="$build_dir/libplacebo-src"
cp -a "$source_dir/libplacebo-7.360.1" "$placebo"
for module in glad jinja markupsafe fast_float Vulkan-Headers; do
  rmdir "$placebo/3rdparty/$module" 2>/dev/null || true
  cp -a "$source_dir/3rdparty/$module" "$placebo/3rdparty/$module"
done
# the libraries end up inside a shared object, so they need position-independent code
"${placebo_meson[@]}" setup "$build_dir/libplacebo" "$placebo" \
  --prefix "$prefix" --libdir lib --buildtype release --default-library static \
  -Dc_args=-fPIC -Dcpp_args=-fPIC -Dprefer_static=true \
  -Dopengl=enabled -Dgl-proc-addr=enabled -Dd3d11=disabled -Dvulkan=disabled \
  -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled -Dlibdovi=disabled -Dxxhash=disabled \
  -Dunwind=disabled -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
ninja -C "$build_dir/libplacebo" -j "$jobs" install

# libpipewire is opened at run time by the player, so only its headers go into the SDK
pipewire="$source_dir/pipewire-1.2.7"
mkdir -p "$prefix/include/spa-0.2" "$prefix/include/pipewire-0.3"
cp -a "$pipewire/spa/include/spa" "$prefix/include/spa-0.2/"
(cd "$pipewire/src" && find pipewire -name '*.h' -exec install -D -m 644 {} "$prefix/include/pipewire-0.3/{}" \;)
sed -e 's/@PIPEWIRE_VERSION_MAJOR@/1/g' -e 's/@PIPEWIRE_VERSION_MINOR@/2/g' \
  -e 's/@PIPEWIRE_VERSION_MICRO@/7/g' -e 's/@PIPEWIRE_API_VERSION@/"0.3"/g' \
  "$pipewire/src/pipewire/version.h.in" > "$prefix/include/pipewire-0.3/pipewire/version.h"

gcc --version > "$prefix/build-environment.txt"
dpkg-query -W gcc libc6-dev nasm ninja-build >> "$prefix/build-environment.txt"
