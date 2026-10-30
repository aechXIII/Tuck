import subprocess

import av
import numpy as np
import pytest

from tuck import media_server, waveform
from tuck.media_server import MediaServer
from tuck.media_tools import find_ffmpeg
from tuck.waveform import draw_waveform

# each sound takes a different way through FFmpeg's drawing: a gain on a stereo mix (which FFmpeg
# measures at (L+R)/2 and draws at 0.71 x (L+R), so its peaks clip), the dense average drawing,
# a big gain on a quiet sound, a sound loud enough for no gain, no mix at all, and 5.1
SOUNDS = {
    "game": (
        "sine=frequency=300:duration=4,volume='if(lt(mod(t,1),0.03),1,0.0005)':eval=frame",
        2,
    ),
    "music": ("anoisesrc=color=pink:amplitude=0.5:duration=4:seed=7", 2),
    "quiet": ("sine=frequency=440:duration=4,volume=-40dB,apulsator=hz=0.7", 2),
    "loud": (
        "sine=frequency=200:duration=4,volume=24dB,"
        "volume='if(lt(mod(t,1),0.02),1,0.0005)':eval=frame",
        2,
    ),
    "mono": ("sine=frequency=500:duration=4,volume=-20dB,apulsator=hz=1.3", 1),
    "surround": ("anoisesrc=color=brown:amplitude=0.4:duration=4:seed=3,apulsator=hz=0.9", 6),
}


def _ffmpeg():
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg is required to compare waveforms")
    return ffmpeg


def _sound(tmp_path, name):
    source, channels = SOUNDS[name]
    path = tmp_path / f"{name}.m4a"
    subprocess.run(
        [
            _ffmpeg(),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            source,
            "-ac",
            str(channels),
            "-c:a",
            "aac",
            "-y",
            str(path),
        ],
        check=True,
    )
    return path


def _pixels(path):
    with av.open(str(path)) as container:
        return next(container.decode(video=0)).to_ndarray(format="rgba")


@pytest.mark.parametrize("name", list(SOUNDS))
def test_drawn_waveform_matches_ffmpegs_two_passes(tmp_path, monkeypatch, name):
    source = _sound(tmp_path, name)
    assert media_server._run_waveform_ffmpeg(_ffmpeg(), source, tmp_path / "ffmpeg.png", 60)
    expected = _pixels(tmp_path / "ffmpeg.png")
    opened = []
    real_open = av.open
    monkeypatch.setattr(
        av, "open", lambda *args, **kwargs: opened.append(1) or real_open(*args, **kwargs)
    )
    # short audio is drawn from the mixes made while measuring; longer audio is decoded again
    # from the packets kept on the way, and the longest is read from the file again
    for kept, limits, opens in (
        ("mixes", {}, 1),
        ("packets", {"_KEPT_MIX_BYTES": 1000}, 2),
        ("nothing", {"_KEPT_MIX_BYTES": 1000, "_KEPT_AUDIO_BYTES": 1000}, 2),
    ):
        for limit, value in limits.items():
            monkeypatch.setattr(waveform, limit, value)
        opened.clear()
        assert draw_waveform(source, tmp_path / f"{kept}.png", 0, 60)
        assert len(opened) == opens, kept
        drawn = _pixels(tmp_path / f"{kept}.png")
        assert drawn.shape == (192, 8192, 4)
        assert np.array_equal(drawn, expected), kept
    # a solid white shape on transparency, which the timeline uses as a mask
    assert set(np.unique(expected)) <= {0, 255}
    assert expected[:, :, 3].any()


def test_what_pyav_should_not_draw_is_left_to_ffmpeg(tmp_path, monkeypatch):
    source = _sound(tmp_path, "game")
    broken = tmp_path / "broken.m4a"
    broken.write_bytes(b"not audio")
    output = tmp_path / "waveform.png"
    # no second track, a file PyAV can't read, and a recording big enough that reading it whole
    # would cost more than FFmpeg's passes, which read only the audio
    assert not draw_waveform(source, output, 1, 60)
    assert not draw_waveform(broken, output, 0, 60)
    monkeypatch.setattr(waveform, "_MAX_FILE_BYTES", source.stat().st_size - 1)
    assert not draw_waveform(source, output, 0, 60)
    assert not output.exists()


def test_a_drawing_past_its_time_stops_and_writes_nothing(tmp_path, monkeypatch):
    source = _sound(tmp_path, "music")
    clock = iter([0.0])
    monkeypatch.setattr(waveform, "monotonic", lambda: next(clock, 1000.0))
    with pytest.raises(TimeoutError):
        draw_waveform(source, tmp_path / "waveform.png", 0, 60)
    assert not (tmp_path / "waveform.png").exists()


def test_the_waveform_needs_no_ffmpeg_once_pyav_is_loaded(tmp_path, monkeypatch):
    source = _sound(tmp_path, "game")
    server = MediaServer()
    server.set_thumbnail_cache_dir(tmp_path / "cache")

    def no_ffmpeg(*_args, **_kwargs):
        raise AssertionError("FFmpeg started")

    monkeypatch.setattr("tuck.media_server.subprocess.run", no_ffmpeg)
    drawn = server.generate_waveform(source)
    assert drawn is not None
    assert _pixels(drawn).shape == (192, 8192, 4)


def test_the_waveform_does_not_wait_while_pyav_loads(tmp_path, monkeypatch):
    source = _sound(tmp_path, "game")
    server = MediaServer()
    server.set_thumbnail_cache_dir(tmp_path / "cache")
    monkeypatch.setattr("tuck.media_server.media_libraries_loading", lambda: True)

    def no_pyav(*_args, **_kwargs):
        raise AssertionError("waited for PyAV")

    monkeypatch.setattr("tuck.media_server.draw_waveform", no_pyav)
    drawn = server.generate_waveform(source)
    assert drawn is not None
    assert _pixels(drawn).shape == (192, 8192, 4)
