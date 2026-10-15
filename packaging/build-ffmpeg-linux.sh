#!/usr/bin/env bash
# Build GPL-enabled FFmpeg for the Linux AppImage from the locked source tree.

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <source-dir> <build-dir> <output-dir> <jobs>" >&2
  exit 2
fi

source_dir=$1
build_dir=$2
output_dir=$3
jobs=$4
prefix="$build_dir/prefix"

for command in cmake gcc g++ make nasm pkg-config autoconf automake libtoolize meson ninja patch; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to build the locked Linux FFmpeg sources." >&2
    exit 1
  fi
done

x264="$source_dir/x264-snapshot-20191217-2245-stable"
x265="$source_dir/multicoreware-x265_git-aa7f602f7592"
zimg="$source_dir/zimg-f819b14e8f39d1282400b0d9543e8ef73c1b2bbd"
dav1d="$source_dir/dav1d-1.5.1"
ffmpeg="$source_dir/ffmpeg-7.1.1"
nvcodec="$source_dir/nv-codec-headers-c69278340ab1d5559c7d7bf0edf615dc33ddbba7"
libdrm="$source_dir/libdrm-2.4.124"
libva="$source_dir/libva-2.24.1"

rm -rf "$build_dir" "$output_dir"
mkdir -p "$build_dir" "$output_dir"

pushd "$x264" >/dev/null
./configure --prefix="$prefix" --enable-static --disable-shared --disable-cli --enable-pic
make -j "$jobs"
make install
popd >/dev/null

cmake -S "$x265/source" -B "$build_dir/x265" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DENABLE_SHARED=ON \
  -DENABLE_CLI=OFF \
  -DENABLE_PIC=ON \
  -DENABLE_LIBNUMA=OFF
cmake --build "$build_dir/x265" --parallel "$jobs"
cmake --install "$build_dir/x265"

# x265 writes x265.pc only with its shared target enabled. Keep that complete
# link metadata, then remove the shared object so FFmpeg can only link libx265.a.
rm -f "$prefix"/lib/libx265.so*

pushd "$zimg" >/dev/null
./autogen.sh
./configure --prefix="$prefix" --enable-static --disable-shared --with-pic
make -j "$jobs"
make install
popd >/dev/null

# FFmpeg's own AV1 decoder only works with GPU acceleration, so AV1 video needs dav1d
meson setup "$build_dir/dav1d" "$dav1d" \
  --prefix "$prefix" --libdir lib --buildtype release --default-library static \
  -Db_pic=true -Denable_tools=false -Denable_tests=false
ninja -C "$build_dir/dav1d" -j "$jobs"
ninja -C "$build_dir/dav1d" install

# the driver is loaded only when CUDA decoding is selected
make -C "$nvcodec" PREFIX="$prefix" install

# link the VAAPI loader statically; the host's GPU driver stays optional at runtime
meson setup "$build_dir/libdrm" "$libdrm" \
  --prefix "$prefix" --libdir lib --buildtype release --default-library static \
  -Db_pic=true -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled \
  -Dnouveau=disabled -Dvmwgfx=disabled -Domap=disabled -Dexynos=disabled \
  -Dfreedreno=disabled -Dtegra=disabled -Dvc4=disabled -Detnaviv=disabled \
  -Dcairo-tests=disabled -Dman-pages=disabled -Dvalgrind=disabled -Dtests=false
ninja -C "$build_dir/libdrm" -j "$jobs"
ninja -C "$build_dir/libdrm" install

# upstream hardcodes shared targets, so use its default-library selection instead
sed -i \
  -e 's/^libva = shared_library(/libva = library(/' \
  -e 's/^  libva_drm = shared_library(/  libva_drm = library(/' \
  "$libva/va/meson.build"
PKG_CONFIG_PATH="$prefix/lib/pkgconfig" meson setup "$build_dir/libva" "$libva" \
  --prefix "$prefix" --libdir lib --sysconfdir /etc \
  --buildtype release --default-library static -Db_pic=true \
  -Dwith_x11=no -Dwith_wayland=no -Dwith_glx=no -Ddisable_drm=false \
  -Ddriverdir=/usr/lib/x86_64-linux-gnu/dri:/usr/lib/dri:/usr/lib64/dri
ninja -C "$build_dir/libva" -j "$jobs"
ninja -C "$build_dir/libva" install

# screen capture would link the host's libxcb; Tuck never captures
recipe_dir=$(cd "$(dirname "$0")" && pwd)
patch -d "$ffmpeg" -p1 < "$recipe_dir/ffmpeg-mix-integer.patch"
install -m644 "$recipe_dir/ffmpeg-mix-integer.h" "$ffmpeg/libavfilter/mix_integer.h"

pushd "$ffmpeg" >/dev/null
PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure \
  --prefix="$prefix" \
  --enable-gpl \
  --enable-libx264 \
  --enable-libx265 \
  --enable-libzimg \
  --enable-libdav1d \
  --enable-ffnvcodec \
  --enable-nvdec \
  --disable-nvenc \
  --enable-vaapi \
  --disable-encoder=av1_vaapi,h264_vaapi,hevc_vaapi,mjpeg_vaapi,mpeg2_vaapi,vp8_vaapi,vp9_vaapi \
  --disable-libdrm \
  --disable-libxcb \
  --enable-static \
  --disable-shared \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" \
  --extra-ldflags="-L$prefix/lib" \
  --extra-libs="-lpthread -lm -ldl -lstdc++"
make -j "$jobs"
install -Dm755 ffmpeg "$output_dir/ffmpeg"
install -Dm755 ffprobe "$output_dir/ffprobe"
popd >/dev/null
