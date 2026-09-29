from __future__ import annotations

import math

import pytest

from tuck.models.frame_blending import FrameBlending, interval_weight


@pytest.mark.parametrize(
    "raw",
    [
        {"amount": math.nan},
        {"amount": math.inf},
        {"amount": -1},
        {"amount": 5},
        {"enabled": 1},
        {"linear_light": "yes"},
        {"curve": "motion"},
        {"custom_weights": [0, 0]},
        {"custom_weights": [-1, 2]},
        {"custom_weights": [1] * 65},
        {"custom_weights": [True]},
        {"sigma": 0},
        {"peak": 1},
        {"power": math.inf},
        {"surprise": 1},
    ],
)
def test_reject_invalid_settings(raw):
    with pytest.raises(ValueError):
        FrameBlending.from_dict(raw)


@pytest.mark.parametrize("curve", ["equal", "gaussian", "triangular", "ascending", "descending"])
def test_curve_normalization_and_additivity(curve):
    settings = FrameBlending(curve=curve)
    pieces = [interval_weight(settings, i / 8, (i + 1) / 8) for i in range(8)]
    assert all(w >= 0 for w in pieces)
    assert sum(pieces) == pytest.approx(interval_weight(settings, 0, 1))
    assert sum(pieces) > 0


def test_weight_direction_and_custom_temporal_bins():
    up = FrameBlending(curve="ascending")
    down = FrameBlending(curve="descending")
    assert interval_weight(up, 0, 0.5) < interval_weight(up, 0.5, 1)
    assert interval_weight(down, 0, 0.5) > interval_weight(down, 0.5, 1)
    custom = FrameBlending(custom_weights=(1, 3))
    assert interval_weight(custom, 0, 0.5) == pytest.approx(0.5)
    assert interval_weight(custom, 0.5, 1) == pytest.approx(1.5)


def test_profiles_and_plans_default_disabled_and_round_trip():
    from tuck.models import EncodePlan, Profile

    assert not Profile.from_dict(
        {"name": "Old profile", "profile_id": "old", "target_size_bytes": 10485760}
    ).frame_blending.enabled
    assert not EncodePlan.from_dict(
        {"source": "in.mp4", "output": "out.mp4"}
    ).frame_blending.enabled
    settings = FrameBlending(enabled=True, curve="gaussian", linear_light=True)
    profile = Profile(name="Blend", frame_blending=settings)
    assert Profile.from_dict(profile.to_dict()).frame_blending == settings
    plan = EncodePlan(source="in.mp4", output="out.mp4", frame_blending=settings)
    assert EncodePlan.from_dict(plan.to_dict()).frame_blending == settings


def test_linear_transfer_known_black_white_result():
    import numpy as np

    from tuck.encoding.frame_blending import from_linear, to_linear

    samples = np.array([0, 1], dtype=np.float32)
    average = to_linear(samples, "iec61966-2-1").mean()
    assert float(from_linear(average, "iec61966-2-1")) == pytest.approx(0.735357, abs=1e-5)
    assert float(from_linear(to_linear(np.float32(0.4), "bt709"), "bt709")) == pytest.approx(0.4)


def test_unsupported_color_is_explicit():
    from tuck.encoding.frame_blending import validate_blending_source
    from tuck.models import VideoInfo

    info = VideoInfo(
        "in.mp4", 1, 16, 16, 60, "h264", pixel_format="yuv420p", color_transfer="smpte2084"
    )
    with pytest.raises(ValueError, match="SDR"):
        validate_blending_source(FrameBlending(enabled=True), info, 30)
    info.color_transfer = "unknown"
    with pytest.raises(ValueError, match="missing color information"):
        validate_blending_source(FrameBlending(enabled=True, linear_light=True), info, 30)


@pytest.fixture
def timestamped_source(tmp_path):
    import shutil
    import subprocess

    import numpy as np

    from tuck.probe import probe

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("FFmpeg is unavailable")
    path = tmp_path / "source.mkv"
    pixels = np.repeat(np.array([0, 255, 0, 255, 0, 255, 0, 255], dtype=np.uint8), 16 * 16 * 3)
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            "16x16",
            "-framerate",
            "8",
            "-i",
            "pipe:0",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
            "-vf",
            "setparams=color_trc=iec61966-2-1:color_primaries=bt709",
            "-c:v",
            "libx264rgb",
            "-crf",
            "0",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "rgb24",
            "-color_trc",
            "iec61966-2-1",
            "-c:a",
            "pcm_s16le",
            "-shortest",
            str(path),
        ],
        input=pixels.tobytes(),
        check=True,
        capture_output=True,
    )
    return path, probe(path)


def make_blend_plan(source, info, **kwargs):
    from tuck.models import EncodePlan, Segment

    return EncodePlan(
        source=str(source),
        output=str(source.with_name("out.mp4")),
        source_info=info,
        target_fps=4,
        segments=[Segment(0, 1)],
        frame_blending=FrameBlending(enabled=True, **kwargs),
    )


@pytest.mark.ffmpeg
def test_actual_frame_contributions_and_linear_light(timestamped_source):
    from tuck.encoding.frame_blending import blended_frames

    source, info = timestamped_source
    for linear, expected in [(False, 128), (True, 188)]:
        frames = list(
            blended_frames(make_blend_plan(source, info, linear_light=linear), lambda: None)
        )
        assert len(frames) == 4
        assert [float(f.mean()) for f in frames] == pytest.approx([expected] * 4, abs=1)


@pytest.mark.ffmpeg
def test_cut_boundaries_and_zero_amount(timestamped_source):
    from tuck.encoding.frame_blending import blended_frames
    from tuck.models import Segment

    source, info = timestamped_source
    plan = make_blend_plan(source, info, amount=4)
    plan.segments = [Segment(0, 0.125), Segment(0.375, 0.5)]
    plan.target_fps = 8
    frames = list(blended_frames(plan, lambda: None))
    assert [float(f.mean()) for f in frames] == pytest.approx([0, 255])
    plan = make_blend_plan(source, info, amount=0)
    assert [float(f.mean()) for f in blended_frames(plan, lambda: None)] == [255] * 4


@pytest.mark.ffmpeg
def test_prepared_video_preserves_fractional_fps(timestamped_source, tmp_path):
    import av

    from tuck.encoding.frame_blending import prepare_blended_video

    source, info = timestamped_source
    plan = make_blend_plan(source, info)
    plan.target_fps = 30000 / 1001
    path = tmp_path / "prepared.nut"
    prepare_blended_video(plan, path, lambda: None, lambda _: None)
    with av.open(str(path)) as container:
        frames = list(container.decode(video=0))
        assert len(frames) == 30
        assert float(frames[1].time - frames[0].time) == pytest.approx(1001 / 30000)
        assert frames[-1].time < 1


def test_prepared_video_command_keeps_audio_timeline(timestamped_source, tmp_path):
    from tuck.encoding.command import build_base_cmd
    from tuck.models import Segment

    source, info = timestamped_source
    plan = make_blend_plan(source, info)
    plan.audio_bitrate = 128000
    plan.segments = [Segment(0, 0.25), Segment(0.5, 1)]
    cmd = build_base_cmd("ffmpeg", plan, source, prepared_video=tmp_path / "blend.nut")
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "[1:v]" in graph
    assert "[0:v]" not in graph
    assert "atrim=start=0.500:end=1.000" in graph
    assert "fps=" not in graph


@pytest.mark.ffmpeg
@pytest.mark.parametrize("two_pass", [False, True])
def test_full_encode_audio_duration_and_pixels(timestamped_source, two_pass, monkeypatch):
    import av

    from tuck.encoding.runner import FFmpegEngine
    from tuck.models import Segment

    source, info = timestamped_source
    plan = make_blend_plan(source, info, linear_light=True)
    plan.segments = [Segment(0, 0.25), Segment(0.5, 1)]
    plan.audio_bitrate = 128000
    plan.video_bitrate = 100000
    plan.target_size = 2 * 1024 * 1024
    plan.two_pass = two_pass
    plan.preset = "ultrafast"
    import hashlib

    from tuck.encoding import runner

    commands = []
    original = runner.build_base_cmd

    def capture(*args, **kwargs):
        prepared = kwargs["prepared_video"]
        commands.append((prepared, hashlib.sha256(prepared.read_bytes()).hexdigest()))
        return original(*args, **kwargs)

    monkeypatch.setattr(runner, "build_base_cmd", capture)
    # this tiny clip cannot use its bitrate, which now ends the encode after one attempt;
    # keep the undershoot retry so its reuse of the blended video is still checked
    monkeypatch.setattr(runner.FFmpegEngine, "_left_bitrate_unused", staticmethod(lambda *_: False))
    progress = []
    prepare = runner.prepare_blended_video

    def capture_preparation(*args):
        assert progress[-1].status_text() == "Blending frames (0%)"
        assert progress[-1].current_time == 0
        return prepare(*args)

    monkeypatch.setattr(runner, "prepare_blended_video", capture_preparation)
    result = FFmpegEngine().encode(plan, progress.append)
    blending = [event for event in progress if event.message.startswith("Blending frames")]
    assert blending[-1].status_text() == "Blending frames (100%)"
    assert blending[-1].current_time == blending[-1].duration == plan.effective_duration
    assert all(event.percent == 0 for event in blending)
    assert [event.current_time for event in blending] == sorted(
        event.current_time for event in blending
    )
    last_blending = progress.index(blending[-1])
    assert progress[last_blending + 1].stage.value in {"encoding", "pass_1"}
    assert all(event.stage.value != "preparing" for event in progress[last_blending + 1 :])
    assert progress[-1].percent == 100
    assert len(commands) >= 2
    assert len(set(commands)) == 1
    with av.open(str(result)) as container:
        video, audio = container.streams.video[0], container.streams.audio[0]
        assert float(video.average_rate) == pytest.approx(4)
        assert float(video.duration * video.time_base) == pytest.approx(0.75, abs=0.01)
        assert float(audio.duration * audio.time_base) == pytest.approx(0.75, abs=0.03)
        assert (
            abs(
                float(video.start_time * video.time_base)
                - float(audio.start_time * audio.time_base)
            )
            < 0.03
        )
        frames = list(container.decode(video=0))
        assert len(frames) == 3
        assert float(frames[0].to_ndarray(format="rgb24").mean()) == pytest.approx(188, abs=5)
    assert not list(source.parent.glob(".tuck-*"))
    assert not list(source.parent.glob("*.lock"))


@pytest.mark.ffmpeg
def test_cancel_preparation_cleans_up(timestamped_source):
    from tuck.encoding.runner import EncodeCancelled, FFmpegEngine

    source, info = timestamped_source
    engine = FFmpegEngine()

    def progress(value):
        if "Blending" in value.message:
            engine.cancel()

    with pytest.raises(EncodeCancelled):
        engine.encode(make_blend_plan(source, info), progress)
    assert not source.with_name("out.mp4").exists()
    assert not list(source.parent.glob(".tuck-*"))


@pytest.mark.ffmpeg
def test_request_profile_and_budget_propagation(timestamped_source):
    from tuck.bridge_validation import parse_plan_request
    from tuck.models import Profile
    from tuck.planner import plan

    source, info = timestamped_source
    settings = {"enabled": True, "curve": "descending", "amount": 2}
    request = parse_plan_request({"source": str(source), "frame_blending": settings}, str)
    profile = Profile(name="Test")
    baseline = plan(source, profile, source_info=info)
    blended = plan(source, profile, source_info=info, request=request)
    assert blended.frame_blending == FrameBlending.from_dict(settings)
    assert blended.video_bitrate == baseline.video_bitrate
    assert blended.audio_bitrate == baseline.audio_bitrate
    assert blended.target_size == baseline.target_size
    profile.frame_blending = request.frame_blending
    assert plan(source, profile, source_info=info).frame_blending.enabled


@pytest.mark.ffmpeg
def test_variable_frame_timestamps_determine_contributions(tmp_path):
    from fractions import Fraction

    import av
    import numpy as np

    from tuck.encoding.frame_blending import blended_frames
    from tuck.probe import probe

    path = tmp_path / "vfr.mkv"
    with av.open(str(path), "w") as output:
        stream = output.add_stream("ffv1", rate=10)
        stream.width = stream.height = 16
        stream.pix_fmt = "bgr0"
        stream.time_base = Fraction(1, 1000)
        stream.codec_context.time_base = Fraction(1, 1000)
        for pts, level in [(0, 0), (100, 255), (400, 0), (800, 255)]:
            frame = av.VideoFrame.from_ndarray(
                np.full((16, 16, 3), level, dtype=np.uint8), format="rgb24"
            )
            frame.pts, frame.time_base = pts, Fraction(1, 1000)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    info = probe(path)
    assert info.duration == pytest.approx(0.9, abs=0.002)
    plan = make_blend_plan(path, info)
    from tuck.models import Segment

    plan.segments = [Segment(0, 0.9)]
    plan.target_fps = 2
    frames = list(blended_frames(plan, lambda: None))
    assert [float(frame.mean()) for frame in frames] == pytest.approx([153, 64], abs=1)


@pytest.mark.ffmpeg
@pytest.mark.parametrize("rotation", [90, 180, 270])
def test_display_rotation_matches_ffmpeg(skip_if_no_ffmpeg, tmp_path, rotation):
    import subprocess

    import numpy as np

    from tuck.encoding.frame_blending import _source_frames
    from tuck.media_tools import find_ffmpeg
    from tuck.probe import probe

    ffmpeg = find_ffmpeg()
    assert ffmpeg is not None

    source = tmp_path / "pattern.mp4"
    rotated = tmp_path / "rotated.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=32x16:rate=1:duration=1",
            "-c:v",
            "libx264rgb",
            "-crf",
            "0",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    tagged = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-display_rotation",
            str(rotation),
            "-i",
            str(source),
            "-c",
            "copy",
            str(rotated),
        ],
        capture_output=True,
    )
    if tagged.returncode != 0:
        assert b"Unrecognized option 'display_rotation'" in tagged.stderr, tagged.stderr.decode()
        subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-i",
                str(source),
                "-c",
                "copy",
                "-metadata:s:v:0",
                f"rotate={rotation}",
                str(rotated),
            ],
            check=True,
            capture_output=True,
        )
    info = probe(rotated)
    assert info.display_rotation == rotation
    expected = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(rotated),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    decoded = list(_source_frames(rotated, info, lambda: None))
    actual = decoded[0][1]
    assert np.array_equal(actual.ravel(), np.frombuffer(expected, dtype=np.uint8))


@pytest.mark.ffmpeg
def test_memory_and_disk_limits_are_actionable(timestamped_source, tmp_path, monkeypatch):
    import tuck.encoding.frame_blending as blending

    source, info = timestamped_source
    plan = make_blend_plan(source, info)
    monkeypatch.setattr(blending, "MAX_BUFFER_BYTES", 1)
    with pytest.raises(ValueError, match="memory limit"):
        list(blending.blended_frames(plan, lambda: None))
    monkeypatch.setattr(blending, "MAX_BUFFER_BYTES", 256 * 1024**2)
    monkeypatch.setattr(blending, "MAX_TEMP_BYTES", -1)
    with pytest.raises(ValueError, match="16 GiB"):
        blending.prepare_blended_video(plan, tmp_path / "limited.nut", lambda: None, lambda _: None)


@pytest.mark.ffmpeg
@pytest.mark.parametrize("matrix", ["bt709", "smpte170m"])
@pytest.mark.parametrize("full_range", [False, True])
def test_yuv_color_conversion_matches_ffmpeg(tmp_path, matrix, full_range):
    import subprocess

    import numpy as np

    from tuck.encoding.frame_blending import _source_frames
    from tuck.probe import probe

    source = tmp_path / "color.mkv"
    data = bytes([81] * 256 + [90] * 64 + [240] * 64)
    range_name = "full" if full_range else "limited"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "-s",
            "16x16",
            "-r",
            "1",
            "-i",
            "pipe:0",
            "-vf",
            f"setparams=colorspace={matrix}:range={range_name}",
            "-c:v",
            "ffv1",
            "-color_range",
            "pc" if full_range else "tv",
            str(source),
        ],
        input=data,
        check=True,
        capture_output=True,
    )
    expected = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            f"scale=in_color_matrix={matrix}:in_range={'pc' if full_range else 'tv'}:out_range=pc",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    info = probe(source)
    assert info.color_range == ("pc" if full_range else "tv")
    frames = list(_source_frames(source, info, lambda: None))
    assert np.array_equal(frames[0][1].ravel(), np.frombuffer(expected, dtype=np.uint8))

    from tuck.encoding.runner import FFmpegEngine

    plan = make_blend_plan(source, info)
    plan.workflow = "upscale"
    plan.rate_control_method = "crf"
    plan.crf = 0
    plan.two_pass = False
    plan.target_width = plan.target_height = 32
    plan.apply_scale = True
    plan.target_fps = 1
    plan.preset = "ultrafast"
    result = FFmpegEngine().encode(plan)
    encoded = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(result),
            "-vf",
            f"scale=in_color_matrix={matrix}:out_range=pc",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    encoded_rgb = np.frombuffer(encoded, dtype=np.uint8).reshape(-1, 3).mean(axis=0)
    expected_rgb = np.frombuffer(expected, dtype=np.uint8).reshape(-1, 3).mean(axis=0)
    assert encoded_rgb == pytest.approx(expected_rgb, abs=3)


@pytest.mark.ffmpeg
def test_non_square_pixels_survive_encoding(timestamped_source):
    import av

    from tuck.encoding.runner import FFmpegEngine

    source, info = timestamped_source
    info.sample_aspect_ratio = "2:1"
    plan = make_blend_plan(source, info)
    plan.target_size = 2 * 1024**2
    plan.video_bitrate = 100000
    plan.two_pass = False
    plan.preset = "ultrafast"
    result = FFmpegEngine().encode(plan)
    with av.open(str(result)) as container:
        assert container.streams.video[0].sample_aspect_ratio == 2


@pytest.mark.ffmpeg
@pytest.mark.parametrize("independent", [False, True])
def test_delayed_source_audio_stays_aligned(timestamped_source, tmp_path, independent):
    import subprocess

    import numpy as np

    from tuck.encoding.runner import FFmpegEngine
    from tuck.models import Segment
    from tuck.probe import probe

    original, _ = timestamped_source
    source = tmp_path / "delayed.mkv"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(original),
            "-itsoffset",
            "0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.75:sample_rate=48000",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "copy",
            "-c:a",
            "pcm_s16le",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    plan = make_blend_plan(source, probe(source))
    plan.audio_bitrate = 128000
    plan.video_bitrate = 100000
    plan.target_size = 2 * 1024**2
    plan.two_pass = False
    plan.preset = "ultrafast"
    if independent:
        plan.source_audio_segments = [Segment(0.1, 0.9)]
    result = FFmpegEngine().encode(plan)
    decoded = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(result),
            "-map",
            "0:a",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    samples = np.frombuffer(decoded, dtype=np.int16)
    assert np.max(np.abs(samples[4800:9600])) < 30
    assert np.max(np.abs(samples[16800:19200])) > 1000


@pytest.mark.ffmpeg
def test_upscale_uses_blending_with_existing_quality_control(timestamped_source):
    import av

    from tuck.encoding.runner import FFmpegEngine

    source, info = timestamped_source
    plan = make_blend_plan(source, info)
    plan.workflow = "upscale"
    plan.rate_control_method = "crf"
    plan.crf = 18
    plan.two_pass = False
    plan.target_width = plan.target_height = 32
    plan.apply_scale = True
    plan.preset = "ultrafast"
    result = FFmpegEngine().encode(plan)
    with av.open(str(result)) as container:
        stream = container.streams.video[0]
        assert (stream.width, stream.height) == (32, 32)
        frames = list(container.decode(video=0))
        assert len(frames) == 4
        assert float(frames[0].to_ndarray(format="rgb24").mean()) == pytest.approx(128, abs=5)


def test_cancel_before_preparation_releases_reservation(timestamped_source):
    from tuck.encoding.runner import EncodeCancelled, FFmpegEngine

    source, info = timestamped_source
    engine = FFmpegEngine()
    engine.cancel()
    with pytest.raises(EncodeCancelled):
        engine.encode(make_blend_plan(source, info))
    assert not list(source.parent.glob("*.lock"))
    assert not list(source.parent.glob(".tuck-*"))


def test_profile_settings_survive_save_reload_and_partial_edit(tmp_path, monkeypatch):
    import tuck.settings as settings
    from tuck.bridge import BridgeAPI
    from tuck.models import Profile

    monkeypatch.setattr(settings, "_settings_manager", None)
    for name in ("_config_dir", "_data_dir", "_cache_dir"):
        monkeypatch.setattr(settings, name, lambda: tmp_path)
    api = BridgeAPI()
    api._settings.load()
    profile = Profile(name="Blend", profile_id="blend")
    api._settings.set_profiles([profile])
    payload = {"enabled": True, "amount": 1.23, "curve": "gaussian", "sigma": 0.27}
    assert api.update_profile("blend", {"frame_blending": payload})["ok"]
    assert api.update_profile("blend", {"name": "Renamed", "custom_fps": 29.97})["ok"]
    reloaded = BridgeAPI()
    actual = reloaded._settings.get_profiles()[0]
    assert actual.frame_blending == FrameBlending.from_dict(payload)
    assert actual.custom_fps == 29.97
    assert actual.name == "Renamed"


@pytest.mark.ffmpeg
def test_temporary_size_limit_includes_flushed_packets(timestamped_source, tmp_path, monkeypatch):
    from tuck.encoding import frame_blending as blending

    source, info = timestamped_source
    plan = make_blend_plan(source, info)
    plan.target_fps = 1
    monkeypatch.setattr(blending, "MAX_TEMP_BYTES", 0)
    with pytest.raises(ValueError, match="16 GiB"):
        blending.prepare_blended_video(plan, tmp_path / "flushed.nut", lambda: None, lambda _: None)


def test_vegas_weights_and_timestamp_integrals():
    from tuck.models.frame_blending import vegas_weights

    assert vegas_weights(240, 60, 1) == (1, 2, 2, 2, 1)
    assert vegas_weights(900, 60, 1) == (1,) * 15
    assert vegas_weights(60, 60, 0) == (1,)
    weights = vegas_weights(240, 60, 1)
    settings = FrameBlending(curve="vegas")
    contributions = [interval_weight(settings, i / 4, (i + 1) / 4, vegas=weights) for i in range(4)]
    assert contributions == pytest.approx([0.3, 0.5, 0.5, 0.3])
    assert sum(contributions) == pytest.approx(interval_weight(settings, 0, 1, vegas=weights))
    assert FrameBlending.from_dict(settings.to_dict()) == settings
    with pytest.raises(ValueError, match="too large"):
        vegas_weights(900, 0.1, 4)
    with pytest.raises(ValueError, match="finite"):
        vegas_weights(math.inf, 60, 1)


@pytest.mark.ffmpeg
def test_vegas_softens_edge_frame_contributions(tmp_path):
    from fractions import Fraction

    import av
    import numpy as np

    from tuck.encoding.frame_blending import blended_frames
    from tuck.probe import probe

    source = tmp_path / "vegas.mkv"
    with av.open(str(source), "w") as output:
        stream = output.add_stream("ffv1", rate=8)
        stream.width = stream.height = 16
        stream.pix_fmt = "bgr0"
        for index, level in enumerate([255, 0, 0, 0]):
            frame = av.VideoFrame.from_ndarray(
                np.full((16, 16, 3), level, dtype=np.uint8), format="rgb24"
            )
            frame.pts, frame.time_base = index, Fraction(1, 8)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    info = probe(source)
    plan = make_blend_plan(source, info)
    plan.target_fps = 2
    plan.segments = []
    assert info.duration == pytest.approx(0.5)
    plan.frame_blending = FrameBlending(enabled=True, curve="vegas")
    frames = list(blended_frames(plan, lambda: None))
    assert len(frames) == 1
    assert float(frames[0].mean()) == pytest.approx(48, abs=1)
    plan.frame_blending = FrameBlending(enabled=True, curve="vegas", custom_weights=(1,))
    frames = list(blended_frames(plan, lambda: None))
    assert float(frames[0].mean()) == pytest.approx(64, abs=1)


@pytest.fixture
def long_source(skip_if_no_ffmpeg, tmp_path):
    import shutil
    import subprocess

    from tuck.probe import probe

    path = tmp_path / "long.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x64:rate=30:duration=8",
            "-c:v",
            "libx264",
            "-g",
            "30",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path, probe(path)


def blend_all(plan):
    from tuck.encoding.frame_blending import blended_frames

    return [frame.copy() for frame in blended_frames(plan, lambda: None)]


@pytest.mark.ffmpeg
def test_a_late_selection_skips_the_video_before_it(long_source, monkeypatch):
    import numpy as np

    from tuck.encoding import frame_blending
    from tuck.models import Segment

    source, info = long_source
    plan = make_blend_plan(source, info)
    plan.target_fps = 10
    plan.segments = [Segment(6, 7)]
    original = frame_blending._source_frames
    decoded = 0

    def counted(*args, **kwargs):
        nonlocal decoded
        for frame in original(*args, **kwargs):
            decoded += 1
            yield frame

    monkeypatch.setattr(frame_blending, "_source_frames", counted)
    seeking = blend_all(plan)
    # reading starts at the keyframe before the selection, not at the start of the file
    assert decoded <= 2 * 30 + 2
    monkeypatch.setattr(frame_blending, "SEEK_THRESHOLD", math.inf)
    from_start = blend_all(plan)
    assert len(seeking) == 10
    assert all(np.array_equal(a, b) for a, b in zip(seeking, from_start, strict=True))


@pytest.mark.ffmpeg
def test_parts_in_any_source_order_blend_like_each_part_alone(long_source):
    import numpy as np

    from tuck.models import Segment

    source, info = long_source
    plan = make_blend_plan(source, info)
    plan.target_fps = 10
    parts = [Segment(5, 6), Segment(1, 2), Segment(6.5, 7)]
    alone = []
    for part in parts:
        plan.segments = [part]
        alone += blend_all(plan)
    plan.segments = parts
    joined = blend_all(plan)
    assert len(joined) == len(alone) == 25
    assert all(np.array_equal(a, b) for a, b in zip(joined, alone, strict=True))


def test_fixed_point_blending_matches_the_exact_average():
    import numpy as np

    from tuck.encoding.frame_blending import _blend

    rng = np.random.default_rng(3)
    pictures = [rng.integers(0, 256, (32, 48, 3), dtype=np.uint8) for _ in range(7)]
    for weights in ([1.0] * 7, [0.1, 0.3, 2.0, 0.7, 1e-6, 5.0, 0.25]):
        weighted = list(zip(pictures, weights, strict=True))
        exact = sum(p.astype(np.float64) * w for p, w in weighted) / sum(weights)
        blended = _blend(weighted, None, "bt709")
        assert np.abs(blended.astype(np.float64) - exact).max() <= 0.5 + 1e-3
    white = np.full((4, 4, 3), 255, dtype=np.uint8)
    assert (_blend([(white, 1.0)] * 3, None, "bt709") == 255).all()


@pytest.fixture
def grid_source(skip_if_no_ffmpeg, tmp_path):
    import shutil
    import subprocess

    from tuck.probe import probe

    path = tmp_path / "grid.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=96x64:rate=90:duration=6",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=6",
            "-c:v",
            "libx264",
            "-crf",
            "10",
            "-g",
            "45",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path, probe(path)


def grid_plan(source, info, segments, **blending):
    from tuck.models import EncodePlan

    return EncodePlan(
        source=str(source),
        output=str(source.with_name("out.mp4")),
        source_info=info,
        target_fps=30,
        segments=segments,
        frame_blending=FrameBlending(enabled=True, **blending),
    )


@pytest.mark.ffmpeg
@pytest.mark.parametrize(
    ("segments", "amount"),
    [
        ([(0, 6)], 1),
        ([(1.013, 2.4), (3.3, 4.05)], 1),
        ([(4.2, 5.1), (0.5, 1.7)], 0.5),
        ([(2.02, 3.5)], 2),
    ],
)
def test_ffmpeg_blending_matches_frame_by_frame_away_from_cuts(grid_source, segments, amount):
    import shutil
    import subprocess

    import numpy as np

    from tuck.encoding.command import _tmix_graph
    from tuck.encoding.frame_blending import _output_indices, tmix_blend
    from tuck.models import Segment

    source, info = grid_source
    plan = grid_plan(source, info, [Segment(a, b) for a, b in segments], amount=amount)
    blend = tmix_blend(plan)
    assert blend is not None
    reference = np.stack(blend_all(plan)).astype(int)
    frames = subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-v",
            "error",
            "-i",
            str(source),
            "-filter_complex",
            ";".join(_tmix_graph(blend, [])),
            "-map",
            "[vout]",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    blended = np.frombuffer(frames, np.uint8).reshape(-1, 64, 96, 3).astype(int)
    # the same frames on the same output grid, so audio stays in step
    assert len(blended) == len(reference)
    # only frames whose blur reaches past a cut may differ
    edges = set()
    for first, count, _ in _output_indices(
        plan.effective_segments, blend.rate, plan.effective_duration
    ):
        reach = math.ceil(amount)
        edges |= set(range(first, first + reach)) | set(range(first + count - reach, first + count))
    difference = np.abs(blended - reference).mean(axis=(1, 2, 3))
    assert [i for i, value in enumerate(difference) if value > 1 and i not in edges] == []


@pytest.mark.ffmpeg
def test_ffmpeg_blending_is_only_used_where_it_can_match(grid_source, tmp_path):
    import shutil
    import subprocess
    from dataclasses import replace

    from tuck.encoding.frame_blending import tmix_blend
    from tuck.models import Segment
    from tuck.probe import probe

    source, info = grid_source
    whole = [Segment(0, 6)]
    assert tmix_blend(grid_plan(source, info, whole)) is not None
    tagged = replace(info, color_transfer="bt709")
    assert tmix_blend(grid_plan(source, tagged, whole, linear_light=True)) is None
    for settings in (
        {"curve": "vegas"},
        {"curve": "gaussian"},
        {"custom_weights": (1.0, 2.0)},
        {"amount": 0},
    ):
        assert tmix_blend(grid_plan(source, info, whole, **settings)) is None, settings
    # 90 to 40 FPS is not a whole number of source frames per output frame
    uneven = grid_plan(source, info, whole)
    uneven.target_fps = 40
    assert tmix_blend(uneven) is None
    # frames that are not evenly spaced keep the frame-by-frame path
    variable = tmp_path / "variable.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            r"select=not(eq(mod(n\,5)\,2))",
            "-fps_mode",
            "vfr",
            "-an",
            str(variable),
        ],
        check=True,
        capture_output=True,
    )
    assert tmix_blend(grid_plan(variable, probe(variable), whole)) is None


@pytest.mark.ffmpeg
def test_simple_blends_export_without_the_prepared_video(grid_source, monkeypatch):
    import av

    from tuck.encoding import runner
    from tuck.encoding.runner import FFmpegEngine
    from tuck.models import Segment

    source, info = grid_source
    plan = grid_plan(source, info, [Segment(1.013, 2.4), Segment(3.3, 4.05)])
    plan.audio_bitrate = 128000
    plan.video_bitrate = 500000
    plan.target_size = 2 * 1024 * 1024
    plan.preset = "ultrafast"
    monkeypatch.setattr(
        runner, "prepare_blended_video", lambda *_: pytest.fail("blended frame by frame")
    )
    result = FFmpegEngine().encode(plan, lambda _: None)
    with av.open(str(result)) as container:
        video = container.streams.video[0]
        assert sum(1 for _ in container.decode(video)) == 65
        assert container.streams.audio


def _pictures(count, closed, fail_at=None):
    import numpy as np

    try:
        for index in range(count):
            if index == fail_at:
                raise ValueError("The source changed to an unsupported frame blending pixel format")
            yield float(index), np.full((2, 2, 3), index, dtype=np.uint8)
    finally:
        closed.append(True)


def test_read_ahead_hands_out_every_picture_in_order():
    from tuck.encoding.frame_blending import _ReadAhead

    closed = []
    frames = _ReadAhead(_pictures(12, closed))
    assert [timestamp for timestamp, _ in frames] == [float(i) for i in range(12)]
    frames.close()
    assert closed == [True]


def test_read_ahead_raises_a_reader_error_where_the_picture_is_read():
    from tuck.encoding.frame_blending import _ReadAhead

    closed = []
    frames = _ReadAhead(_pictures(12, closed, fail_at=5))
    assert [next(frames)[0] for _ in range(5)] == [0.0, 1.0, 2.0, 3.0, 4.0]
    with pytest.raises(ValueError, match="unsupported frame blending pixel format"):
        next(frames)
    frames.close()
    assert closed == [True]


def test_closing_read_ahead_early_stops_and_closes_the_reader():
    from tuck.encoding.frame_blending import _ReadAhead

    closed = []
    frames = _ReadAhead(_pictures(10_000, closed))
    assert next(frames)[0] == 0.0
    frames.close()
    assert closed == [True]
