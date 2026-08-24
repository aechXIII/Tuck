import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture
def temp_dir():

    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


def _create_valid_mp4(path: Path) -> bool:

    from tuck.media_tools import find_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return False
    try:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=64x64:rate=30",
                "-frames:v",
                "1",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                str(path),
            ],
            capture_output=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return path.exists() and path.stat().st_size > 0
    except Exception:
        return False


@pytest.fixture
def sample_video_path(temp_dir):

    path = temp_dir / "sample.mp4"
    if not _create_valid_mp4(path):
        pytest.skip("ffmpeg not available for generating test video")
    return path


@pytest.fixture
def skip_if_no_ffmpeg():

    ffmpeg_available = False
    try:
        from tuck.engine import is_ffmpeg_available

        ffmpeg_available = is_ffmpeg_available()
    except Exception:
        pass
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")


@pytest.fixture
def skip_if_no_ffprobe():

    ffprobe_available = False
    try:
        from tuck.probe import is_ffprobe_available

        ffprobe_available = is_ffprobe_available()
    except Exception:
        pass
    if not ffprobe_available:
        pytest.skip("ffprobe not available")
