from __future__ import annotations

import logging
import subprocess
import threading
from collections.abc import Callable
from dataclasses import replace
from functools import partial
from pathlib import Path
from typing import Any

from av.error import FFmpegError

from . import __version__
from .bridge_contract import BridgeResult, JsonValue
from .bridge_serialization import (
    audio_info_dict,
    plan_preview_dict,
    profile_ui_dict,
    video_info_dict,
)
from .bridge_serialization import queue_item_dict as _item_to_dict
from .bridge_validation import (
    AUDIO_EXTENSIONS,
    VIDEO_EXTENSIONS,
    parse_plan_request,
    validate_path,
)
from .cutting.analysis import CutAnalysisError, check_request
from .cutting.planner import CutPlanChanged, parse_cut_export, parse_cut_request, plan_cut
from .cutting.serialization import (
    KeyframeCursor,
    analysis_snapshot_dict,
    cut_plan_preview_dict,
)
from .cutting.service import CutAnalysisService
from .desktop_platform import is_linux_desktop
from .diagnostics import build_diagnostics
from .encoding.capabilities import (
    clear_encoder_cache,
    get_available_encoders,
    get_encoder_capabilities,
)
from .engine import cleanup_cache, is_ffmpeg_available
from .engine import get_available_encoders as _engine_available_encoders
from .frame_export import export_frame
from .media_server import get_media_server
from .media_tools import find_ffmpeg, find_ffprobe
from .models import (
    AudioInfo,
    EncodePlan,
    PlanRequest,
    PlanValidationError,
    Profile,
    VideoInfo,
    find_profile_by_id,
)
from .models.encoding_policy import VALID_SCALERS
from .models.export_preferences import (
    OUTPUT_LOCATION_FOLDER,
    normalize_output_location,
    normalize_output_subfolder,
)
from .models.ui_preferences import (
    CHOICE_PREFERENCES,
    DEFAULT_CUT_SUFFIX,
    ENCODE_SUFFIXES,
    FLAG_PREFERENCES,
    PROFILE_LIST_PREFERENCES,
    normalize_choice,
    normalize_cut_suffix,
    normalize_encode_suffix,
    normalize_hidden_ui,
    normalize_profile_ids,
    normalize_session_files,
    normalize_shortcut_overrides,
    normalize_start_task,
    normalize_timeline_toggle,
)
from .output_paths import sweep_stale_outputs_later
from .planner import plan
from .planner_options import CutOutputOptions, OutputOptions, output_options
from .probe import is_ffprobe_available, probe_audio
from .probe import probe as probe_video
from .probe_cache import ProbeCache
from .profile_service import ProfileService
from .queue import RetryRefused, get_queue
from .request_work import RequestWork
from .settings import get_settings_manager
from .settings_backup import SettingsBackupService

logger = logging.getLogger(__name__)


class BridgeAPI:
    def __init__(self) -> None:
        self._settings = get_settings_manager()
        self._profile_service = ProfileService(self._settings)
        self._settings_backup = SettingsBackupService(self._settings, self.save_settings)
        self._queue = get_queue()
        self._apply_run_preferences()
        self._ipc_files: list[str] = []
        self._ipc_lock = threading.Lock()
        self._ipc_metadata: dict[str, str] = {}

        self._probe_cache = ProbeCache(lambda path: probe_video(path))
        self._audio_probe_cache = ProbeCache(lambda path: probe_audio(path))
        self._cut_analysis = CutAnalysisService()

        self._media_server = get_media_server()
        self._media_server.set_thumbnail_cache_dir(self._settings.cache_dir / "thumbs")

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
        """Start the queue and the media server for a GUI or sidecar lifetime."""
        self._media_server.start()
        self._queue.start()
        # a crashed or killed export leaves its reservation and scratch folder behind
        settings = self._settings.load()
        if settings.output_location == OUTPUT_LOCATION_FOLDER and settings.output_dir:
            sweep_stale_outputs_later(Path(settings.output_dir))

    def stop_background_services(self) -> None:
        """Stop process-owned services using the GUI cleanup order."""
        self._cut_analysis.close()
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

    def clear_lut_history(self) -> BridgeResult:
        from .lut import clear_lut_history

        try:
            clear_lut_history(self._settings.data_dir / "luts")
            return {"ok": True, "cleared": True}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def list_luts(self) -> BridgeResult:
        from .lut import list_luts

        try:
            return {
                "ok": True,
                "luts": list_luts(
                    self._settings.data_dir / "luts",
                    (profile.lut for profile in self._settings.get_profiles()),
                ),
            }
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def load_lut(self, path: str) -> BridgeResult:
        from .lut import import_lut

        try:
            source = Path(self._validate_path(path))
            saved_name = next(
                (
                    profile.lut.name
                    for profile in self._settings.get_profiles()
                    if profile.lut.path and Path(profile.lut.path).resolve() == source.resolve()
                ),
                "",
            )
            imported = import_lut(source, self._settings.data_dir / "luts", saved_name=saved_name)
            token = self._media_server.register_file(str(imported.table_path))
            return {
                "ok": True,
                "path": str(imported.path),
                "name": imported.name,
                "size": imported.size,
                "table_url": self._media_server.get_url(token),
                "token": token,
            }
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def get_media_url(self, path: str, track: int | None = None) -> BridgeResult:

        try:
            path = self._validate_path(path)
        except (ValueError, FileNotFoundError) as e:
            return {"ok": False, "error": str(e)}
        # the page asks for any path it likes, so only the video and audio Tuck opens are served
        if Path(path).suffix.lower() not in VIDEO_EXTENSIONS | AUDIO_EXTENSIONS:
            return {"ok": False, "error": f"Unsupported media file type: {Path(path).name}"}
        if track is not None:
            try:
                if isinstance(track, bool) or not isinstance(track, int) or track < 0:
                    raise ValueError("track must be a whole number >= 0")
                info = self._probe_once(path)
                count = max(1, info.audio_stream_count) if info.has_audio else 0
                if track >= count:
                    raise ValueError(f"This video has no audio track {track + 1}")
                audio = self._media_server.generate_audio_preview(path, track=track)
                if not audio:
                    return {
                        "ok": False,
                        "error": f"Could not preview audio track {track + 1}. Export still works.",
                    }
                token = self._media_server.register_file(audio)
                return {"ok": True, "url": self._media_server.get_url(token), "token": token}
            except (OSError, ValueError, RuntimeError) as exc:
                return {"ok": False, "error": str(exc)}
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

    def export_frame(self, request: object, *, work: RequestWork | None = None) -> BridgeResult:
        try:
            return export_frame(request, work=work)
        except subprocess.CalledProcessError:
            return {
                "ok": False,
                "error": "The source video could not be read. Choose another video",
            }
        except (ValueError, OSError, RuntimeError, FFmpegError) as exc:
            return {"ok": False, "error": str(exc)}

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

    def get_waveform(self, path: str, track: int = 0) -> BridgeResult:
        try:
            path = self._validate_path(path)
            if isinstance(track, bool) or not isinstance(track, int) or track < 0:
                raise ValueError("track must be a whole number >= 0")
            if track == 0:
                self._probe_audio_once(path)
            elif track >= self._probe_once(path).audio_stream_count:
                raise ValueError(f"This video has no audio track {track + 1}")
            waveform = self._media_server.generate_waveform(path, track=track)
            if not waveform:
                return {"ok": False, "error": "Could not generate audio waveform"}
            token = self._media_server.register_file(waveform)
            return {"ok": True, "url": self._media_server.get_url(token), "token": token}

        except Exception as e:
            return {"ok": False, "error": str(e)}

    def analyze_cut(self, path: str, work_id: str) -> BridgeResult:
        try:
            source = Path(validate_path(path))
            return {"ok": True, **analysis_snapshot_dict(self._cut_analysis.start(source, work_id))}
        except (ValueError, OSError) as exc:
            return {"ok": False, "error": str(exc), "code": "analysis_failed", "field": "cut"}

    def get_cut_analysis(self, path: str, keyframes: KeyframeCursor | None = None) -> BridgeResult:
        try:
            if not isinstance(path, str) or not path:
                raise ValueError("Invalid path: empty or not a string")
            # only a lookup key: nothing is opened, and a removed file reads as changed
            snapshot = self._cut_analysis.get(Path(path))
            return {"ok": True, **analysis_snapshot_dict(snapshot, keyframes)}
        except (ValueError, OSError) as exc:
            return {"ok": False, "error": str(exc), "code": "analysis_failed", "field": "cut"}

    def cancel_cut_work(self, work_id: str) -> BridgeResult:
        return {"ok": True, "cancelled": self._cut_analysis.cancel(work_id)}

    def create_plan(self, request: object) -> BridgeResult:
        if not isinstance(request, dict):
            return {"ok": False, "error": "Expected request object"}
        raw = request

        req_id = raw.get("_request_id", 0)

        if raw.get("operation") == "cut":
            try:
                cut_request = parse_cut_request(raw, **self._cut_options())
                analysis = self._cut_analysis.result(Path(cut_request.source))
                cut_plan = plan_cut(cut_request, analysis)
                return {"ok": True, "_request_id": req_id, "data": cut_plan_preview_dict(cut_plan)}
            except (ValueError, OSError) as exc:
                return {
                    "ok": False,
                    "error": str(exc),
                    "code": exc.code
                    if isinstance(exc, CutAnalysisError)
                    else "invalid_cut_request",
                    "field": "cut",
                    "_request_id": req_id,
                }

        try:
            req = self._parse_plan_request(raw)
        except PlanValidationError as e:
            return {"ok": False, "error": str(e), "field": e.field, "_request_id": req_id}
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

        except PlanValidationError as e:
            return {"ok": False, "error": str(e), "field": e.field, "_request_id": req_id}
        except Exception as e:
            return {"ok": False, "error": str(e), "_request_id": req_id}

    def enqueue_with_options(
        self, request: object, *, work: RequestWork | None = None
    ) -> BridgeResult:
        if not isinstance(request, dict):
            return {"ok": False, "error": "Expected request object"}
        raw = request

        if raw.get("operation") == "cut":
            return self._enqueue_cut(raw, work or RequestWork())

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

    def _enqueue_cut(self, raw: object, work: RequestWork) -> dict[str, JsonValue]:
        try:
            check_request(work)
            request, fingerprint = parse_cut_export(raw, **self._cut_options())
            cut = self._cut_analysis.plan_for_export(request, fingerprint, work)
            options = self._planning_options()
            cut = replace(
                cut,
                keep_file_dates=options["keep_file_dates"],
                replace_existing=options["replace_existing"],
            )
            item = self._queue.enqueue(cut, work=work)
            return {"ok": True, "item_id": item.id}
        except CutPlanChanged as exc:
            return {
                "ok": False,
                "error": str(exc),
                "code": exc.code,
                "field": "cut",
                "current_plan": cut_plan_preview_dict(exc.current_plan),
            }
        except (CutAnalysisError, OSError, ValueError) as exc:
            return {
                "ok": False,
                "error": str(exc),
                "code": exc.code if isinstance(exc, CutAnalysisError) else "invalid_cut_request",
                "field": "cut",
            }

    def enqueue_batch(self, requests: object, *, work: RequestWork | None = None) -> BridgeResult:
        if not isinstance(requests, list) or not requests:
            return {"ok": False, "error": "No requests provided"}
        raw = requests
        work = work or RequestWork()

        planning_options = None
        enqueued: list[str] = []
        errors: list[str] = []
        rejections: list[JsonValue] = []

        for idx, entry in enumerate(raw):
            if not isinstance(entry, dict):
                errors.append(f"Request {idx}: expected JSON object")
                continue
            if entry.get("operation") == "cut":
                response = self._enqueue_cut(entry, work)
                item_id = response.get("item_id")
                if response["ok"] and isinstance(item_id, str):
                    enqueued.append(item_id)
                else:
                    errors.append(str(response["error"]))
                    rejections.append({"index": idx, **response})
                continue
            # the request's time budget is for preparing cuts; encodes plan quickly
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
                if planning_options is None:
                    planning_options = self._planning_options()
                enc_plan = self._build_plan(req, profile, planning_options)
                item = self._queue.enqueue(enc_plan)
                enqueued.append(item.id)
            except Exception as e:
                errors.append(f"{Path(req.source).name}: {e}")

        if not enqueued:
            return {
                "ok": False,
                "error": "No files could be enqueued",
                "errors": errors,
                "rejections": rejections,
            }

        return {
            "ok": True,
            "enqueued": enqueued,
            "errors": errors,
            "count": len(enqueued),
            "rejections": rejections,
        }

    def cancel_item(self, item_id: str) -> BridgeResult:
        ok = self._queue.cancel(str(item_id))
        return {"ok": ok}

    def remove_item(self, item_id: str) -> BridgeResult:
        # a running export is cancelled first; the queue never drops one mid-encode
        if self._queue.remove(str(item_id)):
            return {"ok": True}
        return {
            "ok": False,
            "error": "This export can't be removed while it runs. Cancel it first.",
        }

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

    def retry_item(self, item_id: str, *, work: RequestWork | None = None) -> BridgeResult:
        try:
            item = self._queue.retry(str(item_id), work=work)
        except CutPlanChanged as exc:
            return {
                "ok": False,
                "error": str(exc),
                "code": exc.code,
                "field": "cut",
                "current_plan": cut_plan_preview_dict(exc.current_plan),
            }
        except CutAnalysisError as exc:
            return {"ok": False, "error": str(exc), "code": exc.code, "field": "cut"}
        except RetryRefused as exc:
            return {"ok": False, "error": str(exc), "code": exc.code}
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
            # the page only knows the requested encoder; the queue item knows what really ran
            resolved_encoder=str(
                (matched_item.effective_encoder if matched_item is not None else "")
                or raw.get("resolved_encoder")
                or (getattr(plan_obj, "video_encoder", "") if plan_obj else "")
            ),
            encoder_fallback=matched_item.encoder_fallback if matched_item is not None else "",
            workflow=str(
                raw.get("workflow") or (getattr(plan_obj, "workflow", "") if plan_obj else "")
            ),
            profile_name=str(raw.get("profile_name") or ""),
            extra=extra or None,
        )
        return {"ok": True, "text": text}

    def install_profile_sendto(self, profile_id: str, action: str = "start") -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}
        try:
            from .sendto import install_profile_shortcut

            path = install_profile_shortcut(
                profile_id,
                found.name,
                action=action,
                workflow=found.workflow,
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

    def repair_profile_sendto(self, profile_id: str, action: str = "start") -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}
        try:
            from .sendto import repair_profile_shortcut

            repaired = repair_profile_shortcut(
                profile_id,
                found.name,
                action=action,
                workflow=found.workflow,
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

    def install_generic_sendto(self, kind: object) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import generic_shortcut, install_generic_shortcut

            spec = generic_shortcut(kind)
            path = install_generic_shortcut(spec.kind)
            return {"ok": True, "kind": spec.kind, "path": str(path)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def remove_generic_sendto(self, kind: object) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import generic_shortcut, uninstall_generic_shortcut

            spec = generic_shortcut(kind)
            removed = uninstall_generic_shortcut(spec.kind)
            return {"ok": True, "kind": spec.kind, "removed": removed}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def repair_generic_sendto(self, kind: object) -> BridgeResult:

        if is_linux_desktop():
            return {"ok": False, "error": "Send To shortcuts are only available on Windows."}
        try:
            from .sendto import generic_shortcut, repair_generic_shortcut

            spec = generic_shortcut(kind)
            repaired = repair_generic_shortcut(spec.kind)
            return {"ok": True, "kind": spec.kind, "repaired": repaired}
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
            "hidden_ui": list(s.hidden_ui),
            "start_task": s.start_task,
            "compression_suffix": getattr(s, "compression_suffix", "_tucked_{size}")
            or "_tucked_{size}",
            "upscale_suffix": getattr(s, "upscale_suffix", "_upscaled_{width}x{height}")
            or "_upscaled_{width}x{height}",
            "cut_suffix": s.cut_suffix,
            "timeline_snap": s.timeline_snap,
            "timeline_keyframes": s.timeline_keyframes,
            "shortcut_overrides": {
                command: list(combos) for command, combos in s.shortcut_overrides.items()
            },
            "accent_color": s.accent_color,
            "interface_size": s.interface_size,
            "animations": s.animations,
            "time_format": s.time_format,
            "output_location": s.output_location,
            "output_subfolder": s.output_subfolder,
            "keep_file_dates": s.keep_file_dates,
            "notify_when_done": s.notify_when_done,
            "keep_awake": s.keep_awake,
            "background_exports": s.background_exports,
            "remove_after_export": s.remove_after_export,
            "reopen_last_videos": s.reopen_last_videos,
            # files moved or deleted since the last session are not offered again
            # checking up to 500 paths can be slow on network drives, so only when they're used
            "last_session_files": (
                [path for path in s.last_session_files if Path(path).is_file()]
                if s.reopen_last_videos
                else list(s.last_session_files)
            ),
            "loop_playback": s.loop_playback,
            "timeline_style": s.timeline_style,
            "skip_seconds": s.skip_seconds,
            "name_taken": s.name_taken,
            "pinned_profile_ids": list(s.pinned_profile_ids),
            "hidden_profile_ids": list(s.hidden_profile_ids),
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
            "hidden_ui",
            "start_task",
            "compression_suffix",
            "upscale_suffix",
            "cut_suffix",
            "shortcut_overrides",
            "output_location",
            "output_subfolder",
            "last_session_files",
            *FLAG_PREFERENCES,
            *CHOICE_PREFERENCES,
            *PROFILE_LIST_PREFERENCES,
        }
        preference_normalizers: dict[str, Callable[[object], object]] = {
            "hidden_ui": normalize_hidden_ui,
            "start_task": normalize_start_task,
            "cut_suffix": normalize_cut_suffix,
            "shortcut_overrides": normalize_shortcut_overrides,
            "output_location": normalize_output_location,
            "output_subfolder": normalize_output_subfolder,
            "last_session_files": normalize_session_files,
            **{key: partial(normalize_encode_suffix, key) for key in ENCODE_SUFFIXES},
            **{key: partial(normalize_timeline_toggle, key) for key in FLAG_PREFERENCES},
            **{key: partial(normalize_choice, key) for key in CHOICE_PREFERENCES},
            **{key: partial(normalize_profile_ids, key) for key in PROFILE_LIST_PREFERENCES},
        }
        preferences: dict[str, object] = {}
        updates: dict[str, object] = {}
        for key, normalize in preference_normalizers.items():
            if key in data:
                try:
                    preferences[key] = normalize(data[key])
                except ValueError as error:
                    return {"ok": False, "error": str(error)}
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
                if key == "last_task" and data[key] not in ("compression", "upscale", "cut"):
                    return {"ok": False, "error": "last_task must be compression, upscale or cut"}

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
                # pages save every field together, so a saved folder or tool that has since
                # gone missing is only checked again when it is changed
                unchanged = data[key] == self._settings.get_setting(key)
                if key == "output_dir":
                    val = data[key]
                    if not isinstance(val, str):
                        return {"ok": False, "error": "output_dir must be string"}
                    if val and not unchanged and not Path(val).is_dir():
                        return {"ok": False, "error": f"output_dir does not exist: {val}"}

                if key in ("ffmpeg_path", "ffprobe_path"):
                    val = data[key]
                    if not isinstance(val, str):
                        return {"ok": False, "error": f"{key} must be string"}
                    if val and not unchanged and not Path(val).is_file():
                        return {"ok": False, "error": f"File not found: {val}"}
                updates[key] = preferences.get(key, data[key])

        # only a change to where exports go is held to this; other saves must not fail on it
        if "output_location" in updates or "output_dir" in updates:
            location = updates.get("output_location", self._settings.get_setting("output_location"))
            folder = updates.get("output_dir", self._settings.get_setting("output_dir", ""))
            if location == OUTPUT_LOCATION_FOLDER and not folder:
                return {"ok": False, "error": "Choose a folder for your exports."}

        # every key is checked before any is applied, so a rejected value changes nothing;
        # a failed save puts memory back to what is on disk
        with self._settings.lock:
            for key, value in updates.items():
                self._settings.set_setting(key, value)
            self._settings.save()
        self._apply_run_preferences()
        if ffmpeg_path_changed:
            clear_encoder_cache(delete_disk=True)
        return {"ok": True}

    def export_settings_to_file(self, file_path: str) -> BridgeResult:
        return self._settings_backup.export_to_file(file_path)

    def import_settings_from_file(self, file_path: str) -> BridgeResult:
        return self._settings_backup.import_from_file(file_path)

    def reset_settings(self) -> BridgeResult:
        return self._settings_backup.reset()

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

    def _validate_path(self, path: str) -> str:
        return validate_path(path)

    def _resolve_profile(self, profile_id: str) -> Profile | None:
        profiles = self._settings.get_profiles()
        if not profile_id:
            return self._settings.get_default_profile()
        return find_profile_by_id(profiles, profile_id)

    def _parse_plan_request(self, raw: dict[str, Any]) -> PlanRequest:
        # cut requests are routed to the cut planner before this point
        if raw.get("operation", "encode") != "encode":
            raise ValueError("Unknown export operation")

        return parse_plan_request(raw, self._validate_path)

    def _planning_options(self) -> OutputOptions:
        return output_options(self._settings.load())

    def _apply_run_preferences(self) -> None:
        settings = self._settings.load()
        self._queue.set_run_preferences(
            keep_awake=settings.keep_awake, low_priority=settings.background_exports
        )

    def _cut_options(self) -> CutOutputOptions:
        # read for both preview and export, so a change in between shows up as a changed plan
        options = output_options(self._settings.load())
        return {
            "name_suffix": str(self._settings.get_setting("cut_suffix", DEFAULT_CUT_SUFFIX)),
            "output_folder": options["output_dir"],
            "output_subfolder": options["output_subfolder"],
        }

    def _build_plan(
        self,
        request: PlanRequest,
        profile: Profile,
        options: OutputOptions | None = None,
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
