# Building Tuck

This page covers building the Windows installer and the Linux AppImage. First set up Tuck to run from source, as the [README](../README.md#build-from-source) explains.

## Native player library

Both packages include Tuck's own video player, a library built on Ubuntu 22.04 (or in WSL) from the exact versions in `packaging/player-sources.lock.json`. Install the build tools, then build it for each package you make:

```bash
sudo apt-get install build-essential cmake nasm pkg-config meson ninja-build patch \
  gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix
python3 scripts/player_library.py windows
python3 scripts/player_library.py linux
```

The libraries go to `build/player-library`, where the package builds pick them up. To use one when running from source, set `TUCK_PLAYER_LIBRARY` to its path.

## Windows installer

The installer needs the Windows player library from above, and FFmpeg and ffprobe built for Windows. They're compiled on Ubuntu 22.04, or in WSL, from the exact versions in `packaging/ffmpeg-sources.lock.json`. [Building Windows FFmpeg](../packaging/windows-ffmpeg.md) has the steps.

Then build the installer in PowerShell:

```powershell
.\scripts\build.ps1
```

## Linux AppImage

Build the AppImage on Ubuntu 22.04, after the Linux player library. Besides the development packages from the README, you need:

- CMake, NASM, pkg-config, and a C/C++ compiler
- Xvfb and squashfs-tools
- the GStreamer tools and its base, good, bad, and libav plugins
- the GStreamer development files (`libgstreamer1.0-dev` and `libgstreamer-plugins-base1.0-dev`)

Then run:

```bash
./scripts/build-linux.sh
```

The script checks for these tools before it starts. Once the AppImage is built, the script opens it on a virtual screen and tests the packaged app.

## FFmpeg sources

The Linux build compiles FFmpeg and the libraries it uses, like x264 and x265, from the exact versions in `packaging/ffmpeg-linux-sources.lock.json`. The AppImage carries those sources and the build recipe in `ffmpeg/source`. For Windows, each release has a separate FFmpeg source archive next to the installer. Both packages also carry the player library's sources as `player-source.tar.xz`.
