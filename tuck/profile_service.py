from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import cast

from .bridge_contract import BridgeResult
from .bridge_serialization import profile_ui_dict
from .bridge_validation import normalize_profile_ui_payload
from .desktop_platform import is_linux_desktop
from .models import (
    PROFILE_ID_DISCORD_FREE,
    Profile,
    export_profiles_json,
    find_profile_by_id,
    import_profiles_json,
    merge_imported_profiles,
    normalize_profile_id,
)
from .settings import ProfilesUnreadableError, SettingsManager

logger = logging.getLogger(__name__)


class ProfileService:
    def __init__(self, settings: SettingsManager) -> None:
        self._settings = settings

    def _store(self, profiles: list[Profile]) -> BridgeResult | None:
        """saves the new list, or returns why it can't be saved; a refused list is undone"""
        with self._settings.lock:
            self._settings.set_profiles(profiles)
            try:
                self._settings.save()
            except ProfilesUnreadableError as exc:
                return {"ok": False, "error": str(exc)}
        return None

    def list_profiles(self) -> BridgeResult:
        return [
            profile_ui_dict(profile, include_explicit_bitrate=True)
            for profile in self._settings.get_profiles()
        ]

    def import_from_file(self, file_path: str) -> BridgeResult:
        path = Path(file_path)
        if not path.is_file():
            return {"ok": False, "error": f"File not found: {file_path}"}
        try:
            imported = import_profiles_json(path)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

        merged = merge_imported_profiles(self._settings.get_profiles(), imported)
        if refused := self._store(merged):
            return refused
        return {"ok": True, "count": len(imported)}

    def export_to_file(self, file_path: str, profile_id: str) -> BridgeResult:
        profile = find_profile_by_id(self._settings.get_profiles(), profile_id)
        if profile is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}

        try:
            export_profiles_json([profile], Path(file_path))
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def create(self, profile: object) -> BridgeResult:
        if not isinstance(profile, dict):
            return {"ok": False, "error": "Expected profile object"}
        try:
            data = normalize_profile_ui_payload(profile)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        data.pop("profile_id", None)
        data["profile_id"] = uuid.uuid4().hex[:12]
        if "scaler" not in data:
            data["scaler"] = self._settings.get_setting("default_scaler", "neighbor")

        try:
            validated = Profile.from_dict(data)
        except (ValueError, TypeError) as exc:
            return {"ok": False, "error": str(exc)}

        profiles = self._settings.get_profiles()
        profiles.append(validated)
        if refused := self._store(profiles):
            return refused
        return {"ok": True, "profile_id": validated.profile_id}

    def duplicate(self, profile_id: str) -> BridgeResult:
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}

        data = found.to_dict()
        data["profile_id"] = uuid.uuid4().hex[:12]
        data["name"] = f"{found.name} (copy)"
        try:
            validated = Profile.from_dict(data)
        except (ValueError, TypeError) as exc:
            return {"ok": False, "error": str(exc)}

        profiles.append(validated)
        if refused := self._store(profiles):
            return refused
        return {"ok": True, "profile_id": validated.profile_id}

    def delete(self, profile_id: str) -> BridgeResult:
        profile_id = normalize_profile_id(profile_id)
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}
        if len(profiles) <= 1:
            return {"ok": False, "error": "Cannot delete the last profile"}

        remaining = [profile for profile in profiles if profile.profile_id != profile_id]
        with self._settings.lock:
            if self._settings.get_setting("default_profile_id", "") == profile_id:
                self._settings.set_setting("default_profile_id", pick_surviving_default(remaining))
            if refused := self._store(remaining):
                return refused

        try:
            from .sendto import uninstall_profile_shortcut

            uninstall_profile_shortcut(profile_id)
        except Exception as exc:
            logger.warning(
                "Could not remove Send To shortcut for deleted profile %s: %s",
                profile_id,
                exc,
            )
        return {"ok": True}

    def update(self, profile_id: str, profile: object) -> BridgeResult:
        profile_id = normalize_profile_id(profile_id)
        if not isinstance(profile, dict):
            return {"ok": False, "error": "Expected profile object"}

        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}

        try:
            data = normalize_profile_ui_payload(profile)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}

        if "profile_id" in data and (
            not isinstance(data["profile_id"], str)
            or normalize_profile_id(data["profile_id"]) != found.profile_id
        ):
            return {"ok": False, "error": "profile_id cannot be changed"}
        if "schema_version" in data:
            return {"ok": False, "error": "schema_version cannot be changed"}

        data["profile_id"] = found.profile_id
        try:
            validated = Profile.from_dict({**found.to_dict(), **data})
        except (ValueError, TypeError) as exc:
            return {"ok": False, "error": str(exc)}

        for index, existing in enumerate(profiles):
            if existing.profile_id == profile_id:
                profiles[index] = validated
                break

        if refused := self._store(profiles):
            return refused
        if validated.name != found.name or validated.workflow != found.workflow:
            _rename_sendto_shortcut(profile_id, validated)
        return {"ok": True}


def _rename_sendto_shortcut(profile_id: str, profile: Profile) -> None:
    # the profile is already saved, so a shortcut problem is only logged
    if is_linux_desktop():
        return
    try:
        from .sendto import rename_profile_shortcut

        rename_profile_shortcut(profile_id, profile.name, workflow=profile.workflow)
    except Exception as exc:
        logger.warning("Could not rename Send To shortcut for profile %s: %s", profile_id, exc)


def pick_surviving_default(remaining: list[Profile]) -> str:
    desired_order = [PROFILE_ID_DISCORD_FREE, "discord-50mb", "discord-500mb"]
    remaining_ids = {profile.profile_id for profile in remaining}
    for profile_id in desired_order:
        if profile_id in remaining_ids:
            return profile_id
    if remaining:
        return cast(str, remaining[0].profile_id)
    return PROFILE_ID_DISCORD_FREE
