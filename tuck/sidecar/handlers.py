from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING

from ..models.cutting import CUT_ERROR_CODES
from ..request_work import RequestWork
from ..sendto import SENDTO_KINDS
from .protocol import JsonValue, Request, Response

if TYPE_CHECKING:
    from ..bridge import BridgeAPI

logger = logging.getLogger(__name__)

Handler = Callable[["BridgeAPI", dict[str, object]], object]


def _handler_for(method: str, work: RequestWork | None) -> Handler | None:
    work_handler = _WORK_HANDLERS.get(method)
    if work_handler is None:
        return _HANDLERS.get(method)
    current = work or RequestWork()

    def run(api: BridgeAPI, params: dict[str, object]) -> object:
        return work_handler(api, params, current)

    return run


def dispatch(api: BridgeAPI, request: Request, work: RequestWork | None = None) -> Response:
    if request.method == "health":
        if request.params:
            return _invalid_params(request)
        return Response.success(request.request_id, {"status": "ok"})

    handler = _handler_for(request.method, work)
    if handler is None:
        return Response.failure(
            request.request_id,
            code="UNKNOWN_METHOD",
            message="The requested backend method is not available.",
        )
    try:
        value = handler(api, request.params)
    except _ParameterError:
        return _invalid_params(request)
    except TimeoutError:
        return Response.failure(
            request.request_id,
            code="BACKEND_TIMEOUT",
            message="The backend request timed out.",
        )
    except Exception:
        logger.exception("Sidecar handler failed: %s", request.method)
        return Response.failure(
            request.request_id,
            code="INTERNAL_ERROR",
            message="The backend could not complete the request.",
        )
    return _normalize_result(request, value)


class _ParameterError(ValueError):
    pass


def _invalid_params(request: Request) -> Response:
    return Response.failure(
        request.request_id,
        code="INVALID_REQUEST",
        message="Request parameters are invalid.",
        details={"method": request.method},
    )


def _normalize_result(request: Request, value: object) -> Response:
    if isinstance(value, dict):
        if "ok" in value:
            if value["ok"] is False:
                message = value.get("error")
                if not isinstance(message, str) or not message:
                    message = "The backend could not complete the request."
                field = value.get("field")
                details: dict[str, JsonValue] = {"method": request.method}
                if field in ("lut", "frame_blending", "cut"):
                    details["field"] = field
                if field == "cut" and isinstance(value.get("_request_id"), int):
                    details["_request_id"] = value["_request_id"]
                current_plan = value.get("current_plan")
                if (
                    field == "cut"
                    and isinstance(current_plan, dict)
                    and _is_json_value(current_plan)
                ):
                    details["current_plan"] = current_plan
                for key in ("rejections", "errors"):
                    entries = value.get(key)
                    if isinstance(entries, list) and _is_json_value(entries):
                        details[key] = entries
                cut_code = value.get("code")
                code = (
                    cut_code.upper()
                    if field == "cut" and isinstance(cut_code, str) and cut_code in CUT_ERROR_CODES
                    else _error_code(request.method, message)
                )
                return Response.failure(
                    request.request_id,
                    code=code,
                    message=message,
                    details=details,
                )
            if value["ok"] is not True:
                return Response.failure(
                    request.request_id,
                    code="INTERNAL_ERROR",
                    message="The backend returned an invalid response.",
                    details={"method": request.method},
                )
        result = {key: item for key, item in value.items() if key != "ok"}
        if _is_json_value(result):
            return Response.success(request.request_id, result)
    elif isinstance(value, list) and _is_json_value(value):
        return Response.success(request.request_id, value)
    return Response.failure(
        request.request_id,
        code="INTERNAL_ERROR",
        message="The backend returned an invalid response.",
        details={"method": request.method},
    )


def _error_code(method: str, message: str) -> str:
    lower = message.lower()
    if "file not found" in lower or "path" in lower:
        return "INVALID_PATH"
    if "ffprobe" in lower or method in {"probe_file", "probe_audio_file"}:
        return "PROBE_FAILED"
    if "ffmpeg" in lower:
        return "FFMPEG_UNAVAILABLE"
    if "not found" in lower:
        return "NOT_FOUND"
    if "queue" in lower:
        return "QUEUE_REJECTED"
    return "INTERNAL_ERROR"


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


def _empty(params: dict[str, object]) -> None:
    if params:
        raise _ParameterError


def _string(params: dict[str, object], name: str) -> str:
    if set(params) != {name}:
        raise _ParameterError
    value = params[name]
    if not isinstance(value, str):
        raise _ParameterError
    return value


def _object(params: dict[str, object], name: str) -> dict[str, object]:
    if set(params) != {name}:
        raise _ParameterError
    value = params[name]
    if not isinstance(value, dict):
        raise _ParameterError
    return value


def _probe_file(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.probe_file(_string(params, "path"))


def _probe_audio_file(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.probe_audio_file(_string(params, "path"))


def _get_waveform(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.get_waveform(_string(params, "path"))


def _get_thumbnail(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.get_thumbnail(_string(params, "path"))


def _get_media_url(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.get_media_url(_string(params, "path"))


def _release_media_token(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.release_media_token(_string(params, "token"))


def _create_plan(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.create_plan(_object(params, "request"))


def _enqueue_with_options(api: BridgeAPI, params: dict[str, object], work: RequestWork) -> object:
    return api.enqueue_with_options(_object(params, "request"), work=work)


def _enqueue_batch(api: BridgeAPI, params: dict[str, object], work: RequestWork) -> object:
    if set(params) != {"requests"} or not isinstance(params["requests"], list):
        raise _ParameterError
    return api.enqueue_batch(params["requests"], work=work)


def _cancel_item(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.cancel_item(_string(params, "item_id"))


def _cancel_all_items(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.cancel_all_items()


def _clear_completed(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.clear_completed()


def _move_item(api: BridgeAPI, params: dict[str, object]) -> object:
    if (
        set(params) != {"item_id", "new_index"}
        or not isinstance(params["item_id"], str)
        or isinstance(params["new_index"], bool)
        or not isinstance(params["new_index"], int)
    ):
        raise _ParameterError
    return api.move_item(params["item_id"], params["new_index"])


def _retry_item(api: BridgeAPI, params: dict[str, object], work: RequestWork) -> object:
    return api.retry_item(_string(params, "item_id"), work=work)


def _stop_after_current(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.stop_after_current()


def _get_queue_state(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.get_queue_state()


def _get_diagnostics(api: BridgeAPI, params: dict[str, object]) -> object:
    if not params:
        return api.get_diagnostics()
    return api.get_diagnostics(_object(params, "context"))


def _get_settings(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.get_settings()


def _get_storage_paths(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.get_storage_paths()


def _save_settings(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.save_settings(_object(params, "settings"))


def _refresh_encoders(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.refresh_encoders()


def _get_profiles_json(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.get_profiles_json()


def _create_profile(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.create_profile(_object(params, "profile"))


def _update_profile(api: BridgeAPI, params: dict[str, object]) -> object:
    if set(params) != {"profile_id", "profile"} or not isinstance(params["profile_id"], str):
        raise _ParameterError
    return api.update_profile(
        params["profile_id"], _object({"profile": params["profile"]}, "profile")
    )


def _delete_profile(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.delete_profile(_string(params, "profile_id"))


def _duplicate_profile(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.duplicate_profile(_string(params, "profile_id"))


def _import_profiles_from_file(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.import_profiles_from_file(_string(params, "path"))


def _export_profile_to_file(api: BridgeAPI, params: dict[str, object]) -> object:
    if (
        set(params) != {"path", "profile_id"}
        or not isinstance(params["path"], str)
        or not isinstance(params["profile_id"], str)
    ):
        raise _ParameterError
    return api.export_profile_to_file(params["path"], params["profile_id"])


def _sendto_kind(params: dict[str, object], *, allow_executable_path: bool) -> str:
    allowed = {"kind", "executable_path"} if allow_executable_path else {"kind"}
    kind = params.get("kind")
    if set(params) - allowed or not isinstance(kind, str) or kind not in SENDTO_KINDS:
        raise _ParameterError
    return kind


def _executable_path(params: dict[str, object]) -> str | None:
    exec_path = params.get("executable_path")
    if exec_path is not None and not isinstance(exec_path, str):
        raise _ParameterError
    return exec_path


def _install_generic_sendto(api: BridgeAPI, params: dict[str, object]) -> object:
    kind = _sendto_kind(params, allow_executable_path=True)
    return api.install_generic_sendto(kind, executable_path=_executable_path(params))


def _remove_generic_sendto(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.remove_generic_sendto(_sendto_kind(params, allow_executable_path=False))


def _repair_generic_sendto(api: BridgeAPI, params: dict[str, object]) -> object:
    kind = _sendto_kind(params, allow_executable_path=True)
    return api.repair_generic_sendto(kind, executable_path=_executable_path(params))


def _install_profile_sendto(api: BridgeAPI, params: dict[str, object]) -> object:
    profile_id = params.get("profile_id")
    if set(params) - {"profile_id", "action", "executable_path"} or not isinstance(profile_id, str):
        raise _ParameterError
    action = params.get("action", "start")
    if not isinstance(action, str):
        raise _ParameterError
    exec_path = params.get("executable_path")
    if exec_path is not None and not isinstance(exec_path, str):
        raise _ParameterError
    return api.install_profile_sendto(
        profile_id, action, executable_path=exec_path if isinstance(exec_path, str) else None
    )


def _remove_profile_sendto(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.remove_profile_sendto(_string(params, "profile_id"))


def _repair_profile_sendto(api: BridgeAPI, params: dict[str, object]) -> object:
    profile_id = params.get("profile_id")
    if set(params) - {"profile_id", "action", "executable_path"} or not isinstance(profile_id, str):
        raise _ParameterError
    action = params.get("action", "start")
    if not isinstance(action, str):
        raise _ParameterError
    exec_path = params.get("executable_path")
    if exec_path is not None and not isinstance(exec_path, str):
        raise _ParameterError
    return api.repair_profile_sendto(
        profile_id, action, executable_path=exec_path if isinstance(exec_path, str) else None
    )


def _list_sendto_shortcuts(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.list_sendto_shortcuts()


def _clear_lut_history(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.clear_lut_history()


def _list_luts(api: BridgeAPI, params: dict[str, object]) -> object:
    _empty(params)
    return api.list_luts()


def _load_lut(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.load_lut(_string(params, "path"))


def _analyze_cut(api: BridgeAPI, params: dict[str, object]) -> object:
    if (
        set(params) != {"path", "work_id"}
        or not isinstance(params["path"], str)
        or not isinstance(params["work_id"], str)
    ):
        raise _ParameterError
    return api.analyze_cut(params["path"], params["work_id"])


def _get_cut_analysis(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.get_cut_analysis(_string(params, "path"))


def _cancel_cut_work(api: BridgeAPI, params: dict[str, object]) -> object:
    return api.cancel_cut_work(_string(params, "work_id"))


_WORK_HANDLERS: dict[str, Callable[[BridgeAPI, dict[str, object], RequestWork], object]] = {
    "enqueue_with_options": _enqueue_with_options,
    "enqueue_batch": _enqueue_batch,
    "retry_item": _retry_item,
}


_HANDLERS: dict[str, Handler] = {
    "analyze_cut": _analyze_cut,
    "get_cut_analysis": _get_cut_analysis,
    "cancel_cut_work": _cancel_cut_work,
    "load_lut": _load_lut,
    "list_luts": _list_luts,
    "clear_lut_history": _clear_lut_history,
    "probe_file": _probe_file,
    "probe_audio_file": _probe_audio_file,
    "get_waveform": _get_waveform,
    "get_thumbnail": _get_thumbnail,
    "get_media_url": _get_media_url,
    "release_media_token": _release_media_token,
    "create_plan": _create_plan,
    "cancel_item": _cancel_item,
    "cancel_all_items": _cancel_all_items,
    "clear_completed": _clear_completed,
    "move_item": _move_item,
    "stop_after_current": _stop_after_current,
    "get_queue_state": _get_queue_state,
    "get_diagnostics": _get_diagnostics,
    "get_settings": _get_settings,
    "get_storage_paths": _get_storage_paths,
    "save_settings": _save_settings,
    "refresh_encoders": _refresh_encoders,
    "get_profiles_json": _get_profiles_json,
    "create_profile": _create_profile,
    "update_profile": _update_profile,
    "delete_profile": _delete_profile,
    "duplicate_profile": _duplicate_profile,
    "import_profiles_from_file": _import_profiles_from_file,
    "export_profile_to_file": _export_profile_to_file,
    "install_generic_sendto": _install_generic_sendto,
    "remove_generic_sendto": _remove_generic_sendto,
    "repair_generic_sendto": _repair_generic_sendto,
    "install_profile_sendto": _install_profile_sendto,
    "remove_profile_sendto": _remove_profile_sendto,
    "repair_profile_sendto": _repair_profile_sendto,
    "list_sendto_shortcuts": _list_sendto_shortcuts,
}
