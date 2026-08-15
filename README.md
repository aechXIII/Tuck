# Tuck

Tuck is a Windows app for compressing and upscaling videos with FFmpeg. It lets you trim, crop, rotate, and resize clips before encoding, and includes ready-made profiles for Discord upload limits.

[![Release](https://img.shields.io/github/v/release/aechXIII/Tuck?style=flat-square&color=3B6AD8)](https://github.com/aechXIII/Tuck/releases) [![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue?style=flat-square)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-lightgrey?style=flat-square)]() [![Buy Me a Coffee](https://img.shields.io/badge/support-Buy%20Me%20a%20Coffee-F5A623?style=flat-square&logo=buy-me-a-coffee)](https://buymeacoffee.com/aechxiii)

> [!NOTE]
> **Microsoft Defender false positive resolved**
>
> Microsoft reviewed Tuck 0.3.2 and the 0.3.3 release candidate and removed the false-positive cloud detection. Both files are classified as not malware.
>
> If Defender still reports an older detection, open Windows Security, go to **Virus & threat protection > Protection updates**, and select **Check for updates**.



https://github.com/user-attachments/assets/532317a7-e628-455e-b041-4aeceef810b5


![Tuck](docs/screenshots/Tuck_GUI.png)

<details>
<summary>Send To</summary>

![Tuck Send To](docs/screenshots/Tuck_SENDTO.png)

</details>

## Features

**Trim and transform**
- Trim clips with the two-handle timeline before encoding
- Crop directly in the preview using a freeform selection or fixed aspect ratio
- Rotate in 90-degree steps or flip the picture horizontally or vertically
- Choose Fit to keep the whole picture, Fill to crop it to the output frame, or Stretch to match the exact output dimensions

**Compress**
- Default Discord presets for 20 MB, 50 MB, and 500 MB files
- Two-pass encoding with target-size retries; outputs over the configured limit are never published
- Auto (best compression) favors quality per byte. Auto (fastest available) uses NVIDIA or AMD hardware when possible
- Choose CPU, NVIDIA, or AMD H.264/H.265 encoders. If your selected encoder is unavailable, Tuck tells you instead of silently switching

**Upscale**
- Default 1440p and 4K presets
- Quality-based encoding with CRF or CQP
- Choose the scaler you prefer

**Profiles and queue**
- Create, edit, copy, and import profiles, or export one profile at a time
- Profiles can remember aspect ratio, sizing mode, and rotation. Each clip keeps its own crop region
- Queue several files, drag pending jobs into order, and follow each encode's stage, pass, speed, ETA, and retry progress
- Cancel a pending or running job. Failed and cancelled jobs can be retried with their original trim and encode settings
- Stop after the current job or clear completed jobs automatically. Failed and cancelled jobs stay available for inspection or retry
- Keep source resolution and FPS, or set limits per profile
- Copy a support report that hides local paths, or open the logs and configuration folders directly

**Windows**
- Drag files into the app
- Add Tuck or a profile to the File Explorer Send To menu
- Check GitHub Releases for updates

## Install

1. Download the latest release from [Releases](https://github.com/aechXIII/Tuck/releases).
2. Run the installer. It installs Tuck to `%LOCALAPPDATA%\Tuck`.
3. Start Tuck from the Start menu or File Explorer Send To menu.

Tuck needs Windows 10 or 11, [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/), and FFmpeg. WebView2 is included with current Windows 10 and 11 installations; if it is missing, install it from Microsoft's official download page before starting Tuck.

Install FFmpeg from PowerShell, then restart Tuck:

```powershell
winget install -e --id Gyan.FFmpeg
```

If `winget` is unavailable, download a Windows build from [FFmpeg](https://ffmpeg.org/download.html). Extract `ffmpeg.exe` and `ffprobe.exe` to `C:\ffmpeg\bin`. You can also set custom FFmpeg and FFprobe paths in **Settings**.

## Use

1. Add one or more video files and optionally trim, crop, rotate, or flip the selected clip.
2. Select a compression or upscale profile and encoder.
3. Start the queue. You can reorder pending jobs, cancel a pending or running job, and retry failed or cancelled jobs without changing the original request.
4. Use **Settings > System > Copy diagnostics** after a failure to copy a path-sanitized support report.

For File Explorer, select video files, right-click them, then use **Send To > Tuck**. You can also add profile-specific shortcuts from Settings.

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
node --test
```

The app build is in `dist\Tuck\`. The installer is in `scripts\Output\`.

## License

Tuck is licensed under the GNU General Public License v3.0 only (`GPL-3.0-only`). See [LICENSE](LICENSE).
