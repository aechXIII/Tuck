from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

from . import __version__
from .bridge_serialization import plan_preview_dict, profile_ui_dict, video_info_dict
from .bridge_serialization import queue_item_dict as _item_to_dict
from .bridge_validation import (
    normalize_profile_ui_payload,
    parse_plan_request,
    validate_path,
)
from .diagnostics import build_diagnostics
from .encoding.capabilities import (
    clear_encoder_cache,
    get_available_encoders,
    get_encoder_capabilities,
)
from .engine import _find_ffmpeg, is_ffmpeg_available
from .engine import get_available_encoders as _engine_available_encoders
from .media_server import get_media_server
from .models import (
    PROFILE_ID_DISCORD_FREE,
    EncodePlan,
    PlanRequest,
    Profile,
    VideoInfo,
    find_profile_by_id,
)
from .planner import plan
from .probe import _find_ffprobe, is_ffprobe_available
from .probe import probe as probe_video
from .probe_cache import ProbeCache
from .queue import get_queue
from .settings import get_settings_manager
from .updater import UpdateChecker, UpdateInfo
from .updater import check_for_updates as _check_for_updates

logger = logging.getLogger(__name__)

_SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")


class BridgeAPI:
    def __init__(self) -> None:
        self._settings = get_settings_manager()
        self._queue = get_queue()
        self._update_checker: UpdateChecker | None = None
        self._update_info: UpdateInfo | None = None
        self._ipc_files: list[str] = []
        self._ipc_lock = threading.Lock()
        self._ipc_metadata: dict[str, str] = {}
        self._checking_updates: bool = False

        self._probe_cache = ProbeCache(lambda path: probe_video(path))

        self._media_server = get_media_server()
        self._media_server.set_thumbnail_cache_dir(self._settings.cache_dir / "thumbs")
        self._media_server.start()

    def add_ipc_files(self, paths: list[str]) -> None:
        with self._ipc_lock:
            for p in paths:
                if p not in self._ipc_files:
                    self._ipc_files.append(p)

    def add_ipc_metadata(self, metadata: dict[str, str]) -> None:
        with self._ipc_lock:
            self._ipc_metadata = dict(metadata)

    def get_ipc_files(self) -> str:
        with self._ipc_lock:
            if not self._ipc_files:
                return json.dumps([])
            result = list(self._ipc_files)
            self._ipc_files.clear()
            return json.dumps(result)

    def get_ipc_metadata(self) -> str:

        with self._ipc_lock:
            if not self._ipc_metadata:
                return json.dumps({})
            result = dict(self._ipc_metadata)
            self._ipc_metadata.clear()
            return json.dumps(result)

    def get_media_url(self, path: str) -> str:

        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return json.dumps({"ok": False, "error": str(e)})
        try:
            token = self._media_server.register_file(path)
            url = self._media_server.get_url(token)
            return json.dumps({"ok": True, "url": url, "token": token})
        except Exception as e:
            thumb = self._media_server.generate_thumbnail(path)
            if thumb:
                thumb_token = self._media_server.register_file(thumb)
                thumb_url = self._media_server.get_url(thumb_token)
                return json.dumps(
                    {
                        "ok": True,
                        "thumbnail": thumb_url,
                        "fallback": True,
                        "reason": str(e),
                    }
                )
            return json.dumps({"ok": False, "error": str(e)})

    def get_thumbnail(self, path: str) -> str:

        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return json.dumps({"ok": False, "error": str(e)})
        thumb = self._media_server.generate_thumbnail(path)
        if thumb:
            thumb_token = self._media_server.register_file(thumb)
            thumb_url = self._media_server.get_url(thumb_token)
            return json.dumps({"ok": True, "thumbnail": thumb_url})
        return json.dumps({"ok": False, "error": "Could not generate thumbnail"})

    def release_media_token(self, token: str) -> str:

        if token and isinstance(token, str):
            self._media_server.unregister_token(token)
        return json.dumps({"ok": True})

    def probe_file(self, path: str) -> str:
        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return json.dumps({"ok": False, "error": str(e)})
        try:
            info = self._probe_once(path)

            return json.dumps({"ok": True, "data": video_info_dict(info)})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def create_plan(self, request_json: str) -> str:

        try:
            raw = json.loads(request_json)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "Invalid JSON"})

        if not isinstance(raw, dict):
            return json.dumps({"ok": False, "error": "Expected JSON object"})

        req_id = raw.get("_request_id", 0)

        try:
            req = self._parse_plan_request(raw)
        except (ValueError, TypeError, FileNotFoundError) as e:
            return json.dumps({"ok": False, "error": str(e), "_request_id": req_id})

        profile = self._resolve_profile(req.profile_id)
        if profile is None:
            return json.dumps(
                {
                    "ok": False,
                    "error": f"Profile not found: {req.profile_id}",
                    "_request_id": req_id,
                }
            )

        try:
            p = self._build_plan(req, profile)
            return json.dumps(
                {
                    "ok": True,
                    "_request_id": req_id,
                    "data": plan_preview_dict(p),
                }
            )
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e), "_request_id": req_id})

    def enqueue_with_options(self, request_json: str) -> str:

        try:
            raw = json.loads(request_json)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "Invalid JSON"})

        if not isinstance(raw, dict):
            return json.dumps({"ok": False, "error": "Expected JSON object"})

        try:
            req = self._parse_plan_request(raw)
        except (ValueError, TypeError, FileNotFoundError) as e:
            return json.dumps({"ok": False, "error": str(e)})

        profile = self._resolve_profile(req.profile_id)
        if profile is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {req.profile_id}"})

        try:
            enc_plan = self._build_plan(req, profile)
            item = self._queue.enqueue(enc_plan)
            return json.dumps({"ok": True, "item_id": item.id})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def enqueue_batch(self, requests_json: str) -> str:

        try:
            raw = json.loads(requests_json)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "Invalid JSON"})

        if not isinstance(raw, list) or not raw:
            return json.dumps({"ok": False, "error": "No requests provided"})

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
            return json.dumps(
                {"ok": False, "error": "No files could be enqueued", "errors": errors}
            )
        return json.dumps(
            {
                "ok": True,
                "enqueued": enqueued,
                "errors": errors,
                "count": len(enqueued),
            }
        )

    def cancel_item(self, item_id: str) -> str:
        ok = self._queue.cancel(str(item_id))
        return json.dumps({"ok": ok})

    def cancel_all_items(self) -> str:
        self._queue.cancel_all()
        return json.dumps({"ok": True})

    def clear_completed(self) -> str:
        return json.dumps({"ok": True, "count": self._queue.clear_completed()})

    def move_item(self, item_id: str, new_index: int) -> str:
        if isinstance(new_index, bool) or not isinstance(new_index, int):
            return json.dumps({"ok": False, "error": "new_index must be an integer"})
        ok = self._queue.move_item(str(item_id), new_index)
        return json.dumps({"ok": ok})

    def retry_item(self, item_id: str) -> str:
        item = self._queue.retry(str(item_id))
        if item is None:
            return json.dumps(
                {"ok": False, "error": "Only failed or cancelled items can be retried"}
            )
        return json.dumps({"ok": True, "item_id": item.id})

    def stop_after_current(self) -> str:
        self._queue.stop_after_current()
        return json.dumps({"ok": True})

    def get_queue_state(self) -> str:
        items, current, pending_ids = self._queue.snapshot()
        return json.dumps(
            {
                "items": [_item_to_dict(i) for i in items],
                "current_id": current.id if current else None,
                "pending_ids": pending_ids,
            }
        )

    def get_diagnostics(self, context_json: str = "{}") -> str:
        try:
            raw = json.loads(context_json) if context_json else {}
        except json.JSONDecodeError:
            raw = {}
        if not isinstance(raw, dict):
            raw = {}

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
        return json.dumps({"ok": True, "text": text})

    def install_profile_sendto(self, profile_id: str, action: str = "start") -> str:

        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {profile_id}"})
        try:
            from .sendto import install_profile_shortcut

            path = install_profile_shortcut(profile_id, found.name, action=action)
            return json.dumps({"ok": True, "path": str(path)})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def remove_profile_sendto(self, profile_id: str) -> str:

        try:
            from .sendto import uninstall_profile_shortcut

            removed = uninstall_profile_shortcut(profile_id)
            return json.dumps({"ok": True, "removed": removed})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def repair_profile_sendto(self, profile_id: str, action: str = "start") -> str:

        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {profile_id}"})
        try:
            from .sendto import repair_profile_shortcut

            repaired = repair_profile_shortcut(profile_id, found.name, action=action)
            return json.dumps({"ok": True, "repaired": repaired})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def list_sendto_shortcuts(self) -> str:

        try:
            from .sendto import list_sendto_shortcuts

            shortcuts = list_sendto_shortcuts()
            return json.dumps({"ok": True, "shortcuts": shortcuts})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def install_generic_sendto(self) -> str:

        try:
            from .sendto import install_sendto, repair_sendto

            if repair_sendto():
                return json.dumps({"ok": True, "repaired": True})
            path = install_sendto()
            return json.dumps({"ok": True, "path": str(path)})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def remove_generic_sendto(self) -> str:

        try:
            from .sendto import uninstall_sendto

            uninstall_sendto()
            return json.dumps({"ok": True})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def get_settings(self) -> str:
        s = self._settings.load()
        profiles = self._settings.get_profiles()
        return json.dumps(
            {
                "default_profile_id": s.default_profile_id,
                "default_scaler": getattr(s, "default_scaler", "neighbor"),
                "output_dir": s.output_dir,
                "ffmpeg_path": s.ffmpeg_path,
                "ffprobe_path": s.ffprobe_path,
                "encoder_cache_days": s.encoder_cache_days,
                "detected_ffmpeg_path": _find_ffmpeg() or "",
                "detected_ffprobe_path": _find_ffprobe() or "",
                "check_updates": s.check_updates,
                "last_update_check": s.last_update_check,
                "clear_completed_automatically": getattr(s, "clear_completed_automatically", False),
                "open_output_folder_after_queue": getattr(
                    s, "open_output_folder_after_queue", False
                ),
                "last_task": getattr(s, "last_task", "compression"),
                "last_compress_profile_id": getattr(s, "last_compress_profile_id", ""),
                "last_upscale_profile_id": getattr(s, "last_upscale_profile_id", ""),
                "left_sidebar_width": getattr(s, "left_sidebar_width", 240),
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
        )

    def save_settings(self, settings_json: str) -> str:
        try:
            data = json.loads(settings_json)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "Invalid JSON"})

        if not isinstance(data, dict):
            return json.dumps({"ok": False, "error": "Expected JSON object"})

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
                    return json.dumps({"ok": False, "error": f"{key} must be boolean"})
                if key == "encoder_cache_days" and (
                    not isinstance(data[key], int) or not 0 <= data[key] <= 365
                ):
                    return json.dumps({"ok": False, "error": "encoder_cache_days must be 0 to 365"})
                if key == "last_task" and data[key] not in ("compression", "upscale"):
                    return json.dumps(
                        {"ok": False, "error": "last_task must be compression or upscale"}
                    )
                if key in (
                    "last_compress_profile_id",
                    "last_upscale_profile_id",
                ) and not isinstance(data[key], str):
                    return json.dumps({"ok": False, "error": f"{key} must be string"})
                if key == "left_sidebar_width" and (
                    not isinstance(data[key], int) or not 180 <= data[key] <= 360
                ):
                    return json.dumps(
                        {"ok": False, "error": "left_sidebar_width must be 180 to 360"}
                    )
                if key == "default_profile_id" and not isinstance(data[key], str):
                    return json.dumps({"ok": False, "error": "default_profile_id must be string"})
                if key == "default_scaler":
                    val = data[key]
                    if not isinstance(val, str):
                        return json.dumps({"ok": False, "error": "default_scaler must be string"})
                    from .models import _VALID_SCALERS

                    if val not in _VALID_SCALERS:
                        return json.dumps({"ok": False, "error": f"Invalid scaler: {val}"})
                if key == "default_profile_id":
                    pid = data[key]
                    if not pid:
                        return json.dumps(
                            {"ok": False, "error": "default_profile_id must not be empty"}
                        )
                    profiles = self._settings.get_profiles()
                    if find_profile_by_id(profiles, pid) is None:
                        return json.dumps({"ok": False, "error": f"Profile not found: {pid}"})
                if key == "output_dir":
                    val = data[key]
                    if val and not isinstance(val, str):
                        return json.dumps({"ok": False, "error": "output_dir must be string"})
                    if val and not Path(val).is_dir():
                        return json.dumps(
                            {"ok": False, "error": f"output_dir does not exist: {val}"}
                        )
                if key in ("ffmpeg_path", "ffprobe_path"):
                    val = data[key]
                    if not isinstance(val, str):
                        return json.dumps({"ok": False, "error": f"{key} must be string"})
                    if val and not Path(val).is_file():
                        return json.dumps({"ok": False, "error": f"File not found: {val}"})
                if key in ("compression_suffix", "upscale_suffix"):
                    val = data[key]
                    if not isinstance(val, str) or not val.strip():
                        return json.dumps(
                            {"ok": False, "error": f"{key} must be a non-empty string"}
                        )
                self._settings.set_setting(key, data[key])

        self._settings.save()
        if ffmpeg_path_changed:
            clear_encoder_cache(delete_disk=True)
        return json.dumps({"ok": True})

    def refresh_encoders(self) -> str:
        clear_encoder_cache(delete_disk=True)
        encoders = get_available_encoders(refresh=True)
        return json.dumps({"ok": True, "available_encoders": sorted(encoders)})

    def get_profiles_json(self) -> str:

        profiles = self._settings.get_profiles()
        return json.dumps(
            [profile_ui_dict(profile, include_explicit_bitrate=True) for profile in profiles]
        )

    def import_profiles_from_file(self, file_path: str) -> str:

        from .models import import_profiles_json, merge_imported_profiles

        p = Path(file_path)
        if not p.is_file():
            return json.dumps({"ok": False, "error": f"File not found: {file_path}"})
        try:
            imported = import_profiles_json(p)
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

        merged = merge_imported_profiles(self._settings.get_profiles(), imported)
        self._settings.set_profiles(merged)
        self._settings.save()
        return json.dumps({"ok": True, "count": len(imported)})

    def export_profiles_to_file(self, file_path: str) -> str:

        from .models import export_profiles_json

        p = Path(file_path)
        try:
            profiles = self._settings.get_profiles()
            export_profiles_json(profiles, p)
            return json.dumps({"ok": True})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def export_profile_to_file(self, file_path: str, profile_id: str) -> str:

        from .models import export_profiles_json, find_profile_by_id

        profile = find_profile_by_id(self._settings.get_profiles(), profile_id)
        if profile is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {profile_id}"})

        try:
            export_profiles_json([profile], Path(file_path))
            return json.dumps({"ok": True})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def create_profile(self, profile_json: str) -> str:

        try:
            data = json.loads(profile_json)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "Invalid JSON"})

        if not isinstance(data, dict):
            return json.dumps({"ok": False, "error": "Expected JSON object"})

        try:
            data = _normalize_profile_ui_payload(data)
        except ValueError as e:
            return json.dumps({"ok": False, "error": str(e)})

        data.pop("profile_id", None)
        data["profile_id"] = uuid.uuid4().hex[:12]

        if "scaler" not in data:
            data["scaler"] = self._settings.get_setting("default_scaler", "neighbor")

        try:
            validated = Profile.from_dict(data)
        except (ValueError, TypeError) as e:
            return json.dumps({"ok": False, "error": str(e)})

        profiles = self._settings.get_profiles()
        profiles.append(validated)
        self._settings.set_profiles(profiles)
        self._settings.save()
        return json.dumps({"ok": True, "profile_id": validated.profile_id})

    def duplicate_profile(self, profile_id: str) -> str:

        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {profile_id}"})

        new_id = uuid.uuid4().hex[:12]
        data = found.to_dict()
        data["profile_id"] = new_id
        data["name"] = f"{found.name} (copy)"

        try:
            validated = Profile.from_dict(data)
        except (ValueError, TypeError) as e:
            return json.dumps({"ok": False, "error": str(e)})

        profiles.append(validated)
        self._settings.set_profiles(profiles)
        self._settings.save()
        return json.dumps({"ok": True, "profile_id": validated.profile_id})

    def delete_profile(self, profile_id: str) -> str:

        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {profile_id}"})

        if len(profiles) <= 1:
            return json.dumps({"ok": False, "error": "Cannot delete the last profile"})

        current_default = self._settings.get_setting("default_profile_id", "")
        if current_default == profile_id:
            remaining = [p for p in profiles if p.profile_id != profile_id]
            survivor_id = _pick_surviving_default(remaining)
            self._settings.set_setting("default_profile_id", survivor_id)

        profiles = [p for p in profiles if p.profile_id != profile_id]
        self._settings.set_profiles(profiles)
        self._settings.save()

        try:
            from .sendto import uninstall_profile_shortcut

            uninstall_profile_shortcut(profile_id)
        except Exception as e:
            logger.warning(
                "Could not remove Send To shortcut for deleted profile %s: %s",
                profile_id,
                e,
            )

        return json.dumps({"ok": True})

    def update_profile(self, profile_id: str, profile_json: str) -> str:

        try:
            data = json.loads(profile_json)
        except json.JSONDecodeError:
            return json.dumps({"ok": False, "error": "Invalid JSON"})

        if not isinstance(data, dict):
            return json.dumps({"ok": False, "error": "Expected JSON object"})

        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return json.dumps({"ok": False, "error": f"Profile not found: {profile_id}"})

        existing = found.to_dict()
        try:
            data = _normalize_profile_ui_payload(data)
        except ValueError as e:
            return json.dumps({"ok": False, "error": str(e)})

        if "profile_id" in data and data["profile_id"] != found.profile_id:
            return json.dumps({"ok": False, "error": "profile_id cannot be changed"})
        if "schema_version" in data:
            return json.dumps({"ok": False, "error": "schema_version cannot be changed"})

        data["profile_id"] = found.profile_id

        candidate = {**existing, **data}
        try:
            validated = Profile.from_dict(candidate)
        except (ValueError, TypeError) as e:
            return json.dumps({"ok": False, "error": str(e)})

        for i, p in enumerate(profiles):
            if p.profile_id == profile_id:
                profiles[i] = validated
                break

        self._settings.set_profiles(profiles)
        self._settings.save()
        return json.dumps({"ok": True})

    def check_for_updates(self) -> str:
        if self._checking_updates:
            return json.dumps({"available": False, "error": "Update check already in progress"})
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
                return json.dumps(
                    {
                        "available": True,
                        "version": str(info.version),
                        "notes": info.notes,
                        "size": info.file_size,
                        "size_mb": round(info.file_size / (1024 * 1024), 2)
                        if info.file_size
                        else 0,
                    }
                )
            return json.dumps({"available": False})
        except Exception as e:
            return json.dumps({"available": False, "error": str(e)})
        finally:
            self._checking_updates = False

    def download_update(self) -> str:
        if not self._update_info:
            return json.dumps(
                {"ok": False, "error": "No update has been checked. Call check_for_updates first."}
            )
        info = self._update_info
        if not info.download_url:
            return json.dumps({"ok": False, "error": "No download URL available for update"})
        if not info.checksum:
            return json.dumps(
                {"ok": False, "error": "No checksum available for update; refusing to download"}
            )
        if not _SHA256_RE.match(info.checksum):
            return json.dumps(
                {
                    "ok": False,
                    "error": (
                        f"Invalid checksum format: {info.checksum[:20]}... "
                        f"; must be 64 hex characters"
                    ),
                }
            )
        try:
            from .updater import UpdateChecker

            self._update_checker = UpdateChecker(info.download_url, info.checksum)
            self._update_checker.start()
            return json.dumps({"ok": True})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def get_download_progress(self) -> str:
        if not self._update_checker:
            return json.dumps({"downloading": False})
        try:
            return json.dumps(self._update_checker.get_progress())
        except Exception as e:
            return json.dumps({"downloading": False, "error": str(e)})

    def install_update(self) -> str:
        if not self._update_checker:
            return json.dumps({"ok": False, "error": "No update downloaded"})
        try:
            result = self._update_checker.install()
            return json.dumps({"ok": True, "path": str(result)})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

    def open_output_folder(self, path: str) -> str:
        import subprocess

        p = Path(self._validate_path(path))
        folder = p if p.is_dir() else p.parent
        if folder.exists():
            subprocess.Popen(["explorer", str(folder)], creationflags=0)
            return json.dumps({"ok": True})
        return json.dumps({"ok": False, "error": "Folder not found"})

    def open_logs_folder(self) -> str:
        return self._open_app_folder(self._settings.log_dir)

    def open_config_folder(self) -> str:
        return self._open_app_folder(self._settings.config_dir)

    @staticmethod
    def _open_app_folder(folder: Path) -> str:
        import subprocess

        try:
            folder.mkdir(parents=True, exist_ok=True)
            subprocess.Popen(["explorer", str(folder)], creationflags=0)
            return json.dumps({"ok": True, "path": str(folder)})
        except OSError as e:
            return json.dumps({"ok": False, "error": str(e)})

    def copy_text(self, text: str) -> str:
        if not isinstance(text, str) or not text:
            return json.dumps({"ok": False, "error": "Nothing to copy"})
        try:
            import win32clipboard

            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
            finally:
                win32clipboard.CloseClipboard()
            return json.dumps({"ok": True})
        except Exception as e:
            return json.dumps({"ok": False, "error": str(e)})

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
        return plan(
            request.source,
            profile,
            request=request,
            source_info=self._probe_once(request.source),
            **(options or self._planning_options()),
        )

    def _probe_once(self, path: str) -> VideoInfo:
        return self._probe_cache.get(path)


_normalize_profile_ui_payload = normalize_profile_ui_payload


def _pick_surviving_default(remaining: list[Profile]) -> str:
    desired_order = [
        PROFILE_ID_DISCORD_FREE,
        "discord-50mb",
        "discord-500mb",
    ]
    remaining_ids = {p.profile_id for p in remaining}
    for pid in desired_order:
        if pid in remaining_ids:
            return pid

    if remaining:
        return cast(str, remaining[0].profile_id)

    return PROFILE_ID_DISCORD_FREE
