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

    def remove_item(self, item_id: str) -> dict[str, object]:
        self.calls.append(("remove_item", item_id))
        return {"ok": True}

    def get_queue_state(self) -> dict[str, object]:
        self.calls.append(("get_queue_state", None))
        return {"items": [], "current_id": None, "pending_ids": []}

    def get_storage_paths(self) -> dict[str, object]:
        self.calls.append(("get_storage_paths", None))
        return {"ok": True, "config_dir": "C:/Tuck/config", "log_dir": "C:/Tuck/data/logs"}

    def export_settings_to_file(self, path: str) -> dict[str, object]:
        self.calls.append(("export_settings_to_file", path))
        return {"ok": True}

    def import_settings_from_file(self, path: str) -> dict[str, object]:
        self.calls.append(("import_settings_from_file", path))
        return {"ok": True, "skipped": ["output_dir"]}

    def reset_settings(self) -> dict[str, object]:
        self.calls.append(("reset_settings", None))
        return {"ok": True}


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


def test_removing_a_finished_export_is_bound_through_the_allowlist() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("remove_item", {"item_id": "item-9"}))

    assert api.calls == [("remove_item", "item-9")]
    assert response.ok is True


def test_storage_paths_are_available_only_through_the_allowlisted_empty_request() -> None:
    api = RecordingApi()

    response = dispatch(api, _request("get_storage_paths", {}))

    assert api.calls == [("get_storage_paths", None)]
    assert response.ok is True
    assert response.result == {"config_dir": "C:/Tuck/config", "log_dir": "C:/Tuck/data/logs"}


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


def test_settings_backup_handlers_take_only_a_path() -> None:
    api = RecordingApi()

    exported = dispatch(api, _request("export_settings_to_file", {"path": "C:/backup.json"}))
    imported = dispatch(api, _request("import_settings_from_file", {"path": "C:/backup.json"}))
    reset = dispatch(api, _request("reset_settings", {}))

    assert api.calls == [
        ("export_settings_to_file", "C:/backup.json"),
        ("import_settings_from_file", "C:/backup.json"),
        ("reset_settings", None),
    ]
    assert exported.ok and reset.ok
    assert imported.result == {"skipped": ["output_dir"]}


def test_settings_backup_handlers_reject_extra_parameters() -> None:
    api = RecordingApi()

    for method, params in [
        ("export_settings_to_file", {"path": "C:/a.json", "profile_id": "x"}),
        ("import_settings_from_file", {"path": 4}),
        ("reset_settings", {"keep": True}),
    ]:
        response = dispatch(api, _request(method, params))
        assert response.ok is False

    assert api.calls == []


def test_refused_retry_keeps_its_code_for_the_page(monkeypatch) -> None:
    from tuck.bridge import BridgeAPI
    from tuck.queue import RETRY_REFUSAL_CODES, RetryRefused

    class RefusingQueue:
        def __init__(self, code: str) -> None:
            self.code = code

        def retry(self, item_id: str, *, work: object = None) -> None:
            raise RetryRefused(self.code, "This video changed after it was added to the queue.")

    def retry_refused_with(code: str):
        api = BridgeAPI.__new__(BridgeAPI)
        monkeypatch.setattr(api, "_queue", RefusingQueue(code), raising=False)
        response = dispatch(api, _request("retry_item", {"item_id": "item-1"}))
        assert response.ok is False
        assert response.error is not None
        return response.error

    assert {"source_changed", "source_unavailable"} == RETRY_REFUSAL_CODES
    for code in RETRY_REFUSAL_CODES:
        error = retry_refused_with(code)
        assert error.code == code.upper()
        assert error.message.startswith("This video changed")
    # only declared codes pass through
    assert retry_refused_with("disk_on_fire").code != "DISK_ON_FIRE"
