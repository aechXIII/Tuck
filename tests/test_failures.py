import pytest

from tuck.encoding.failures import (
    ACCESS_DENIED_MESSAGE,
    DECODER_MISSING_MESSAGE,
    DISK_FULL_MESSAGE,
    ENCODER_FAILED_MESSAGE,
    FILTER_FAILED_MESSAGE,
    INPUT_DAMAGED_MESSAGE,
    describe_ffmpeg_failure,
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
    assert "Diagnostics" in message
