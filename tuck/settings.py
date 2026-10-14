from __future__ import annotations

import contextlib
import copy
import json
import logging
import os

try:
    import msvcrt  # type: ignore[import-not-found]
except ImportError:
    msvcrt = None  # type: ignore[assignment]
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import platformdirs

if TYPE_CHECKING:

    class _FcntlModule(Protocol):
        LOCK_EX: int
        LOCK_UN: int

        def flock(self, fd: int, operation: int) -> None: ...

    fcntl: _FcntlModule | None
else:
    try:
        import fcntl
    except ImportError:
        fcntl = None

from .models import (
    BUILTIN_PROFILE_IDS,
    DEFAULT_PROFILES,
    FPS_MODE_LIMIT,
    FPS_MODE_SOURCE,
    PROFILE_ID_4K_UPSCALE,
    PROFILE_ID_1440P_UPSCALE,
    PROFILE_ID_DISCORD_FREE,
    PROFILE_ID_LEGACY_CUSTOM,
    PROFILE_SCHEMA_VERSION,
    RC_TARGET_SIZE,
    RCM_CBR,
    RCM_CRF,
    RES_MODE_LIMIT,
    RES_MODE_SOURCE,
    WORKFLOW_COMPRESSION,
    WORKFLOW_UPSCALE,
    AppSettings,
    Profile,
    dicts_to_profiles,
    find_profile_by_id,
    migrate_profile_ids,
    profile_id_migrations,
    profiles_to_dicts,
    read_profiles_json,
)
from .models.export_preferences import (
    DEFAULT_OUTPUT_SUBFOLDER,
    OUTPUT_LOCATION_FOLDER,
    OUTPUT_LOCATION_SOURCE,
    normalize_output_location,
    normalize_output_subfolder,
)
from .models.ui_preferences import (
    CHOICE_PREFERENCES,
    DEFAULT_CUT_SUFFIX,
    ENCODE_SUFFIXES,
    FLAG_PREFERENCES,
    PROFILE_LIST_PREFERENCES,
    START_TASK_LAST,
    clean_profile_ids,
    clean_session_files,
    clean_shortcut_overrides,
    migrate_appearance_preferences,
    normalize_choice,
    normalize_cut_suffix,
    normalize_encode_suffix,
    normalize_hidden_ui,
    normalize_start_task,
)

logger = logging.getLogger(__name__)

APP_NAME = "Tuck"
APP_AUTHOR = "Tuck"

_MISSING: object = object()
_storage_root: Path | None = None


def configure_storage_root(root: Path | None) -> None:
    """Override persisted paths for an isolated sidecar process before settings load."""
    global _storage_root
    if _settings_manager is not None:
        raise RuntimeError("Storage root must be configured before settings are created.")
    _storage_root = root.resolve() if root is not None else None


def _storage_path(name: str, fallback: Callable[[], Path]) -> Path:
    if _storage_root is None:
        return fallback()
    path = _storage_root / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config_dir() -> Path:
    return _storage_path(
        "config",
        lambda: Path(platformdirs.user_config_dir(APP_NAME, APP_AUTHOR, ensure_exists=True)),
    )


def _data_dir() -> Path:
    return _storage_path(
        "data", lambda: Path(platformdirs.user_data_dir(APP_NAME, APP_AUTHOR, ensure_exists=True))
    )


def _cache_dir() -> Path:
    return _storage_path(
        "cache", lambda: Path(platformdirs.user_cache_dir(APP_NAME, APP_AUTHOR, ensure_exists=True))
    )


def _log_dir() -> Path:
    p = _data_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def settings_path() -> Path:
    return _config_dir() / "settings.json"


def profiles_path() -> Path:
    return _config_dir() / "profiles.json"


def _dict_without_profiles(d: dict) -> dict:

    return {k: v for k, v in d.items() if k != "profiles"}


def _backup_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".bak")


def _is_settings_document(value: object) -> bool:
    return isinstance(value, dict)


def _is_profiles_document(value: object) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("profiles"), list)
        and bool(value["profiles"])
    )


def _atomic_write(
    path: Path,
    data: str,
    *,
    backup_validator: Callable[[object], bool] | None = None,
) -> None:
    """writes to a temp file, then renames it over the target so
    readers never see a half-written file"""
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    backup_tmp: Path | None = None
    try:
        tmp.write_text(data, encoding="utf-8")
        if backup_validator is not None and path.is_file():
            try:
                previous = path.read_text(encoding="utf-8")
                previous_value = json.loads(previous)
            except (OSError, json.JSONDecodeError):
                pass
            else:
                if backup_validator(previous_value):
                    backup = _backup_path(path)
                    backup_tmp = backup.with_name(f".{backup.name}.{uuid.uuid4().hex}.tmp")
                    backup_tmp.write_text(previous, encoding="utf-8")
                    backup_tmp.replace(backup)
                    backup_tmp = None
        tmp.replace(path)
    except Exception:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        if backup_tmp is not None:
            with contextlib.suppress(OSError):
                backup_tmp.unlink(missing_ok=True)
        raise


def _get_lock_path() -> Path:

    return _config_dir() / "settings.lock"


# keeps settings writes serialized across independent Tuck processes
class ProcessLock:
    def __init__(self, lock_path: Path) -> None:
        self._lock_path = lock_path
        self._fd: int | None = None

    def acquire(self) -> None:
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self._lock_path), os.O_CREAT | os.O_RDWR)
        try:
            os.lseek(fd, 0, os.SEEK_END)
            if os.lseek(fd, 0, os.SEEK_CUR) == 0:
                os.lseek(fd, 1, os.SEEK_SET)
                os.write(fd, b"\x00")

            os.lseek(fd, 0, os.SEEK_SET)
            if os.name == "nt" and msvcrt is not None:
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            elif fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX)
        except OSError as exc:
            os.close(fd)
            raise OSError(
                f"Could not acquire settings lock on {self._lock_path}. "
                f"Another Tuck process may be writing settings."
            ) from exc
        except Exception:
            os.close(fd)
            raise
        self._fd = fd

    def release(self) -> None:
        if self._fd is not None:
            try:
                os.lseek(self._fd, 0, os.SEEK_SET)
                if os.name == "nt" and msvcrt is not None:
                    msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                elif fcntl is not None:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = None

    def __enter__(self) -> ProcessLock:
        self.acquire()
        return self

    def __exit__(self, *args: object) -> None:
        self.release()


class ProfilesUnreadableError(ValueError):
    """profiles.json holds profiles this version can't read, so changing them would lose them"""


class SettingsManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._settings: AppSettings | None = None
        self._profiles: list[Profile] | None = None
        self._profile_id_migrations: dict[str, str] = {}

        self._settings_snapshot: dict | None = None
        self._profiles_snapshot: list[dict] | None = None

    @property
    def config_dir(self) -> Path:
        return _config_dir()

    @property
    def data_dir(self) -> Path:
        return _data_dir()

    @property
    def cache_dir(self) -> Path:
        return _cache_dir()

    @property
    def log_dir(self) -> Path:
        return _log_dir()

    def load(self) -> AppSettings:

        with self._lock:
            if self._settings is not None:
                return self._settings
            self._profiles = self._load_profiles()
            self._settings = self._load_settings()
            self._settings.profiles = profiles_to_dicts(self._profiles)
            return self._settings

    @property
    def lock(self) -> threading.RLock:
        """held by callers that change several values and must save or undo them together"""
        return self._lock

    def save(self) -> None:
        """acquires the cross-process lock, reloads from disk if another
        process changed the file, merges, then writes; a failed save puts memory
        back to what was last written, so a later save can't write the failed change"""
        with self._lock:
            if self._settings is None:
                return
            try:
                self._write()
            except Exception:
                self._restore_saved_state()
                raise

    def _restore_saved_state(self) -> None:
        if self._settings_snapshot is not None:
            self._settings = AppSettings.from_dict(copy.deepcopy(self._settings_snapshot))
        if self._profiles_snapshot is not None:
            self._profiles = dicts_to_profiles(copy.deepcopy(self._profiles_snapshot))

    def _write(self) -> None:
        assert self._settings is not None
        lock_path = _get_lock_path()
        with ProcessLock(lock_path):
            sp = settings_path()
            pp = profiles_path()

            profiles_readable = True
            if self._profiles_snapshot is not None and pp.exists():
                profiles_readable = self._reload_and_merge_profiles_if_stale(pp)

            if self._settings_snapshot is not None and sp.exists():
                self._reload_and_merge_settings_if_stale(sp)

            # profiles from another Tuck build are left on disk untouched; only a
            # profile change would overwrite them, so that one is refused up front
            profiles_changed = profiles_to_dicts(self._profiles or []) != self._profiles_snapshot
            if not profiles_readable and profiles_changed:
                raise ProfilesUnreadableError(
                    "Your saved profiles come from a different version of Tuck or are "
                    "damaged. Profile changes can't be saved here without losing them."
                )

            self._settings.profiles = profiles_to_dicts(self._profiles or [])
            data = json.dumps(self._settings.to_dict(), indent=2, ensure_ascii=False)
            _atomic_write(sp, data, backup_validator=_is_settings_document)

            if self._profiles is not None and profiles_readable:
                wrapped = {
                    "version": PROFILE_SCHEMA_VERSION,
                    "profiles": profiles_to_dicts(self._profiles),
                }
                if self._profile_id_migrations:
                    # an older settings backup still needs these ids after profiles are migrated
                    wrapped["profile_id_migrations"] = self._profile_id_migrations
                profiles_data = json.dumps(wrapped, indent=2, ensure_ascii=False)
                _atomic_write(pp, profiles_data, backup_validator=_is_profiles_document)

            self._settings_snapshot = _dict_without_profiles(self._settings.to_dict())
            self._profiles_snapshot = profiles_to_dicts(self._profiles or [])

    def _reload_and_merge_settings_if_stale(self, sp: Path) -> None:

        try:
            disk_raw = sp.read_text(encoding="utf-8")
            disk_data = json.loads(disk_raw)
        except (OSError, json.JSONDecodeError):
            return  # disk is unreadable; write our version
        if not _is_settings_document(disk_data):
            return

        disk_migrated = self._migrate_settings(disk_data)
        disk_cmp = _dict_without_profiles(disk_migrated)

        if disk_cmp == self._settings_snapshot:
            return  # no external change

        disk_settings = AppSettings.from_dict(disk_migrated)
        self._settings = self._merge_settings(disk_settings)

    def _reload_and_merge_profiles_if_stale(self, pp: Path) -> bool:
        """returns False when the file holds profiles this version can't read"""
        try:
            disk_raw = pp.read_text(encoding="utf-8")
            disk_data = json.loads(disk_raw)
        except (OSError, json.JSONDecodeError):
            return True
        if not isinstance(disk_data, dict):
            return True

        disk_profile_dicts: list[dict] = disk_data.get("profiles", [])
        if not isinstance(disk_profile_dicts, list):
            return True

        self._profile_id_migrations = profile_id_migrations(
            disk_profile_dicts, disk_data.get("profile_id_migrations")
        )

        if disk_profile_dicts == self._profiles_snapshot:
            return True  # no external change

        try:
            disk_profiles = dicts_to_profiles(disk_profile_dicts)
        except (TypeError, ValueError, KeyError):
            return False
        disk_profiles = self._migrate_profiles(disk_profiles)
        self._profiles = self._merge_profiles(disk_profiles)
        return True

    def _merge_settings(self, disk: AppSettings) -> AppSettings:
        """keeps our in-memory value if we changed it since loading;
        otherwise takes the disk value"""
        assert self._settings is not None, "_merge_settings called before settings loaded"
        current_dict = self._settings.to_dict()
        disk_dict = disk.to_dict()
        snapshot = self._settings_snapshot or {}

        merged: dict = {}
        for key in set(current_dict) | set(disk_dict):
            if key == "profiles":
                continue
            cur_val = current_dict.get(key)
            snap_val = snapshot.get(key, _MISSING)
            disk_val = disk_dict.get(key)

            if snap_val is _MISSING or cur_val != snap_val:
                merged[key] = cur_val
            elif key in disk_dict:
                merged[key] = disk_val
            else:
                merged[key] = cur_val

        return AppSettings.from_dict(merged)

    def _merge_profiles(self, disk_profiles: list[Profile]) -> list[Profile]:
        """Combine our profiles with another process's, using the last loaded or saved
        list as the common starting point.

        A profile either side deleted stays deleted unless the other side changed it
        meanwhile; when both sides changed the same profile, ours wins. The file format
        is unchanged, so older versions read the result as before.
        """
        base = {
            str(entry.get("profile_id")): entry
            for entry in self._profiles_snapshot or []
            if entry.get("profile_id")
        }
        ours = {p.profile_id: p for p in self._profiles or [] if p.profile_id}
        theirs = {p.profile_id: p for p in disk_profiles if p.profile_id}

        merged: dict[str, Profile] = {}
        for profile_id in [*theirs, *ours]:
            if profile_id in merged:
                continue
            original = base.get(profile_id)
            mine, other = ours.get(profile_id), theirs.get(profile_id)
            mine_unchanged = mine is not None and mine.to_dict() == original
            if mine is None:
                # we deleted it; it comes back only if the other process edited it since
                if other is None or other.to_dict() == original:
                    continue
                merged[profile_id] = other
            elif other is None:
                # the other process deleted it; it stays only if we edited it since
                if not mine_unchanged:
                    merged[profile_id] = mine
            else:
                merged[profile_id] = other if mine_unchanged else mine
        return list(merged.values())

    def get_profiles(self) -> list[Profile]:
        if self._profiles is None:
            self.load()
        return list(self._profiles or [])

    def set_profiles(self, profiles: list[Profile]) -> None:
        with self._lock:
            self._profiles = list(profiles)
            if self._settings:
                self._settings.profiles = profiles_to_dicts(self._profiles)

    def get_default_profile(self) -> Profile:

        profiles = self.get_profiles()
        default_id = self.load().default_profile_id
        found = find_profile_by_id(profiles, default_id)
        if found is not None:
            return found

        fallback = find_profile_by_id(profiles, PROFILE_ID_DISCORD_FREE)
        if fallback is not None:
            return fallback

        if profiles:
            return profiles[0]
        return DEFAULT_PROFILES[0]

    def get_setting(self, key: str, default=None):
        s = self.load()
        return getattr(s, key, default)

    def set_setting(self, key: str, value) -> None:
        value = migrate_profile_ids({key: value})[key]
        with self._lock:
            s = self.load()
            if hasattr(s, key):
                setattr(s, key, value)

    def _load_settings(self) -> AppSettings:
        sp = settings_path()
        for candidate in (sp, _backup_path(sp)):
            try:
                if not candidate.exists():
                    continue
                raw = candidate.read_text(encoding="utf-8")
                data = json.loads(raw)
                if not _is_settings_document(data):
                    continue
                migrated = self._migrate_settings(data)
                settings = AppSettings.from_dict(migrated)
                self._settings_snapshot = _dict_without_profiles(migrated)
                return settings
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                continue
        defaults = AppSettings()
        self._settings_snapshot = _dict_without_profiles(defaults.to_dict())
        return defaults

    def _load_profiles(self) -> list[Profile]:
        pp = profiles_path()
        for candidate in (pp, _backup_path(pp)):
            try:
                if not candidate.exists():
                    continue
                profiles, replacements = read_profiles_json(candidate)
                profiles = self._migrate_profiles(profiles)
                self._profile_id_migrations = replacements
                self._profiles_snapshot = profiles_to_dicts(profiles)
                return profiles
            except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError):
                continue

        defaults = [Profile.from_dict(p.to_dict()) for p in DEFAULT_PROFILES]
        self._profiles_snapshot = profiles_to_dicts(defaults)
        return defaults

    def _migrate_settings(self, data: dict) -> dict:
        replacements = self._profile_id_migrations if data.get("profile_ids_version") != 1 else None
        data = migrate_profile_ids(data, replacements)
        # settings and profiles are separate atomic writes, so do not remap new selections twice
        data["profile_ids_version"] = 1
        data = migrate_appearance_preferences(data)
        version = data.get("version", 0)

        if version < 1:
            if "default_profile" in data and "default_profile_id" not in data:
                old_default = data.pop("default_profile", "")
                data["default_profile_id"] = _map_old_default_name(old_default)
            data.pop("profiles", None)
            data["version"] = 1

        if "default_profile_id" not in data or not data["default_profile_id"]:
            data["default_profile_id"] = PROFILE_ID_DISCORD_FREE

        if data.get("default_profile_id") in (PROFILE_ID_LEGACY_CUSTOM, "tuck-default"):
            data["default_profile_id"] = PROFILE_ID_DISCORD_FREE

        for key in ("theme", "source_output_mode", "max_concurrent", "shortcut_installed"):
            data.pop(key, None)

        # a hand-edited or newer file must not stop Tuck from starting
        if "hidden_ui" in data:
            try:
                data["hidden_ui"] = normalize_hidden_ui(data["hidden_ui"])
            except ValueError:
                data["hidden_ui"] = []
        if "start_task" in data:
            try:
                data["start_task"] = normalize_start_task(data["start_task"])
            except ValueError:
                data["start_task"] = START_TASK_LAST
        if "cut_suffix" in data:
            try:
                data["cut_suffix"] = normalize_cut_suffix(data["cut_suffix"])
            except ValueError:
                data["cut_suffix"] = DEFAULT_CUT_SUFFIX
        # older versions saved any text here; one that would write outside the export
        # folder or into an alternate data stream goes back to the default
        for key in ENCODE_SUFFIXES:
            if key in data:
                try:
                    data[key] = normalize_encode_suffix(key, data[key])
                except ValueError:
                    logger.warning("Saved %s can't be used in file names; using the default", key)
                    data[key] = getattr(AppSettings(), key)
        for key in FLAG_PREFERENCES:
            if key in data and not isinstance(data[key], bool):
                data.pop(key)
        for key in CHOICE_PREFERENCES:
            if key in data:
                try:
                    data[key] = normalize_choice(key, data[key])
                except ValueError:
                    data.pop(key)
        if "shortcut_overrides" in data:
            data["shortcut_overrides"] = clean_shortcut_overrides(data["shortcut_overrides"])
        if "last_session_files" in data:
            data["last_session_files"] = clean_session_files(data["last_session_files"])
        for key in PROFILE_LIST_PREFERENCES:
            if key in data:
                data[key] = clean_profile_ids(data[key])
        # files from before the location choice: a chosen folder meant one folder for everything
        if "output_location" not in data:
            data["output_location"] = (
                OUTPUT_LOCATION_FOLDER if data.get("output_dir") else OUTPUT_LOCATION_SOURCE
            )
        else:
            try:
                data["output_location"] = normalize_output_location(data["output_location"])
            except ValueError:
                data["output_location"] = OUTPUT_LOCATION_SOURCE
        # one folder with no folder chosen saves beside the source anyway; say so in the file
        if data["output_location"] == OUTPUT_LOCATION_FOLDER and not data.get("output_dir"):
            data["output_location"] = OUTPUT_LOCATION_SOURCE
        if "output_subfolder" in data:
            try:
                data["output_subfolder"] = normalize_output_subfolder(data["output_subfolder"])
            except ValueError:
                data["output_subfolder"] = DEFAULT_OUTPUT_SUBFOLDER

        return data

    def _migrate_profiles(self, profiles: list[Profile]) -> list[Profile]:
        builtin_map: dict[str, Profile] = {}
        user_profiles: list[Profile] = []

        for p in profiles:
            if p.schema_version < 2:
                p.resolution_mode = RES_MODE_LIMIT
                p.fps_mode = FPS_MODE_LIMIT
                p.rate_control = RC_TARGET_SIZE

                if p.profile_id not in BUILTIN_PROFILE_IDS:
                    p.schema_version = PROFILE_SCHEMA_VERSION

            if p.schema_version < 3:
                if not hasattr(p, "workflow") or not p.workflow:
                    p.workflow = WORKFLOW_COMPRESSION
                if not hasattr(p, "rate_control_method") or not p.rate_control_method:
                    p.rate_control_method = RCM_CBR
                if not hasattr(p, "qp") or p.qp is None:
                    p.qp = 23

                if p.profile_id in (PROFILE_ID_1440P_UPSCALE, PROFILE_ID_4K_UPSCALE):
                    p.workflow = WORKFLOW_UPSCALE
                    p.rate_control_method = RCM_CRF
                    p.crf = 18
                    p.two_pass = False
                    p.preset = "medium"

                if p.profile_id not in BUILTIN_PROFILE_IDS:
                    p.schema_version = PROFILE_SCHEMA_VERSION

            if p.profile_id == PROFILE_ID_LEGACY_CUSTOM:
                import uuid

                p.profile_id = uuid.uuid4().hex[:12]
                p.name = "Custom (migrated)"
                p.schema_version = PROFILE_SCHEMA_VERSION
                user_profiles.append(p)
                continue

            if p.profile_id in BUILTIN_PROFILE_IDS:
                builtin_map[p.profile_id] = p
            else:
                user_profiles.append(p)

        result: list[Profile] = []
        for default in DEFAULT_PROFILES:
            if default.profile_id in builtin_map:
                existing = builtin_map[default.profile_id]

                if existing.schema_version < 2:
                    existing.name = default.name
                    existing.resolution_mode = RES_MODE_SOURCE
                    existing.fps_mode = FPS_MODE_SOURCE
                    existing.rate_control = RC_TARGET_SIZE
                    existing.keep_audio = True
                    existing.schema_version = PROFILE_SCHEMA_VERSION

                if existing.schema_version < 3:
                    existing.workflow = default.workflow
                    existing.rate_control_method = default.rate_control_method
                    existing.qp = default.qp
                    if existing.profile_id in (PROFILE_ID_1440P_UPSCALE, PROFILE_ID_4K_UPSCALE):
                        existing.crf = default.crf
                        existing.two_pass = default.two_pass
                        existing.preset = default.preset
                    existing.schema_version = 3

                if existing.schema_version == 3:
                    from .models import Profile

                    migrated = Profile.from_dict(existing.to_dict())
                    existing.__dict__.update(migrated.__dict__)

                result.append(existing)
            else:
                result.append(default)

        for up in user_profiles:
            if up.profile_id not in BUILTIN_PROFILE_IDS:
                if up.schema_version == 3:
                    from .models import Profile

                    migrated = Profile.from_dict(up.to_dict())
                    up.__dict__.update(migrated.__dict__)
                else:
                    up.schema_version = PROFILE_SCHEMA_VERSION
                result.append(up)

        return result

    def reset(self) -> None:
        """restores built-in defaults and clears the snapshot so next
        save always writes to disk"""
        with self._lock:
            self._settings = AppSettings()

            self._profiles = [Profile.from_dict(p.to_dict()) for p in DEFAULT_PROFILES]
            self._settings_snapshot = None
            self._profiles_snapshot = None


_settings_manager: SettingsManager | None = None


def get_settings_manager() -> SettingsManager:
    global _settings_manager
    if _settings_manager is None:
        _settings_manager = SettingsManager()
    return _settings_manager


_OLD_NAME_MAP = {
    "Discord Free (8 MB)": PROFILE_ID_DISCORD_FREE,
    "Discord Free (10 MB)": PROFILE_ID_DISCORD_FREE,
    "Discord Free - 10MB": PROFILE_ID_DISCORD_FREE,
    "Discord Free (20 MB)": PROFILE_ID_DISCORD_FREE,
    "Discord Free - 20MB": PROFILE_ID_DISCORD_FREE,
    "Discord Nitro Basic (50 MB)": "discord-50mb",
    "Discord Nitro Basic - 50MB": "discord-50mb",
    "Discord Nitro (500 MB)": "discord-500mb",
    "Discord Nitro - 500MB": "discord-500mb",
    "Discord Nitro (100 MB)": "discord-50mb",
    "Custom": PROFILE_ID_DISCORD_FREE,
    "discord-10mb": PROFILE_ID_DISCORD_FREE,
    "discord-free": PROFILE_ID_DISCORD_FREE,
    "discord-50mb": "discord-50mb",
    "discord-500mb": "discord-500mb",
    "custom": PROFILE_ID_DISCORD_FREE,
    "tuck-default": PROFILE_ID_DISCORD_FREE,
    "Tuck Default (100 MB)": PROFILE_ID_DISCORD_FREE,
}


def _map_old_default_name(name: str) -> str:

    return _OLD_NAME_MAP.get(name, PROFILE_ID_DISCORD_FREE)
