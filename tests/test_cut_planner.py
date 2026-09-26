from fractions import Fraction
from pathlib import Path
from threading import Event

import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.models.cutting import MediaTime


def moment(value):
    return MediaTime.from_seconds(Fraction(value)).to_dict()


@pytest.fixture(scope="module")
def analyzed(tmp_path_factory):
    from tuck.cutting.analysis import analyze_source

    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path_factory.mktemp("cut-planner") / "source.mp4")
    return analyze_source(source, Event(), lambda _: None, ffprobe=tools.ffprobe)


def request_for(analysis, **overrides):
    result = {
        "operation": "cut",
        "source": analysis.identity.path,
        "segments": [{"start": moment(Fraction(21, 10)), "end": moment(Fraction(49, 10))}],
        "precision": "keyframes",
        "include_audio": True,
        "edits": [],
        "without_edits": False,
    }
    result.update(overrides)
    return result


def test_planning_resolves_both_edges_without_mutating_intent(analyzed):
    from tuck.cutting.planner import parse_cut_request, plan_cut

    request = parse_cut_request(request_for(analyzed))
    result = plan_cut(request, analyzed)
    assert not result.issues
    segment = result.segments[0]
    assert segment.requested.start.seconds == Fraction(21, 10)
    assert segment.resolved.start.seconds == 4
    assert segment.resolved.end.seconds == Fraction(29, 6)
    assert segment.end_frames_moved == 2
    assert segment.start_kind == "moved"
    assert segment.audio_source is not None
    assert abs(segment.audio_source.start.seconds - 4) <= Fraction(1024, 48000)
    assert segment.audio_packet_count > 0
    assert result.exported_duration.seconds == Fraction(5, 6)
    assert result.output_path == str(Path(analyzed.identity.path).with_name("source_cut.mp4"))


def test_fingerprint_changes_with_intent_but_not_ui_request_id(analyzed):
    from tuck.cutting.planner import parse_cut_request, plan_cut

    first = plan_cut(parse_cut_request(request_for(analyzed, _request_id=1)), analyzed)
    second = plan_cut(parse_cut_request(request_for(analyzed, _request_id=2)), analyzed)
    silent = plan_cut(parse_cut_request(request_for(analyzed, include_audio=False)), analyzed)
    assert first.fingerprint == second.fingerprint
    assert first.fingerprint != silent.fingerprint
    assert silent.segments[0].audio_source is None


@pytest.mark.parametrize(
    "edit",
    [
        "crop",
        "flip",
        "rotation",
        "resize",
        "lut",
        "fps",
        "frame_blending",
        "source_gain",
        "source_fades",
        "added_audio",
        "muted_segments",
    ],
)
def test_edits_need_an_explicit_choice(analyzed, edit):
    from tuck.cutting.planner import parse_cut_request, plan_cut

    raw = request_for(analyzed, edits=[edit])
    blocked = plan_cut(parse_cut_request(raw), analyzed)
    assert any(issue.code == "incompatible_edit" for issue in blocked.issues)
    allowed = plan_cut(parse_cut_request({**raw, "without_edits": True}), analyzed)
    assert not allowed.issues


@pytest.mark.parametrize(
    "overrides",
    [
        {"operation": "unexpected"},
        {"include_audio": 1},
        {"precision": "smart"},
        {"crf": 18},
        {"ffmpeg_args": ["-y"]},
        {"edits": ["unknown"]},
        {"output_name": "../outside.mp4"},
        {"output_name": "CON.mp4"},
        {"segments": []},
        {"segments": [{"start": float("nan"), "end": 2}]},
        {"segments": [{"start": moment(3), "end": moment(2)}]},
        {
            "segments": [
                {"start": moment(0), "end": moment(3)},
                {"start": moment(2), "end": moment(4)},
            ]
        },
    ],
)
def test_untrusted_cut_payloads_are_rejected(analyzed, overrides):
    from tuck.cutting.planner import parse_cut_request

    with pytest.raises(ValueError):
        parse_cut_request(request_for(analyzed, **overrides))


def test_collapsed_and_unavailable_exact_plans_explain_the_block(analyzed):
    from tuck.cutting.planner import parse_cut_request, plan_cut

    raw = request_for(
        analyzed, segments=[{"start": moment(Fraction(21, 10)), "end": moment(Fraction(39, 10))}]
    )
    collapsed = plan_cut(parse_cut_request(raw), analyzed)
    assert collapsed.issues[0].code == "segment_collapsed"
    exact = plan_cut(parse_cut_request({**raw, "precision": "exact"}), analyzed)
    assert any(i.code == "exact_unavailable" for i in exact.issues)


def test_eof_and_requested_source_identity_are_checked(analyzed):
    from tuck.cutting.planner import parse_cut_request, plan_cut

    raw = request_for(analyzed, segments=[{"start": moment(0), "end": analyzed.duration.to_dict()}])
    result = plan_cut(parse_cut_request(raw), analyzed)
    assert result.exported_duration == analyzed.duration
    wrong = plan_cut(
        parse_cut_request(
            {**raw, "source": str(Path(analyzed.identity.path).with_name("other.mp4"))}
        ),
        analyzed,
    )
    assert wrong.issues[0].code == "source_changed"


def test_audio_plan_refuses_unqualified_packet_durations(analyzed):
    from dataclasses import replace

    from tuck.cutting.planner import parse_cut_request, plan_cut

    packets = list(analyzed.audio_packets)
    packets[100] = replace(packets[100], duration=MediaTime.from_seconds(Fraction(383, 375)))
    irregular = replace(analyzed, audio_packets=tuple(packets))
    result = plan_cut(
        parse_cut_request(
            request_for(irregular, segments=[{"start": moment(0), "end": moment(6)}])
        ),
        irregular,
    )
    assert any(issue.field == "include_audio" for issue in result.issues)


def test_multi_segment_plan_keeps_copyable_boundaries_and_audio_in_sync(tmp_path):
    from tuck.cutting.analysis import analyze_source
    from tuck.cutting.planner import parse_cut_request, plan_cut

    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path / "example.mp4", duration=120)
    analysis = analyze_source(source, Event(), lambda _: None, ffprobe=tools.ffprobe)
    raw = request_for(
        analysis,
        segments=[
            {"start": moment(0), "end": moment(Fraction(152, 5))},
            {"start": moment(Fraction(212, 5)), "end": moment(120)},
        ],
    )
    plan = plan_cut(parse_cut_request(raw), analysis)
    assert not plan.issues
    assert plan.exported_duration.seconds == Fraction(1063, 10)
    assert plan.segments[0].resolved.end.seconds == Fraction(303, 10)
    assert plan.segments[0].end_frames_moved == 3
    assert plan.segments[1].resolved.start.seconds == 44
    assert plan.segments[1].requested.start.seconds == Fraction(212, 5)
    assert plan.segments[1].audio_output is not None
    assert abs(
        plan.segments[1].audio_output.end.seconds - plan.exported_duration.seconds
    ) <= Fraction(1024, 48000)
    assert plan.estimated_bytes == round(source.stat().st_size * Fraction(1063, 1200))
