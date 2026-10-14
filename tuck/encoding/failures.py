"""Turn FFmpeg's stderr into a short explanation people can act on.

The full FFmpeg output stays on the error for Diagnostics; these messages only say what went
wrong and what to try next.
"""

from __future__ import annotations

import re

# keys FFmpeg writes for `-progress`; they crowd out the lines that explain a failure
_PROGRESS_LINE_RE = re.compile(
    r"^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time(_us|_ms)?|dup_frames|"
    r"drop_frames|speed|progress)=",
)

_DISK_FULL_MARKERS = (
    "no space left on device",
    "not enough space on the disk",
    "disk quota exceeded",
    "file too large",
)
_ACCESS_MARKERS = (
    "permission denied",
    "access is denied",
    "operation not permitted",
    "read-only file system",
)
# a failed filter graph also stops the encoder downstream, so these are checked first
_FILTER_MARKERS = (
    "error while filtering",
    "error reinitializing filters",
    "error initializing filters",
    "error initializing complex filters",
    "failed to configure output pad",
    "no path between colorspaces",
)
_ENCODER_MARKERS = (
    "unknown encoder",
    "encoder not found",
    "error while opening encoder",
    "could not open encoder",
    "failed to open codec",
    "error initializing output stream",
    "error applying encoder options",
    "unable to parse option value",
    "no nvenc capable devices found",
    "openencodesessionex failed",
    "failed to initialise amf",
    "generic error in an external library",
)
# no decoder for the video's format, or one that can't run here; FFmpeg's own AV1 decoder
# needs a GPU and fails every frame without one
_DECODER_MARKERS = (
    "decoder (codec",
    "decode error rate",
)
_INPUT_MARKERS = (
    "invalid data found when processing input",
    "moov atom not found",
    "error while decoding",
    "corrupt",
    "invalid nal unit",
    "error reading header",
    "truncated",
)

DISK_FULL_MESSAGE = (
    "The export stopped because the disk is full. "
    "Free up some space or choose another output folder, then export again."
)
ACCESS_DENIED_MESSAGE = (
    "Tuck couldn't read or write a file because access was denied. "
    "Check that the output folder is writable and the files aren't open in another app, "
    "then export again."
)
ENCODER_FAILED_MESSAGE = (
    "The video encoder couldn't start with these settings. "
    "Try another encoder or a different resolution, then export again."
)
FILTER_FAILED_MESSAGE = (
    "Tuck couldn't convert this video's picture with the current export settings. "
    "Try removing the LUT, crop or frame blending, or open Diagnostics on this export "
    "for FFmpeg's details."
)
DECODER_MISSING_MESSAGE = (
    "Tuck couldn't decode this video. FFmpeg may not support its format, or the file may be "
    "damaged. Check that it plays in another app, or choose a different FFmpeg in "
    "Settings > Media tools, then export again."
)
INPUT_DAMAGED_MESSAGE = (
    "Tuck couldn't read part of the source video. The file may be damaged or incomplete. "
    "Check that it plays in another app, then export again."
)


def is_progress_line(line: str) -> bool:
    return bool(_PROGRESS_LINE_RE.match(line.strip()))


def is_cuda_decode_failure(stderr: str) -> bool:
    text = stderr.lower()
    # hardware setup failures can also print the generic "error while decoding" line
    if any(
        marker in text
        for marker in _DISK_FULL_MARKERS + _ACCESS_MARKERS + _INPUT_MARKERS
        if marker != "error while decoding"
    ):
        return False
    for line in text.splitlines():
        if "unrecognized hwaccel: cuda" in line or "no such filter: 'hwdownload'" in line:
            return True
        if "failed setup for format cuda" in line:
            return True
        if "no device available for decoder" in line and "cuda" in line:
            return True
        if "[av1 @" in line and any(
            marker in line
            for marker in (
                "hwaccel",
                "cuda",
                "hardware is lacking required capabilities",
                "no decoder surfaces left",
            )
        ):
            return True
        if "[avhwdevicecontext @" in line and any(
            marker in line for marker in ("cannot load nvcuda", "cuda_error", "cuda devices")
        ):
            return True
        if "[parsed_hwdownload_" in line and any(
            marker in line
            for marker in (
                "failed to download frame",
                "the input must have a hardware frame reference",
                "input frame is not the in the configured hwframe context",
            )
        ):
            return True
        # a build without AV1 hardware decoding may select dav1d before hwdownload
        if (
            "-> hwdownload:" in text
            and "impossible to convert between the formats" in line
            and "input from stream 0:0'" in line
            and "'auto_scale_" in line
        ):
            return True
    return False


def describe_ffmpeg_failure(stderr: str, returncode: int) -> str:
    """A calm, user-facing explanation for a failed FFmpeg run."""
    text = stderr.lower()
    if any(marker in text for marker in _DISK_FULL_MARKERS):
        return DISK_FULL_MESSAGE
    if any(marker in text for marker in _ACCESS_MARKERS):
        return ACCESS_DENIED_MESSAGE
    if any(marker in text for marker in _FILTER_MARKERS):
        return FILTER_FAILED_MESSAGE
    if any(marker in text for marker in _ENCODER_MARKERS):
        return ENCODER_FAILED_MESSAGE
    if any(marker in text for marker in _DECODER_MARKERS):
        return DECODER_MISSING_MESSAGE
    if any(marker in text for marker in _INPUT_MARKERS):
        return INPUT_DAMAGED_MESSAGE
    return (
        f"FFmpeg stopped with an error (exit code {returncode}) and the export wasn't saved. "
        "Open Diagnostics on this export for FFmpeg's full output."
    )
