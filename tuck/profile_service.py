from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import cast

from .bridge_contract import BridgeResult
from .bridge_serialization import profile_ui_dict
from .bridge_validation import normalize_profile_ui_payload
from .models import (
    PROFILE_ID_DISCORD_FREE,
    Profile,
    export_profiles_json,
    find_profile_by_id,
    import_profiles_json,
    merge_imported_profiles,
)
from .settings import SettingsManager

logger = logging.getLogger(__name__)


class ProfileService:
    def __init__(self, settings: SettingsManager) -> None:
        self._settings = settings

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
        self._settings.set_profiles(merged)
        self._settings.save()
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
        self._settings.set_profiles(profiles)
        self._settings.save()
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
        self._settings.set_profiles(profiles)
        self._settings.save()
        return {"ok": True, "profile_id": validated.profile_id}

    def delete(self, profile_id: str) -> BridgeResult:
        profiles = self._settings.get_profiles()
        found = find_profile_by_id(profiles, profile_id)
        if found is None:
            return {"ok": False, "error": f"Profile not found: {profile_id}"}
        if len(profiles) <= 1:
            return {"ok": False, "error": "Cannot delete the last profile"}

        if self._settings.get_setting("default_profile_id", "") == profile_id:
            remaining = [profile for profile in profiles if profile.profile_id != profile_id]
            self._settings.set_setting("default_profile_id", pick_surviving_default(remaining))

        self._settings.set_profiles(
            [profile for profile in profiles if profile.profile_id != profile_id]
        )
        self._settings.save()

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

        if "profile_id" in data and data["profile_id"] != found.profile_id:
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

        self._settings.set_profiles(profiles)
        self._settings.save()
        return {"ok": True}


def pick_surviving_default(remaining: list[Profile]) -> str:
    desired_order = [PROFILE_ID_DISCORD_FREE, "discord-50mb", "discord-500mb"]
    remaining_ids = {profile.profile_id for profile in remaining}
    for profile_id in desired_order:
        if profile_id in remaining_ids:
            return profile_id
    if remaining:
        return cast(str, remaining[0].profile_id)
    return PROFILE_ID_DISCORD_FREE
