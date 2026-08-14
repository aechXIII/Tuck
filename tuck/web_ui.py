# ruff: noqa: N802
from __future__ import annotations

import json
import logging
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import webview
from webview.dom import DOMEventHandler

from .bridge_validation import validate_video_paths

logger = logging.getLogger(__name__)

_VIDEO_FILE_FILTER = "Video files (*.mp4;*.mkv;*.webm;*.mov;*.avi;*.wmv;*.flv;*.m4v)"
_JSON_FILE_FILTER = "JSON files (*.json)"
_EXECUTABLE_FILE_FILTER = "Executable files (*.exe)"


def _response(value: str) -> dict[str, Any] | list[Any]:
    try:
        result = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {"ok": False, "error": "Invalid backend response"}
    if isinstance(result, (dict, list)):
        return result
    return {"ok": False, "error": "Invalid backend response"}


def _dialog_path(result: Sequence[str] | str | None) -> str:
    if isinstance(result, str):
        return result
    if result:
        return result[0]
    return ""


class _JsApi:
    def __init__(self, bridge_api) -> None:
        self._api = bridge_api
        self._window: webview.Window | None = None

    def _call(self, method, *args: object) -> dict[str, Any] | list[Any]:
        try:
            return _response(method(*args))
        except Exception as e:
            logger.exception("Bridge call failed")
            return {"ok": False, "error": str(e)}

    def probeFile(self, path: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.probe_file, path)

    def getThumbnail(self, path: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_thumbnail, path)

    def getMediaUrl(self, path: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_media_url, path)

    def releaseMediaToken(self, token: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.release_media_token, token)

    def createPlan(self, request_json: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.create_plan, request_json)

    def enqueueWithOptions(self, request_json: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.enqueue_with_options, request_json)

    def enqueueBatch(self, requests_json: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.enqueue_batch, requests_json)

    def cancelItem(self, item_id: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.cancel_item, item_id)

    def cancelAllItems(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.cancel_all_items)

    def clearCompleted(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.clear_completed)

    def moveItem(self, item_id: str, new_index: int) -> dict[str, Any] | list[Any]:
        return self._call(self._api.move_item, item_id, new_index)

    def retryItem(self, item_id: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.retry_item, item_id)

    def stopAfterCurrent(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.stop_after_current)

    def getQueueState(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_queue_state)

    def getDiagnostics(self, context_json: str = "{}") -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_diagnostics, context_json)

    def copyText(self, text: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.copy_text, text)

    def openLogsFolder(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.open_logs_folder)

    def openConfigFolder(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.open_config_folder)

    def getSettings(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_settings)

    def saveSettings(self, settings_json: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.save_settings, settings_json)

    def refreshEncoders(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.refresh_encoders)

    def getProfilesJson(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_profiles_json)

    def createProfile(self, profile_json: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.create_profile, profile_json)

    def updateProfile(self, profile_id: str, profile_json: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.update_profile, profile_id, profile_json)

    def deleteProfile(self, profile_id: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.delete_profile, profile_id)

    def duplicateProfile(self, profile_id: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.duplicate_profile, profile_id)

    def importProfilesFromFile(self, file_path: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.import_profiles_from_file, file_path)

    def exportProfilesToFile(self, file_path: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.export_profiles_to_file, file_path)

    def exportProfileToFile(self, file_path: str, profile_id: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.export_profile_to_file, file_path, profile_id)

    def checkForUpdates(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.check_for_updates)

    def downloadUpdate(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.download_update)

    def getDownloadProgress(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_download_progress)

    def installUpdate(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.install_update)

    def openOutputFolder(self, path: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.open_output_folder, path)

    def installGenericSendto(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.install_generic_sendto)

    def removeGenericSendto(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.remove_generic_sendto)

    def installProfileSendto(
        self, profile_id: str, action: str = "start"
    ) -> dict[str, Any] | list[Any]:
        return self._call(self._api.install_profile_sendto, profile_id, action)

    def removeProfileSendto(self, profile_id: str) -> dict[str, Any] | list[Any]:
        return self._call(self._api.remove_profile_sendto, profile_id)

    def repairProfileSendto(
        self, profile_id: str, action: str = "start"
    ) -> dict[str, Any] | list[Any]:
        return self._call(self._api.repair_profile_sendto, profile_id, action)

    def listSendtoShortcuts(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.list_sendto_shortcuts)

    def getIpcFiles(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_ipc_files)

    def getIpcMetadata(self) -> dict[str, Any] | list[Any]:
        return self._call(self._api.get_ipc_metadata)

    def closeWindow(self) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "error": "Window not ready"}
        self._window.destroy()
        return {"ok": True}

    def pickFiles(self) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "error": "Window not ready"}
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.OPEN,
                allow_multiple=True,
                file_types=(_VIDEO_FILE_FILTER,),
            )
            files, _ = validate_video_paths(list(result or ()))
            return {"ok": True, "files": files}
        except Exception as e:
            logger.exception("Video file picker failed")
            return {"ok": False, "error": str(e)}

    def pickFolder(self) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "error": "Window not ready"}
        try:
            return {
                "ok": True,
                "path": _dialog_path(self._window.create_file_dialog(webview.FileDialog.FOLDER)),
            }
        except Exception as e:
            logger.exception("Folder picker failed")
            return {"ok": False, "error": str(e)}

    def pickFfmpegFile(self) -> dict[str, Any]:
        return self._pick_executable()

    def pickFfprobeFile(self) -> dict[str, Any]:
        return self._pick_executable()

    def _pick_executable(self) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "error": "Window not ready"}
        try:
            return {
                "ok": True,
                "path": _dialog_path(
                    self._window.create_file_dialog(
                        webview.FileDialog.OPEN,
                        allow_multiple=False,
                        file_types=(_EXECUTABLE_FILE_FILTER,),
                    )
                ),
            }
        except Exception as e:
            logger.exception("Executable picker failed")
            return {"ok": False, "error": str(e)}

    def pickImportFile(self) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "error": "Window not ready"}
        try:
            return {
                "ok": True,
                "path": _dialog_path(
                    self._window.create_file_dialog(
                        webview.FileDialog.OPEN,
                        allow_multiple=False,
                        file_types=(_JSON_FILE_FILTER,),
                    )
                ),
            }
        except Exception as e:
            logger.exception("Import file picker failed")
            return {"ok": False, "error": str(e)}

    def pickSaveFile(self, default_name: str = "profiles.json") -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "error": "Window not ready"}
        try:
            return {
                "ok": True,
                "path": _dialog_path(
                    self._window.create_file_dialog(
                        webview.FileDialog.SAVE,
                        save_filename=default_name,
                        file_types=(_JSON_FILE_FILTER,),
                    )
                ),
            }
        except Exception as e:
            logger.exception("Save file picker failed")
            return {"ok": False, "error": str(e)}


def _get_resource_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent.parent))
    return base / relative


def _evaluate(window: webview.Window, function: str, *values: object) -> None:
    args = ", ".join(json.dumps(v) for v in values)
    window.evaluate_js(f"window.{function}({args})")


def _window_size(settings: Any) -> tuple[int, int]:
    width = getattr(settings, "window_width", 1240)
    height = getattr(settings, "window_height", 800)
    if not isinstance(width, int):
        width = 1240
    if not isinstance(height, int):
        height = 800
    return max(960, min(7680, width)), max(640, min(4320, height))


def _save_window_size(settings: Any, window: webview.Window, manager: Any) -> None:
    settings.window_width = window.width
    settings.window_height = window.height
    manager.save()


def _native_hwnd(window: webview.Window) -> int | None:
    native = window.native
    handle = getattr(native, "Handle", None)
    if handle is None:
        return None
    try:
        return int(handle.ToInt64())
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def _register_ipc(window: webview.Window, bridge_api) -> None:
    if os.name != "nt":
        return
    hwnd = _native_hwnd(window)
    if not hwnd:
        logger.warning("Could not retrieve the pywebview window handle for IPC")
        return

    from .instance import get_single_instance

    get_single_instance().register_window(
        hwnd,
        ipc_callback=lambda paths: bridge_api.add_ipc_files(validate_video_paths(paths)[0]),
        ipc_metadata_callback=bridge_api.add_ipc_metadata,
    )
    logger.info("WM_COPYDATA handler registered for pywebview window (hwnd=%d)", hwnd)


def _bind_drag_drop(window: webview.Window) -> None:
    def ignore(_: dict[str, Any]) -> None:
        return

    def on_drop(event: dict[str, Any]) -> None:
        files = event.get("dataTransfer", {}).get("files", [])
        paths = [file.get("pywebviewFullPath") for file in files if isinstance(file, dict)]
        accepted, rejected = validate_video_paths(paths)
        logger.info(
            "Drag/drop received=%d accepted=%d rejected=%d",
            len(files),
            len(accepted),
            len(rejected),
        )
        if accepted or rejected:
            _evaluate(window, "addFiles", accepted, rejected)

    document = window.dom.get_element("html")
    if document is None:
        raise RuntimeError("Could not bind drag and drop to the web UI")
    document.on("dragenter", DOMEventHandler(ignore, True, True))
    document.on("dragstart", DOMEventHandler(ignore, True, True))
    document.on("dragover", DOMEventHandler(ignore, True, True, debounce=250))
    document.on("drop", DOMEventHandler(on_drop, True, True))
    logger.info("Drag/drop handlers bound to the web UI")


def run_web_gui(
    bridge_api,
    files: list[str] | None = None,
    sendto_profile_id: str | None = None,
    sendto_action: str | None = None,
) -> int:
    html_path = _get_resource_path("tuck/web/index.html")
    if not html_path.is_file():
        raise FileNotFoundError(f"Web UI asset is missing: {html_path}")

    initial_files, rejected = validate_video_paths(files or [])
    if rejected:
        logger.warning("Ignored %d invalid startup file(s)", len(rejected))

    settings = bridge_api._settings.load()
    width, height = _window_size(settings)

    js_api = _JsApi(bridge_api)
    window = webview.create_window(
        title="Tuck",
        url=str(html_path),
        js_api=js_api,
        width=width,
        height=height,
        min_size=(960, 640),
        confirm_close=False,
        background_color="#0d0d12",
    )
    if window is None:
        raise RuntimeError("Could not create the Tuck window")
    js_api._window = window

    startup = {
        "files": initial_files,
        "sendto": {
            "profile_id": sendto_profile_id,
            "action": sendto_action or "review",
            "files": initial_files,
        }
        if sendto_profile_id
        else None,
    }

    def on_loaded(*_: object) -> None:
        _evaluate(window, "initApp", startup)

    def on_shown(*_: object) -> None:
        _register_ipc(window, bridge_api)

    def on_closing(*_: object) -> None:
        try:
            _save_window_size(settings, window, bridge_api._settings)
        except Exception:
            logger.exception("Could not save Tuck window size")

    window.events.loaded += on_loaded
    window.events.shown += on_shown
    window.events.closing += on_closing
    webview.start(_bind_drag_drop, (window,), gui="edgechromium", debug=False)
    return 0
