#!/usr/bin/env bash
# Build tuck_player.dll from src-tauri/native/player against the static libraries that
# build-player-sdk-windows.sh produced. Runtimes link statically, so it needs only Windows DLLs.
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <sdk-dir> <player-source-dir> <output-dir>" >&2
  exit 2
fi
sdk=$(realpath "$1")
source_dir=$(realpath "$2")
output_dir=$(realpath -m "$3")
cross=x86_64-w64-mingw32
mkdir -p "$output_dir"
export PKG_CONFIG_LIBDIR="$sdk/lib/pkgconfig"
export PKG_CONFIG_PATH=
"$cross-gcc-posix" -shared -O2 -g -std=c11 -Wall -Wextra -Werror -DTUCK_VIDEO_BUILD \
  -I"$sdk/include" $(pkg-config --cflags libavformat libavcodec libavutil libplacebo) \
  "$source_dir/engine.c" "$source_dir/playback_state.c" "$source_dir/decoder.c" \
  "$source_dir/render_d3d11.c" "$source_dir/video.c" \
  -o "$output_dir/tuck_player.dll" \
  -Wl,--no-undefined -static -static-libgcc -static-libstdc++ \
  $(pkg-config --static --libs libavformat libavcodec libavutil libplacebo) \
  -L"$sdk/lib" -lglslang -lMachineIndependent -lGenericCodeGen -lOSDependent -lSPIRV \
  -lglslang-default-resource-limits -lstdc++ -ld3d11 -ldxgi -luuid -lole32 -lversion -lshlwapi
"$cross-strip" --strip-debug -o "$output_dir/tuck_player.stripped.dll" "$output_dir/tuck_player.dll"
"$cross-objdump" -p "$output_dir/tuck_player.dll" | sed -n '/DLL Name/p' | sort -u > "$output_dir/tuck_player-imports.txt"
