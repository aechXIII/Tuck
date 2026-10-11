import errno
import hashlib
import os
from dataclasses import replace
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from threading import Event

import av
import numpy as np
import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.cutting.analysis import CutAnalysisError, analyze_source
from tuck.cutting.planner import parse_cut_request, plan_cut
from tuck.models.cutting import MediaTime


@pytest.fixture(scope="module")
def media_tools():
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg and ffprobe are required")
    return tools


def make_plan(tools, source, ranges, output, *, audio=True):
    analysis = analyze_source(source, Event(), lambda _: None, ffprobe=tools.ffprobe)
    plan = plan_cut(
        parse_cut_request(
            {
                "operation": "cut",
                "source": str(source),
                "precision": "keyframes",
                "include_audio": audio,
                "segments": [
                    {
                        "start": MediaTime.from_seconds(Fraction(start)).to_dict(),
                        "end": MediaTime.from_seconds(Fraction(end)).to_dict(),
                    }
                    for start, end in ranges
                ],
                "output_dir": str(output.parent),
                "output_name": output.name,
            }
        ),
        analysis,
    )
    assert not plan.issues
    return analysis, plan


def runner(tools):
    from tuck.cutting.runner import CutRunner

    return CutRunner(ffprobe=tools.ffprobe)


def frame_hashes(path):
    with av.open(str(path)) as container:
        return [
            (
                Fraction(frame.pts) * frame.time_base,
                hashlib.sha256(frame.to_ndarray().tobytes()).digest(),
            )
            for frame in container.decode(video=0)
        ]


def check_frames(source, output, analysis, plan):
    frames = frame_hashes(source)
    expected = []
    elapsed = Fraction(0)
    for segment in plan.segments:
        start, end = segment.resolved.start.seconds, segment.resolved.end.seconds
        expected += [
            (time - analysis.origin.seconds - start + elapsed, digest)
            for time, digest in frames
            if start <= time - analysis.origin.seconds < end
        ]
        elapsed += end - start
    assert frame_hashes(output) == expected


def check_audio_packets(source, output, analysis, plan):
    expected = []
    with av.open(str(source)) as container:
        packets = [p for p in container.demux(audio=0) if p.size]
        for index, segment in enumerate(plan.segments):
            if segment.audio_source is None:
                continue
            chosen = [
                p
                for p in packets
                if segment.audio_source.start.seconds
                <= p.pts * p.time_base - analysis.origin.seconds
                < segment.audio_source.end.seconds
            ]
            assert len(chosen) == segment.audio_packet_count
            assert all(
                p.pts * p.time_base - analysis.origin.seconds < segment.resolved.end.seconds
                and (p.pts + p.duration) * p.time_base - analysis.origin.seconds
                > segment.resolved.start.seconds
                for p in chosen
            )
            if index == 0 and segment.resolved.start.seconds == 0:
                expected += [
                    bytes(p)
                    for p in packets
                    if (p.pts + p.duration) * p.time_base == analysis.origin.seconds
                    and int.from_bytes(bytes(p.get_sidedata("skip_samples"))[:4], "little") == 1024
                ]
            expected += [bytes(p) for p in chosen]
    with av.open(str(output)) as container:
        actual = [p for p in container.demux(audio=0) if p.size]
    assert [bytes(p) for p in actual] == expected
    assert all(a.dts < b.dts for a, b in pairwise(actual))
    assert abs(
        (actual[-1].pts + actual[-1].duration) * actual[-1].time_base
        - plan.exported_duration.seconds
    ) <= Fraction(1024, 48000)


@pytest.mark.parametrize(
    "ranges,options,audio",
    [
        ([(0, 3)], {}, True),
        ([(0, Fraction(29, 10)), (4, 6)], {}, True),
        ([(2, Fraction(181, 30))], {"duration": Fraction(181, 30)}, True),
        ([(0, 1), (4, 6)], {"audio": False}, True),
        ([(2, 5)], {}, False),
        ([(0, 2), (4, 6)], {"offset": 7}, True),
        ([(0, Fraction(19, 10)), (4, 6)], {"b_frames": 8}, True),
        ([(0, Fraction(19, 10)), (4, 6)], {"b_frames": 0}, True),
        ([(0, Fraction(19, 10)), (4, 6)], {"rate": "30000/1001"}, True),
        ([(0, Fraction(99, 10)), (10, 20)], {"gop": 300, "duration": 20}, True),
    ],
)
def test_copies_exact_planned_frames_and_audio_packets(
    media_tools, tmp_path, ranges, options, audio
):
    source = create_source(media_tools, tmp_path / "Zółw's source.mp4", **options)
    digest = hashlib.sha256(source.read_bytes()).digest()
    output = tmp_path / "Ścieżka's result.mp4"
    analysis, plan = make_plan(media_tools, source, ranges, output, audio=audio)
    updates = []
    result = runner(media_tools).run(plan, updates.append)
    assert result == output
    check_frames(source, result, analysis, plan)
    decoded = media_tools.run(["-v", "warning", "-i", str(result), "-map", "0", "-f", "null", "-"])
    assert not decoded.stderr
    if audio and options.get("audio", True):
        check_audio_packets(source, result, analysis, plan)
    else:
        with av.open(str(result)) as container:
            assert not container.streams.audio
    assert hashlib.sha256(source.read_bytes()).digest() == digest
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))
    stages = [update.stage.value for update in updates]
    assert "copying" in stages and "joining" in stages and "verifying" in stages
    # moving the file into place is named, and comes after the checks
    assert stages.index("saving") > stages.index("verifying")
    assert next(update for update in updates if update.stage.value == "saving").indeterminate
    assert stages[-1] == "completed" and updates[-1].percent == 100
    assert all(update.percent < 100 for update in updates[:-1])


@pytest.mark.parametrize("stage", ["copying", "joining", "verifying"])
def test_cancellation_in_each_stage_cleans_up_and_can_be_reset(media_tools, tmp_path, stage):
    source = create_source(media_tools, tmp_path / "source.mp4", duration=6)
    _, plan = make_plan(media_tools, source, [(0, 2), (4, 6)], tmp_path / "result.mp4")
    engine = runner(media_tools)

    def cancel(update):
        if update.stage.value == stage and (stage != "copying" or update.current_time >= 1):
            engine.cancel()

    with pytest.raises(CutAnalysisError, match="cancelled"):
        engine.run(plan, cancel)
    assert not Path(plan.output_path).exists()
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))
    engine.reset_cancel()
    assert engine.run(plan).is_file()


@pytest.mark.parametrize("when", ["before", "copying", "verifying"])
def test_source_change_with_preserved_size_and_time_refuses_publication(
    media_tools, tmp_path, when
):
    source = create_source(media_tools, tmp_path / "source.mp4", duration=6)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    changed = False

    def change():
        nonlocal changed
        contents = bytearray(source.read_bytes())
        contents[-1] ^= 1
        source.write_bytes(contents)
        os.utime(source, ns=(plan.identity.mtime_ns, plan.identity.mtime_ns))
        changed = True

    def progress(update):
        if not changed and update.stage.value == when:
            change()

    if when == "before":
        change()
    with pytest.raises(CutAnalysisError) as error:
        runner(media_tools).run(plan, progress)
    assert error.value.code == "source_changed"
    assert not Path(plan.output_path).exists()
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))


def test_disk_failure_during_copy_cleans_up(media_tools, tmp_path, monkeypatch):
    from tuck.cutting import runner as module

    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    original = module.av.open

    def fail_write(file, mode="r", **kwargs):
        if mode == "w":
            Path(file).write_bytes(b"partial")
            raise OSError("No space left on device")
        return original(file, mode, **kwargs)

    monkeypatch.setattr(module.av, "open", fail_write)
    with pytest.raises(CutAnalysisError, match="could not be saved") as error:
        runner(media_tools).run(plan)
    # the system text, which can name private paths, stays in the details
    assert "No space left" not in str(error.value)
    assert error.value.detail == "No space left on device"
    assert not Path(plan.output_path).exists()
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))


def test_modified_resolved_plan_is_rejected(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    plan = replace(plan, exported_duration=MediaTime(9))
    with pytest.raises(CutAnalysisError) as error:
        runner(media_tools).run(plan)
    assert error.value.code == "plan_changed"
    assert not Path(plan.output_path).exists()


def test_export_reuses_the_plan_analysis_of_unchanged_bytes(media_tools, tmp_path, monkeypatch):
    from tuck.cutting import packets

    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    monkeypatch.setattr(packets, "analyze_source", lambda *_, **__: pytest.fail("scanned again"))
    assert runner(media_tools).run(plan) == Path(plan.output_path)


def test_twenty_joins_keep_audio_markers_within_one_packet(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4", duration=42)
    ranges = [(second, Fraction(second) + Fraction(6, 5)) for second in range(0, 40, 2)]
    analysis, plan = make_plan(media_tools, source, ranges, tmp_path / "result.mp4")
    result = runner(media_tools).run(plan)
    check_frames(source, result, analysis, plan)
    check_audio_packets(source, result, analysis, plan)

    def decode(path):
        with av.open(str(path)) as container:
            return np.concatenate(
                [frame.to_ndarray().reshape(-1) for frame in container.decode(audio=0)]
            )

    source_audio, output_audio = decode(source), decode(result)
    elapsed = Fraction(0)
    for segment in plan.segments:
        marker = segment.resolved.start.seconds + Fraction(47, 100)
        sample = round(marker * 48000)
        template = source_audio[sample : sample + 512]
        expected = round((elapsed + Fraction(47, 100)) * 48000)
        low, high = max(0, expected - 1024), expected + 1024
        window = output_audio[low : high + len(template)]
        correlation = np.correlate(window, template, mode="valid")
        actual = low + int(np.argmax(correlation))
        assert abs(actual - expected) <= 1024
        assert np.corrcoef(template, output_audio[actual : actual + len(template)])[0, 1] > 0.99
        elapsed += segment.resolved.end.seconds - segment.resolved.start.seconds


def test_colour_and_metadata_are_preserved(media_tools, tmp_path):
    original = create_source(media_tools, tmp_path / "original.mp4", duration=6)
    source = tmp_path / "source.mp4"
    media_tools.run(
        [
            "-v",
            "error",
            "-i",
            str(original),
            "-map",
            "0",
            "-c",
            "copy",
            "-bsf:v",
            "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
            "-metadata",
            "title=Family video",
            "-metadata",
            "comment=Keep this description",
            "-metadata:s:a:0",
            "language=pol",
            str(source),
        ]
    )
    analysis, plan = make_plan(media_tools, source, [(0, 2), (4, 6)], tmp_path / "result.mp4")
    assert dict(analysis.streams[0].properties)["color_primaries"] == "bt709"
    output = runner(media_tools).run(plan)
    with av.open(str(output)) as container:
        assert container.metadata["title"] == "Family video"
        assert container.metadata["comment"] == "Keep this description"
        assert container.streams.audio[0].metadata["language"] == "pol"
        assert container.streams.video[0].codec_context.color_primaries == 1


@pytest.mark.parametrize("damage", ["drop", "payload", "timestamp"])
def test_verification_refuses_changed_packets(media_tools, tmp_path, damage):
    from tuck.cutting.verification import verify_cut_output

    source = create_source(media_tools, tmp_path / "source.mp4", duration=6)
    _, plan = make_plan(media_tools, source, [(0, 2), (4, 6)], tmp_path / "result.mp4")
    output = runner(media_tools).run(plan)
    damaged = tmp_path / "damaged.mp4"
    with av.open(str(output)) as incoming, av.open(str(damaged), "w") as outgoing:
        streams = {s.index: outgoing.add_stream_from_template(s) for s in incoming.streams}
        for stream in incoming.streams:
            streams[stream.index].metadata.update(stream.metadata)
        count = 0
        for packet in incoming.demux():
            if not packet.size:
                continue
            if packet.stream.type == "video":
                count += 1
                if count == 12:
                    if damage == "drop":
                        continue
                    if damage == "timestamp":
                        packet.pts += 1
                    if damage == "payload":
                        payload = bytearray(packet)
                        payload[-1] ^= 1
                        changed = av.Packet(payload)
                        changed.pts, changed.dts = packet.pts, packet.dts
                        changed.duration, changed.time_base = packet.duration, packet.time_base
                        changed.stream = packet.stream
                        packet = changed
            packet.stream = streams[packet.stream.index]
            outgoing.mux(packet)
    with pytest.raises(CutAnalysisError, match="packet") as error:
        verify_cut_output(plan, damaged, Event(), ffprobe=media_tools.ffprobe)
    assert error.value.code == "verification_failed"


def test_verification_budget_failure_does_not_publish(media_tools, tmp_path, monkeypatch):
    from tuck.cutting import verification

    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    monkeypatch.setattr(verification, "MAX_BOUNDARY_FRAMES", 0)
    with pytest.raises(CutAnalysisError, match="decoding limit"):
        runner(media_tools).run(plan)
    assert not Path(plan.output_path).exists()
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))


def test_cancellation_during_boundary_decoding_does_not_publish(media_tools, tmp_path, monkeypatch):
    from tuck.cutting import verification

    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    engine = runner(media_tools)
    decode = verification._decode_edge

    def cancel(*args, **kwargs):
        engine.cancel()
        return decode(*args, **kwargs)

    monkeypatch.setattr(verification, "_decode_edge", cancel)
    with pytest.raises(CutAnalysisError, match="cancelled"):
        engine.run(plan)
    assert not Path(plan.output_path).exists()
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))


def test_source_change_after_verification_refuses_publication(media_tools, tmp_path, monkeypatch):
    from tuck.cutting import verification

    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    verify = verification._verify_boundaries

    def change(*args, **kwargs):
        result = verify(*args, **kwargs)
        with source.open("ab") as file:
            file.write(b"changed")
        return result

    monkeypatch.setattr(verification, "_verify_boundaries", change)
    with pytest.raises(CutAnalysisError) as error:
        runner(media_tools).run(plan)
    assert error.value.code == "source_changed"
    assert not Path(plan.output_path).exists()


def test_one_frame_cut_and_source_start_audio_marker(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    analysis, plan = make_plan(media_tools, source, [(0, Fraction(1, 30))], tmp_path / "result.mp4")
    output = runner(media_tools).run(plan)
    check_frames(source, output, analysis, plan)
    with av.open(str(source)) as container:
        original = next(container.decode(audio=0)).to_ndarray()
    with av.open(str(output)) as container:
        copied = next(container.decode(audio=0)).to_ndarray()
    assert np.max(np.abs(original)) > 0.1
    np.testing.assert_array_equal(copied, original)


def test_undecodable_audio_at_a_cut_edge_is_not_published(media_tools, tmp_path):
    original = create_source(media_tools, tmp_path / "original.mp4", duration=4)
    source = tmp_path / "source.mp4"
    with av.open(str(original)) as incoming, av.open(str(source), "w") as outgoing:
        streams = {s.index: outgoing.add_stream_from_template(s) for s in incoming.streams}
        audio_count = 0
        for packet in incoming.demux():
            if not packet.size:
                continue
            if packet.stream.type == "audio":
                audio_count += 1
                if audio_count == 3:
                    packet.update(b"\0" * packet.size)
            packet.stream = streams[packet.stream.index]
            outgoing.mux(packet)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    with pytest.raises(CutAnalysisError) as error:
        runner(media_tools).run(plan)
    assert error.value.code == "verification_failed"
    assert not Path(plan.output_path).exists()


@pytest.mark.parametrize(
    ("failure", "says"),
    [
        (OSError(errno.ENOSPC, "No space left on device"), "drive is full"),
        (av.error.OSError(errno.ENOSPC, "No space left on device"), "drive is full"),
        (PermissionError(errno.EACCES, "Permission denied"), "can't write there"),
        (OSError(errno.EPERM, "Operation not permitted"), "can't write there"),
        (OSError(errno.EIO, "Input/output error"), "still available"),
        (av.error.InvalidDataError(-1094995529, "Invalid data found"), "format would not accept"),
        (av.error.ValueError(errno.EINVAL, "Invalid argument"), "format would not accept"),
        (av.error.UndefinedError(-1, "Unknown error"), "format would not accept"),
        (ValueError("non-monotonic timestamps"), "format would not accept"),
    ],
)
def test_save_errors_name_the_real_problem(failure, says):
    from tuck.cutting.runner import save_error

    error = save_error(failure)
    assert error.code == "cut_failed"
    assert says in str(error)
    assert error.detail == str(failure)
    if says != "drive is full":
        assert "free space" not in str(error)


@pytest.mark.parametrize(
    ("failure", "says"),
    [
        (OSError(errno.ENOSPC, "No space left on device"), "drive is full"),
        (av.error.InvalidDataError(-1094995529, "Invalid data found"), "format would not accept"),
    ],
)
def test_a_failed_cut_explains_itself_and_cleans_up(
    media_tools, tmp_path, monkeypatch, failure, says
):
    from tuck.cutting import runner as module

    source = create_source(media_tools, tmp_path / "source.mp4", duration=4)
    _, plan = make_plan(media_tools, source, [(0, 2)], tmp_path / "result.mp4")
    original = module.av.open

    def fail_write(file, mode="r", **kwargs):
        if mode == "w":
            raise failure
        return original(file, mode, **kwargs)

    monkeypatch.setattr(module.av, "open", fail_write)
    with pytest.raises(CutAnalysisError, match=says):
        runner(media_tools).run(plan)
    assert not Path(plan.output_path).exists()
    assert not list(tmp_path.glob(".tuck-*"))
    assert not list(tmp_path.glob("*.reserved"))
