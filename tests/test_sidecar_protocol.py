from __future__ import annotations

import json
from pathlib import Path

import pytest

from tuck.sidecar.protocol import (
    PROTOCOL_VERSION,
    Event,
    ProtocolError,
    Response,
    encode_event,
    encode_response,
    parse_request,
)


def test_request_round_trip_preserves_unicode_id_and_compact_success_frame() -> None:
    request = parse_request(
        '{"kind":"request","protocol":1,"id":"żółw-01","method":"health","params":{}}'
    )

    frame = encode_response(Response.success(request.request_id, {"status": "ok"}))

    assert request.request_id == "żółw-01"
    assert "\n" not in frame
    assert json.loads(frame) == {
        "kind": "response",
        "protocol": PROTOCOL_VERSION,
        "id": "żółw-01",
        "ok": True,
        "result": {"status": "ok"},
    }


def test_error_frame_preserves_request_id_and_uses_a_stable_safe_code() -> None:
    frame = encode_response(
        Response.failure(
            "request-7",
            code="INVALID_PATH",
            message="The selected file does not exist.",
            details={"field": "path"},
        )
    )

    assert json.loads(frame) == {
        "kind": "response",
        "protocol": 1,
        "id": "request-7",
        "ok": False,
        "error": {
            "code": "INVALID_PATH",
            "message": "The selected file does not exist.",
            "details": {"field": "path"},
        },
    }


def test_readiness_event_is_a_valid_first_protocol_frame() -> None:
    frame = encode_event(
        Event(
            event="backend_ready",
            payload={"backend_version": "0.4.0", "pid": 123, "capabilities": {}},
        )
    )

    assert json.loads(frame) == {
        "kind": "event",
        "protocol": 1,
        "event": "backend_ready",
        "payload": {"backend_version": "0.4.0", "pid": 123, "capabilities": {}},
    }


@pytest.mark.parametrize(
    "line",
    [
        "not json",
        '{"kind":"request","protocol":1,"id":"one","method":"health"}',
        '{"kind":"request","protocol":1,"id":"one","method":"health","params":[],"extra":true}',
        '{"kind":"request","protocol":1,"id":"","method":"health","params":{}}',
        '{"kind":"request","protocol":"1","id":"one","method":"health","params":{}}',
    ],
)
def test_invalid_request_envelopes_are_rejected_before_dispatch(line: str) -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_request(line)

    assert caught.value.code == "INVALID_REQUEST"


def test_protocol_mismatch_has_its_own_stable_error_code() -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_request('{"kind":"request","protocol":2,"id":"one","method":"health","params":{}}')

    assert caught.value.code == "PROTOCOL_MISMATCH"


def test_duplicate_request_fields_are_rejected_instead_of_being_silently_overwritten() -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_request(
            '{"kind":"request","protocol":1,"id":"first","id":"second",'
            '"method":"health","params":{}}'
        )

    assert caught.value.code == "INVALID_REQUEST"


def test_response_rejects_non_json_payloads_instead_of_contaminating_stdout() -> None:
    with pytest.raises(ValueError, match="JSON-compatible"):
        encode_response(Response.success("one", {"bad": object()}))


def test_machine_readable_schema_declares_all_protocol_frame_kinds() -> None:
    schema_path = Path("contracts/backend-protocol-v1.schema.json")

    schema = json.loads(schema_path.read_text(encoding="utf-8"))

    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert set(schema["$defs"]) >= {"request", "response", "event"}
