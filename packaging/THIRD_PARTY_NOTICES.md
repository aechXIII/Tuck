# Third-party notices for Tuck on Windows

Tuck is free software, licensed under the GNU General Public License, version 3.0
only (`GPL-3.0-only`). See `LICENSE`. The packaged Windows app also includes the
components below.

## FFmpeg and ffprobe

Tuck builds `ffmpeg.exe` and `ffprobe.exe` from pinned sources with MinGW-w64.
The tools statically link FFmpeg 7.1.1, x264, x265 3.6, dav1d 1.5.1, and
zlib 1.3.1. NVIDIA codec headers 12.2.72.0 and AMD AMF headers 1.4.35 enable
hardware encoding through the user's installed GPU drivers.

FFmpeg, x264, and x265 are licensed under GPL-2.0-or-later; dav1d uses
BSD-2-Clause, zlib uses the zlib license, and the GPU headers use MIT licenses.
The build enables GPL components and does not enable nonfree components.
License texts are installed under `ffmpeg/`, including the MinGW-w64 and GCC
runtime notices in `Toolchain-LICENSE.txt`. GCC runtime components carry the
GCC Runtime Library Exception.

Each release includes `Tuck-FFmpeg-Windows-Sources.tar.xz` as a separate
download alongside the installer. It contains the exact upstream archives,
source lock, and build recipe. The installed `ffmpeg/build-manifest.json`
records its SHA-256, the source lock hash, and the built files' hashes.
`ffmpeg/build-environment.txt` records the compiler and build-tool versions.
Source archive URLs and hashes are pinned in `packaging/ffmpeg-sources.lock.json`.

**Patents.** FFmpeg and its codecs (including H.264, H.265, and AAC) may be
covered by third-party patents. FFmpeg upstream grants no patent license. This
notice is not legal advice.

## Microsoft Edge WebView2 Runtime

If WebView2 is missing, the installer runs the Microsoft-provided Evergreen bootstrapper
`MicrosoftEdgeWebView2Setup.exe` (SHA-256 in
`packaging/webview2-bootstrapper.lock.json`) to install the WebView2
Runtime. It is redistributed under the Microsoft Edge WebView2 Runtime
distribution terms, <https://developer.microsoft.com/microsoft-edge/webview2/>.
The runtime is a Microsoft component and is not part of Tuck's source.

## Rust, npm, and Python components

The `Tuck.exe` shell is built with Tauri 2 and links the crates pinned in
`src-tauri/Cargo.lock`. Rust dependency licenses include MIT, Apache-2.0, BSD, ISC, Zlib,
Unicode-3.0, and MPL-2.0. The frontend embeds only
`@tauri-apps/api` (MIT OR Apache-2.0). The other npm packages are build-time
tools and are not distributed.

`tuck-sidecar.exe` and `TuckCli.exe` embed CPython (PSF License Agreement,
<https://docs.python.org/3/license.html>) and the packages pinned in
`packaging/sidecar-constraints.txt`: `platformdirs`, `rich`, `markdown-it-py`,
`mdurl` (MIT), `Pygments` (BSD-2-Clause), `packaging` (Apache-2.0 OR
BSD-2-Clause), and `pywin32` (PSF-2.0).

Each component's full license text is available in its own source repository.
