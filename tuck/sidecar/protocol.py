from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TypeAlias

PROTOCOL_VERSION = 1

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]

_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]*$")


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str, request_id: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.request_id = request_id


class _DuplicateFieldError(ValueError):
    pass


@dataclass(frozen=True)
class Request:
    request_id: str
    method: str
    params: dict[str, object]


@dataclass(frozen=True)
class Error:
    code: str
    message: str
    details: dict[str, JsonValue]


@dataclass(frozen=True)
class Response:
    request_id: str
    ok: bool
    result: JsonValue | None = None
    error: Error | None = None

    @classmethod
    def success(cls, request_id: str, result: JsonValue) -> Response:
        return cls(request_id=request_id, ok=True, result=result)

    @classmethod
    def failure(
        cls,
        request_id: str,
        *,
        code: str,
        message: str,
        details: dict[str, JsonValue] | None = None,
    ) -> Response:
        return cls(
            request_id=request_id,
            ok=False,
            error=Error(code=code, message=message, details=details or {}),
        )


@dataclass(frozen=True)
class Event:
    event: str
    payload: dict[str, JsonValue]


def parse_request(line: str, expected_protocol: int = PROTOCOL_VERSION) -> Request:
    try:
        raw = json.loads(line, object_pairs_hook=_object_without_duplicate_fields)
    except _DuplicateFieldError as exc:
        raise ProtocolError("INVALID_REQUEST", "Request fields must not be duplicated.") from exc
    except json.JSONDecodeError as exc:
        raise ProtocolError("INVALID_REQUEST", "Request must be valid JSON.") from exc
    if not isinstance(raw, dict):
        raise ProtocolError("INVALID_REQUEST", "Request must be an object.")

    raw_id = raw.get("id")
    request_id = raw_id if isinstance(raw_id, str) else ""
    expected_fields = {"kind", "protocol", "id", "method", "params"}
    if set(raw) != expected_fields:
        raise ProtocolError("INVALID_REQUEST", "Request fields are invalid.", request_id)
    if raw["kind"] != "request":
        raise ProtocolError("INVALID_REQUEST", "Request kind is invalid.", request_id)
    protocol = raw["protocol"]
    if isinstance(protocol, bool) or not isinstance(protocol, int):
        raise ProtocolError("INVALID_REQUEST", "Request protocol is invalid.", request_id)
    if protocol != expected_protocol:
        raise ProtocolError("PROTOCOL_MISMATCH", "Protocol version is not supported.", request_id)
    if not request_id:
        raise ProtocolError("INVALID_REQUEST", "Request id must be a non-empty string.")
    method = raw["method"]
    if not isinstance(method, str) or not method:
        raise ProtocolError(
            "INVALID_REQUEST", "Request method must be a non-empty string.", request_id
        )
    params = raw["params"]
    if not isinstance(params, dict) or not _is_json_value(params):
        raise ProtocolError("INVALID_REQUEST", "Request params must be an object.", request_id)
    return Request(request_id=request_id, method=method, params=params)


def encode_response(response: Response) -> str:
    if not response.request_id:
        raise ValueError("Response id must be a non-empty string.")
    if response.ok:
        if response.error is not None or not _is_json_value(response.result):
            raise ValueError("Response result must be JSON-compatible.")
        frame: dict[str, JsonValue] = {
            "kind": "response",
            "protocol": PROTOCOL_VERSION,
            "id": response.request_id,
            "ok": True,
            "result": response.result,
        }
    else:
        if response.result is not None or response.error is None:
            raise ValueError("Error response must contain one error.")
        if not _ERROR_CODE.fullmatch(response.error.code) or not _is_json_value(
            response.error.details
        ):
            raise ValueError("Response error is invalid.")
        frame = {
            "kind": "response",
            "protocol": PROTOCOL_VERSION,
            "id": response.request_id,
            "ok": False,
            "error": {
                "code": response.error.code,
                "message": response.error.message,
                "details": response.error.details,
            },
        }
    return _encode_frame(frame)


def encode_event(event: Event) -> str:
    if event.event not in {"backend_ready", "backend_fatal"} or not _is_json_value(event.payload):
        raise ValueError("Event is invalid.")
    return _encode_frame(
        {
            "kind": "event",
            "protocol": PROTOCOL_VERSION,
            "event": event.event,
            "payload": event.payload,
        }
    )


def _encode_frame(frame: dict[str, JsonValue]) -> str:
    try:
        return json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise ValueError("Protocol frame must be JSON-compatible.") from exc


def _object_without_duplicate_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateFieldError(key)
        result[key] = value
    return result


def _is_json_value(value: object) -> bool:
    if value is None or isinstance(value, (str, int, float, bool)):
        return not isinstance(value, float) or (
            value == value and value not in (float("inf"), float("-inf"))
        )
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False
