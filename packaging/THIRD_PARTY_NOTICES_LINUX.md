# Third-party notices for Tuck on Linux

Tuck is free software under the GNU GPL version 3.0 only. See `LICENSE`.
This notice is for the x86-64 AppImage, which also includes the components
below.

## FFmpeg and ffprobe

`ffmpeg` and `ffprobe` are built on Ubuntu 22.04 from pinned sources:
FFmpeg 7.1.1, x264 (snapshot 20191217-2245-stable) and x265 3.6, all
GPL-2.0-or-later, zimg 3.0.6 (WTFPL) and dav1d 1.5.1 (BSD-2-Clause). x264,
x265, zimg and dav1d are linked statically. The lock file is
`packaging/ffmpeg-linux-sources.lock.json`.

The AppImage includes `ffmpeg/source/ffmpeg-source.tar.xz` with the five
source archives, the build recipe and the license files. If it is missing,
ask for a copy through Tuck's GitHub repository.

## AV1 preview decoder

`gstreamer/libgstdav1d.so` lets video previews decode AV1 with dav1d. It is
built from `gst-plugin-dav1d` 0.15.4 (MIT or Apache-2.0) and the Rust crates in
its `Cargo.lock`, and includes the same dav1d 1.5.1 (BSD-2-Clause) as FFmpeg,
linked statically. The lock file is `packaging/gst-dav1d-linux.lock.json`, and
the plugin's license files are in `licenses/gst-plugin-dav1d/`.

## Desktop shell

`Tuck` is built with Tauri 2 and the Rust crates in `src-tauri/Cargo.lock`
(MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 and MPL-2.0 licenses). The
AppImage bundles GTK, WebKitGTK, GStreamer and their dependencies from
Ubuntu 22.04 so video preview works without system packages. Those libraries
keep their own licenses, mostly LGPL, GPL, MIT and BSD.

## Python and media libraries

`tuck-sidecar` embeds CPython (PSF license) and the packages in
`packaging/sidecar-constraints.txt`: platformdirs, rich, markdown-it-py and
mdurl (MIT) and Pygments (BSD-2-Clause).

Frame blending and LUTs use PyAV 16.1.0 and NumPy 2.2.6 (both BSD-3-Clause).
Their license files are in `_internal/licenses/av/` and `_internal/licenses/numpy/`.

PyAV ships its own FFmpeg 8.0.1 libraries with x264, x265 4.1 and LAME 3.100.
They are separate from the command-line tools above and are built by
`pyav-ffmpeg` release `8.0.1-3`, whose sources, patches and build scripts are at
<https://github.com/PyAV-Org/pyav-ffmpeg/tree/8.0.1-3>.

## Source code

Tuck's source is at <https://github.com/aechXIII/Tuck>. The bundled Ubuntu
libraries come from Ubuntu 22.04 source packages at <https://launchpad.net/ubuntu>.
For any GPL, LGPL or MPL component in this package, you can also ask for the
matching source through Tuck's repository for at least three years after
release, for no more than the cost of sending it.
