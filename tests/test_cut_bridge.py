import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.bridge import BridgeAPI
from tuck.cutting.exact import encoder_supports
from tuck.models.cutting import MediaTime
from tuck.sidecar.handlers import dispatch
from tuck.sidecar.protocol import Request


@pytest.fixture
def api(tmp_path):
    from tuck.cutting.service import CutAnalysisService

    value = BridgeAPI.__new__(BridgeAPI)
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
    from tuck.cutting import analysis, service

    request, preview = planned_cut
    request = {**request, "plan_fingerprint": preview["fingerprint"]}
    clock = [0.0]
    monkeypatch.setattr(analysis, "monotonic", lambda: clock[0], raising=False)
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
    from tuck.cutting import analysis

    request, preview = planned_cut
    clock = [0.0]
    monkeypatch.setattr(analysis, "monotonic", lambda: clock[0])
    work = analysis.CutRequestWork()
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


def test_expired_request_stops_source_hashing(planned_cut, monkeypatch):
    from pathlib import Path

    from tuck.cutting import analysis

    request, _ = planned_cut
    clock = [0.0]
    monkeypatch.setattr(analysis, "monotonic", lambda: clock[0])
    work = analysis.CutRequestWork()
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
