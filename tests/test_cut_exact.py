from dataclasses import replace
from fractions import Fraction
from threading import Event

import av
import numpy as np
import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.cutting import exact
from tuck.cutting.analysis import CutAnalysisError, analyze_source
from tuck.cutting.exact import DecoderConfig, exact_media_reason, exact_regions
from tuck.cutting.planner import parse_cut_request, plan_cut
from tuck.models.cutting import MediaTime
from tuck.models.progress import EncodeStage


@pytest.fixture(scope="module")
def tools():
    value = find_tools()
    if value is None:
        pytest.skip("FFmpeg and ffprobe are required")
    if not exact.exact_encoder_available():
        pytest.skip("FFmpeg with libx264 is required")
    return value


@pytest.fixture(scope="module")
def source(tools, tmp_path_factory):
    # B-frames, a non-zero start and audio are the cases most likely to break a splice
    path = tmp_path_factory.mktemp("exact") / "source.mp4"
    return create_source(tools, path, duration=6, gop=60, b_frames=3, offset=5)


def CutRunner():  # noqa: N802
    # tuck.encoding imports the cut runner, so importing it first would be circular
    from tuck.cutting.runner import CutRunner as Runner

    return Runner()


def frame_time(index, rate=Fraction(30)):
    return MediaTime.from_seconds(index / rate).to_dict()


def make_plan(source, ranges, output, *, audio=True, rate=Fraction(30), precision="exact"):
    analysis = analyze_source(source, Event(), lambda _: None)
    request = parse_cut_request(
        {
            "operation": "cut",
            "source": str(source),
            "precision": precision,
            "include_audio": audio,
            "segments": [
                {"start": frame_time(start, rate), "end": frame_time(end, rate)}
                for start, end in ranges
            ],
            "output_dir": str(output.parent),
            "output_name": output.name,
        }
    )
    return analysis, plan_cut(request, analysis, exact_encoder=True)


def decoded(path):
    with av.open(str(path)) as container:
        return [f.to_ndarray(format="rgb24").astype(np.int16) for f in container.decode(video=0)]


def assert_frames(source, output, ranges, encoded):
    """Every output frame is the intended source frame; copied frames are identical."""
    reference = decoded(source)
    frames = decoded(output)
    wanted = [index for start, end in ranges for index in range(start, end)]
    assert len(frames) == len(wanted)
    for image, index in zip(frames, wanted, strict=True):
        if index not in encoded:
            assert np.array_equal(image, reference[index]), index
            continue
        differences = {
            neighbour: np.abs(image - reference[neighbour]).mean()
            for neighbour in range(max(0, index - 2), min(len(reference), index + 3))
        }
        assert min(differences, key=differences.get) == index
        assert differences[index] < 4


def encoded_frames(plan, rate=Fraction(30)):
    return {
        index
        for region in exact_regions(plan)
        for index in range(round(region.start * rate), round(region.end * rate))
    }


@pytest.mark.parametrize(
    ("ranges", "kinds", "encoded_count"),
    [
        # off-keyframe start: 15 frames before the keyframe and one after the last safe end
        ([(45, 150)], ["exact"], 16),
        # starts on a keyframe and ends on a safe end: nothing needs encoding
        ([(60, 121)], ["keyframe"], 0),
        # a copied B-frame tail followed by a wholly encoded segment keeps the exact duration
        ([(60, 121), (130, 175)], ["keyframe", "exact"], 45),
        # end after the last safe end: the tail is encoded
        ([(60, 119)], ["keyframe"], 2),
        # shorter than one GOP: the whole segment is encoded
        ([(70, 76)], ["exact"], 6),
        # first and last source frames, with a join between them; the tail has no keyframe
        ([(0, 7), (173, 180)], ["at_start", "exact"], 9),
        # several joins, each with encoded edges and copied audio
        ([(10, 50), (65, 100), (130, 175)], ["exact", "exact", "exact"], None),
    ],
)
def test_exact_cuts_keep_exactly_the_requested_frames(
    tools, source, tmp_path, ranges, kinds, encoded_count
):
    output = tmp_path / "cut.mp4"
    _, plan = make_plan(source, ranges, output)
    assert plan.issues == ()
    assert plan.exact_available
    assert [s.start_kind for s in plan.segments] == kinds
    assert [s.resolved.start.seconds for s in plan.segments] == [Fraction(a, 30) for a, _ in ranges]
    assert [s.resolved.end.seconds for s in plan.segments] == [Fraction(b, 30) for _, b in ranges]
    assert all(s.end_frames_moved == 0 for s in plan.segments)
    encoded = encoded_frames(plan)
    if encoded_count is not None:
        assert len(encoded) == encoded_count
    stages = []
    result = CutRunner().run(plan, lambda progress: stages.append(progress.stage))
    assert result == output
    assert stages.index(EncodeStage.ENCODING_EDGES) < stages.index(EncodeStage.COPYING)
    assert stages[-1] == EncodeStage.COMPLETED
    assert_frames(source, output, ranges, encoded)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["cut.mp4"]
    with av.open(str(output)) as container:
        config = DecoderConfig.parse(container.streams.video[0].codec_context.extradata)
        parameter_sets = 2 if encoded else 1
        assert len(config.sps) == parameter_sets and len(config.pps) == parameter_sets
        audio = container.streams.audio[0]
        assert audio.duration is not None and audio.time_base is not None
        video = container.streams.video[0]
        # copied AAC stays within one packet of the exported video
        assert abs(audio.duration * audio.time_base - plan.exported_duration.seconds) <= Fraction(
            1024, 48000
        )
        assert video.duration * video.time_base == plan.exported_duration.seconds


def test_fractional_frame_rates_cut_exactly(tools, tmp_path):
    rate = Fraction(30000, 1001)
    path = create_source(
        tools, tmp_path / "ntsc.mp4", duration=4, rate="30000/1001", gop=48, audio=False
    )
    output = tmp_path / "cut.mp4"
    ranges = [(7, 40), (61, 90)]
    _, plan = make_plan(path, ranges, output, audio=False, rate=rate)
    assert plan.issues == ()
    CutRunner().run(plan)
    assert_frames(path, output, ranges, encoded_frames(plan, rate))


def test_segments_shorter_than_a_frame_collapse_and_other_times_round_inward(tools, source):
    analysis = analyze_source(source, Event(), lambda _: None)
    request = parse_cut_request(
        {
            "operation": "cut",
            "source": str(source),
            "precision": "exact",
            "segments": [
                {
                    "start": MediaTime(10, 1, 1000).to_dict(),
                    "end": MediaTime(2030, 1, 1000).to_dict(),
                },
                {
                    "start": MediaTime(3001, 1, 1000).to_dict(),
                    "end": MediaTime(3020, 1, 1000).to_dict(),
                },
            ],
        }
    )
    plan = plan_cut(request, analysis, exact_encoder=True)
    assert plan.segments[0].resolved.start.seconds == Fraction(1, 30)
    assert plan.segments[0].resolved.end.seconds == Fraction(60, 30)
    assert plan.segments[1].start_kind == "collapsed"
    assert [issue.code for issue in plan.issues] == ["segment_collapsed"]


def test_exact_is_unavailable_without_the_encoder_or_for_unsupported_video(source, tmp_path):
    analysis, plan = make_plan(source, [(45, 150)], tmp_path / "cut.mp4")
    request = plan.request
    assert request is not None
    blocked = plan_cut(request, analysis, exact_encoder=False)
    assert not blocked.exact_available
    assert blocked.exact_reason == "Exact needs FFmpeg with the libx264 encoder."
    assert [issue.code for issue in blocked.issues] == ["exact_unavailable"]
    keyframes = plan_cut(replace(request, precision="keyframes"), analysis, exact_encoder=False)
    assert keyframes.issues == ()
    video = next(s for s in analysis.streams if s.kind == "video")
    for key, value, reason in [
        ("profile", "High 4:4:4 Predictive", "Exact needs H.264 Baseline, Main or High video."),
        ("width", "161", "Exact needs video with even width and height."),
    ]:
        properties = tuple((k, value if k == key else v) for k, v in video.properties)
        changed = replace(
            analysis,
            streams=tuple(
                replace(s, properties=properties) if s is video else s for s in analysis.streams
            ),
        )
        assert exact_media_reason(changed) == reason


def test_keyframe_plans_are_unchanged_by_exact_support(source, tmp_path):
    _, plan = make_plan(source, [(45, 150)], tmp_path / "cut.mp4", precision="keyframes")
    assert plan.segments[0].start_kind == "moved"
    assert plan.segments[0].copied is None
    assert exact_regions(plan) == []


def test_cancelling_while_encoding_edges_leaves_no_output(tools, source, tmp_path, monkeypatch):
    output = tmp_path / "cut.mp4"
    _, plan = make_plan(source, [(10, 50), (65, 100)], output)
    runner = CutRunner()
    original = exact._source_frames
    frames = 0

    def cancel_after_some(*args, **kwargs):
        nonlocal frames
        for frame in original(*args, **kwargs):
            frames += 1
            if frames == 5:
                runner.cancel()
            yield frame

    monkeypatch.setattr(exact, "_source_frames", cancel_after_some)
    stages = []
    with pytest.raises(CutAnalysisError) as error:
        runner.run(plan, lambda progress: stages.append(progress.stage))
    assert error.value.code == "cut_cancelled"
    assert stages[-1] == EncodeStage.CANCELLED
    assert list(tmp_path.iterdir()) == []


def test_an_encoder_failure_reports_ffmpeg_detail(tools, source, tmp_path, monkeypatch):
    output = tmp_path / "cut.mp4"
    _, plan = make_plan(source, [(45, 150)], output)
    arguments = exact._encoder_arguments

    def broken(*args, **kwargs):
        values = arguments(*args, **kwargs)
        return [*values[:-1], "-profile:v", "not-a-profile", values[-1]]

    monkeypatch.setattr(exact, "_encoder_arguments", broken)
    with pytest.raises(CutAnalysisError) as error:
        CutRunner().run(plan)
    assert error.value.code == "cut_failed"
    assert "could not encode a cut edge" in str(error.value)
    assert list(tmp_path.iterdir()) == []


def test_a_misplaced_edge_frame_fails_verification(tools, source, tmp_path, monkeypatch):
    output = tmp_path / "cut.mp4"
    _, plan = make_plan(source, [(45, 150)], output)
    original = exact._source_frames

    def shifted(path, analysis, start, end, cancel):
        # encode the frames one position late; timestamps still look right
        step = analysis.frame_duration.seconds
        frames = list(original(path, analysis, start + step, end + step, cancel))
        yield from frames

    monkeypatch.setattr(exact, "_source_frames", shifted)
    with pytest.raises(CutAnalysisError) as error:
        CutRunner().run(plan)
    assert error.value.code == "verification_failed"
    assert not output.exists()


def test_decoder_configuration_round_trips_and_merges():
    sps = bytes([0x67, 0x64, 0x00, 0x1F, 0xAC, 0xD9, 0x40])
    pps = bytes([0x68, 0xEB, 0xE3, 0xCB])
    edge_sps = bytes([0x67, 0x64, 0x00, 0x1F, 0x4C, 0xA5])  # sps id ue(1) = 010
    edge_pps = bytes([0x68, 0x5B, 0x0F])  # pps 1, sps 1
    config = DecoderConfig(b"\x64\x00\x1f", 4, (sps,), (pps,), b"\xfd\xf8\xf8\x00")
    raw = config.merged(DecoderConfig(b"", 4, (), (), b""))
    parsed = DecoderConfig.parse(raw)
    assert parsed == config
    assert parsed.sps_ids() == {0} and parsed.pps_ids() == {0}
    merged = DecoderConfig.parse(
        config.merged(DecoderConfig(b"", 4, (edge_sps,), (edge_pps,), b""))
    )
    assert merged.sps == (sps, edge_sps) and merged.pps == (pps, edge_pps)
    assert merged.sps_ids() == {0, 1} and merged.pps_ids() == {0, 1}
    assert merged.extension == config.extension
    for broken in [b"", b"\x02" + raw[1:], raw[:-8]]:
        with pytest.raises(CutAnalysisError):
            DecoderConfig.parse(broken)
