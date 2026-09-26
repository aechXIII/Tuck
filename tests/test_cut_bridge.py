import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.bridge import BridgeAPI
from tuck.models.cutting import MediaTime
from tuck.sidecar.handlers import dispatch
from tuck.sidecar.protocol import Request


@pytest.fixture
def api(tmp_path):
    from tuck.cutting.service import CutAnalysisService

    value = BridgeAPI.__new__(BridgeAPI)
    value._cut_analysis = CutAnalysisService()
    value._resolve_profile = lambda _: pytest.fail(
        "Cut requests must not resolve an encoding profile"
    )
    yield value
    value._cut_analysis.close()


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
    assert preview["data"]["exact_available"] is False
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


def test_unknown_operations_and_premature_cut_enqueue_never_encode(api):
    assert not api.create_plan({"operation": "unknown"})["ok"]
    assert not api.enqueue_with_options({"operation": "cut"})["ok"]
    assert not api.enqueue_with_options({"operation": "unknown"})["ok"]
