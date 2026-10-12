# Changelog

## [0.6.0] - 2026-10-12

### Lossless cut

Cut the parts you don't want out of a video without re-encoding it. Pick Lossless cut at the
bottom of the window, keep the parts you want on the timeline, and export. The video keeps its
full quality and saves much faster than a compressed export.

- Works with MP4, MOV, MKV, WebM, MPEG-TS and AVI
- Keeps audio tracks, subtitles and chapters
- Keyframes on the timeline, with `[` and `]` to jump between them
- Exact cuts (Beta) for cuts that don't land on a keyframe

### Added

- Custom keyboard shortcuts
- Shortcuts for cut points, playback speed and removing videos
- Search in Settings
- Accent colors and interface size
- Option to turn off animations
- Graphite and Violet timeline styles
- Time shown as seconds, timecode or frames
- More choices for where exports are saved
- Keep original file dates
- Replace files with the same name
- Notifications when exports finish
- Export progress on the Windows taskbar
- Keep the PC awake while exporting
- Run exports in the background
- Reopen last videos on start
- Choose which task Tuck opens with
- Choose how far the arrow keys skip
- Loop playback toggle
- Pinned and hidden profiles
- Hide tasks and panels
- Choose which Send To shortcuts to add
- Back up, restore and reset settings
- HDR to SDR conversion
- Undo for removing videos
- Remove videos from the Library after they export
- Remove failed exports from the queue
- Warning before closing or updating during exports
- Export warnings for parts of a video that can't be kept
- Restart option after a crash

### Changed

- Updated editor layout
- Updated Settings layout
- New title bar on Windows with Snap Layouts
- Clearer timeline waveform, toolbar and trim handles
- Faster loading of videos and thumbnails
- Faster NVIDIA exports
- Faster frame blending
- Unreadable videos grouped under Needs attention
- Better quality at the same file size
- Clearer error messages
- Clearer export progress in the queue
- Undo and Redo only change the selected video
- Notice when exports fall back to the CPU
- Exports keep text subtitles
- Only the first audio track of a video is exported
- More video formats play in the preview
- Smoother video previews on Linux
- Faster first video import after starting Tuck on Linux
- Preview note when a video's picture can't be shown, such as HEVC on Windows

### Fixed

- Settings not saving with profiles from another Tuck version
- Exports failing on file names with letters like ą, ж or あ
- Cancel sometimes needing a second click
- Numbered file names after a crash
- Clear done removing videos from the Library
- One unreadable video blocking Compress all
- Deleted profiles coming back
- Repeated frames in phone videos when limiting frame rate
- Tuck not coming to the front from Send To
- AV1 videos failing to export on Linux

## [0.5.2] - 2026-09-19

### Added

- Frame blending
- Color LUT support

### Changed

- Updated resolution and frame rate controls
- Replaced checkboxes with toggles

### Fixed

- Clips dropping in the wrong position in Library
- Preview freezing when scrubbing through videos
- Incorrect rotation in some videos

## [0.5.1] - 2026-09-14

- Fixed an arrow

## [0.5.0] - 2026-09-14

### Added

- Linux support (AppImage)
- Linux installer script

### Changed

- Updated editor layout
- Bundled FFmpeg and ffprobe on Windows
- Signed in-app updates on Windows and Linux
- Estimated output sizes in Library
- Updated quick size presets: 20, 50, 200, and 500 MB
- Show exported files in their folder

### Fixed

- Repeated encoding when the output was already below the size limit
- Editor freezing when changing export settings after an encode
- Audio waveforms disappearing after edits or undo

## [0.4.0] - 2026-08-27

### Added

- Keyboard shortcuts modal
- Multiple segments support
- Retry files that Tuck could not read
- Collapsible Library and Inspector panels
- Add new audio tracks (songs for example)
- Add or remove audio, change volume, mute fragments

### Changed

- New logo
- UI redesign
- Timeline rework
- Simplified descriptions and texts
- Split Windows Send To into Tuck and Tuck Compress

## [0.3.2] - 2026-08-15

### Added

- Option to open the output folder when the queue finishes

### Fixed

- Stretch now works correctly on cropped videos

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
