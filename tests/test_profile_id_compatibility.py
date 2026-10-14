import json

import pytest

from tuck.cli import _build_parser, _resolve_profile
from tuck.models import (
    DEFAULT_PROFILES,
    PROFILE_ID_DISCORD_FREE,
    AppSettings,
    Profile,
    find_profile_by_id,
)
from tuck.settings import SettingsManager


def test_discord_free_uses_a_size_independent_id():
    assert PROFILE_ID_DISCORD_FREE == "discord-free"
    assert (
        find_profile_by_id(DEFAULT_PROFILES, "discord-free").target_size_bytes == 20 * 1024 * 1024
    )


@pytest.mark.parametrize("profile_id", ["discord-free", "discord-10mb"])
def test_cli_accepts_both_profile_ids(profile_id):
    args = _build_parser().parse_args(["compress", "clip.mp4", "--profile", profile_id])
    profile = _resolve_profile(args, DEFAULT_PROFILES)
    assert profile is not None
    assert profile.profile_id == "discord-free"


def test_import_preserves_customized_legacy_profile():
    data = DEFAULT_PROFILES[0].to_dict()
    data.update(profile_id="discord-10mb", name="My upload", target_size_bytes=7 * 1024 * 1024)
    profile = Profile.from_dict(data)
    assert profile.profile_id == "discord-free"
    assert profile.name == "My upload"
    assert profile.target_size_bytes == 7 * 1024 * 1024


def test_settings_normalize_old_selections_and_deduplicate_lists():
    settings = AppSettings.from_dict(
        {
            "default_profile_id": "discord-10mb",
            "last_compress_profile_id": "discord-10mb",
            "pinned_profile_ids": ["discord-10mb", "discord-free", "discord-50mb"],
            "hidden_profile_ids": ["discord-10mb"],
        }
    )
    assert settings.default_profile_id == "discord-free"
    assert settings.last_compress_profile_id == "discord-free"
    assert settings.pinned_profile_ids == ["discord-free", "discord-50mb"]
    assert settings.hidden_profile_ids == ["discord-free"]


def test_saved_legacy_profile_is_migrated_once_with_preferences(tmp_path, monkeypatch):
    import tuck.settings as settings_mod

    monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
    data = DEFAULT_PROFILES[0].to_dict()
    data.update(profile_id="discord-10mb", name="My upload", target_size_bytes=7 * 1024 * 1024)
    (tmp_path / "profiles.json").write_text(json.dumps({"profiles": [data]}), encoding="utf-8")
    (tmp_path / "settings.json").write_text(
        json.dumps(
            {
                "version": 1,
                "default_profile_id": "discord-10mb",
                "last_compress_profile_id": "discord-10mb",
                "pinned_profile_ids": ["discord-10mb"],
            }
        ),
        encoding="utf-8",
    )
    manager = SettingsManager()
    settings = manager.load()
    profile = manager.get_default_profile()
    assert profile.profile_id == "discord-free"
    assert profile.name == "My upload"
    assert profile.target_size_bytes == 7 * 1024 * 1024
    assert settings.last_compress_profile_id == "discord-free"
    assert settings.pinned_profile_ids == ["discord-free"]
    assert sum(p.profile_id == "discord-free" for p in manager.get_profiles()) == 1
    manager.save()
    reloaded = SettingsManager()
    assert reloaded.get_default_profile().to_dict() == profile.to_dict()
    assert (
        json.loads((tmp_path / "settings.json").read_text())["default_profile_id"] == "discord-free"
    )


def test_profile_edits_and_deletion_accept_legacy_id(tmp_path, monkeypatch):
    from tuck.profile_service import ProfileService

    monkeypatch.setattr("tuck.settings._config_dir", lambda: tmp_path)
    monkeypatch.setattr("tuck.settings._data_dir", lambda: tmp_path)
    removed = []
    monkeypatch.setattr("tuck.sendto.uninstall_profile_shortcut", removed.append)
    monkeypatch.setattr("tuck.profile_service._rename_sendto_shortcut", lambda *args: None)
    manager = SettingsManager()
    service = ProfileService(manager)
    assert service.update("discord-10mb", {"profile_id": "discord-10mb", "name": "My upload"}) == {
        "ok": True
    }
    assert manager.get_default_profile().name == "My upload"
    assert manager.get_default_profile().profile_id == "discord-free"
    assert service.delete("discord-10mb") == {"ok": True}
    assert find_profile_by_id(manager.get_profiles(), "discord-10mb") is None
    assert manager.load().default_profile_id != "discord-free"
    assert removed == ["discord-free"]


@pytest.mark.parametrize("selected", ["discord-10mb", "discord-free"])
def test_migration_preserves_a_custom_profile_with_the_new_builtin_id(
    tmp_path, monkeypatch, selected
):
    monkeypatch.setattr("tuck.settings._config_dir", lambda: tmp_path)
    monkeypatch.setattr("tuck.settings._data_dir", lambda: tmp_path)
    builtin = DEFAULT_PROFILES[0].to_dict()
    builtin["profile_id"] = "discord-10mb"
    custom = {
        **builtin,
        "profile_id": "discord-free",
        "name": "My upload",
        "target_size_bytes": 7 * 1024 * 1024,
    }
    (tmp_path / "profiles.json").write_text(
        json.dumps({"profiles": [builtin, custom]}), encoding="utf-8"
    )
    (tmp_path / "settings.json").write_text(
        json.dumps(
            {
                "version": 1,
                "default_profile_id": selected,
                "last_compress_profile_id": selected,
                "pinned_profile_ids": ["discord-10mb", "discord-free"],
                "hidden_profile_ids": ["discord-free"],
            }
        ),
        encoding="utf-8",
    )
    manager = SettingsManager()
    settings = manager.load()
    profiles = manager.get_profiles()
    original = next(p for p in profiles if p.profile_id == "discord-free")
    preserved = next(p for p in profiles if p.name == "My upload")
    assert original.target_size_bytes == 20 * 1024 * 1024
    assert preserved.profile_id != original.profile_id
    assert preserved.target_size_bytes == 7 * 1024 * 1024
    expected_id = original.profile_id if selected == "discord-10mb" else preserved.profile_id
    assert settings.default_profile_id == expected_id
    assert settings.last_compress_profile_id == expected_id
    assert settings.pinned_profile_ids == [original.profile_id, preserved.profile_id]
    assert settings.hidden_profile_ids == [preserved.profile_id]
    manager.save()
    saved_settings = (tmp_path / "settings.json").read_bytes()
    (tmp_path / "settings.json").write_text("corrupt", encoding="utf-8")
    recovered = SettingsManager().load()
    assert recovered.default_profile_id == expected_id
    assert recovered.last_compress_profile_id == expected_id
    assert recovered.pinned_profile_ids == [original.profile_id, preserved.profile_id]
    assert recovered.hidden_profile_ids == [preserved.profile_id]
    (tmp_path / "settings.json").write_bytes(saved_settings)
    manager.set_setting("check_updates", False)
    manager.save()
    # a settings write can finish before the separate profiles write
    (tmp_path / "profiles.json").write_text(
        json.dumps({"profiles": [builtin, custom]}), encoding="utf-8"
    )
    reloaded = SettingsManager()
    assert reloaded.load().default_profile_id == expected_id
    assert [p.to_dict() for p in reloaded.get_profiles()] == [p.to_dict() for p in profiles]


def test_backup_restore_preserves_colliding_profile_selections(tmp_path):
    from tuck.settings_backup import BACKUP_FORMAT, BACKUP_VERSION, SettingsBackupService

    builtin = {**DEFAULT_PROFILES[0].to_dict(), "profile_id": "discord-10mb"}
    custom = {**builtin, "profile_id": "discord-free", "name": "My upload"}
    backup = tmp_path / "backup.json"
    backup.write_text(
        json.dumps(
            {
                "format": BACKUP_FORMAT,
                "version": BACKUP_VERSION,
                "settings": {
                    "default_profile_id": "discord-free",
                    "pinned_profile_ids": ["discord-10mb", "discord-free"],
                },
                "profiles": [builtin, custom],
            }
        ),
        encoding="utf-8",
    )
    settings, profiles = SettingsBackupService._read_backup(backup)
    preserved = next(p for p in profiles if p.name == "My upload")
    assert preserved.profile_id != "discord-free"
    assert settings["default_profile_id"] == preserved.profile_id
    assert settings["pinned_profile_ids"] == ["discord-free", preserved.profile_id]
