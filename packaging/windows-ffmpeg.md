# Building Windows FFmpeg

Windows FFmpeg and ffprobe are cross-compiled on Ubuntu 22.04 using MinGW-w64.
The application, Python sidecar, and installer are still built on Windows.
WSL Ubuntu 22.04 is supported for local media-tool builds. Keep temporary build files
on the Linux filesystem for speed; the output can live in the Windows checkout.
The work directory retains extracted sources, compiler output, and configure logs
for inspection. It can be removed after verification.

Install the build tools in Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix \
  cmake make nasm pkg-config meson ninja-build python3
```

From the checkout in Ubuntu, run:

```sh
python3 scripts/windows_ffmpeg.py --work "$HOME/.cache/tuck-ffmpeg-work"
```

The builder checks each source archive and the build recipe against their
recorded hashes. Codecs and compiler runtimes are linked statically, so the
executables need only Windows system DLLs. It writes `build/windows-ffmpeg/tools/` and
`build/windows-ffmpeg/Tuck-FFmpeg-Windows-Sources.tar.xz`. It does not install
anything into Windows. Re-run it when the source lock or recipe changes.

Back in PowerShell, run `scripts/build.ps1` as usual. The sidecar builder verifies
the source archive, build manifest, binaries, codecs, filters, and native startup
before staging anything. Missing or stale media tools stop the build.

The release workflow performs the same cross-build in a separate Ubuntu job,
then transfers its artifacts to the Windows job. It publishes the source archive
beside the installer and checks its contents again immediately before publishing.
Licenses and a build manifest are included in the installer. The source archive
is a separate download. GPU encoder presence is checked automatically, but actual NVENC and AMF
encoding still require suitable hardware and drivers.

To rebuild from a downloaded source archive without Tuck's source tree:

```sh
tar -xf Tuck-FFmpeg-Windows-Sources.tar.xz
cd ffmpeg-source
mkdir source
for archive in sources/*; do tar -xf "$archive" -C source; done
bash build-ffmpeg-windows.sh "$PWD/source" "$PWD/work" "$PWD/output" 4
```

Use a new work directory and freshly extracted sources for each build. No
upstream source patches are applied. `lock.json` records the exact inputs;
`build-environment.txt` records the toolchain used for the released executables.
