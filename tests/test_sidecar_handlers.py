from __future__ import annotations

import logging

from tuck.sidecar.handlers import dispatch
from tuck.sidecar.protocol import Request


class RecordingApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def probe_file(self, path: str) -> dict[str, object]:
        self.calls.append(("probe_file", path))
        return {"ok": True, "data": {"path": path}}

    def move_item(self, item_id: str, new_index: int) -> dict[str, object]:
        self.calls.append(("move_item", (item_id, new_index)))
        return {"ok": True}

    def cancel_item(self, item_id: str) -> dict[str, object]:
        self.calls.append(("cancel_item", item_id))
        return {"ok": True, "canceled_id": item_id}

    def get_queue_state(self) -> dict[str, object]:
        self.calls.append(("get_queue_state", None))
        return {"items": [], "current_id": None, "pending_ids": []}


def _request(method: str, params: dict[str, object], request_id: str = "request-1") -> Request:
    return Request(request_id=request_id, method=method, params=params)


def test_allowlisted_handler_binds_named_parameters_and_normalizes_legacy_success() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("move_item", {"item_id": "item-4", "new_index": 2}))

    assert api.calls == [("move_item", ("item-4", 2))]
    assert response.ok is True
    assert response.result == {}


def test_domain_handler_preserves_request_id_and_result_payload() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("probe_file", {"path": "C:/clip.mp4"}, "unicode-ą"))

    assert response.request_id == "unicode-ą"
    assert response.ok is True
    assert response.result == {"data": {"path": "C:/clip.mp4"}}


def test_unknown_method_never_invokes_the_api() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("delete_everything", {}))

    assert api.calls == []
    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "UNKNOWN_METHOD"


def test_malformed_params_never_invoke_the_api() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("move_item", {"item_id": "item-4", "new_index": "2"}))

    assert api.calls == []
    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "INVALID_REQUEST"


def test_cancellation_request_is_bound_through_the_allowlist() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("cancel_item", {"item_id": "item-4"}))

    assert api.calls == [("cancel_item", "item-4")]
    assert response.ok is True
    assert response.result == {"canceled_id": "item-4"}


def test_handler_exception_is_logged_and_mapped_without_leaking_its_message(caplog) -> None:
    class ExplodingApi(RecordingApi):
        def get_queue_state(self) -> dict[str, object]:
            raise RuntimeError("secret C:/Users/name/token")

    caplog.set_level(logging.ERROR)
    response = dispatch(ExplodingApi(), _request("get_queue_state", {}))

    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "INTERNAL_ERROR"
    assert response.error.message == "The backend could not complete the request."
    assert "secret C:/Users/name/token" not in response.error.message
    assert "Sidecar handler failed" in caplog.text


def test_handler_timeout_maps_to_the_stable_timeout_code() -> None:
    class TimeoutApi(RecordingApi):
        def get_queue_state(self) -> dict[str, object]:
            raise TimeoutError

    response = dispatch(TimeoutApi(), _request("get_queue_state", {}))

    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "BACKEND_TIMEOUT"


def test_missing_probe_path_uses_the_stable_invalid_path_code() -> None:
    class MissingFileApi(RecordingApi):
        def probe_file(self, path: str) -> dict[str, object]:
            return {"ok": False, "error": f"File not found: {path}"}

    response = dispatch(MissingFileApi(), _request("probe_file", {"path": "C:/missing.mp4"}))

    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "INVALID_PATH"


def test_malformed_legacy_success_flag_cannot_be_promoted_to_a_protocol_success() -> None:
    class MalformedApi(RecordingApi):
        def get_queue_state(self) -> dict[str, object]:
            return {"ok": "yes", "items": []}

    response = dispatch(MalformedApi(), _request("get_queue_state", {}))

    assert response.ok is False
    assert response.error is not None
    assert response.error.code == "INTERNAL_ERROR"
