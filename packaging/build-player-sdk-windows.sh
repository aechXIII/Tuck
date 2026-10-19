#!/usr/bin/env bash
# Cross-compile the static libraries the native player links on Windows, on Ubuntu 22.04 with
# MinGW-w64: decode-only FFmpeg with dav1d and D3D11VA, and libplacebo with its D3D11 backend.
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
cross=x86_64-w64-mingw32
for tool in "$cross-gcc-posix" "$cross-g++-posix" cmake make nasm pkg-config ninja python3; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
rm -rf "$build_dir" "$output_dir"
mkdir -p "$build_dir" "$prefix"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=
export SOURCE_DATE_EPOCH=1741737600
export LC_ALL=C
# Ubuntu 22.04's meson is older than libplacebo needs, so the locked release runs from source
meson=(python3 "$source_dir/meson-1.11.2/meson.py")

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
dlltool = '$cross-dlltool'
pkg-config = 'pkg-config'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
[built-in options]
# libplacebo finds glslang by library name, not pkg-config, so the prefix must be searched
c_args = ['-I$prefix/include']
cpp_args = ['-I$prefix/include']
c_link_args = ['-L$prefix/lib']
cpp_link_args = ['-L$prefix/lib']
EOF

# zlib for compressed MP4 headers
cmake -S "$source_dir/zlib-1.3.1" -B "$build_dir/zlib" \
  -DCMAKE_TOOLCHAIN_FILE="$build_dir/mingw.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix"
cmake --build "$build_dir/zlib" --target zlibstatic --parallel "$jobs"
mkdir -p "$prefix/lib" "$prefix/include"
install -m644 "$build_dir/zlib/libzlibstatic.a" "$prefix/lib/libz.a"
install -m644 "$source_dir/zlib-1.3.1/zlib.h" "$build_dir/zlib/zconf.h" "$prefix/include/"

"${meson[@]}" setup "$build_dir/dav1d" "$source_dir/dav1d-1.5.1" \
  --cross-file "$build_dir/mingw.ini" --prefix "$prefix" --libdir lib \
  --buildtype release --default-library static -Denable_tools=false -Denable_tests=false
ninja -C "$build_dir/dav1d" -j "$jobs" install

# Ubuntu 22.04's DXVA header predates AV1; keep its toolchain and replace only this header
install -m644 "$source_dir/mingw-w64-12.0.0/mingw-w64-headers/include/dxva.h" "$prefix/include/dxva.h"

# decode only, plus the few filters that change the sound's speed without its pitch: the player
# never encodes, and leaving encoders and other filters out keeps it LGPL and small
mkdir -p "$build_dir/ffmpeg"
pushd "$build_dir/ffmpeg" >/dev/null
"$source_dir/ffmpeg-7.1.1/configure" \
  --arch=x86_64 --target-os=mingw32 --cross-prefix="$cross-" \
  --cc="$cross-gcc-posix" --cxx="$cross-g++-posix" \
  --prefix="$prefix" --enable-cross-compile --disable-autodetect \
  --enable-static --disable-shared --disable-debug --disable-doc --disable-programs \
  --disable-encoders --disable-muxers --disable-filters \
  --enable-filter=abuffer,abuffersink,aformat,aresample,atempo --disable-avdevice \
  --disable-devices --disable-network --disable-swscale --disable-postproc \
  --enable-libdav1d --enable-zlib --enable-d3d11va --enable-w32threads \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib"
make -j "$jobs"
make install
popd >/dev/null

cmake -S "$source_dir/glslang-vulkan-sdk-1.4.363.0" -B "$build_dir/glslang" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$build_dir/mingw.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DBUILD_SHARED_LIBS=OFF -DENABLE_OPT=OFF \
  -DENABLE_GLSLANG_BINARIES=OFF -DENABLE_HLSL=OFF -DGLSLANG_TESTS=OFF -DBUILD_EXTERNAL=OFF \
  -DENABLE_PCH=OFF
ninja -C "$build_dir/glslang" -j "$jobs" install

cmake -S "$source_dir/SPIRV-Cross-vulkan-sdk-1.4.363.0" -B "$build_dir/spirv-cross" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$build_dir/mingw.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DSPIRV_CROSS_STATIC=ON -DSPIRV_CROSS_SHARED=OFF \
  -DSPIRV_CROSS_CLI=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF -DSPIRV_CROSS_ENABLE_C_API=ON \
  -DSPIRV_CROSS_ENABLE_HLSL=ON -DSPIRV_CROSS_ENABLE_GLSL=ON -DSPIRV_CROSS_ENABLE_MSL=OFF \
  -DSPIRV_CROSS_ENABLE_CPP=OFF -DSPIRV_CROSS_ENABLE_REFLECT=OFF -DSPIRV_CROSS_ENABLE_UTIL=OFF
ninja -C "$build_dir/spirv-cross" -j "$jobs" install
# libplacebo looks SPIRV-Cross up by its shared library's pkg-config name; the static C API
# needs the same flags plus the C++ runtime
cat > "$prefix/lib/pkgconfig/spirv-cross-c-shared.pc" <<EOF
prefix=$prefix
libdir=\${prefix}/lib
includedir=\${prefix}/include/spirv_cross

Name: spirv-cross-c-shared
Description: SPIRV-Cross C API, static
Version: 0.$(sed -n 's/.*SPVC_C_API_VERSION_MINOR \([0-9]*\).*/\1/p' "$source_dir/SPIRV-Cross-vulkan-sdk-1.4.363.0/spirv_cross_c.h").0
Libs: -L\${libdir} -lspirv-cross-c -lspirv-cross-hlsl -lspirv-cross-glsl -lspirv-cross-core -lstdc++
Cflags: -I\${includedir}
EOF

placebo="$build_dir/libplacebo-src"
cp -a "$source_dir/libplacebo-7.360.1" "$placebo"
for module in glad jinja markupsafe fast_float Vulkan-Headers; do
  rmdir "$placebo/3rdparty/$module" 2>/dev/null || true
  cp -a "$source_dir/3rdparty/$module" "$placebo/3rdparty/$module"
done
"${meson[@]}" setup "$build_dir/libplacebo" "$placebo" \
  --cross-file "$build_dir/mingw.ini" --prefix "$prefix" --libdir lib \
  --buildtype release --default-library static -Dprefer_static=true \
  -Dd3d11=enabled -Dvulkan=disabled -Dopengl=disabled -Dglslang=enabled -Dshaderc=disabled \
  -Dlcms=disabled -Dlibdovi=disabled -Dxxhash=disabled -Dunwind=disabled \
  -Dvulkan-sdk="$prefix" -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false
ninja -C "$build_dir/libplacebo" -j "$jobs" install

"$cross-gcc-posix" --version > "$prefix/build-environment.txt"
dpkg-query -W gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix mingw-w64-x86-64-dev \
  binutils-mingw-w64-x86-64 cmake nasm ninja-build >> "$prefix/build-environment.txt"
