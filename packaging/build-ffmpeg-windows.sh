#!/usr/bin/env bash
# Cross-compile standalone Windows tools on Ubuntu 22.04 with MinGW-w64.
set -euo pipefail
if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <source-dir> <new-build-dir> <output-dir> <jobs>" >&2
  exit 2
fi
source_dir=$(realpath "$1")
build_dir=$(realpath -m "$2")
output_dir=$(realpath -m "$3")
jobs=$4
prefix="$build_dir/prefix"
cross=x86_64-w64-mingw32
for tool in "$cross-gcc-posix" "$cross-g++-posix" cmake make nasm pkg-config meson ninja; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
mkdir -p "$build_dir" "$output_dir" "$prefix"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=
export SOURCE_DATE_EPOCH=1741737600
export LC_ALL=C

cat > "$build_dir/mingw.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER $cross-gcc-posix)
set(CMAKE_CXX_COMPILER $cross-g++-posix)
set(CMAKE_RC_COMPILER $cross-windres)
set(CMAKE_FIND_ROOT_PATH "$prefix" /usr/$cross)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
EOF
cat > "$build_dir/mingw.ini" <<EOF
[binaries]
c = '$cross-gcc-posix'
cpp = '$cross-g++-posix'
ar = '$cross-ar'
strip = '$cross-strip'
windres = '$cross-windres'
pkgconfig = 'pkg-config'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF

pushd "$source_dir/x264-snapshot-20191217-2245-stable" >/dev/null
CC="$cross-gcc-posix" ./configure --host="$cross" --cross-prefix="$cross-" \
  --prefix="$prefix" --enable-static --disable-shared --disable-cli
make -j "$jobs"
make install
popd >/dev/null

cmake -S "$source_dir/multicoreware-x265_git-aa7f602f7592/source" -B "$build_dir/x265" \
  -DCMAKE_TOOLCHAIN_FILE="$build_dir/mingw.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF \
  -DENABLE_LIBNUMA=OFF -DENABLE_ASSEMBLY=ON
cmake --build "$build_dir/x265" --parallel "$jobs"
cmake --install "$build_dir/x265"
# upstream emits pkg-config metadata only for shared builds
cat > "$prefix/lib/pkgconfig/x265.pc" <<EOF
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: x265
Description: H.265 encoder
Version: 3.6
Libs: -L\${libdir} -lx265
Libs.private: -lstdc++ -lm -lpthread
Cflags: -I\${includedir}
EOF

cmake -S "$source_dir/zlib-1.3.1" -B "$build_dir/zlib" \
  -DCMAKE_TOOLCHAIN_FILE="$build_dir/mingw.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix"
cmake --build "$build_dir/zlib" --target zlibstatic --parallel "$jobs"
install -m644 "$build_dir/zlib/libzlibstatic.a" "$prefix/lib/libz.a"
install -m644 "$source_dir/zlib-1.3.1/zlib.h" "$build_dir/zlib/zconf.h" "$prefix/include/"

meson setup "$build_dir/dav1d" "$source_dir/dav1d-1.5.1" \
  --cross-file "$build_dir/mingw.ini" --prefix "$prefix" --libdir lib \
  --buildtype release --default-library static -Denable_tools=false -Denable_tests=false
ninja -C "$build_dir/dav1d" -j "$jobs"
ninja -C "$build_dir/dav1d" install

make -C "$source_dir/nv-codec-headers-c69278340ab1d5559c7d7bf0edf615dc33ddbba7" install PREFIX="$prefix"
mkdir -p "$prefix/include/AMF"
cp -R "$source_dir/AMF-ba07d1b3c7c7ee0d846125cffc1d6d78a020c45a/amf/public/include/"* "$prefix/include/AMF/"

mkdir -p "$build_dir/ffmpeg"
pushd "$build_dir/ffmpeg" >/dev/null
"$source_dir/ffmpeg-7.1.1/configure" \
  --arch=x86_64 --target-os=mingw32 --cross-prefix="$cross-" \
  --cc="$cross-gcc-posix" --cxx="$cross-g++-posix" \
  --prefix="$prefix" --enable-cross-compile --disable-autodetect \
  --enable-gpl --enable-static --disable-shared --disable-debug --disable-doc --disable-ffplay \
  --enable-libx264 --enable-libx265 --enable-libdav1d --enable-zlib \
  --enable-amf --enable-ffnvcodec --enable-nvenc --enable-nvdec \
  --enable-d3d11va --enable-dxva2 --enable-w32threads \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib -static" \
  --extra-libs="-lstdc++ -lpthread -lm"
make -j "$jobs"
install -m755 ffmpeg.exe ffprobe.exe "$output_dir/"
popd >/dev/null
"$cross-gcc-posix" --version > "$output_dir/build-environment.txt"
dpkg-query -W gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
  mingw-w64-x86-64-dev binutils-mingw-w64-x86-64 cmake nasm meson ninja-build \
  >> "$output_dir/build-environment.txt"
cat /usr/share/doc/mingw-w64-common/copyright \
  /usr/share/doc/gcc-mingw-w64-base/copyright > "$output_dir/Toolchain-LICENSE.txt"
for name in ffmpeg ffprobe; do
  "$cross-objdump" -p "$output_dir/$name.exe" > "$output_dir/$name-imports.txt"
done
