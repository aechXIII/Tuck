# Tuck

Windows video compressor and upscaler. Built for Discord limits, but useful for any FFmpeg job that needs a smaller file or to upscale a video for YouTube.

[![Release](https://img.shields.io/github/v/release/aechXIII/Tuck?style=flat-square&color=7C3AED)](https://github.com/aechXIII/Tuck/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-lightgrey?style=flat-square)]()

![Tuck](docs/screenshots/Tuck_GUI.png)

<details>
<summary>Send To</summary>

![Tuck Send To](docs/screenshots/Tuck_SENDTO.png)

</details>

## Features

**Compress**
- Default Discord presets for 10 MB, 50 MB, and 500 MB files
- Two-pass encoding and automatic retry when a file exceeds its target
- CPU, NVIDIA, and AMD H.264/H.265 encoders

**Upscale**
- Default 1440p and 4K presets
- Quality-based encoding with CRF or CQP
- Choose the scaler you prefer

**Profiles and queue**
- Edit, copy, import, and export profiles
- Process several files in order
- Keep source resolution and FPS, or set limits per profile

**Windows**
- Drag files into the app
- Add Tuck or a profile to the File Explorer Send To menu
- Check GitHub Releases for updates

## Install

1. Download the latest release from [Releases](https://github.com/aechXIII/Tuck/releases).
2. Run the installer. It installs Tuck to `%LOCALAPPDATA%\Tuck`.
3. Start Tuck from the Start menu or File Explorer Send To menu.

Tuck needs Windows 10 or 11, [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), and FFmpeg.

Install FFmpeg from PowerShell, then restart Tuck:

```powershell
winget install -e --id Gyan.FFmpeg
```

If `winget` is unavailable, download a Windows build from [FFmpeg](https://ffmpeg.org/download.html). Extract `ffmpeg.exe` and `ffprobe.exe` to `C:\ffmpeg\bin`.

## Use

1. Add one or more video files.
2. Select a compression or upscale profile.
3. Check settings and start the queue.

For File Explorer, select video files, right-click them, then use **Send To > Tuck**. You can also add profile-specific shortcuts from Tuck settings.

## Command line

After installing, use `tuck` from a new terminal:

```powershell
tuck profiles list
tuck probe video.mp4
tuck compress video.mp4 --profile discord-50mb
tuck compress video.mp4 --size 25
tuck upscale video.mp4 --to 1440p
tuck upscale video.mp4 --resolution 2560x1440
```

Run `tuck --help` for all commands.

## Build from source

Requires Python 3.10 or newer. Install [Inno Setup 6](https://jrsoftware.org/isdl.php) to build the installer.

```powershell
.\scripts\setup.ps1
.\scripts\run.ps1
```

```powershell
.\scripts\build.ps1 -Clean
.\scripts\build.ps1 -Clean -Installer
```

Run the checks before a release:

```powershell
pytest
ruff format --check tuck/ tests/
ruff check tuck/ tests/
pyright tuck/
```

The app build is in `dist\Tuck\`. The installer is in `scripts\Output\`.

## License

MIT. See [LICENSE](LICENSE).
