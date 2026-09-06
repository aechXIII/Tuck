# Third-party notices for Tuck on Windows

Tuck is free software, licensed under the GNU General Public License, version 3.0
only (`GPL-3.0-only`). See `LICENSE`. The packaged Windows app also includes the
components below.

## FFmpeg and ffprobe

Tuck bundles FFmpeg and ffprobe from gyan.dev's 64-bit static
`ffmpeg-7.1.1-full_build` release. It enables GPL and version 3 components,
without the nonfree build option. The tools use GPL-3.0; their license text
is installed at `ffmpeg/FFmpeg-LICENSE.txt`.

The download URL, build options, file sizes, and SHA-256 hashes are recorded
in `packaging/ffmpeg-sources.lock.json`. The builder checks these hashes before
packaging either executable.

FFmpeg 7.1.1 source is available at
<https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz>. This covers FFmpeg itself;
matching source for the external libraries and the build instructions must
also accompany releases that distribute these binaries. Source requests can
be made through Tuck's GitHub repository for at least three years after
distribution.

**Patents.** FFmpeg and its codecs, including H.264, H.265, and AAC, may be
covered by third-party patents. FFmpeg upstream grants no patent license.

## Microsoft Edge WebView2 Runtime

The installer runs the Microsoft-provided Evergreen bootstrapper
`MicrosoftEdgeWebView2Setup.exe` (SHA-256 in
`packaging/webview2-bootstrapper.lock.json`) to install or update the WebView2
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
