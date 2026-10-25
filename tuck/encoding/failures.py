"""Turn FFmpeg's stderr and file system errors into a short explanation people can act on.

The full FFmpeg output or system error stays on the export for Copy details; these messages
only say what went wrong and what to try next.
"""

from __future__ import annotations

import errno
import re
from pathlib import Path, PurePath, PureWindowsPath

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
    "Try removing the LUT, crop or frame blending. Copy details has FFmpeg's full output."
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


def is_hardware_decode_failure(stderr: str, backend: str = "cuda") -> bool:
    text = stderr.lower()
    # hardware setup failures can also print the generic "error while decoding" line
    access_markers = _ACCESS_MARKERS
    if "hardware device setup failed for decoder: operation not permitted" in text:
        # FFmpeg repeats this device error as an output-open error before touching the file
        access_markers = tuple(
            marker for marker in access_markers if marker != "operation not permitted"
        )
    # a device-node permission failure happens before FFmpeg opens any media files
    device_init_failed = "for option 'init_hw_device'" in text
    if any(
        marker in text
        for marker in _DISK_FULL_MARKERS
        + (() if device_init_failed else access_markers)
        + _INPUT_MARKERS
        if marker != "error while decoding"
    ):
        return False
    if device_init_failed:
        return True
    for line in text.splitlines():
        if "unknown decoder 'av1'" in line:
            return True
        if f"unrecognized hwaccel: {backend}" in line or "no such filter: 'hwdownload'" in line:
            return True
        if f"failed setup for format {'d3d11' if backend == 'd3d11va' else backend}" in line:
            return True
        if "no device available for decoder" in line and backend in line:
            return True
        if "[av1 @" in line and any(
            marker in line
            for marker in (
                "hwaccel",
                "hw accel start frame fail",
                "hw accel decode slice fail",
                "hw accel end frame fail",
                backend,
                "hardware is lacking required capabilities",
                "doesn't support hardware accelerated av1 decoding",
                "no decoder surfaces left",
                "no support for codec",
                "no decoder device for codec",
                "failed to create decode",
                "failed to sync surface",
                "failed to end picture decode",
            )
        ):
            return True
        if "[avhwdevicecontext @" in line and any(
            marker in line
            for marker in (
                "cannot load nvcuda",
                "cannot load libcuda",
                "cuda_error",
                "cuda devices",
                "no va display found",
                "failed to initialise vaapi",
                "failed to initialize vaapi",
                "failed to create direct3d device",
                "failed to find d3d11va adapter",
                "failed to load d3d11 library",
            )
        ):
            return True
        if "[parsed_hwdownload_" in line and any(
            marker in line
            for marker in (
                "failed to download frame",
                "the input must have a hardware frame reference",
                "input frame is not the in the configured hwframe context",
                "invalid output format",
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
        "Retry once. If it stops again, use Copy details and add them to a bug report."
    )


_PICK_ANOTHER_FOLDER = "Pick another folder in Settings > Files & names, then Retry."
NO_PERMISSION_MESSAGE = (
    f"Tuck doesn't have permission to save in the export folder. {_PICK_ANOTHER_FOLDER}"
)
FOLDER_IN_USE_MESSAGE = (
    "Another app is using a file in the export folder. Close it, then Retry. "
    "Copy details names the file."
)
OUTPUT_FAILED_MESSAGE = (
    "Tuck couldn't save the export in the export folder. Check that its drive is connected, "
    "or pick another folder in Settings > Files & names, then Retry."
)
FILE_ERROR_MESSAGE = (
    "Tuck couldn't open a file this export needs. Check that the video and the export folder "
    "are still in place, then Retry. Copy details has the full error."
)

_DISK_FULL_ERRNOS = frozenset(
    code for code in (errno.ENOSPC, errno.EFBIG, getattr(errno, "EDQUOT", None)) if code is not None
)
_ACCESS_ERRNOS = frozenset({errno.EACCES, errno.EPERM})
_MISSING_ERRNOS = frozenset({errno.ENOENT, errno.ENOTDIR})
# Windows reports these as plain access or missing-path errors; only its own code tells them apart
_WINDOWS_WRITE_PROTECTED = 19
_WINDOWS_NOT_READY = frozenset({21, 53, 67})
_WINDOWS_IN_USE = frozenset({32, 33})


def _is_output_path(path: PurePath, folder: PurePath) -> bool:
    # creating the folder can fail on any folder above it, and writing on any file inside it
    return path.is_relative_to(folder) or folder.is_relative_to(path)


def describe_file_error(exc: OSError, output_folder: str | Path | None = None) -> str | None:
    """A calm explanation for a file system error raised while preparing or saving an export.

    Returns None for errors Tuck raised with its own wording, which carry no error number.
    """
    if exc.errno is None:
        return None
    code = exc.errno
    winerror = getattr(exc, "winerror", None)
    if code in _DISK_FULL_ERRNOS:
        return DISK_FULL_MESSAGE
    folder = PurePath(output_folder) if output_folder else None
    path = PurePath(exc.filename) if isinstance(exc.filename, str) and exc.filename else None

    if folder is not None and path is not None and _is_output_path(path, folder):
        if code == errno.EROFS or winerror == _WINDOWS_WRITE_PROTECTED:
            drive = PureWindowsPath(str(folder)).drive
            where = (
                f"{drive} is read-only" if drive else "The export folder is on a read-only drive"
            )
            return f"{where}, so the export couldn't be saved. {_PICK_ANOTHER_FOLDER}"
        if winerror in _WINDOWS_IN_USE:
            return FOLDER_IN_USE_MESSAGE
        if code in _MISSING_ERRNOS or winerror in _WINDOWS_NOT_READY:
            return (
                f"The export folder {folder} can't be reached. Its drive may be disconnected. "
                "Connect it, or pick another folder in Settings > Files & names, then Retry."
            )
        if code in _ACCESS_ERRNOS:
            return NO_PERMISSION_MESSAGE
        return OUTPUT_FAILED_MESSAGE

    if path is not None and (code in _MISSING_ERRNOS or winerror in _WINDOWS_NOT_READY):
        return (
            f"Tuck can't find {path.name} any more. It may have been moved, renamed or deleted. "
            "Put it back, then Retry."
        )
    if code in _ACCESS_ERRNOS:
        return ACCESS_DENIED_MESSAGE
    return FILE_ERROR_MESSAGE
