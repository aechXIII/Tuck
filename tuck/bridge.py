from __future__ import annotations

import logging
import re
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import __version__
from .bridge_contract import BridgeResult
from .bridge_serialization import (
    audio_info_dict,
    plan_preview_dict,
    profile_ui_dict,
    video_info_dict,
)
from .bridge_serialization import queue_item_dict as _item_to_dict
from .bridge_validation import (
    parse_plan_request,
    validate_path,
)
from .desktop_platform import is_linux_desktop
from .diagnostics import build_diagnostics
from .encoding.capabilities import (
    clear_encoder_cache,
    get_available_encoders,
    get_encoder_capabilities,
)
from .engine import cleanup_cache, is_ffmpeg_available
from .engine import get_available_encoders as _engine_available_encoders
from .media_server import get_media_server
from .media_tools import find_ffmpeg, find_ffprobe
from .models import (
    AudioInfo,
    EncodePlan,
    PlanRequest,
    Profile,
    VideoInfo,
    find_profile_by_id,
)
from .models.encoding_policy import VALID_SCALERS
from .planner import plan
from .probe import is_ffprobe_available, probe_audio
from .probe import probe as probe_video
from .probe_cache import ProbeCache
from .profile_service import ProfileService
from .queue import get_queue
from .settings import get_settings_manager

if TYPE_CHECKING:
    from .updater import UpdateChecker, UpdateInfo

    _check_for_updates: Callable[[], UpdateInfo | None]
elif not is_linux_desktop():
    from .updater import check_for_updates as _check_for_updates

logger = logging.getLogger(__name__)

_SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")


class BridgeAPI:
    def __init__(self) -> None:
        self._settings = get_settings_manager()
        self._profile_service = ProfileService(self._settings)
        self._queue = get_queue()
        self._update_checker: UpdateChecker | None = None
        self._update_info: UpdateInfo | None = None
        self._ipc_files: list[str] = []
        self._ipc_lock = threading.Lock()
        self._ipc_metadata: dict[str, str] = {}
        self._checking_updates: bool = False

        self._probe_cache = ProbeCache(lambda path: probe_video(path))
        self._audio_probe_cache = ProbeCache(lambda path: probe_audio(path))

        self._media_server = get_media_server()
        self._media_server.set_thumbnail_cache_dir(self._settings.cache_dir / "thumbs")
        self._media_server.start()

    @property
    def log_dir(self) -> Path:
        return self._settings.log_dir

    def get_storage_paths(self) -> BridgeResult:
        """Return the persisted locations owned by Python's settings service.

        Desktop callers must use these paths instead of independently deriving
        platform-specific application directories.
        """

        return {
            "ok": True,
            "config_dir": str(self._settings.config_dir),
            "data_dir": str(self._settings.data_dir),
            "cache_dir": str(self._settings.cache_dir),
            "log_dir": str(self._settings.log_dir),
        }

    def start_background_services(self) -> None:
        """Start the queue service for a GUI or sidecar lifetime."""
        self._queue.start()

    def stop_background_services(self) -> None:
        """Stop process-owned services using the GUI cleanup order."""
        self._queue.stop()
        self._media_server.stop()
        cleanup_cache(self._settings.cache_dir)

    def add_ipc_files(self, paths: list[str]) -> None:
        with self._ipc_lock:
            for p in paths:
                if p not in self._ipc_files:
                    self._ipc_files.append(p)

    def add_ipc_metadata(self, metadata: dict[str, str]) -> None:
        with self._ipc_lock:
            self._ipc_metadata = dict(metadata)

    def get_ipc_files(self) -> BridgeResult:
        with self._ipc_lock:
            if not self._ipc_files:
                return []
            result = list(self._ipc_files)
            self._ipc_files.clear()
            return result

    def get_ipc_metadata(self) -> BridgeResult:

        with self._ipc_lock:
            if not self._ipc_metadata:
                return {}
            result = dict(self._ipc_metadata)
            self._ipc_metadata.clear()
            return result

    def get_media_url(self, path: str) -> BridgeResult:

        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return {"ok": False, "error": str(e)}
        try:
            token = self._media_server.register_file(path)
            url = self._media_server.get_url(token)
            return {"ok": True, "url": url, "token": token}
        except Exception as e:
            thumb = self._media_server.generate_thumbnail(path)
            if thumb:
                thumb_token = self._media_server.register_file(thumb)
                thumb_url = self._media_server.get_url(thumb_token)
                return {
                    "ok": True,
                    "thumbnail": thumb_url,
                    "fallback": True,
                    "reason": str(e),
                }

            return {"ok": False, "error": str(e)}

    def get_thumbnail(self, path: str) -> BridgeResult:

        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return {"ok": False, "error": str(e)}
        thumb = self._media_server.generate_thumbnail(path)
        if thumb:
            thumb_token = self._media_server.register_file(thumb)
            thumb_url = self._media_server.get_url(thumb_token)
            return {"ok": True, "thumbnail": thumb_url}
        return {"ok": False, "error": "Could not generate thumbnail"}

    def release_media_token(self, token: str) -> BridgeResult:

        if token and isinstance(token, str):
            self._media_server.unregister_token(token)
        return {"ok": True}

    def probe_file(self, path: str) -> BridgeResult:
        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return {"ok": False, "error": str(e)}
        try:
            info = self._probe_once(path)

            return {"ok": True, "data": video_info_dict(info)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def probe_audio_file(self, path: str) -> BridgeResult:
        try:
            path = self._validate_path(path)
            info = self._probe_audio_once(path)
            return {"ok": True, "data": audio_info_dict(info)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_waveform(self, path: str) -> BridgeResult:
        try:
            path = self._validate_path(path)
            self._probe_audio_once(path)
            waveform = self._media_server.generate_waveform(path)
            if not waveform:
                return {"ok": False, "error": "Could not generate audio waveform"}
            token = self._media_server.register_file(waveform)
            return {"ok": True, "url": self._media_server.get_url(token), "token": token}

        except Exception as e:
            return {"ok": False, "error": str(e)}

    def create_plan(self, request: object) -> BridgeResult:
        if not isinstance(request, dict):
            return {"ok": False, "error": "Expected request object"}
        raw = request

        req_id = raw.get("_request_id", 0)

        try:
            req = self._parse_plan_request(raw)
        except (ValueError, TypeError, FileNotFoundError) as e:
            return {"ok": False, "error": str(e), "_request_id": req_id}

        profile = self._resolve_profile(req.profile_id)
        if profile is None:
            return {
                "ok": False,
                "error": f"Profile not found: {req.profile_id}",
                "_request_id": req_id,
            }

        try:
            p = self._build_plan(req, profile)
            return {
                "ok": True,
                "_request_id": req_id,
                "data": plan_preview_dict(p),
            }

        except Exception as e:
            return {"ok": False, "error": str(e), "_request_id": req_id}

    def enqueue_with_options(self, request: object) -> BridgeResult:
        if not isinstance(request, dict):
            return {"ok": False, "error": "Expected request object"}
        raw = request

        try:
            req = self._parse_plan_request(raw)
        except (ValueError, TypeError, FileNotFoundError) as e:
            return {"ok": False, "error": str(e)}

        profile = self._resolve_profile(req.profile_id)
        if profile is None:
            return {"ok": False, "error": f"Profile not found: {req.profile_id}"}

        try:
            enc_plan = self._build_plan(req, profile)
            item = self._queue.enqueue(enc_plan)
            return {"ok": True, "item_id": item.id}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def enqueue_batch(self, requests: object) -> BridgeResult:
        if not isinstance(requests, list) or not requests:
            return {"ok": False, "error": "No requests provided"}
        raw = requests

        planning_options = self._planning_options()
        enqueued: list[str] = []
        errors: list[str] = []

        for idx, entry in enumerate(raw):
            if not isinstance(entry, dict):
                errors.append(f"Request {idx}: expected JSON object")
                continue
            try:
                req = self._parse_plan_request(entry)
            except (ValueError, TypeError, FileNotFoundError) as e:
                src = entry.get("source", f"request {idx}")
                errors.append(f"{Path(src).name}: {e}")
                continue

            profile = self._resolve_profile(req.profile_id)
            if profile is None:
                errors.append(f"Request {idx}: Profile not found: {req.profile_id}")
                continue

            try:
                enc_plan = self._build_plan(req, profile, planning_options)
                item = self._queue.enqueue(enc_plan)
                enqueued.append(item.id)
            except Exception as e:
                errors.append(f"{Path(req.source).name}: {e}")

        if not enqueued:
            return {"ok": False, "error": "No files could be enqueued", "errors": errors}

        return {
            "ok": True,
            "enqueued": enqueued,
            "errors": errors,
            "count": len(enqueued),
        }

    def cancel_item(self, item_id: str) -> BridgeResult:
        ok = self._queue.cancel(str(item_id))
        return {"ok": ok}

    def cancel_all_items(self) -> BridgeResult:
        self._queue.cancel_all()
        return {"ok": True}

    def clear_completed(self) -> BridgeResult:
        return {"ok": True, "count": self._queue.clear_completed()}

    def move_item(self, item_id: str, new_index: int) -> BridgeResult:
        if isinstance(new_index, bool) or not isinstance(new_index, int):
            return {"ok": False, "error": "new_index must be an integer"}
        ok = self._queue.move_item(str(item_id), new_index)
        return {"ok": ok}

    def retry_item(self, item_id: str) -> BridgeResult:
        item = self._queue.retry(str(item_id))
        if item is None:
            return {"ok": False, "error": "Only failed or cancelled items can be retried"}

        return {"ok": True, "item_id": item.id}

    def stop_after_current(self) -> BridgeResult:
        self._queue.stop_after_current()
        return {"ok": True}

    def get_queue_state(self) -> BridgeResult:
        items, current, pending_ids = self._queue.snapshot()
        return {
            "items": [_item_to_dict(i) for i in items],
            "current_id": current.id if current else None,
            "pending_ids": pending_ids,
        }

    def get_diagnostics(self, context: object | None = None) -> BridgeResult:
        raw = context if isinstance(context, dict) else {}

        plan_obj = None
        error = str(raw.get("error") or "")
        stderr = str(raw.get("stderr") or "")
        item_id = raw.get("item_id")
        matched_item = None
        if item_id:
            for item in self._queue.items:
                if item.id == str(item_id):
                    matched_item = item
                    plan_obj = item.plan
                    if not error:
                        error = item.error or ""
                    if not stderr:
                        stderr = getattr(item, "error_detail", "") or ""
                    break
        elif not error:
            failed = [
                i
                for i in self._queue.items
                if i.state.value == "failed" and (i.error or getattr(i, "error_detail", ""))
            ]
            if failed:
                matched_item = failed[-1]
                plan_obj = matched_item.plan
                error = matched_item.error or error
                stderr = getattr(matched_item, "error_detail", "") or stderr

        extra: dict[str, Any] = {}
        for key in (
            "target_size_mb",
            "resolution",
            "fps",
            "two_pass",
            "preset",
            "scaler",
            "trim_start",
            "trim_end",
            "segments",
            "segment_count",
            "selected_duration",
            "source_name",
            "keep_audio",
            "audio_bitrate_kbps",
            "rate_control_method",
        ):
            if key in raw and raw[key] not in (None, ""):
                extra[key] = raw[key]
        if matched_item is not None:
            extra["queue_item_id"] = matched_item.id
            extra["queue_state"] = matched_item.state.value

        text = build_diagnostics(
            plan=plan_obj,
            error=error,
            stderr=stderr,
            selected_encoder=str(raw.get("selected_encoder") or ""),
            resolved_encoder=str(
                raw.get("resolved_encoder")
                or (getattr(plan_obj, "video_encoder", "") if plan_obj else "")
            ),
            workflow=str(
                raw.get("workflow") or (getattr(plan_obj, "workflow", "") if plan_obj else "")
            ),
            profile_name=str(raw.get("profile_name") or ""),
            extra=extra or None,
        )
        return {"ok": True, "text": text}

    def install_profile_sendto(
        self, profile_id: str, action: str = "start", executable_path: str | None = None
    ) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}
        try:
            from .sendto import install_profile_shortcut

            path = install_profile_shortcut(
                profile_id, found.name, action=action, executable_path=executable_path
            )
            return {"ok": True, "path": str(path)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def remove_profile_sendto(self, profile_id: str) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import uninstall_profile_shortcut

            removed = uninstall_profile_shortcut(profile_id)
            return {"ok": True, "removed": removed}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def repair_profile_sendto(
        self, profile_id: str, action: str = "start", executable_path: str | None = None
    ) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}
        try:
            from .sendto import repair_profile_shortcut

            repaired = repair_profile_shortcut(
                profile_id, found.name, action=action, executable_path=executable_path
            )
            return {"ok": True, "repaired": repaired}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def list_sendto_shortcuts(self) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import list_sendto_shortcuts

            shortcuts = list_sendto_shortcuts()
            return {"ok": True, "shortcuts": shortcuts}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def install_generic_sendto(self, executable_path: str | None = None) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import install_sendto, repair_sendto

            if repair_sendto(executable_path=executable_path):
                return {"ok": True, "repaired": True}
            path = install_sendto(executable_path=executable_path)
            return {"ok": True, "path": str(path)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def remove_generic_sendto(self) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import uninstall_sendto

            uninstall_sendto()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_settings(self) -> BridgeResult:
        s = self._settings.load()
        profiles = self._settings.get_profiles()
        return {
            "default_profile_id": s.default_profile_id,
            "default_scaler": getattr(s, "default_scaler", "neighbor"),
            "output_dir": s.output_dir,
            "ffmpeg_path": s.ffmpeg_path,
            "ffprobe_path": s.ffprobe_path,
            "encoder_cache_days": s.encoder_cache_days,
            "detected_ffmpeg_path": find_ffmpeg() or "",
            "detected_ffprobe_path": find_ffprobe() or "",
            "check_updates": s.check_updates,
            "last_update_check": s.last_update_check,
            "clear_completed_automatically": getattr(s, "clear_completed_automatically", False),
            "open_output_folder_after_queue": getattr(s, "open_output_folder_after_queue", False),
            "last_task": getattr(s, "last_task", "compression"),
            "last_compress_profile_id": getattr(s, "last_compress_profile_id", ""),
            "last_upscale_profile_id": getattr(s, "last_upscale_profile_id", ""),
            "left_sidebar_width": getattr(s, "left_sidebar_width", 240),
            "timeline_height": getattr(s, "timeline_height", 0),
            "inspector_start_panel": getattr(s, "inspector_start_panel", "export"),
            "last_inspector_panel": getattr(s, "last_inspector_panel", "export"),
            "compression_suffix": getattr(s, "compression_suffix", "_tucked_{size}")
            or "_tucked_{size}",
            "upscale_suffix": getattr(s, "upscale_suffix", "_upscaled_{width}x{height}")
            or "_upscaled_{width}x{height}",
            "version": __version__,
            "ffmpeg_available": is_ffmpeg_available(),
            "ffprobe_available": is_ffprobe_available(),
            "available_encoders": sorted(_engine_available_encoders()),
            "encoder_capabilities": get_encoder_capabilities().to_dict(),
            "profiles": [profile_ui_dict(profile) for profile in profiles],
        }

    def save_settings(self, settings: object) -> BridgeResult:
        if not isinstance(settings, dict):
            return {"ok": False, "error": "Expected settings object"}
        data = settings

        ffmpeg_path_changed = "ffmpeg_path" in data and data[
            "ffmpeg_path"
        ] != self._settings.get_setting("ffmpeg_path", "")
        allowed_keys = {
            "default_profile_id",
            "default_scaler",
            "output_dir",
            "ffmpeg_path",
            "ffprobe_path",
            "encoder_cache_days",
            "check_updates",
            "clear_completed_automatically",
            "open_output_folder_after_queue",
            "last_task",
            "last_compress_profile_id",
            "last_upscale_profile_id",
            "left_sidebar_width",
            "timeline_height",
            "inspector_start_panel",
            "last_inspector_panel",
            "compression_suffix",
            "upscale_suffix",
        }
        for key in allowed_keys:
            if key in data:
                if key in (
                    "check_updates",
                    "clear_completed_automatically",
                    "open_output_folder_after_queue",
                ) and not isinstance(data[key], bool):
                    return {"ok": False, "error": f"{key} must be boolean"}
                if key == "encoder_cache_days" and (
                    not isinstance(data[key], int) or not 0 <= data[key] <= 365
                ):
                    return {"ok": False, "error": "encoder_cache_days must be 0 to 365"}
                if key == "last_task" and data[key] not in ("compression", "upscale"):
                    return {"ok": False, "error": "last_task must be compression or upscale"}

                if key in (
                    "last_compress_profile_id",
                    "last_upscale_profile_id",
                ) and not isinstance(data[key], str):
                    return {"ok": False, "error": f"{key} must be string"}
                if key == "left_sidebar_width" and (
                    not isinstance(data[key], int) or not 180 <= data[key] <= 360
                ):
                    return {"ok": False, "error": "left_sidebar_width must be 180 to 360"}

                if key == "timeline_height" and (
                    not isinstance(data[key], int)
                    or (data[key] != 0 and not 170 <= data[key] <= 2400)
                ):
                    return {
                        "ok": False,
                        "error": "timeline_height must be 0 or 170 to 2400",
                    }

                if key == "inspector_start_panel" and data[key] not in (
                    "last",
                    "video",
                    "audio",
                    "export",
                ):
                    return {
                        "ok": False,
                        "error": "inspector_start_panel must be last, video, audio, or export",
                    }

                if key == "last_inspector_panel" and data[key] not in (
                    "video",
                    "audio",
                    "export",
                ):
                    return {
                        "ok": False,
                        "error": "last_inspector_panel must be video, audio, or export",
                    }

                if key == "default_profile_id" and not isinstance(data[key], str):
                    return {"ok": False, "error": "default_profile_id must be string"}
                if key == "default_scaler":
                    val = data[key]
                    if not isinstance(val, str):
                        return {"ok": False, "error": "default_scaler must be string"}
                    if val not in VALID_SCALERS:
                        return {"ok": False, "error": f"Invalid scaler: {val}"}
                if key == "default_profile_id":
                    pid = data[key]
                    if not pid:
                        return {"ok": False, "error": "default_profile_id must not be empty"}

                    profiles = self._settings.get_profiles()
                    if find_profile_by_id(profiles, pid) is None:
                        return {"ok": False, "error": f"Profile not found: {pid}"}
                if key == "output_dir":
                    val = data[key]
                    if val and not isinstance(val, str):
                        return {"ok": False, "error": "output_dir must be string"}
                    if val and not Path(val).is_dir():
                        return {"ok": False, "error": f"output_dir does not exist: {val}"}

                if key in ("ffmpeg_path", "ffprobe_path"):
                    val = data[key]
                    if not isinstance(val, str):
                        return {"ok": False, "error": f"{key} must be string"}
                    if val and not Path(val).is_file():
                        return {"ok": False, "error": f"File not found: {val}"}
                if key in ("compression_suffix", "upscale_suffix"):
                    val = data[key]
                    if not isinstance(val, str) or not val.strip():
                        return {"ok": False, "error": f"{key} must be a non-empty string"}

                self._settings.set_setting(key, data[key])

        self._settings.save()
        if ffmpeg_path_changed:
            clear_encoder_cache(delete_disk=True)
        return {"ok": True}

    def refresh_encoders(self) -> BridgeResult:
        clear_encoder_cache(delete_disk=True)
        encoders = get_available_encoders(refresh=True)
        return {"ok": True, "available_encoders": sorted(encoders)}

    def get_profiles_json(self) -> BridgeResult:
        return self._profile_service.list_profiles()

    def import_profiles_from_file(self, file_path: str) -> BridgeResult:
        return self._profile_service.import_from_file(file_path)

    def export_profile_to_file(self, file_path: str, profile_id: str) -> BridgeResult:
        return self._profile_service.export_to_file(file_path, profile_id)

    def create_profile(self, profile: object) -> BridgeResult:
        return self._profile_service.create(profile)

    def duplicate_profile(self, profile_id: str) -> BridgeResult:
        return self._profile_service.duplicate(profile_id)

    def delete_profile(self, profile_id: str) -> BridgeResult:
        return self._profile_service.delete(profile_id)

    def update_profile(self, profile_id: str, profile: object) -> BridgeResult:
        return self._profile_service.update(profile_id, profile)

    def check_for_updates(self) -> BridgeResult:
        if is_linux_desktop():
            return {"available": False, "error": "Automatic updates are not supported on Linux."}
        if self._checking_updates:
            return {"available": False, "error": "Update check already in progress"}
        self._checking_updates = True
        try:
            info = _check_for_updates()
            self._settings.set_setting("last_update_check", datetime.now(timezone.utc).isoformat())
            self._settings.save()
            if info:
                self._update_info = info
                if info.checksum and not _SHA256_RE.match(info.checksum):
                    logger.warning("Invalid checksum from release: %s", info.checksum)
                    info.checksum = ""
                return {
                    "available": True,
                    "version": str(info.version),
                    "notes": info.notes,
                    "size": info.file_size,
                    "size_mb": round(info.file_size / (1024 * 1024), 2) if info.file_size else 0,
                }

            return {"available": False}
        except Exception as e:
            return {"available": False, "error": str(e)}
        finally:
            self._checking_updates = False

    def download_update(self) -> BridgeResult:
        if is_linux_desktop():
            return {"ok": False, "error": "Automatic updates are not supported on Linux."}
        if not self._update_info:
            return {
                "ok": False,
                "error": "No update has been checked. Call check_for_updates first.",
            }

        info = self._update_info
        if not info.download_url:
            return {"ok": False, "error": "No download URL available for update"}
        if not info.checksum:
            return {"ok": False, "error": "No checksum available for update; refusing to download"}

        if not _SHA256_RE.match(info.checksum):
            return {
                "ok": False,
                "error": (
                    f"Invalid checksum format: {info.checksum[:20]}... ; must be 64 hex characters"
                ),
            }

        try:
            from .updater import UpdateChecker

            self._update_checker = UpdateChecker(info.download_url, info.checksum)
            self._update_checker.start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_download_progress(self) -> BridgeResult:
        if is_linux_desktop():
            return {"downloading": False, "error": "Automatic updates are not supported on Linux."}
        if not self._update_checker:
            return {"downloading": False}
        try:
            return self._update_checker.get_progress()
        except Exception as e:
            return {"downloading": False, "error": str(e)}

    def install_update(self) -> BridgeResult:
        if is_linux_desktop():
            return {"ok": False, "error": "Automatic updates are not supported on Linux."}
        if not self._update_checker:
            return {"ok": False, "error": "No update downloaded"}
        try:
            result = self._update_checker.install()
            return {"ok": True, "path": str(result)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def open_output_folder(self, path: str) -> BridgeResult:
        import subprocess

        folder = Path(self._validate_path(path)).parent
        subprocess.Popen(["explorer", str(folder)], creationflags=0)
        return {"ok": True}

    def open_logs_folder(self) -> BridgeResult:
        return self._open_app_folder(self._settings.log_dir)

    def open_config_folder(self) -> BridgeResult:
        return self._open_app_folder(self._settings.config_dir)

    @staticmethod
    def _open_app_folder(folder: Path) -> BridgeResult:
        import subprocess

        try:
            folder.mkdir(parents=True, exist_ok=True)
            subprocess.Popen(["explorer", str(folder)], creationflags=0)
            return {"ok": True, "path": str(folder)}
        except OSError as e:
            return {"ok": False, "error": str(e)}

    def copy_text(self, text: str) -> BridgeResult:
        if not isinstance(text, str) or not text:
            return {"ok": False, "error": "Nothing to copy"}
        try:
            import win32clipboard

            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
            finally:
                win32clipboard.CloseClipboard()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _validate_path(self, path: str) -> str:
        return validate_path(path)

    def _resolve_profile(self, profile_id: str) -> Profile | None:
        profiles = self._settings.get_profiles()
        if not profile_id:
            return self._settings.get_default_profile()
        return find_profile_by_id(profiles, profile_id)

    def _parse_plan_request(self, raw: dict[str, Any]) -> PlanRequest:

        return parse_plan_request(raw, self._validate_path)

    def _planning_options(self) -> dict[str, str]:
        return {
            "output_dir": str(self._settings.get_setting("output_dir", "") or ""),
            "compression_suffix": str(
                self._settings.get_setting("compression_suffix", "_tucked_{size}")
                or "_tucked_{size}"
            ),
            "upscale_suffix": str(
                self._settings.get_setting("upscale_suffix", "_upscaled_{width}x{height}")
                or "_upscaled_{width}x{height}"
            ),
        }

    def _build_plan(
        self,
        request: PlanRequest,
        profile: Profile,
        options: dict[str, str] | None = None,
    ) -> EncodePlan:
        audio_sources = {
            clip.source for track in request.audio_tracks or [] for clip in track.clips
        }
        audio_source_durations = {
            source: self._probe_audio_once(source).duration for source in audio_sources
        }
        return plan(
            request.source,
            profile,
            request=request,
            source_info=self._probe_once(request.source),
            audio_source_durations=audio_source_durations,
            **(options or self._planning_options()),
        )

    def _probe_once(self, path: str) -> VideoInfo:
        return self._probe_cache.get(path)

    def _probe_audio_once(self, path: str) -> AudioInfo:
        return self._audio_probe_cache.get(path)
