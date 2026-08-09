# Changelog

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
