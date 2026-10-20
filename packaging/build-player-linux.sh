#!/usr/bin/env bash
# Build libtuck_player.so from src-tauri/native/player against the static libraries that
# build-player-sdk-linux.sh produced, natively on Ubuntu 22.04 so it runs on that baseline.
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <sdk-dir> <player-source-dir> <output-dir>" >&2
  exit 2
fi
sdk=$(realpath "$1")
source_dir=$(realpath "$2")
output_dir=$(realpath -m "$3")
mkdir -p "$output_dir"
export PKG_CONFIG_LIBDIR="$sdk/lib/pkgconfig"
export PKG_CONFIG_PATH=
# The static FFmpeg and libplacebo stay private to the library: WebKit's media stack may load the
# system's own FFmpeg into the same process, and the two must never resolve to each other.
# libpipewire is opened at run time, so only its headers are needed here.
gcc -shared -fPIC -O2 -g -std=c11 -Wall -Wextra -Werror -fvisibility=hidden \
  -D_GNU_SOURCE -DTUCK_VIDEO_BUILD \
  -I"$sdk/include" -isystem "$sdk/include/pipewire-0.3" -isystem "$sdk/include/spa-0.2" \
  $(pkg-config --cflags libavformat libavcodec libavfilter libavutil libswresample libplacebo) \
  "$source_dir/engine.c" "$source_dir/playback_state.c" "$source_dir/decoder.c" \
  "$source_dir/render_gl.c" "$source_dir/video.c" "$source_dir/audio.c" \
  "$source_dir/audio_pipewire.c" "$source_dir/lut.c" "$source_dir/tempo.c" "$source_dir/mix.c" "$source_dir/audio_reader.c" \
  -o "$output_dir/libtuck_player.so" \
  -Wl,-soname,libtuck_player.so -Wl,--no-undefined -Wl,--exclude-libs,ALL -Wl,-Bsymbolic \
  -Wl,-z,relro -Wl,-z,now \
  $(pkg-config --static --libs libavformat libavcodec libavfilter libavutil libswresample libplacebo) \
  -lstdc++ -ldl -lpthread -lm
# the seek check runs the player's decoder and sound reader over the clips from
# scripts/player_fixtures.py
gcc -O2 -g -std=c11 -Wall -Wextra -Werror -D_GNU_SOURCE \
  -I"$sdk/include" $(pkg-config --cflags libavformat libavcodec libavutil libswresample) \
  "$source_dir/tests/seek_check.c" "$source_dir/decoder.c" "$source_dir/playback_state.c" \
  "$source_dir/audio_reader.c" \
  -o "$output_dir/tuck_player_seek_check" \
  $(pkg-config --static --libs libavformat libavcodec libavutil libswresample) -ldl -lpthread -lm
objdump -p "$output_dir/libtuck_player.so" | sed -n 's/^ *NEEDED *//p' | sort > "$output_dir/libtuck_player-needed.txt"
nm -D --defined-only "$output_dir/libtuck_player.so" | awk '{print $3}' | sort > "$output_dir/libtuck_player-exports.txt"
