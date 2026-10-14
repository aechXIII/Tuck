from __future__ import annotations

import subprocess
import sys
import threading
from dataclasses import replace
from fractions import Fraction
from io import BytesIO
from pathlib import Path

import av
import numpy as np
import pytest

from tuck.encoding import frame_blending
from tuck.encoding.command import build_base_cmd
from tuck.models import ENCODER_AUTO_COMPRESSION, EncodePlan, FrameBlending, VideoInfo
from tuck.models.encoding_policy import RCM_CRF, WORKFLOW_UPSCALE


def blend_plan(tmp_path: Path) -> EncodePlan:
    source = tmp_path / "source.mkv"
    return EncodePlan(
        source=str(source),
        output=str(tmp_path / "output.mp4"),
        source_info=VideoInfo(
            path=str(source),
            duration=1,
            width=64,
            height=48,
            fps=12,
            video_codec="h264",
            pixel_format="yuv420p",
            has_audio=True,
            color_space="bt709",
            color_range="tv",
            color_transfer="bt709",
        ),
        target_width=64,
        target_height=48,
        target_fps=4,
        workflow=WORKFLOW_UPSCALE,
        rate_control_method=RCM_CRF,
        two_pass=False,
        preset="ultrafast",
        crf=0,
        audio_bitrate=128000,
        frame_blending=FrameBlending(enabled=True, curve="gaussian"),
    )


def test_prepared_video_wraps_the_original_rgb_buffer(tmp_path, monkeypatch):
    original_frame = av.VideoFrame
    pictures = [
        np.random.default_rng(i).integers(0, 256, (24, 37, 3), dtype=np.uint8) for i in range(4)
    ]
    wrapped = []

    class BufferFrames:
        @staticmethod
        def from_numpy_buffer(pixels, format):
            frame = original_frame.from_numpy_buffer(pixels, format=format)
            assert frame.planes[0].buffer_ptr == pixels.ctypes.data
            wrapped.append(frame)
            return frame

        @staticmethod
        def from_ndarray(*args, **kwargs):
            pytest.fail("the writer copied an already contiguous RGB frame")

    monkeypatch.setattr(av, "VideoFrame", BufferFrames)
    monkeypatch.setattr(frame_blending, "blended_frames", lambda *_: iter(pictures))
    plan = blend_plan(tmp_path)
    plan.source_info = replace(plan.source_info, width=37, height=24)
    output = tmp_path / "prepared.nut"
    frame_blending.prepare_blended_video(plan, output, lambda: None, lambda *_: None)
    assert len(wrapped) == 4
    with av.open(str(output)) as container:
        decoded = [frame.to_ndarray(format="rgb24") for frame in container.decode(video=0)]
    for expected, actual in zip(pictures, decoded, strict=True):
        np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize(
    "change",
    [
        {"two_pass": True},
        {"workflow": "compression"},
        {"rate_control_method": "cbr"},
        {"source_info": None},
        {"target_fps": 0},
        {"video_encoder": ENCODER_AUTO_COMPRESSION},
    ],
)
def test_streaming_is_reserved_for_single_pass_quality_exports(tmp_path, change):
    from tuck.encoding.frame_stream import can_stream_blend

    plan = blend_plan(tmp_path)
    assert can_stream_blend(plan)
    assert not can_stream_blend(replace(plan, **change))


def test_stream_command_preserves_the_prepared_video_color_and_audio_graph(tmp_path):
    plan = blend_plan(tmp_path)
    prepared = build_base_cmd("ffmpeg", plan, Path(plan.source), prepared_video=tmp_path / "v.nut")
    streamed = build_base_cmd("ffmpeg", plan, Path(plan.source), streamed_video=True)
    assert (
        prepared[prepared.index("-filter_complex") + 1]
        == streamed[streamed.index("-filter_complex") + 1]
    )
    assert streamed[streamed.index("-f") + 1] == "nut"
    assert streamed[streamed.index("pipe:0") - 1] == "-i"
    assert streamed.count("-i") == 2


def test_stream_command_rejects_two_simultaneous_blended_inputs(tmp_path):
    plan = blend_plan(tmp_path)
    with pytest.raises(ValueError, match="one blended video"):
        build_base_cmd(
            "ffmpeg",
            plan,
            Path(plan.source),
            prepared_video=tmp_path / "v.nut",
            streamed_video=True,
        )


@pytest.mark.parametrize("width", [1, 37, 64])
def test_frame_stream_handles_short_writes_and_closes_the_input(tmp_path, monkeypatch, width):
    from tuck.encoding import frame_stream

    pictures = [
        np.random.default_rng(i).integers(0, 256, (48, width, 3), dtype=np.uint8) for i in range(3)
    ]
    monkeypatch.setattr(frame_stream, "blended_frames", lambda *_: (p for p in pictures))
    data = bytearray()
    closed = []

    class ShortPipe:
        def write(self, chunk):
            size = min(7, len(chunk))
            data.extend(chunk[:size])
            return size

        def close(self):
            closed.append(True)

    plan = blend_plan(tmp_path)
    plan.source_info = replace(plan.source_info, width=width)
    plan.target_fps = 30000 / 1001
    stream = frame_stream.FrameStream(plan, lambda: None, lambda: pytest.fail("aborted"))
    stream.start(ShortPipe())
    stream.join()
    assert stream.error is None
    with av.open(BytesIO(data)) as container:
        assert container.streams.video[0].codec_context.format.name == "rgb24"
        sizes = [packet.size for packet in container.demux(video=0) if packet.size]
        assert sizes == [48 * width * 3] * len(pictures)
    with av.open(BytesIO(data)) as container:
        frames = list(container.decode(video=0))
    assert [frame.pts * frame.time_base for frame in frames] == [
        index * Fraction(1001, 30000) for index in range(len(pictures))
    ]
    decoded = [frame.to_ndarray(format="rgb24") for frame in frames]
    for expected, actual in zip(pictures, decoded, strict=True):
        np.testing.assert_array_equal(actual, expected)
    assert closed == [True]


def test_frame_stream_reports_a_decoder_error_and_aborts_the_consumer(tmp_path, monkeypatch):
    from tuck.encoding import frame_stream

    failure = ValueError("source changed format")
    closed = []
    aborted = threading.Event()

    def pictures(*_):
        raise failure
        yield

    class Pipe:
        def close(self):
            closed.append(True)

    monkeypatch.setattr(frame_stream, "blended_frames", pictures)
    stream = frame_stream.FrameStream(blend_plan(tmp_path), lambda: None, aborted.set)
    stream.start(Pipe())
    stream.join()
    assert stream.error is failure
    assert aborted.is_set()
    assert closed == [True]


def test_muxer_shutdown_cannot_hide_an_earlier_source_error(tmp_path, monkeypatch):
    from tuck.encoding import frame_stream

    failure = ValueError("source decode failed")
    aborted = threading.Event()

    def pictures(*_):
        yield np.zeros((48, 64, 3), dtype=np.uint8)
        raise failure

    class FakeStream:
        codec_context = type("Context", (), {})()

        def encode(self, frame=None):
            return ()

    class Output:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            raise BrokenPipeError("consumer already exited")

        def add_stream(self, *args, **kwargs):
            return FakeStream()

    class Pipe:
        def close(self):
            pass

    monkeypatch.setattr(frame_stream, "blended_frames", pictures)
    monkeypatch.setattr(frame_stream.av, "open", lambda *args, **kwargs: Output())
    monkeypatch.setattr(frame_stream, "VideoStream", FakeStream)
    stream = frame_stream.FrameStream(blend_plan(tmp_path), lambda: None, aborted.set)
    stream.start(Pipe())
    stream.join()
    assert stream.error is failure
    assert aborted.is_set()


def test_stopping_stream_closes_the_source_generator(tmp_path, monkeypatch):
    from tuck.encoding import frame_stream

    entered = threading.Event()
    release = threading.Event()
    closed = threading.Event()

    def pictures(plan, check_cancel):
        try:
            while True:
                check_cancel()
                yield np.zeros((48, 64, 3), dtype=np.uint8)
        finally:
            closed.set()

    class Pipe:
        def write(self, data):
            entered.set()
            assert release.wait(5)
            return len(data)

        def close(self):
            pass

    monkeypatch.setattr(frame_stream, "blended_frames", pictures)
    stream = frame_stream.FrameStream(blend_plan(tmp_path), lambda: None, lambda: None)
    stream.start(Pipe())
    assert entered.wait(5)
    stream.stop()
    release.set()
    stream.join()
    assert closed.is_set()
    assert stream.error is None


def test_consumer_pipe_eof_stops_the_producer_without_an_abort(tmp_path, monkeypatch):
    from tuck.encoding import frame_stream

    closed = threading.Event()

    def pictures(*_):
        try:
            for _ in range(20):
                yield np.zeros((48, 64, 3), dtype=np.uint8)
        finally:
            closed.set()

    class Pipe:
        def write(self, data):
            raise BrokenPipeError("encoder finished its duration")

        def close(self):
            pass

    monkeypatch.setattr(frame_stream, "blended_frames", pictures)
    stream = frame_stream.FrameStream(
        blend_plan(tmp_path), lambda: None, lambda: pytest.fail("aborted")
    )
    stream.start(Pipe())
    stream.join()
    assert stream.error is None
    assert closed.is_set()


@pytest.fixture
def stream_source(tmp_path, skip_if_no_ffmpeg):
    from tuck.media_tools import find_ffmpeg
    from tuck.probe import probe

    plan = blend_plan(tmp_path)
    plan.source = str(tmp_path / "source.mp4")
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x48:rate=12:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
            "-c:v",
            "libx264",
            "-crf",
            "0",
            "-vf",
            "setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_primaries",
            "bt709",
            "-c:a",
            "aac",
            plan.source,
        ],
        capture_output=True,
        check=True,
    )
    plan.source_info = probe(plan.source)
    return plan


@pytest.mark.ffmpeg
def test_quality_blending_exports_without_preparing_a_video(stream_source, monkeypatch):
    from tuck.encoding import runner

    monkeypatch.setattr(
        runner, "prepare_blended_video", lambda *_: pytest.fail("prepared an intermediate")
    )
    output = runner.FFmpegEngine().encode(stream_source, lambda _: None)
    with av.open(str(output)) as container:
        assert len(list(container.decode(video=0))) == 4
        assert len(container.streams.audio) == 1


def output_identity(path):
    import hashlib

    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        video = [
            (
                frame.pts * frame.time_base,
                hashlib.sha256(frame.to_ndarray(format="rgb24")).hexdigest(),
            )
            for frame in container.decode(stream)
        ]
        color = (
            stream.codec_context.color_range,
            stream.codec_context.colorspace,
            stream.codec_context.color_trc,
            stream.codec_context.color_primaries,
        )
    with av.open(str(path)) as container:
        audio = [
            (packet.pts, packet.dts, packet.duration, str(packet.time_base), bytes(packet))
            for packet in container.demux(audio=0)
            if packet.size
        ]
    return video, audio, color


@pytest.mark.ffmpeg
@pytest.mark.parametrize(
    "curve", ["gaussian", "triangular", "ascending", "descending", "vegas", "custom"]
)
@pytest.mark.parametrize("linear_light", [False, True])
def test_streamed_export_matches_the_existing_rgb_pipeline(
    stream_source, tmp_path, monkeypatch, curve, linear_light
):
    from tuck.encoding import native_blending, runner

    plan = stream_source
    plan.frame_blending = FrameBlending(
        enabled=True,
        curve="equal" if curve == "custom" else curve,
        linear_light=linear_light,
        sigma=0.19,
        peak=0.27,
        power=2.3,
        custom_weights=(0, 3, 0.1, 7, 0) if curve == "custom" else (),
    )
    plan.output = str(tmp_path / "streamed.mp4")
    streamed = runner.FFmpegEngine().encode(plan)
    monkeypatch.setattr(runner, "can_stream_blend", lambda _: False)
    monkeypatch.setattr(native_blending, "blend_encoded", lambda *_: None)
    monkeypatch.setattr(native_blending, "accumulate_linear", lambda *_: None)
    plan.output = str(tmp_path / "reference.mp4")
    reference = runner.FFmpegEngine().encode(plan)
    assert output_identity(streamed) == output_identity(reference)


@pytest.mark.ffmpeg
def test_streamed_export_preserves_fractional_clock_cuts_and_imported_audio(
    stream_source, tmp_path, monkeypatch
):
    from tuck.encoding import runner
    from tuck.models import AudioClip, AudioTrack, Segment

    plan = stream_source
    plan.target_fps = 30000 / 1001
    plan.segments = [Segment(0.09, 0.43), Segment(0.6, 0.93)]
    plan.audio_tracks = [
        AudioTrack("music", "Music", [AudioClip(plan.source, 0, 0, 0.4, 0.4, gain_db=-3)])
    ]
    plan.output = str(tmp_path / "streamed.mp4")
    streamed = runner.FFmpegEngine().encode(plan)
    monkeypatch.setattr(runner, "can_stream_blend", lambda _: False)
    plan.output = str(tmp_path / "reference.mp4")
    reference = runner.FFmpegEngine().encode(plan)
    assert output_identity(streamed) == output_identity(reference)


@pytest.mark.ffmpeg
@pytest.mark.parametrize("matrix", ["bt709", "smpte170m"])
@pytest.mark.parametrize("full_range", [False, True])
@pytest.mark.parametrize("linear_light", [False, True])
def test_rgb24_stream_matches_prepared_export_for_source_color_ranges(
    stream_source, tmp_path, monkeypatch, matrix, full_range, linear_light
):
    from tuck.encoding import runner
    from tuck.media_tools import find_ffmpeg
    from tuck.probe import probe

    plan = stream_source
    source = tmp_path / "color-source.mkv"
    range_name = "pc" if full_range else "tv"
    subprocess.run(
        [
            find_ffmpeg(),
            "-v",
            "error",
            "-i",
            plan.source,
            "-vf",
            f"scale=out_color_matrix={matrix}:out_range={range_name}",
            "-c:v",
            "ffv1",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            matrix,
            "-color_range",
            range_name,
            "-color_trc",
            "bt709",
            "-color_primaries",
            "bt709",
            "-c:a",
            "copy",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    plan.source = str(source)
    plan.source_info = probe(str(source))
    assert plan.source_info.color_space == matrix
    assert plan.source_info.color_range == range_name
    plan.frame_blending = FrameBlending(enabled=True, curve="gaussian", linear_light=linear_light)
    plan.output = str(tmp_path / "streamed.mp4")
    streamed = runner.FFmpegEngine().encode(plan)
    monkeypatch.setattr(runner, "can_stream_blend", lambda _: False)
    plan.output = str(tmp_path / "reference.mp4")
    reference = runner.FFmpegEngine().encode(plan)
    assert output_identity(streamed) == output_identity(reference)


@pytest.mark.ffmpeg
def test_cancellation_unblocks_a_stream_waiting_for_its_encoder(stream_source, monkeypatch):
    from tuck.encoding import runner

    plan = stream_source
    plan.target_fps = 240
    engine = runner.FFmpegEngine()
    spawn = engine._spawn_ffmpeg
    entered = threading.Event()
    failures = []

    def blocked_encoder(command, flags, **kwargs):
        child = (
            "import sys,threading;"
            "print('out_time_us=500000',file=sys.stderr,flush=True);"
            "print('progress=continue',file=sys.stderr,flush=True);"
            "threading.Event().wait(30)"
        )
        return spawn([sys.executable, "-c", child], flags, **kwargs)

    def progress(event):
        if event.current_time > 0:
            entered.set()

    def encode():
        try:
            engine.encode(plan, progress)
        except Exception as exc:
            failures.append(exc)

    monkeypatch.setattr(engine, "_spawn_ffmpeg", blocked_encoder)
    worker = threading.Thread(target=encode)
    worker.start()
    try:
        assert entered.wait(10), failures
        engine.cancel()
    finally:
        engine.cancel()
        worker.join(10)
    assert not worker.is_alive()
    assert len(failures) == 1 and isinstance(failures[0], runner.EncodeCancelled)
    assert engine._process is None and engine._stream_plan is None
    assert not Path(plan.output).exists()
    assert not list(Path(plan.output).parent.glob(".tuck-*"))


@pytest.mark.ffmpeg
@pytest.mark.parametrize("error_type", [ValueError, BrokenPipeError])
def test_decoder_error_aborts_the_encoder_and_preserves_the_error(
    stream_source, monkeypatch, error_type
):
    from tuck.encoding import frame_stream, runner

    failure = error_type("source changed color format")

    def broken_source(*args):
        yield np.zeros((48, 64, 3), dtype=np.uint8)
        raise failure

    monkeypatch.setattr(frame_stream, "blended_frames", broken_source)
    engine = runner.FFmpegEngine()
    with pytest.raises(error_type, match="source changed color format") as caught:
        engine.encode(stream_source)
    assert caught.value is failure
    assert engine._process is None and engine._stream_plan is None
    assert not Path(stream_source.output).exists()
    assert not list(Path(stream_source.output).parent.glob(".tuck-*"))


@pytest.mark.ffmpeg
@pytest.mark.skipif(sys.platform != "win32", reason="hardware encoder fallback is Windows-only")
def test_encoder_fallback_restarts_the_blended_frame_stream(stream_source, monkeypatch):
    from tuck.encoding import runner
    from tuck.models import ENCODER_AUTO_FAST

    plan = stream_source
    plan.video_encoder = ENCODER_AUTO_FAST
    engine = runner.FFmpegEngine()
    spawn = engine._spawn_ffmpeg
    attempts = []
    producers = []
    stream_type = runner.FrameStream

    class RecordingStream(stream_type):
        def __init__(self, *args):
            super().__init__(*args)
            producers.append(self)

    def failed_hardware(command, flags, **kwargs):
        encoder = command[command.index("-c:v") + 1]
        attempts.append(encoder)
        if encoder == "h264_nvenc":
            child = "import sys;print('No NVENC capable devices found',file=sys.stderr);sys.exit(1)"
            return spawn([sys.executable, "-c", child], flags, **kwargs)
        return spawn(command, flags, **kwargs)

    monkeypatch.setattr(runner, "FrameStream", RecordingStream)
    monkeypatch.setattr(
        runner, "get_available_encoders", lambda: frozenset({"h264_nvenc", "libx264"})
    )
    monkeypatch.setattr(engine, "_spawn_ffmpeg", failed_hardware)
    output = engine.encode(plan)
    assert attempts == ["h264_nvenc", "libx264"]
    assert len(producers) == 2 and producers[0] is not producers[1]
    assert all(producer.error is None for producer in producers)
    assert engine.resolved_encoder == "libx264"
    with av.open(str(output)) as container:
        assert len(list(container.decode(video=0))) == 4
    assert engine._process is None and engine._stream_plan is None
