import time
from fractions import Fraction
from threading import Event

import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.cutting.exact import exact_media_reason


def analyzer():
    from tuck.cutting.analysis import analyze_source

    return analyze_source


@pytest.fixture
def media_tools():
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg and ffprobe are required")
    return tools


def test_scan_preserves_rational_safe_endpoints_and_stream_inventory(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4", rate="30000/1001", offset=7)
    updates = []
    result = analyzer()(source, Event(), updates.append, ffprobe=media_tools.ffprobe)
    assert not result.issues
    assert result.frame_duration.seconds == Fraction(1001, 30000)
    assert result.keyframes[1].seconds == Fraction(1001, 500)
    assert result.safe_ends[0].seconds == Fraction(1001, 30000)
    assert {s.kind for s in result.streams} == {"video", "audio"}
    assert result.audio_packets
    assert updates[-1].coverage_end == result.duration
    assert updates[-1].progress == 1
    assert len(result.identity.signature) == 64
    # a supported fractional-rate H.264 source can use Exact
    assert exact_media_reason(result) == ""


@pytest.mark.parametrize(
    ("variant", "note"),
    [
        ("open_gop", "unverified_start"),
        ("vfr", None),
        ("hdr", None),
        ("multiple_audio", None),
        ("subtitle", None),
    ],
)
def test_wider_media_can_be_cut_and_says_what_is_not_checked(media_tools, tmp_path, variant, note):
    source = create_source(media_tools, tmp_path / "source.mp4", variant=variant)
    result = analyzer()(source, Event(), lambda _: None, ffprobe=media_tools.ffprobe)
    assert result.issues == ()
    assert [n.code for n in result.unverified] == ([note] if note else [])
    kinds = [track.kind for track in result.tracks]
    if variant == "multiple_audio":
        assert kinds == ["audio", "audio"]
    if variant == "subtitle":
        assert "subtitle" in kinds


def test_scan_cancels_and_stops_reporting_progress(media_tools, tmp_path):
    from tuck.cutting.analysis import CutAnalysisError

    source = create_source(media_tools, tmp_path / "source.mp4")
    cancel = Event()

    def progress(update):
        if update.coverage_end.seconds > 0:
            cancel.set()

    with pytest.raises(CutAnalysisError, match="cancelled"):
        analyzer()(source, cancel, progress, ffprobe=media_tools.ffprobe)


def test_source_identity_detects_replacement_with_preserved_size_and_time(tmp_path):
    import os

    from tuck.cutting.analysis import source_identity

    path = tmp_path / "source.mp4"
    path.write_bytes(b"a" * 1024)
    first = source_identity(path, Event())
    path.write_bytes(b"b" * 1024)
    os.utime(path, ns=(first.mtime_ns, first.mtime_ns))
    assert source_identity(path, Event()) != first


def test_media_time_serialization_keeps_large_ticks():
    from tuck.models.cutting import MediaTime

    time = MediaTime(2**53 + 17, 1, 90000)
    assert time.to_dict()["ticks"] == str(2**53 + 17)
    assert MediaTime.from_dict(time.to_dict()) == time
    for bad in (
        {"ticks": 4, "time_base_num": 1, "time_base_den": 30},
        {"ticks": "4", "time_base_num": 1, "time_base_den": 0},
    ):
        with pytest.raises(ValueError):
            MediaTime.from_dict(bad)


def test_source_change_during_scan_is_rejected(media_tools, tmp_path):
    from tuck.cutting.analysis import CutAnalysisError

    source = create_source(media_tools, tmp_path / "source.mp4")
    changed = False

    def progress(update):
        nonlocal changed
        if update.coverage_end.seconds > 0 and not changed:
            with source.open("ab") as output:
                output.write(b"changed")
            changed = True

    with pytest.raises(CutAnalysisError, match="changed"):
        analyzer()(source, Event(), progress, ffprobe=media_tools.ffprobe)


def test_async_service_replaces_work_and_ignores_late_progress(tmp_path):
    from tuck.cutting.analysis import check_cancel
    from tuck.cutting.service import CutAnalysisService
    from tuck.models.cutting import AnalysisProgress, MediaTime

    entered, release, exited = Event(), Event(), Event()
    path = tmp_path / "source.mp4"
    path.write_bytes(b"fixture")

    def scan(source, cancel, progress, identity):
        entered.set()
        assert release.wait(5)
        progress(AnalysisProgress(0.8, MediaTime(8)))
        exited.set()
        check_cancel(cancel)
        raise AssertionError("cancelled work continued")

    service = CutAnalysisService(scanner=scan)
    try:
        service.start(path, "first")
        assert entered.wait(5)
        assert service.cancel("first")
        release.set()
        assert exited.wait(5)
        snapshot = service.get(path)
        assert snapshot.status == "cancelled"
        assert snapshot.progress.progress != 0.8
    finally:
        release.set()
        service.close()


def test_analysis_resource_limit_is_a_blocked_result(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4")
    result = analyzer()(source, Event(), lambda _: None, ffprobe=media_tools.ffprobe, max_packets=3)
    assert result.issues[0].code == "unsupported_stream"


def test_packet_key_flag_does_not_substitute_for_an_idr():
    from tuck.cutting.analysis import has_idr

    assert not has_idr(b"\x00\x00\x00\x02\x61\x00", 4)
    assert not has_idr(b"\x00\x00\x00\x08\x65", 4)
    assert has_idr(b"\x00\x00\x00\x02\x65\x00", 4)


def test_analysis_cache_checks_content_and_tool_version(media_tools, tmp_path):
    import os

    from tuck.cutting.service import CutAnalysisService

    path = create_source(media_tools, tmp_path / "source.mp4")
    calls = []
    version = ["one"]

    def scan(source, cancel, progress, identity):
        calls.append(source)
        return analyzer()(source, cancel, progress, identity, ffprobe=media_tools.ffprobe)

    service = CutAnalysisService(scanner=scan, version=lambda: version[0])

    def run(work_id):
        service.start(path, work_id)
        with service._condition:
            assert service._condition.wait_for(
                lambda: service.get(path).status in {"ready", "failed"}, timeout=10
            )
        assert service.get(path).status == "ready"

    try:
        run("one")
        run("two")
        assert len(calls) == 1
        version[0] = "two"
        run("three")
        assert len(calls) == 2
        # trailing padding changes identity without changing decodability
        stat = path.stat()
        with path.open("ab") as output:
            output.write(b"\x00\x00\x00\x08free")
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        run("four")
        assert len(calls) == 3
        stat = path.stat()
        with path.open("r+b") as output:
            output.seek(-4, 2)
            output.write(b"skip")
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        run("five")
        assert len(calls) == 4
    finally:
        service.close()


def test_progress_from_an_old_scan_cannot_update_a_new_job(media_tools, tmp_path):
    from tuck.cutting.service import CutAnalysisService
    from tuck.models.cutting import AnalysisProgress, MediaTime

    path = create_source(media_tools, tmp_path / "source.mp4")
    callbacks = []

    def scan(source, cancel, progress, identity):
        callbacks.append(progress)
        return analyzer()(source, cancel, progress, identity, ffprobe=media_tools.ffprobe)

    service = CutAnalysisService(scanner=scan)
    try:
        for work_id in ("first", "second"):
            service.start(path, work_id)
            with service._condition:
                assert service._condition.wait_for(
                    lambda: service.get(path).status == "ready", timeout=10
                )
        callbacks[0](AnalysisProgress(0.25, MediaTime(99)))
        assert service.get(path).progress.progress == 1
    finally:
        service.close()


def test_rotation_metadata_is_inventoried_and_not_silently_ignored(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4")
    rotated = tmp_path / "rotated.mp4"
    media_tools.run(
        [
            "-v",
            "error",
            "-y",
            "-display_rotation:v:0",
            "90",
            "-i",
            str(source),
            "-c",
            "copy",
            str(rotated),
        ]
    )
    result = analyzer()(rotated, Event(), lambda _: None, ffprobe=media_tools.ffprobe)
    # rotation is kept by copying, so it is recorded rather than refused
    assert dict(result.streams[0].properties)["rotation"] == "90"
    assert result.issues == ()


def test_truncated_file_is_a_real_error(media_tools, tmp_path):
    from tuck.cutting.analysis import CutAnalysisError

    source = create_source(media_tools, tmp_path / "source.mp4")
    source.write_bytes(source.read_bytes()[: source.stat().st_size // 2])
    with pytest.raises(CutAnalysisError, match="metadata"):
        analyzer()(source, Event(), lambda _: None, ffprobe=media_tools.ffprobe)


def test_reading_keyframes_hashes_the_video_before_and_after_the_scan_only(
    media_tools, tmp_path, monkeypatch
):
    from tuck.cutting import analysis, service
    from tuck.cutting.service import CutAnalysisService

    path = create_source(media_tools, tmp_path / "source.mp4")
    hashes = []
    identity = analysis.source_identity

    def counted(source, cancel):
        hashes.append(source)
        return identity(source, cancel)

    monkeypatch.setattr(analysis, "source_identity", counted)
    monkeypatch.setattr(service, "source_identity", counted)

    def scan(source, cancel, progress, known):
        return analysis.analyze_source(source, cancel, progress, known, ffprobe=media_tools.ffprobe)

    cut_service = CutAnalysisService(scanner=scan)
    try:
        cut_service.start(path, "only")
        with cut_service._condition:
            assert cut_service._condition.wait_for(
                lambda: cut_service.get(path).status in {"ready", "failed"}, timeout=10
            )
        assert cut_service.get(path).status == "ready"
        assert len(hashes) == 2
    finally:
        cut_service.close()


def test_new_request_cancels_running_work_before_the_next_scan(media_tools, tmp_path):
    from tuck.cutting.analysis import check_cancel
    from tuck.cutting.service import CutAnalysisService

    path = create_source(media_tools, tmp_path / "source.mp4")
    entered, release = Event(), Event()
    calls = []

    def scan(source, cancel, progress, identity):
        calls.append(cancel)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
            check_cancel(cancel)
        return analyzer()(source, cancel, progress, identity, ffprobe=media_tools.ffprobe)

    service = CutAnalysisService(scanner=scan)
    try:
        service.start(path, "old")
        assert entered.wait(5)
        service.start(path, "new")
        assert calls[0].is_set()
        release.set()
        with service._condition:
            assert service._condition.wait_for(
                lambda: service.get(path).status == "ready", timeout=10
            )
        assert len(calls) == 2
        assert service.get(path).work_id == "new"
        assert not service.cancel("old")
    finally:
        release.set()
        service.close()


def test_cancelling_metadata_read_reaps_its_child_process(monkeypatch):
    import subprocess
    import sys
    from pathlib import Path
    from threading import Thread

    from tuck.cutting import analysis

    real_popen = subprocess.Popen
    cancel, entered = Event(), Event()
    children, errors = [], []

    def launch(_command, **kwargs):
        child = real_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        children.append(child)
        entered.set()
        return child

    def read():
        try:
            analysis.read_inventory(Path("fixture.mp4"), cancel, "fixture-ffprobe")
        except analysis.CutAnalysisError as exc:
            errors.append(exc.code)

    monkeypatch.setattr(analysis.subprocess, "Popen", launch)
    worker = Thread(target=read)
    worker.start()
    try:
        assert entered.wait(5)
        cancel.set()
        worker.join(5)
        assert not worker.is_alive()
        assert children[0].poll() is not None
        assert errors == ["analysis_cancelled"]
    finally:
        cancel.set()
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait()
        worker.join(5)


def test_cache_never_uses_identity_from_before_a_replacement(media_tools, tmp_path):
    import os

    from tuck.cutting.analysis import source_identity
    from tuck.cutting.service import CutAnalysisService

    path = create_source(media_tools, tmp_path / "source.mp4", duration=3)
    with path.open("ab") as output:
        output.write(b"\x00\x00\x00\x08free")
    original = path.read_bytes()
    original_identity = source_identity(path, Event())
    calls = []

    def scan(source, cancel, progress, identity):
        calls.append(source)
        if len(calls) == 1:
            source.write_bytes(original[:-4] + b"skip")
            os.utime(source, ns=(original_identity.mtime_ns, original_identity.mtime_ns))
        return analyzer()(source, cancel, progress, identity, ffprobe=media_tools.ffprobe)

    service = CutAnalysisService(scanner=scan)

    def run(work_id):
        service.start(path, work_id)
        with service._condition:
            assert service._condition.wait_for(
                lambda: service.get(path).status in {"ready", "failed"}, timeout=10
            )
        return service.get(path)

    try:
        changed = run("changed")
        assert changed.status == "failed"
        assert changed.issue.code == "source_changed"
        path.write_bytes(original)
        os.utime(path, ns=(original_identity.mtime_ns, original_identity.mtime_ns))
        restored = run("restored")
        assert restored.status == "ready"
        assert restored.analysis.identity == original_identity
        assert len(calls) == 2
    finally:
        service.close()


def test_irregular_aac_timing_is_marked_as_not_checked(media_tools, tmp_path):
    source = create_source(media_tools, tmp_path / "source.mp4", duration=6)
    irregular = tmp_path / "irregular.mp4"
    media_tools.run(
        [
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-c:v",
            "copy",
            "-af",
            "asetpts=PTS+gte(T\\,2)/TB",
            "-c:a",
            "aac",
            str(irregular),
        ]
    )
    result = analyzer()(irregular, Event(), lambda _: None, ffprobe=media_tools.ffprobe)
    assert result.issues == ()
    assert any(note.code == "unverified_audio" for note in result.unverified)


def test_faststart_video_truncated_at_packet_boundary_is_marked_incomplete(media_tools, tmp_path):
    import av

    source = create_source(
        media_tools, tmp_path / "source.mp4", duration=6, audio=False, b_frames=0
    )
    faststart = tmp_path / "faststart.mp4"
    media_tools.run(
        [
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(faststart),
        ]
    )
    with av.open(str(faststart)) as container:
        packets = [p for p in container.demux(video=0) if p.size]
        packet = packets[89]
        boundary = packet.pos + packet.size
    faststart.write_bytes(faststart.read_bytes()[:boundary])
    result = analyzer()(faststart, Event(), lambda _: None, ffprobe=media_tools.ffprobe)
    # the frames that exist can be cut, but the file is not taken for a shorter complete video
    assert result.duration.seconds == 3
    assert any(note.code == "unverified_end" for note in result.unverified)


def test_metadata_limit_stops_a_running_probe(monkeypatch):
    import subprocess
    import sys
    from pathlib import Path
    from threading import Thread

    from tuck.cutting import analysis

    real_popen = subprocess.Popen
    cancel, entered = Event(), Event()
    children, failures = [], []

    def launch(_command, **kwargs):
        child = real_popen(
            [
                sys.executable,
                "-c",
                "import sys,time; sys.stdout.write('x'*4096); sys.stdout.flush(); time.sleep(30)",
            ],
            **kwargs,
        )
        children.append(child)
        entered.set()
        return child

    def read():
        try:
            analysis.read_inventory(Path("fixture.mp4"), cancel, "fixture-ffprobe")
        except analysis.CutAnalysisError as exc:
            failures.append(str(exc))

    monkeypatch.setattr(analysis, "MAX_METADATA_BYTES", 1024, raising=False)
    monkeypatch.setattr(analysis.subprocess, "Popen", launch)
    worker = Thread(target=read)
    worker.start()
    try:
        assert entered.wait(5)
        worker.join(5)
        assert not worker.is_alive()
        assert children[0].poll() is not None
        assert failures and "metadata" in failures[0]
    finally:
        cancel.set()
        worker.join(5)
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait()


@pytest.mark.parametrize(
    ("name", "options"),
    [
        ("source.mp4", {}),
        ("offset.mp4", {"offset": 7}),
        ("hevc.mov", {"variant": "hevc"}),
        ("vfr.mp4", {"variant": "vfr"}),
        ("source.mkv", {}),
    ],
)
def test_keyframe_preview_finds_the_same_keyframes_as_the_checked_scan(
    media_tools, tmp_path, name, options
):
    from tuck.cutting.timeline import read_timeline, sweep_keyframes

    path = create_source(media_tools, tmp_path / name, duration=6, gop=30, **options)
    reports = []
    sweep_keyframes(str(path), lambda: False, lambda keys, reached: reports.append((keys, reached)))
    checked = read_timeline(str(path), Event())
    assert reports, "the preview reports at least once"
    keys, reached = reports[-1]
    assert keys == checked.video.keyframes
    assert reached > 0


def test_mp4_keyframes_come_from_its_index_in_one_report(media_tools, tmp_path):
    from tuck.cutting.timeline import sweep_keyframes

    path = create_source(media_tools, tmp_path / "source.mp4", duration=20, gop=30)
    reports = []
    sweep_keyframes(str(path), lambda: False, lambda keys, reached: reports.append((keys, reached)))
    assert len(reports) == 1
    assert len(reports[0][0]) == 20


def test_keyframe_preview_is_right_when_the_index_is_shifted(media_tools, tmp_path):
    from tuck.cutting.timeline import read_timeline, sweep_keyframes

    source = create_source(media_tools, tmp_path / "source.mp4", duration=8, gop=30)
    trimmed = tmp_path / "trimmed.mp4"
    # a copy that starts between keyframes gets an edit list, so its index and frame times differ
    media_tools.run(
        ["-v", "error", "-y", "-ss", "2.1", "-i", str(source), "-c", "copy", str(trimmed)]
    )
    reports = []
    sweep_keyframes(
        str(trimmed), lambda: False, lambda keys, reached: reports.append((keys, reached))
    )
    assert reports[-1][0] == read_timeline(str(trimmed), Event()).video.keyframes


def test_file_hash_covers_every_piece_in_order(tmp_path, monkeypatch):
    import hashlib

    from tuck.cutting import analysis

    monkeypatch.setattr(analysis, "HASH_PIECE_BYTES", 4096)
    # enough pieces to keep every hashing thread busy, and a short last piece
    data = bytes(range(256)) * 400 + b"tail"
    path = tmp_path / "source.bin"
    path.write_bytes(data)
    pieces = b"".join(
        hashlib.sha256(data[start : start + 4096]).digest() for start in range(0, len(data), 4096)
    )
    identity = analysis.source_identity(path, Event())
    assert identity.signature == hashlib.sha256(pieces).hexdigest()
    path.write_bytes(data[:-1] + b"T")
    assert analysis.source_identity(path, Event()).signature != identity.signature


def test_keyframes_show_while_the_video_is_still_being_hashed(media_tools, tmp_path, monkeypatch):
    from tuck.cutting import service
    from tuck.cutting.service import CutAnalysisService

    path = create_source(media_tools, tmp_path / "source.mp4", duration=6)
    hashing, release = Event(), Event()
    identity = service.source_identity

    def slow_hash(source, cancel):
        hashing.set()
        assert release.wait(10)
        return identity(source, cancel)

    monkeypatch.setattr(service, "source_identity", slow_hash)
    cut_service = CutAnalysisService(
        scanner=lambda source, cancel, progress, known: analyzer()(
            source, cancel, progress, known, ffprobe=media_tools.ffprobe
        )
    )
    try:
        cut_service.start(path, "preview")
        assert hashing.wait(10)
        # progress is a snapshot rather than an event, so read it until keyframes appear
        deadline = time.monotonic() + 10
        while not cut_service.get(path).progress.keyframes and time.monotonic() < deadline:
            time.sleep(0.02)
        assert cut_service.get(path).progress.keyframes
        assert cut_service.get(path).status == "reading"
        release.set()
        with cut_service._condition:
            assert cut_service._condition.wait_for(
                lambda: cut_service.get(path).status in {"ready", "failed"}, timeout=10
            )
        assert cut_service.get(path).status == "ready"
    finally:
        release.set()
        cut_service.close()


def test_a_pass_that_is_behind_cannot_take_keyframes_back(tmp_path):
    from tuck.cutting.service import CutAnalysisService
    from tuck.models.cutting import AnalysisProgress, MediaTime

    path = tmp_path / "source.mp4"
    path.write_bytes(b"fixture")
    previewed, checked, release = Event(), Event(), Event()

    def preview(source, stopped, progress):
        progress(AnalysisProgress(0.5, MediaTime(10), (MediaTime(0), MediaTime(4), MediaTime(8))))
        previewed.set()

    def scan(source, cancel, progress, known):
        assert previewed.wait(5)
        progress(AnalysisProgress(0.1, MediaTime(2), (MediaTime(0),)))
        checked.set()
        assert release.wait(5)
        raise AssertionError("released")

    cut_service = CutAnalysisService(scanner=scan, previewer=preview)
    try:
        cut_service.start(path, "only")
        assert checked.wait(5)
        shown = cut_service.get(path).progress
        assert shown.coverage_end == MediaTime(10)
        assert len(shown.keyframes) == 3
        # the bar follows the checked scan, which is what export waits for
        assert shown.progress == 0.1
    finally:
        release.set()
        cut_service.close()
