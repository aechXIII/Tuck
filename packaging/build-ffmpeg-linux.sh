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

for command in cmake gcc g++ make nasm pkg-config; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to build the locked Linux FFmpeg sources." >&2
    exit 1
  fi
done

x264="$source_dir/x264-snapshot-20191217-2245-stable"
x265="$source_dir/multicoreware-x265_git-aa7f602f7592"
ffmpeg="$source_dir/ffmpeg-7.1.1"

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

pushd "$ffmpeg" >/dev/null
PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure \
  --prefix="$prefix" \
  --enable-gpl \
  --enable-libx264 \
  --enable-libx265 \
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
