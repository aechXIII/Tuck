from __future__ import annotations

import dataclasses
import subprocess
import threading
from pathlib import Path

import pytest
from conftest import wait_until

from tuck.encoding.runner import EncodeCancelled, FFmpegEngine
from tuck.models import EncodePlan, Profile, Segment, SourceAudioTrack, VideoInfo
from tuck.size_estimate import (
    VERYSLOW_OF_MEDIUM,
    SizeEstimator,
    estimate_size,
    sample_pieces,
)


def _plan(duration: float = 60.0, **changes: object) -> EncodePlan:
    info = VideoInfo(
        path="clip.mp4", duration=duration, width=1280, height=720, fps=60, video_codec="h264"
    )
    plan = EncodePlan(
        source="clip.mp4",
        output="clip_tucked_CRF23.mp4",
        source_info=info,
        rate_control_method="crf",
        crf=23,
        two_pass=False,
        audio_bitrate=128_000,
    )
    return dataclasses.replace(plan, **changes)


def test_pieces_spread_over_a_long_export():
    pieces = sample_pieces([Segment(0, 60)])
    assert [(p.start, p.end) for p in pieces] == [(9.5, 10.5), (29.5, 30.5), (49.5, 50.5)]


def test_a_short_export_is_encoded_whole():
    assert [(p.start, p.end) for p in sample_pieces([Segment(2, 7)])] == [(2, 7)]
    two = sample_pieces([Segment(0, 2), Segment(10, 12)])
    assert [(p.start, p.end) for p in two] == [(0, 2), (10, 12)]


def test_pieces_stay_inside_the_kept_segments():
    segments = [Segment(0, 10), Segment(100, 101.5), Segment(200, 230)]
    pieces = sample_pieces(segments)
    assert len(pieces) == 3
    for piece in pieces:
        assert any(s.start <= piece.start and piece.end <= s.end for s in segments)
    # a segment shorter than a piece is taken whole
    short = sample_pieces([Segment(0, 10), Segment(20, 20.4), Segment(30, 40)])
    assert (short[1].start, short[1].end) == (20, 20.4)


def test_estimate_scales_the_pieces_and_counts_audio_from_its_bitrate(tmp_path):
    samples: list[EncodePlan] = []

    def encode(sample: EncodePlan) -> Path:
        samples.append(sample)
        # 100 kB for every second of video
        out = Path(sample.output)
        out.write_bytes(b"x" * round(sample.effective_duration * 100_000))
        return out

    estimate = estimate_size(_plan(), encode, tmp_path)
    assert len(samples) == 3
    for sample in samples:
        assert len(sample.segments) == 1
        assert sample.audio_enabled is False
        assert sample.audio_bitrate == 0
        assert Path(sample.output).parent == tmp_path
    assert estimate.video_bytes == 6_000_000
    assert estimate.audio_bytes == 128_000 // 8 * 60
    assert estimate.size_bytes == estimate.video_bytes + estimate.audio_bytes
    assert estimate.sampled_seconds == pytest.approx(3.0)


def test_estimate_counts_each_written_audio_track(tmp_path):
    def encode(sample: EncodePlan) -> Path:
        out = Path(sample.output)
        out.write_bytes(b"x")
        return out

    two = _plan(source_audio_tracks=[SourceAudioTrack(0, 0.0), SourceAudioTrack(1, 0.0)])
    assert estimate_size(two, encode, tmp_path).audio_bytes == 2 * 128_000 // 8 * 60
    silent = _plan(audio_bitrate=0)
    assert estimate_size(silent, encode, tmp_path).audio_bytes == 0


class _BlockingEngine(FFmpegEngine):
    def __init__(self, started: threading.Event) -> None:
        super().__init__()
        self.started = started

    def encode(self, plan, on_progress=None):  # type: ignore[override]
        del plan, on_progress
        self.started.set()
        wait_until(self._cancel_event.is_set, timeout=5, what="cancel")
        raise EncodeCancelled("stopped")


def test_a_new_estimate_stops_the_one_before_it(tmp_path):
    started = threading.Event()
    engines: list[_BlockingEngine] = []

    def factory() -> FFmpegEngine:
        engines.append(_BlockingEngine(started))
        return engines[-1]

    estimator = SizeEstimator(lambda: tmp_path, engine_factory=factory)
    outcome: list[str] = []

    def first() -> None:
        try:
            estimator.estimate(_plan())
        except EncodeCancelled:
            outcome.append("cancelled")

    thread = threading.Thread(target=first)
    thread.start()
    assert started.wait(5)
    assert estimator.cancel() is True
    thread.join(5)
    assert outcome == ["cancelled"]
    # nothing is left behind in the cache folder
    assert list((tmp_path / "estimates").iterdir()) == []
    assert estimator.cancel() is False


def test_veryslow_is_estimated_from_medium_pieces(tmp_path, monkeypatch):
    seen: list[tuple[str, str]] = []

    def encode(sample: EncodePlan) -> Path:
        seen.append((sample.video_encoder, sample.preset))
        out = Path(sample.output)
        out.write_bytes(b"x" * round(sample.effective_duration * 100_000))
        return out

    plain = estimate_size(_plan(video_encoder="libx264", preset="medium"), encode, tmp_path)
    assert set(seen) == {("libx264", "medium")}
    seen.clear()
    slow = estimate_size(_plan(video_encoder="libx264", preset="veryslow"), encode, tmp_path)
    assert set(seen) == {("libx264", "medium")}
    assert slow.video_bytes == round(plain.video_bytes * VERYSLOW_OF_MEDIUM)
    assert slow.audio_bytes == plain.audio_bytes

    # Auto (best compression) runs x264 at veryslow when it has x264, and a GPU as it is otherwise
    monkeypatch.setattr(
        "tuck.size_estimate.auto_encoder_choices", lambda: {"auto_compression": "libx264"}
    )
    seen.clear()
    auto = _plan(video_encoder="auto_compression", preset="veryslow")
    assert estimate_size(auto, encode, tmp_path).video_bytes == slow.video_bytes
    assert set(seen) == {("libx264", "medium")}
    monkeypatch.setattr(
        "tuck.size_estimate.auto_encoder_choices", lambda: {"auto_compression": "h264_nvenc"}
    )
    seen.clear()
    assert estimate_size(auto, encode, tmp_path).video_bytes == plain.video_bytes
    assert set(seen) == {("auto_compression", "veryslow")}
    # x265 and the other x264 presets keep their own pieces
    seen.clear()
    estimate_size(_plan(video_encoder="libx265", preset="veryslow"), encode, tmp_path)
    assert set(seen) == {("libx265", "veryslow")}


def test_pieces_encode_at_the_same_time(tmp_path):
    together = threading.Barrier(3, timeout=5)

    def encode(sample: EncodePlan) -> Path:
        # every piece has to be running before any can finish
        together.wait()
        out = Path(sample.output)
        out.write_bytes(b"x" * 1000)
        return out

    assert estimate_size(_plan(), encode, tmp_path).sampled_seconds == pytest.approx(3.0)


def test_a_failed_piece_stops_the_others(tmp_path):
    stopped = threading.Event()

    def encode(sample: EncodePlan) -> Path:
        if sample.output.endswith("piece-0.mp4"):
            raise RuntimeError("FFmpeg stopped")
        wait_until(stopped.is_set, timeout=5, what="stop")
        raise EncodeCancelled("stopped")

    with pytest.raises(RuntimeError, match="FFmpeg stopped"):
        estimate_size(_plan(), encode, tmp_path, stop=stopped.set)


def test_bridge_waits_for_exports_and_only_estimates_quality(monkeypatch, tmp_path):
    import tuck.settings as settings_mod
    from tuck.bridge import BridgeAPI

    monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
    api = BridgeAPI()
    api._settings.load()

    monkeypatch.setattr(api._queue, "snapshot", lambda: ([], object(), []))
    busy = api.estimate_size({"source": "clip.mp4", "_request_id": 4})
    assert busy == {
        "ok": False,
        "code": "export_running",
        "error": "Tuck estimates the size once the exports finish.",
        "_request_id": 4,
    }
    assert api.estimate_size("clip.mp4") == {"ok": False, "error": "Expected request object"}


@pytest.mark.usefixtures("skip_if_no_ffmpeg")
def test_real_estimate_lands_near_the_whole_encode(tmp_path):
    from tuck.media_tools import find_ffmpeg
    from tuck.planner import plan as make_plan
    from tuck.probe import probe

    source = tmp_path / "moving.mp4"
    ffmpeg = find_ffmpeg()
    assert ffmpeg
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=12",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        timeout=60,
    )
    profile = Profile.from_dict(
        {
            "profile_id": "q",
            "name": "q",
            "workflow": "compression",
            "video_encoder": "libx264",
            "rate_control_method": "crf",
            "crf": 23,
            "two_pass": False,
            "preset": "veryfast",
            "target_size_bytes": 50 * 1024 * 1024,
            "schema_version": 7,
        }
    )
    plan = make_plan(source, profile, output=str(tmp_path / "out.mp4"), source_info=probe(source))
    whole = FFmpegEngine().encode(plan).stat().st_size
    estimate = SizeEstimator(lambda: tmp_path).estimate(plan)
    assert estimate.encoder == "libx264"
    assert estimate.audio_bytes == 0
    assert estimate.video_bytes == pytest.approx(whole, rel=0.25)
