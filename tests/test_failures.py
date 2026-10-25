import errno
from pathlib import PurePath, PureWindowsPath

import pytest

from tuck.encoding import failures
from tuck.encoding.failures import (
    ACCESS_DENIED_MESSAGE,
    DECODER_MISSING_MESSAGE,
    DISK_FULL_MESSAGE,
    ENCODER_FAILED_MESSAGE,
    FILE_ERROR_MESSAGE,
    FILTER_FAILED_MESSAGE,
    FOLDER_IN_USE_MESSAGE,
    INPUT_DAMAGED_MESSAGE,
    NO_PERMISSION_MESSAGE,
    OUTPUT_FAILED_MESSAGE,
    describe_ffmpeg_failure,
    describe_file_error,
)


@pytest.mark.parametrize(
    ("stderr", "message"),
    [
        (
            "[mp4 @ 0000021] Error writing trailer: No space left on device\n",
            DISK_FULL_MESSAGE,
        ),
        (
            "av_interleaved_write_frame(): There is not enough space on the disk.\n",
            DISK_FULL_MESSAGE,
        ),
        (
            "[out#0/mp4 @ 000001] Error opening output C:/Videos/clip.mp4: Permission denied\n",
            ACCESS_DENIED_MESSAGE,
        ),
        (
            "[h264_nvenc @ 000001] OpenEncodeSessionEx failed: unsupported device (2)\n"
            "[vost#0:0/h264_nvenc @ 000002] Error while opening encoder\n",
            ENCODER_FAILED_MESSAGE,
        ),
        ("Unknown encoder 'libx265'\n", ENCODER_FAILED_MESSAGE),
        # a failed filter graph also stops the encoder, which must not take the blame
        (
            "[Parsed_zscale_0 @ 000001] code 3074: no path between colorspaces\n"
            "[vf#0:0 @ 000002] Error while filtering: Generic error in an external library\n"
            "[vost#0:0/libx264 @ 000003] Could not open encoder before EOF\n",
            FILTER_FAILED_MESSAGE,
        ),
        # FFmpeg's own AV1 decoder without a GPU, the way it fails on an AV1 export
        (
            "[dec:av1 @ 0x5b] Decode error rate 1 exceeds maximum 0.666667\n"
            "[dec:av1 @ 0x5b] Task finished with error code: -1145393733\n",
            DECODER_MISSING_MESSAGE,
        ),
        (
            "[vist#0:0/av1 @ 0x5a] Decoder (codec av1) not found for input stream #0:0\n",
            DECODER_MISSING_MESSAGE,
        ),
        (
            "[mov,mp4,m4a,3gp,3g2,mj2 @ 000001] moov atom not found\n"
            "[in#0 @ 000002] Error opening input: Invalid data found when processing input\n",
            INPUT_DAMAGED_MESSAGE,
        ),
    ],
    ids=[
        "disk-full",
        "disk-full-windows",
        "access-denied",
        "encoder-open",
        "unknown-encoder",
        "filter",
        "av1-without-gpu",
        "no-decoder",
        "damaged-input",
    ],
)
def test_common_failures_get_a_plain_explanation(stderr, message):
    assert describe_ffmpeg_failure(stderr, 1) == message


def test_unknown_failure_still_says_what_happened():
    message = describe_ffmpeg_failure("Something new went wrong\n", 187)
    assert "exit code 187" in message
    # the row's action is called Copy details, so the message sends people there
    assert "Copy details" in message
    assert "Diagnostics" not in message


def test_filter_failure_points_at_copy_details():
    assert "Copy details" in FILTER_FAILED_MESSAGE
    assert "Diagnostics" not in FILTER_FAILED_MESSAGE


FOLDER = "/media/usb/Tucked"
PICK_FOLDER = "Pick another folder in Settings > Files & names, then Retry."


class _WindowsError(OSError):
    # POSIX ignores the Windows code given to OSError, so it is kept by hand
    def __init__(self, code: int, filename: str, winerror: int) -> None:
        super().__init__(code, "system words", filename)
        self.winerror = winerror


def _error(code: int, filename: str | None, winerror: int | None = None) -> OSError:
    if winerror is not None and filename:
        return _WindowsError(code, filename, winerror)
    return OSError(code, "system words", filename) if filename else OSError(code, "system words")


@pytest.mark.parametrize(
    ("exc", "message"),
    [
        (_error(errno.ENOSPC, f"{FOLDER}/clip_tucked.mp4"), DISK_FULL_MESSAGE),
        (_error(errno.EFBIG, f"{FOLDER}/clip_tucked.mp4"), DISK_FULL_MESSAGE),
        # creating the folder fails on the folder itself or on one above it
        (_error(errno.EACCES, FOLDER), NO_PERMISSION_MESSAGE),
        (_error(errno.EPERM, "/media/usb"), NO_PERMISSION_MESSAGE),
        (
            _error(errno.EROFS, FOLDER),
            f"The export folder is on a read-only drive, so the export couldn't be saved. "
            f"{PICK_FOLDER}",
        ),
        (
            _error(errno.ENOENT, "/media/usb"),
            # the folder is shown with the system's own separators
            f"The export folder {PurePath(FOLDER)} can't be reached. "
            "Its drive may be disconnected. "
            "Connect it, or pick another folder in Settings > Files & names, then Retry.",
        ),
        (_error(errno.EIO, f"{FOLDER}/.tuck-work"), OUTPUT_FAILED_MESSAGE),
        # the same errors elsewhere are about a file the export reads
        (
            _error(errno.ENOENT, "/videos/Bike trail morning.mov"),
            "Tuck can't find Bike trail morning.mov any more. It may have been moved, renamed "
            "or deleted. Put it back, then Retry.",
        ),
        (_error(errno.EACCES, "/videos/clip.mov"), ACCESS_DENIED_MESSAGE),
        (_error(errno.EIO, "/videos/clip.mov"), FILE_ERROR_MESSAGE),
        (_error(errno.EIO, None), FILE_ERROR_MESSAGE),
    ],
)
def test_file_errors_say_what_happened_and_what_to_do(exc, message):
    assert describe_file_error(exc, FOLDER) == message


def test_a_write_protected_windows_drive_is_named(monkeypatch):
    monkeypatch.setattr(failures, "PurePath", PureWindowsPath)
    # Windows reports a write-protected drive as a plain access error
    exc = _error(errno.EACCES, "E:\\Tucked", winerror=19)
    assert describe_file_error(exc, "E:\\Tucked") == (
        f"E: is read-only, so the export couldn't be saved. {PICK_FOLDER}"
    )
    in_use = _error(errno.EACCES, "E:\\Tucked\\clip_tucked.mp4", winerror=32)
    assert describe_file_error(in_use, "E:\\Tucked") == FOLDER_IN_USE_MESSAGE
    unplugged = _error(errno.ENOENT, "E:\\", winerror=3)
    assert "The export folder E:\\Tucked can't be reached" in str(
        describe_file_error(unplugged, "E:\\Tucked")
    )


def test_errors_tuck_words_itself_keep_their_words():
    assert describe_file_error(FileExistsError("Cannot reserve an output name."), FOLDER) is None
    assert describe_file_error(FileNotFoundError("FFmpeg not found."), FOLDER) is None
