import pytest
from media.cut_fixtures import create_source, find_tools

from tuck import request_work
from tuck.bridge import BridgeAPI
from tuck.cutting.exact import encoder_supports
from tuck.models.cutting import MediaTime
from tuck.sidecar.handlers import dispatch
from tuck.sidecar.protocol import Request


@pytest.fixture
def api(tmp_path, monkeypatch):
    import tuck.settings as settings
    from tuck.cutting.service import CutAnalysisService

    monkeypatch.setattr(settings, "_settings_manager", None)
    monkeypatch.setattr(settings, "_storage_root", tmp_path / "storage")
    value = BridgeAPI.__new__(BridgeAPI)
    value._settings = settings.get_settings_manager()
    value._cut_analysis = CutAnalysisService()
    from tuck.queue import ProcessingQueue

    value._queue = ProcessingQueue()
    value._resolve_profile = lambda _: pytest.fail(
        "Cut requests must not resolve an encoding profile"
    )
    yield value
    value._cut_analysis.close()
    value._queue.stop()


def test_cut_analysis_allowlist_validates_arguments_before_calling_api(api):
    bad = dispatch(api, Request("bad", "analyze_cut", {"path": "source.mp4", "work_id": 4}))
    assert not bad.ok
    assert bad.error.code == "INVALID_REQUEST"
    missing = dispatch(api, Request("missing", "get_cut_analysis", {"path": "source.mp4"}))
    assert missing.ok
    assert missing.result["status"] == "missing"
    cancelled = dispatch(api, Request("cancel", "cancel_cut_work", {"work_id": "never-started"}))
    assert cancelled.ok
    assert cancelled.result == {"cancelled": False}


def test_cut_plan_needs_analysis_and_preserves_domain_error_details(api, tmp_path):
    path = tmp_path / "source.mp4"
    path.write_bytes(b"fixture")
    request = {
        "operation": "cut",
        "source": str(path),
        "segments": [{"start": MediaTime(0).to_dict(), "end": MediaTime(1).to_dict()}],
        "_request_id": 42,
    }
    response = dispatch(api, Request("envelope", "create_plan", {"request": request}))
    assert not response.ok
    assert response.error.code == "ANALYSIS_REQUIRED"
    assert response.error.details["_request_id"] == 42
    assert response.error.details["field"] == "cut"


def test_real_analysis_and_profile_free_cut_preview_round_trip(api, tmp_path):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path / "żółć ' source.mp4")
    response = dispatch(
        api, Request("scan", "analyze_cut", {"path": str(source), "work_id": "scan-1"})
    )
    assert response.ok
    assert response.result["status"] == "pending"
    with api._cut_analysis._condition:
        assert api._cut_analysis._condition.wait_for(
            lambda: api._cut_analysis.get(source).status in {"ready", "failed"}, timeout=15
        )
    preview = api.create_plan(
        {
            "operation": "cut",
            "source": str(source),
            "segments": [{"start": MediaTime(0).to_dict(), "end": MediaTime(61, 1, 30).to_dict()}],
            "_request_id": 7,
        }
    )
    assert preview["ok"]
    assert preview["_request_id"] == 7
    assert preview["data"]["operation"] == "cut"
    assert preview["data"]["issues"] == []
    assert preview["data"]["exported_duration"] == MediaTime(61, 1, 30).to_dict()
    # the generated fixture is supported H.264, so only the encoder decides
    assert preview["data"]["exact_available"] is encoder_supports("libx264", "yuv420p")
    assert preview["data"]["segments"][0]["audio_source"] is not None
    with source.open("ab") as output:
        output.write(b"changed")
    stale = api.create_plan(
        {
            "operation": "cut",
            "source": str(source),
            "segments": [{"start": MediaTime(0).to_dict(), "end": MediaTime(1).to_dict()}],
        }
    )
    assert stale["code"] == "source_changed"


def test_unknown_operations_and_invalid_cut_enqueue_never_encode(api):
    assert not api.create_plan({"operation": "unknown"})["ok"]
    assert not api.enqueue_with_options({"operation": "cut"})["ok"]
    assert not api.enqueue_with_options({"operation": "unknown"})["ok"]


@pytest.fixture
def planned_cut(api, tmp_path, monkeypatch):
    from threading import Event

    from tuck.cutting.analysis import analyze_source

    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg is required")
    source = create_source(tools, tmp_path / "source.mp4", duration=4)
    analysis = analyze_source(source, Event(), lambda _: None, ffprobe=tools.ffprobe)
    monkeypatch.setattr(api._cut_analysis, "result", lambda _: analysis)
    request = {
        "operation": "cut",
        "source": str(source),
        "segments": [{"start": MediaTime(0).to_dict(), "end": MediaTime(2).to_dict()}],
    }
    preview = api.create_plan(request)["data"]
    return request, preview


def test_cut_enqueue_requires_the_current_fingerprint_and_returns_a_new_plan(api, planned_cut):
    request, preview = planned_cut
    stale = api.enqueue_with_options({**request, "plan_fingerprint": "0" * 64})
    assert not stale["ok"] and stale["code"] == "plan_changed"
    assert stale["current_plan"] == preview
    assert not api._queue.items
    response = dispatch(
        api,
        Request(
            "stale", "enqueue_with_options", {"request": {**request, "plan_fingerprint": "0" * 64}}
        ),
    )
    assert not response.ok and response.error.code == "PLAN_CHANGED"
    assert response.error.details["current_plan"] == preview
    response = dispatch(
        api,
        Request(
            "enqueue",
            "enqueue_with_options",
            {"request": {**request, "plan_fingerprint": preview["fingerprint"]}},
        ),
    )
    assert response.ok
    assert len(api._queue.items) == 1


def test_cut_output_name_follows_the_saved_suffix(api, planned_cut):
    from pathlib import Path

    request, preview = planned_cut
    assert Path(preview["output_path"]).name == "source_cut.mp4"

    assert api.save_settings({"cut_suffix": " trimmed"}) == {"ok": True}
    renamed = api.create_plan(request)["data"]
    assert Path(renamed["output_path"]).name == "source trimmed.mp4"

    # a plan reviewed under the old name no longer matches what export would write
    stale = api.enqueue_with_options({**request, "plan_fingerprint": preview["fingerprint"]})
    assert not stale["ok"] and stale["code"] == "plan_changed"
    assert stale["current_plan"] == renamed

    result = api.enqueue_with_options({**request, "plan_fingerprint": renamed["fingerprint"]})
    assert result["ok"]
    [item] = api._queue.items
    assert item.plan is not None
    assert Path(item.plan.output).name == "source trimmed.mp4"


def test_cut_batch_preserves_partial_success_and_rejected_plan(api, planned_cut):
    request, preview = planned_cut
    result = api.enqueue_batch(
        [
            {**request, "plan_fingerprint": "0" * 64},
            {**request, "plan_fingerprint": preview["fingerprint"]},
        ]
    )
    assert result["ok"] and result["count"] == 1
    assert result["rejections"][0]["index"] == 0
    assert result["rejections"][0]["current_plan"] == preview
    assert len(api._queue.items) == 1


@pytest.mark.parametrize("batch", [False, True])
def test_expired_cut_request_cannot_enqueue_after_hashing(api, planned_cut, monkeypatch, batch):
    from tuck.cutting import service

    request, preview = planned_cut
    request = {**request, "plan_fingerprint": preview["fingerprint"]}
    clock = [0.0]
    monkeypatch.setattr(request_work, "monotonic", lambda: clock[0])
    identity = service.source_identity

    def slow_hash(path, cancel):
        result = identity(path, cancel)
        clock[0] += 61.0 if batch else 121.0
        return result

    monkeypatch.setattr(service, "source_identity", slow_hash)
    if batch:
        result = api.enqueue_batch([request, request, request])
        assert result["ok"] and result["count"] == 1
        assert len(api._queue.items) == 1
        assert all(r["code"] == "cut_timed_out" for r in result["rejections"])
    else:
        result = api.enqueue_with_options(request)
        assert not result["ok"] and result["code"] == "cut_timed_out"
        assert not api._queue.items


def test_cut_enqueue_hashes_the_source_even_when_its_stat_is_unchanged(api, planned_cut):
    import os
    from pathlib import Path

    request, preview = planned_cut
    path = Path(request["source"])
    original = path.stat()
    data = bytearray(path.read_bytes())
    data[-1] ^= 1
    path.write_bytes(data)
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
    result = api.enqueue_with_options({**request, "plan_fingerprint": preview["fingerprint"]})
    assert not result["ok"] and result["code"] == "source_changed"
    assert not api._queue.items


def test_expired_sidecar_work_is_not_restarted_by_dispatch(api, planned_cut, monkeypatch):

    request, preview = planned_cut
    clock = [0.0]
    monkeypatch.setattr(request_work, "monotonic", lambda: clock[0])
    work = request_work.RequestWork()
    clock[0] = 121.0
    response = dispatch(
        api,
        Request(
            "expired",
            "enqueue_with_options",
            {
                "request": {**request, "plan_fingerprint": preview["fingerprint"]},
            },
        ),
        work,
    )
    assert not response.ok and response.error.code == "CUT_TIMED_OUT"
    assert not api._queue.items


def test_compress_batches_are_not_held_to_the_cut_preparation_time(api, planned_cut, monkeypatch):
    request, _ = planned_cut
    clock = [0.0]
    monkeypatch.setattr(request_work, "monotonic", lambda: clock[0])
    from tuck.models import EncodePlan

    # only the batch control flow is under test, so encode planning is stubbed
    monkeypatch.setattr(api, "_resolve_profile", lambda _: object())
    monkeypatch.setattr(api, "_planning_options", lambda: None)
    monkeypatch.setattr(
        api,
        "_build_plan",
        lambda req, *_: EncodePlan(source=req.source, output=req.source + ".out.mp4"),
    )
    work = request_work.RequestWork()
    clock[0] = 121.0
    result = api.enqueue_batch([{"source": request["source"]}] * 2, work=work)
    assert result["ok"] and result["count"] == 2, result
    assert result["errors"] == []


def test_expired_request_stops_source_hashing(planned_cut, monkeypatch):
    from pathlib import Path

    from tuck.cutting import analysis

    request, _ = planned_cut
    clock = [0.0]
    monkeypatch.setattr(request_work, "monotonic", lambda: clock[0])
    work = request_work.RequestWork()
    clock[0] = 91.0
    with pytest.raises(analysis.CutAnalysisError) as error:
        analysis.source_identity(Path(request["source"]), work)
    assert error.value.code == "cut_timed_out"


@pytest.mark.parametrize("fingerprint", [None, 3, "", "g" * 64, "a" * 63])
def test_cut_enqueue_rejects_missing_or_malformed_fingerprints(api, planned_cut, fingerprint):
    request, _ = planned_cut
    response = api.enqueue_with_options({**request, "plan_fingerprint": fingerprint})
    assert not response["ok"]
    assert response["code"] == "invalid_cut_request"
    assert not api._queue.items


def test_every_cut_error_code_reaches_the_desktop_app():
    import ast
    from pathlib import Path

    import tuck.cutting
    from tuck.models.cutting import CUT_ERROR_CODES

    raised = set()
    for path in Path(tuck.cutting.__file__).parent.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "CutAnalysisError"
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                raised.add(node.args[0].value)
    # an unlisted code would reach the app as a generic failure
    assert raised and raised <= CUT_ERROR_CODES, raised - CUT_ERROR_CODES


def _reading_snapshot(count, revision=7):
    from tuck.cutting.service import AnalysisSnapshot
    from tuck.models.cutting import AnalysisProgress

    keyframes = tuple(MediaTime(n, 1, 30) for n in range(count))
    progress = AnalysisProgress(0.5, MediaTime(count, 1, 30), keyframes)
    return AnalysisSnapshot("scan-1", "reading", progress, keyframes_revision=revision)


def test_keyframes_go_out_a_page_at_a_time_from_the_readers_cursor():
    from tuck.cutting.serialization import KEYFRAME_PAGE, KeyframeCursor, analysis_snapshot_dict

    snapshot = _reading_snapshot(KEYFRAME_PAGE + 10)

    first = analysis_snapshot_dict(snapshot)
    assert (first["keyframes_revision"], first["keyframes_from"]) == (7, 0)
    assert first["keyframe_count"] == KEYFRAME_PAGE + 10
    assert len(first["keyframes"]) == KEYFRAME_PAGE
    rest = analysis_snapshot_dict(snapshot, KeyframeCursor(7, KEYFRAME_PAGE))
    assert rest["keyframes_from"] == KEYFRAME_PAGE
    assert rest["keyframes"] == [
        MediaTime(n, 1, 30).to_dict() for n in range(KEYFRAME_PAGE, KEYFRAME_PAGE + 10)
    ]
    held = analysis_snapshot_dict(snapshot, KeyframeCursor(7, KEYFRAME_PAGE + 10))
    assert held["keyframes"] == [] and held["keyframes_from"] == KEYFRAME_PAGE + 10
    # a cursor for a list that has since been replaced, or past its end, starts over
    for stale in (KeyframeCursor(6, 5), KeyframeCursor(7, KEYFRAME_PAGE + 11)):
        restart = analysis_snapshot_dict(snapshot, stale)
        assert restart["keyframes_from"] == 0
        assert len(restart["keyframes"]) == KEYFRAME_PAGE


def test_status_reads_of_an_all_intra_video_stay_under_the_frame_limit(api, monkeypatch):
    from tuck.sidecar.protocol import encode_response, frame_fits

    # one keyframe per frame for half an hour at 60 fps, about 6 MB as one list
    snapshot = _reading_snapshot(108_000)
    monkeypatch.setattr(api._cut_analysis, "get", lambda _: snapshot)
    cursor = {"keyframes_revision": 7, "keyframes_from": 0}
    received = []
    while True:
        response = dispatch(
            api, Request("poll", "get_cut_analysis", {"path": "source.mp4", **cursor})
        )
        assert response.ok and frame_fits(encode_response(response))
        assert response.result["keyframes_from"] == len(received)
        if not response.result["keyframes"]:
            break
        received.extend(response.result["keyframes"])
        cursor["keyframes_from"] = len(received)
    assert len(received) == response.result["keyframe_count"] == 108_000


@pytest.mark.parametrize(
    "params",
    [
        {"path": "source.mp4", "keyframes_from": 3},
        {"path": "source.mp4", "keyframes_revision": 1},
        {"path": "source.mp4", "keyframes_revision": 1, "keyframes_from": -1},
        {"path": "source.mp4", "keyframes_revision": True, "keyframes_from": 0},
        {"path": "source.mp4", "keyframes_revision": 1, "keyframes_from": "4"},
        {"path": "source.mp4", "keyframes_revision": 1, "keyframes_from": 0, "extra": 1},
        {"path": 4, "keyframes_revision": 1, "keyframes_from": 0},
    ],
)
def test_keyframe_cursor_is_validated_before_calling_api(api, params):
    response = dispatch(api, Request("bad", "get_cut_analysis", params))
    assert not response.ok
    assert response.error.code == "INVALID_REQUEST"


def test_a_replaced_keyframe_list_gets_a_new_revision(tmp_path):
    from threading import Event

    from tuck.cutting.service import CutAnalysisService
    from tuck.models.cutting import AnalysisProgress

    path = tmp_path / "source.mp4"
    path.write_bytes(b"fixture")
    step, release = Event(), Event()
    reports = []

    def scan(source, cancel, progress, known):
        for report in reports:
            progress(report)
            step.set()
            assert release.wait(5)
            release.clear()
        raise AssertionError("released")

    seconds = [MediaTime(n) for n in range(4)]
    reports.extend(
        [
            AnalysisProgress(0.1, MediaTime(1), (seconds[0],)),
            # the same pass with more keyframes on the end
            AnalysisProgress(0.2, MediaTime(2), (seconds[0], seconds[1])),
            # a different list, such as the checked scan overtaking the preview
            AnalysisProgress(0.3, MediaTime(3), (seconds[0], seconds[2], seconds[3])),
        ]
    )
    service = CutAnalysisService(scanner=scan, previewer=lambda *_: None)
    revisions = []
    try:
        started = service.start(path, "only").keyframes_revision
        for _ in reports:
            assert step.wait(5)
            step.clear()
            revisions.append(service.get(path).keyframes_revision)
            release.set()
    finally:
        release.set()
        service.close()
    assert revisions[0] == revisions[1] == started
    assert revisions[2] != started


def test_a_read_ahead_says_so_and_anything_else_is_refused(api, monkeypatch, tmp_path):
    path = tmp_path / "source.mp4"
    path.write_bytes(b"fixture")
    calls = []

    def start(source, work_id, *, background):
        calls.append((work_id, background))
        return api._cut_analysis.get(source)

    monkeypatch.setattr(api._cut_analysis, "start", start)
    for work_id, extra in (("screen", {}), ("ahead", {"background": True})):
        response = dispatch(
            api, Request(work_id, "analyze_cut", {"path": str(path), "work_id": work_id, **extra})
        )
        assert response.ok
    assert calls == [("screen", False), ("ahead", True)]
    for background in (1, "yes", None):
        bad = dispatch(
            api,
            Request(
                "bad",
                "analyze_cut",
                {"path": str(path), "work_id": "x", "background": background},
            ),
        )
        assert bad.error.code == "INVALID_REQUEST"
