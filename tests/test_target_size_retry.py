from pathlib import Path

import av
import pytest

from tuck.encoding.runner import EncodeCancelled, FFmpegEngine
from tuck.models import RCM_CBR, EncodePlan


@pytest.fixture
def engine():
    return FFmpegEngine()


def test_overshoot_then_underfill_uses_the_remaining_refinement(engine, tmp_path):
    output = tmp_path / "output.mp4"
    plan = EncodePlan(
        source="source.mp4",
        output=str(output),
        video_bitrate=1_000_000,
        audio_bitrate=0,
        target_size=10_000,
        two_pass=False,
        rate_control_method=RCM_CBR,
    )
    sizes = iter([12_000, 8_000, 9_700])
    bitrates = []

    def encode(_ffmpeg, attempt, _source, destination, *_args, **_kwargs):
        bitrates.append(attempt.video_bitrate)
        destination.write_bytes(b"x" * next(sizes))
        return destination

    engine._encode_single_pass = encode
    result = engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 1.0, None)
    assert result.stat().st_size == 9_700
    assert len(bitrates) == 3
    assert bitrates[1] < bitrates[0]
    assert bitrates[2] > bitrates[1]
    assert plan.video_bitrate == bitrates[2]
    assert set(tmp_path.iterdir()) == {output}


@pytest.mark.parametrize(
    "size, video_bytes, duration, bitrate, corrected",
    [(12_000, 9_000, 0.036, 2_000_000, 1_488_888), (8_500, 7_000, 0.056, 1_000_000, 1_171_428)],
)
def test_retry_reserves_measured_audio_and_container_bytes(
    engine,
    tmp_path,
    monkeypatch,
    size,
    video_bytes,
    duration,
    bitrate,
    corrected,
):
    output = tmp_path / "output.mp4"
    plan = EncodePlan(
        source="source.mp4",
        output=str(output),
        video_bitrate=bitrate,
        audio_bitrate=128_000,
        target_size=10_000,
        two_pass=False,
        rate_control_method=RCM_CBR,
    )
    bitrates = []
    measured = []

    def encode(_ffmpeg, attempt, _source, destination, *_args, **_kwargs):
        bitrates.append(attempt.video_bitrate)
        destination.write_bytes(b"x" * (size if len(bitrates) == 1 else 9_700))
        return destination

    def measure(path):
        measured.append(path)
        return video_bytes, duration

    monkeypatch.setattr(engine, "_encode_single_pass", encode)
    monkeypatch.setattr(engine, "_measure_video_size", measure)
    result = engine._encode_with_retry("ffmpeg", plan, Path(plan.source), output, 1.0, None)
    assert result.stat().st_size == 9_700
    assert bitrates == [bitrate, corrected]
    assert len(measured) == 1


def test_measurement_reads_the_output_video_without_counting_audio(engine):
    source = Path(__file__).parents[1] / "frontend/tests/fixtures/media/two-source-tracks.mp4"
    with av.open(str(source)) as container:
        expected_bytes = sum(packet.size for packet in container.demux(container.streams.video[0]))
        duration = container.duration / av.time_base
    assert 0 < expected_bytes < source.stat().st_size
    assert engine._measure_video_size(source) == (expected_bytes, duration)


def test_audio_only_output_has_no_video_measurement(engine):
    source = Path(__file__).parents[1] / "frontend/tests/fixtures/media/source-track-0.m4a"
    assert engine._measure_video_size(source) is None


def test_unreadable_output_has_no_video_measurement(engine, tmp_path):
    source = tmp_path / "output.mp4"
    source.write_bytes(b"invalid")
    assert engine._measure_video_size(source) is None


def test_measurement_honors_cancellation(engine):
    engine.cancel()
    source = Path(__file__).parents[1] / "frontend/tests/fixtures/media/two-source-tracks.mp4"
    with pytest.raises(EncodeCancelled):
        engine._measure_video_size(source)


def test_cancel_during_measurement_preserves_the_existing_export(engine, tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "output.mp4"
    output.write_bytes(b"existing export")
    plan = EncodePlan(
        source=str(source),
        output=str(output),
        replace_existing=True,
        video_bitrate=1_000_000,
        target_size=10_000,
        two_pass=False,
        rate_control_method=RCM_CBR,
    )

    def encode(_ffmpeg, _attempt, _source, destination, *_args, **_kwargs):
        destination.write_bytes(b"x" * 8_500)
        return destination

    def measure(_path):
        engine.cancel()
        raise EncodeCancelled("Encoding cancelled by user")

    monkeypatch.setattr("tuck.encoding.runner.find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(
        "tuck.encoding.runner.get_available_encoders", lambda: frozenset({"libx264"})
    )
    monkeypatch.setattr(engine, "_encode_single_pass", encode)
    monkeypatch.setattr(engine, "_measure_video_size", measure)
    with pytest.raises(EncodeCancelled):
        engine.encode(plan)
    assert output.read_bytes() == b"existing export"
    assert source.read_bytes() == b"source"
    assert set(tmp_path.iterdir()) == {source, output}


def test_cancellation_during_packet_measurement_closes_the_container(engine, monkeypatch):
    from types import SimpleNamespace

    class Container:
        streams = SimpleNamespace(video=[object()])
        duration = av.time_base
        closed = False

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.closed = True

        def demux(self, _stream):
            yield SimpleNamespace(size=100)
            engine.cancel()
            yield SimpleNamespace(size=100)

    container = Container()
    monkeypatch.setattr("tuck.encoding.runner.av.open", lambda _path: container)
    with pytest.raises(EncodeCancelled):
        engine._measure_video_size(Path("output.mp4"))
    assert container.closed


@pytest.mark.parametrize("duration", [None, 0, -1])
def test_unknown_output_duration_uses_fallback_correction(engine, monkeypatch, duration):
    from types import SimpleNamespace

    class Container:
        streams = SimpleNamespace(video=[object()])

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    container = Container()
    container.duration = duration
    monkeypatch.setattr("tuck.encoding.runner.av.open", lambda _path: container)
    assert engine._measure_video_size(Path("output.mp4")) is None
