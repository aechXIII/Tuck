from __future__ import annotations

import contextlib
import json
import uuid
from collections.abc import Callable
from dataclasses import fields
from pathlib import Path

from .bridge_contract import BridgeResult
from .models import (
    PROFILE_SCHEMA_VERSION,
    AppSettings,
    Profile,
    dicts_to_profiles,
    find_profile_by_id,
    profiles_to_dicts,
)
from .models.ui_preferences import migrate_appearance_preferences
from .settings import ProfilesUnreadableError, SettingsManager

BACKUP_FORMAT = "tuck-settings"
BACKUP_VERSION = 1
BACKUP_MAX_BYTES = 4 * 1024 * 1024

# a backup holds the choices a person made, not window sizes or what was open last time
_SESSION_KEYS = frozenset(
    {
        "version",
        "profiles",
        "last_update_check",
        "last_session_files",
        "window_width",
        "window_height",
        "left_sidebar_width",
        "timeline_height",
        "last_inspector_panel",
        "last_task",
        "last_compress_profile_id",
        "last_upscale_profile_id",
    }
)
# paths that may not exist on another computer; a restore skips them instead of failing
_PATH_KEYS = ("output_dir", "ffmpeg_path", "ffprobe_path")

BACKUP_KEYS: tuple[str, ...] = tuple(
    f.name for f in fields(AppSettings) if f.name not in _SESSION_KEYS
)


def _restored_profiles(existing: list[Profile], restored: list[Profile]) -> list[Profile]:
    """Restore profiles by id, so restoring the same backup twice doesn't duplicate them."""
    by_id = {profile.profile_id: profile for profile in existing if profile.profile_id}
    order = [profile.profile_id for profile in existing if profile.profile_id]
    for profile in restored:
        if not profile.profile_id:
            profile.profile_id = uuid.uuid4().hex[:12]
        if profile.profile_id not in by_id:
            order.append(profile.profile_id)
        by_id[profile.profile_id] = profile
    return [by_id[profile_id] for profile_id in order]


class SettingsBackupService:
    """Writes, restores, and resets the user's settings and profiles as one file."""

    def __init__(
        self,
        settings: SettingsManager,
        save_settings: Callable[[object], BridgeResult],
    ) -> None:
        self._settings = settings
        # restores go through the same checks as any other settings change
        self._save_settings = save_settings

    def export_to_file(self, file_path: str) -> BridgeResult:
        stored = self._settings.load().to_dict()
        document = {
            "format": BACKUP_FORMAT,
            "version": BACKUP_VERSION,
            "profile_version": PROFILE_SCHEMA_VERSION,
            "settings": {key: stored[key] for key in BACKUP_KEYS},
            "profiles": profiles_to_dicts(self._settings.get_profiles()),
        }
        path = Path(file_path)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            tmp.write_text(json.dumps(document, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError as exc:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            return {"ok": False, "error": f"Could not save the backup: {exc}"}
        return {"ok": True}

    def import_from_file(self, file_path: str) -> BridgeResult:
        try:
            settings, profiles = self._read_backup(Path(file_path))
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        skipped = [
            key for key in _PATH_KEYS if settings.get(key) and not _path_exists(key, settings)
        ]
        for key in skipped:
            settings.pop(key)

        # profiles and settings are restored together; holding the lock keeps another save
        # from writing the profiles before the settings have passed their checks
        with self._settings.lock:
            # a missing backup folder keeps the folder in use here, if there is one
            folder_missing = not self._settings.get_setting("output_dir")
            if "output_dir" in skipped and settings.get("output_location") == "folder":
                if folder_missing:
                    settings["output_location"] = "source"
                else:
                    settings.pop("output_location")
            previous = self._settings.get_profiles()
            self._settings.set_profiles(_restored_profiles(previous, profiles))
            try:
                result = self._save_settings(settings)
            except ProfilesUnreadableError as exc:
                return {"ok": False, "error": str(exc)}
            if not isinstance(result, dict) or not result.get("ok"):
                self._settings.set_profiles(previous)
                return result
        return {"ok": True, "profiles": len(profiles), "skipped": skipped}

    def reset(self) -> BridgeResult:
        defaults = AppSettings().to_dict()
        values = {key: defaults[key] for key in BACKUP_KEYS}
        # the default profile may have been deleted; keep the current choice then
        if find_profile_by_id(self._settings.get_profiles(), values["default_profile_id"]) is None:
            values.pop("default_profile_id")
        return self._save_settings(values)

    @staticmethod
    def _read_backup(path: Path) -> tuple[dict[str, object], list[Profile]]:
        try:
            if path.stat().st_size > BACKUP_MAX_BYTES:
                raise ValueError("This file is too large to be a Tuck settings backup.")
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("This file can't be read as a Tuck settings backup.") from exc
        if not isinstance(document, dict) or document.get("format") != BACKUP_FORMAT:
            raise ValueError("This file isn't a Tuck settings backup.")
        version = document.get("version")
        if not isinstance(version, int) or version > BACKUP_VERSION:
            raise ValueError("This backup is from a newer version of Tuck. Update Tuck first.")
        profile_version = document.get("profile_version", PROFILE_SCHEMA_VERSION)
        if not isinstance(profile_version, int) or profile_version > PROFILE_SCHEMA_VERSION:
            raise ValueError("This backup is from a newer version of Tuck. Update Tuck first.")
        settings = document.get("settings")
        profiles = document.get("profiles", [])
        if not isinstance(settings, dict) or not isinstance(profiles, list):
            raise ValueError("This settings backup is damaged.")
        try:
            restored = dicts_to_profiles(profiles)
        except (TypeError, ValueError, KeyError) as exc:
            raise ValueError(f"A profile in this backup is damaged: {exc}") from exc
        values = {key: value for key, value in settings.items() if key in BACKUP_KEYS}
        return migrate_appearance_preferences(values), restored


def _path_exists(key: str, settings: dict[str, object]) -> bool:
    value = settings[key]
    if not isinstance(value, str):
        return True  # left for the normal checks to reject
    return Path(value).is_dir() if key == "output_dir" else Path(value).is_file()
