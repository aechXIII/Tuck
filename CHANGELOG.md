# Changelog

## [0.3.1] - 2026-08-14

### Changed
- Improved the update notes and installation flow

### Fixed
- Fixed crop controls and aspect-ratio handling
- Fixed transform tooltips

## [0.3.0] - 2026-08-14

### Added
- Crop videos directly in the preview using a freeform selection or fixed aspect ratio
- Rotate videos in 90-degree steps, flip them horizontally or vertically, and preview Fit, Fill, or Stretch output sizing from the new transform toolbar
- Save aspect ratio, sizing mode, and rotation in profiles without carrying crop regions from one video to another
- Open the logs and configuration folders from Settings

### Changed
- Reorganized Settings, moved output options into their own section, and grouped system and support tools
- Changed profile export in Settings to save one profile at a time
- Updated the Discord Free profile from 10 MB to 20 MB to match Discord's current upload limit
- Reused file details while preparing previews and queued jobs instead of running FFprobe again

### Fixed
- Fixed width and height detection for phone videos that store rotation as metadata
- Fixed target-size bitrate calculations when using Auto (fastest available)
- Fixed Windows Send To shortcuts showing an unknown status in Settings

## [0.2.1] - 2026-08-09

### Fixed
- Send To compression progress

## [0.2.0] - 2026-08-09

### Added
- Video trimming with a two-handle timeline
- Copy path-sanitized diagnostics for issue reports
- Auto (best compression) and Auto (fastest available) encoder modes with usable hardware detection
- Persistent encoder-capability cache, with manual refresh in Settings
- Automatic and manual update checks, with the last-check time in Settings
- Custom FFmpeg and FFprobe executable paths in Settings
- Cancel individual pending or running queue jobs
- Stop the queue after the current job and optionally clear completed jobs automatically
- A 2 MB minimum target size for new compression requests
- Drag-and-drop feedback for accepted and rejected files

### Changed
- Queue status with encode stage, pass, speed, ETA, and retry details
- Drag to reorder clips before encoding
- Target-size bitrate planning and retry policy
- Output name handling after interrupted or in-progress encodes
- Clear completed jobs removes completed clips from Files while keeping failed and cancelled jobs available for inspection or retry
- Show a completion notification for each finished video

### Fixed
- Retry failed or cancelled jobs with their original requested trim and encode settings
- Keep failed and cancelled job history unchanged while retrying

## [0.1.0]

First public release.

- Windows video compressor and upscaler built on FFmpeg
- Discord presets for 10 MB, 50 MB, and 500 MB files
- 1440p, 4K, and custom-resolution upscaling
- Two-pass compression with automatic retry for files over the target size
- CPU, NVIDIA, and AMD H.264/H.265 encoders
- Profile editor with import, export, copy, and delete
- Queue multiple files and preview output settings before encoding
- Drag and drop and File Explorer Send To shortcuts
- CLI for compression, upscaling, probing, and profile management
- In-app updates through GitHub Releases with SHA-256 verification
- Windows installer built and released through GitHub Actions
