# Third-party notices for Tuck on Linux

Tuck is free software, licensed under the GNU General Public License, version 3.0
only (`GPL-3.0-only`). See `LICENSE`. This notice applies to the x86-64 Linux
AppImage. The locked inputs for its media tools are recorded in
`packaging/ffmpeg-linux-sources.lock.json`.

## FFmpeg and ffprobe

The AppImage builds and bundles `ffmpeg` and `ffprobe` on native Ubuntu 22.04
from these locked sources:

- FFmpeg 7.1.1, GPL-2.0-or-later when built with the GPL options used here
- x264 snapshot 20191217-2245-stable, GPL-2.0-or-later
- x265 3.6 at revision `aa7f602f7592eddb9d87749be7466da005b556ee`, GPL-2.0-or-later

The tools link x264 and x265 statically and use the system's `libc.so.6`.
Source URLs, hashes, licenses, and the build recipe are recorded in
`packaging/ffmpeg-linux-sources.lock.json`.

Each AppImage includes `ffmpeg/source/ffmpeg-source.tar.xz`, containing the
three source archives, build recipe, and source manifest. If the archive is
missing, request a copy through Tuck's GitHub repository. Corresponding source
is available on request for at least three years after distribution.

Before packaging, the verifier checks the sources, executable hashes, required
codecs and filters, build options, and library dependencies.

## Tauri desktop shell

The `Tuck` shell uses Tauri 2, WebKitGTK, GTK, and the Rust crates pinned in
`src-tauri/Cargo.lock`. The AppImage contains the shell and its runtime
dependencies, not a system Python or FFmpeg installation.

## Python sidecar

`tuck-sidecar` embeds CPython and the packages pinned in
`packaging/sidecar-constraints.txt`: platformdirs (MIT), rich (MIT),
markdown-it-py (MIT), mdurl (MIT), Pygments (BSD-2-Clause), and packaging
(Apache-2.0 OR BSD-2-Clause). CPython is distributed under the PSF License
Agreement: <https://docs.python.org/3/license.html>.
