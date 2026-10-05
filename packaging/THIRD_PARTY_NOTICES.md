# Third-party notices for Tuck on Windows

Tuck is free software under the GNU GPL version 3.0 only. See `LICENSE`.
The package also includes the components below.

## FFmpeg and ffprobe

`ffmpeg.exe` and `ffprobe.exe` are built from pinned sources with MinGW-w64.
They statically link FFmpeg 7.1.1, x264, x265 3.6, dav1d 1.5.1 and zlib 1.3.1,
and use the NVIDIA (12.2.72.0) and AMD AMF (1.4.35) headers for hardware
encoding through your GPU drivers.

FFmpeg, x264 and x265 are GPL-2.0-or-later. dav1d is BSD-2-Clause, zlib uses
the zlib license, and the GPU headers are MIT. GPL parts are enabled, nonfree
parts are not. The license files are in `ffmpeg/`.

The exact sources, lock file and build recipe ship with every release as
`Tuck-FFmpeg-Windows-Sources.tar.xz`. `ffmpeg/build-manifest.json` records its
hash and the hashes of the built files.

FFmpeg and its codecs (H.264, H.265, AAC and others) may be covered by
patents. FFmpeg grants no patent license. This is not legal advice.

## WebView2

If the WebView2 Runtime is missing, the installer runs Microsoft's bootstrapper
`MicrosoftEdgeWebView2Setup.exe` (hash in `packaging/webview2-bootstrapper.lock.json`).
It is a Microsoft component under Microsoft's own terms:
<https://developer.microsoft.com/microsoft-edge/api/eula/webview2?locale=en-us>.

## Desktop shell and installer

`Tuck.exe` is built with Tauri 2 and the Rust crates in `src-tauri/Cargo.lock`
(MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 and MPL-2.0 licenses). The
frontend includes `@tauri-apps/api` (MIT). The installer is made with NSIS.

## Python and media libraries

`tuck-sidecar.exe` and `TuckCli.exe` embed CPython (PSF license) and the
packages in `packaging/sidecar-constraints.txt`: platformdirs, rich,
markdown-it-py and mdurl (MIT), Pygments (BSD-2-Clause), packaging
(BSD-2-Clause) and pywin32 (BSD-style).

Frame blending and LUTs use PyAV 16.1.0 and NumPy 2.2.6 (both BSD-3-Clause).
Their license files are in `_internal/licenses/av/` and `_internal/licenses/numpy/`.

PyAV ships its own FFmpeg 8.0.1 libraries with x264, x265 4.1 and LAME 3.100.
They are separate from the command-line tools above and are built by
`pyav-ffmpeg` release `8.0.1-3`, whose sources, patches and build scripts are at
<https://github.com/PyAV-Org/pyav-ffmpeg/tree/8.0.1-3>.

## Source code

Tuck's source is at <https://github.com/aechXIII/Tuck>. For any GPL, LGPL or
MPL component in this package, you can also ask for the matching source
through that repository for at least three years after release, for no more
than the cost of sending it.
