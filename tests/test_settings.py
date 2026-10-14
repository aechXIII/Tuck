import contextlib
import json
import os
import threading
import time

import pytest

from tuck.engine import cleanup_cache
from tuck.models import (
    BUILTIN_PROFILE_IDS,
    DEFAULT_PROFILES,
    FPS_MODE_LIMIT,
    PROFILE_ID_4K_UPSCALE,
    PROFILE_ID_1440P_UPSCALE,
    PROFILE_ID_DISCORD_FREE,
    PROFILE_ID_DISCORD_NITRO,
    PROFILE_SCHEMA_VERSION,
    RC_TARGET_SIZE,
    RCM_CRF,
    RES_MODE_LIMIT,
    WORKFLOW_COMPRESSION,
    WORKFLOW_UPSCALE,
    Profile,
)
from tuck.models.ui_preferences import (
    HIDDEN_UI_PARTS,
    clean_shortcut_overrides,
    normalize_cut_suffix,
    normalize_hidden_ui,
    normalize_shortcut_overrides,
    normalize_start_task,
)
from tuck.settings import (
    ProcessLock,
    ProfilesUnreadableError,
    SettingsManager,
    _atomic_write,
    _get_lock_path,
    _map_old_default_name,
    profiles_path,
    settings_path,
)


class TestSettingsManager:
    def test_load_returns_defaults_on_first_run(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        s = mgr.load()
        assert s.default_profile_id == PROFILE_ID_DISCORD_FREE
        assert s.version == 1
        assert s.encoder_cache_days == 7

    def test_get_profiles_returns_defaults(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        profiles = mgr.get_profiles()
        assert len(profiles) == len(DEFAULT_PROFILES)
        ids = {p.profile_id for p in profiles}
        assert PROFILE_ID_DISCORD_FREE in ids
        assert PROFILE_ID_DISCORD_NITRO in ids

        assert "custom" not in ids
        assert "tuck-default" not in ids

    def test_save_and_load_preserves_settings(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("default_profile_id", PROFILE_ID_DISCORD_NITRO)
        mgr.set_setting("output_dir", str(tmp_path / "out"))
        mgr.set_setting("open_output_folder_after_queue", True)
        mgr.save()

        mgr2 = SettingsManager()
        s = mgr2.load()
        assert s.default_profile_id == PROFILE_ID_DISCORD_NITRO
        assert s.output_dir == str(tmp_path / "out")
        assert s.open_output_folder_after_queue is True

    def test_save_and_load_preserves_encoder_cache_days(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("encoder_cache_days", 30)
        mgr.save()

        assert SettingsManager().load().encoder_cache_days == 30

    def test_reset_restores_defaults(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("default_profile_id", PROFILE_ID_DISCORD_NITRO)
        mgr.set_profiles([])
        mgr.save()

        mgr.reset()
        mgr.save()

        s = mgr.load()
        assert s.default_profile_id == PROFILE_ID_DISCORD_FREE
        profiles = mgr.get_profiles()
        assert len(profiles) == len(DEFAULT_PROFILES)

    def test_get_default_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        profile = mgr.get_default_profile()
        assert profile.profile_id == PROFILE_ID_DISCORD_FREE
        assert profile.name == "Discord Free - 20MB"
        assert profile.target_size_bytes == 20 * 1024 * 1024

    def test_get_default_profile_with_changed_default(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("default_profile_id", PROFILE_ID_DISCORD_NITRO)
        mgr.save()

        profile = mgr.get_default_profile()
        assert profile.profile_id == PROFILE_ID_DISCORD_NITRO

    def test_get_default_profile_fallback(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("default_profile_id", "nonexistent")
        mgr.save()

        profile = mgr.get_default_profile()

        assert profile.profile_id == PROFILE_ID_DISCORD_FREE

    def test_set_profiles(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        custom = [Profile(name="Custom Profile", profile_id="custom-1")]
        mgr.set_profiles(custom)
        profiles = mgr.get_profiles()
        assert len(profiles) == 1
        assert profiles[0].profile_id == "custom-1"

    def test_corrupt_settings_falls_back(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        sp = tmp_path / "settings.json"
        sp.write_text("not valid json", encoding="utf-8")

        mgr = SettingsManager()
        s = mgr.load()
        assert s.default_profile_id == PROFILE_ID_DISCORD_FREE

    def test_atomic_write(self, tmp_path):
        target = tmp_path / "target.json"
        _atomic_write(target, '{"key": "value"}')
        assert target.exists()
        data = json.loads(target.read_text(encoding="utf-8"))
        assert data["key"] == "value"


class TestMigration:
    def test_untouched_discord_free_profile_updates_to_20mb(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        old_default = DEFAULT_PROFILES[0].to_dict()
        old_default.update(
            name="Discord Free - 10MB",
            target_size_bytes=10 * 1024 * 1024,
            schema_version=4,
        )
        _atomic_write(
            profiles_path(),
            json.dumps({"version": 4, "profiles": [old_default]}),
        )

        profile = SettingsManager().get_default_profile()

        assert profile.name == "Discord Free - 20MB"
        assert profile.target_size_bytes == 20 * 1024 * 1024
        assert profile.schema_version == PROFILE_SCHEMA_VERSION

    def test_customized_discord_free_profile_stays_at_10mb(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        customized = DEFAULT_PROFILES[0].to_dict()
        customized.update(
            name="Discord Free - 10MB",
            target_size_bytes=10 * 1024 * 1024,
            audio_bitrate=96_000,
            schema_version=4,
        )
        _atomic_write(
            profiles_path(),
            json.dumps({"version": 4, "profiles": [customized]}),
        )

        profile = SettingsManager().get_default_profile()

        assert profile.name == "Discord Free - 10MB"
        assert profile.target_size_bytes == 10 * 1024 * 1024
        assert profile.audio_bitrate == 96_000
        assert profile.schema_version == PROFILE_SCHEMA_VERSION

    def test_map_old_default_name_discord_free_8mb(self):
        result = _map_old_default_name("Discord Free (8 MB)")
        assert result == PROFILE_ID_DISCORD_FREE

    def test_map_old_default_name_discord_free_10mb(self):
        result = _map_old_default_name("Discord Free (10 MB)")
        assert result == PROFILE_ID_DISCORD_FREE

    def test_map_old_default_name_nitro_basic(self):
        result = _map_old_default_name("Discord Nitro Basic (50 MB)")
        assert result == "discord-50mb"

    def test_map_old_default_name_nitro(self):
        result = _map_old_default_name("Discord Nitro (500 MB)")
        assert result == "discord-500mb"

    def test_map_old_default_name_custom(self):
        result = _map_old_default_name("Custom")
        assert result == PROFILE_ID_DISCORD_FREE

    def test_map_old_default_name_unknown(self):
        result = _map_old_default_name("Unknown Profile")
        assert result == PROFILE_ID_DISCORD_FREE

    def test_migrate_v1_profiles_get_limit_modes(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        v1_profiles = [
            {
                "profile_id": "discord-10mb",
                "name": "Discord Free (10 MB)",
                "target_size_bytes": 10485760,
                "max_width": 1920,
                "max_height": 1080,
                "max_fps": 30.0,
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 1,
            },
        ]
        pp = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(v1_profiles), pp)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        found = None
        for p in profiles:
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                found = p
                break
        assert found is not None

        assert found.resolution_mode == RES_MODE_LIMIT
        assert found.fps_mode == FPS_MODE_LIMIT
        assert found.rate_control == RC_TARGET_SIZE
        assert found.keep_audio is False
        assert found.name == "Discord Free (10 MB)"

    def test_legacy_custom_migrated_to_user_profile(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        legacy = [
            {
                "profile_id": "custom",
                "name": "Custom",
                "target_size_bytes": 10485760,
                "max_width": 1920,
                "max_height": 1080,
                "max_fps": 30.0,
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 1,
            },
        ]
        profiles_path = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(legacy), profiles_path)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        user_customs = [p for p in profiles if p.name == "Custom (migrated)"]
        assert len(user_customs) >= 1
        for uc in user_customs:
            assert uc.profile_id not in BUILTIN_PROFILE_IDS
            assert uc.profile_id != "custom"

    def test_builtin_edit_persists_through_save_reload(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        mgr = SettingsManager()
        mgr.load()
        profiles = mgr.get_profiles()

        for i, p in enumerate(profiles):
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                p.name = "Discord Free - Edited"
                p.target_size_bytes = 25 * 1024 * 1024
                p.resolution_mode = "custom"
                p.custom_width = 1280
                p.custom_height = 720
                p.fps_mode = "custom"
                p.custom_fps = 24.0
                p.rate_control = "explicit_bitrate"
                p.explicit_bitrate = 2_000_000
                p.audio_bitrate = 192_000
                p.keep_audio = False
                p.two_pass = False
                p.preset = "fast"
                profiles[i] = p
                break

        mgr.set_profiles(profiles)
        mgr.save()

        monkeypatch.setattr(settings_mod, "_settings_manager", None)
        mgr2 = SettingsManager()
        mgr2.load()
        reloaded = mgr2.get_profiles()

        found = None
        for p in reloaded:
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                found = p
                break
        assert found is not None
        assert found.name == "Discord Free - Edited"
        assert found.target_size_bytes == 25 * 1024 * 1024
        assert found.resolution_mode == "custom"
        assert found.custom_width == 1280
        assert found.custom_height == 720
        assert found.fps_mode == "custom"
        assert found.custom_fps == 24.0
        assert found.rate_control == "target_size"
        assert found.explicit_bitrate == 0
        assert found.audio_bitrate == 192_000
        assert found.keep_audio is False
        assert found.two_pass is False
        assert found.preset == "fast"

        monkeypatch.setattr(settings_mod, "_settings_manager", None)

    def test_missing_builtin_seeded_from_defaults(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        partial = [
            {
                "profile_id": "discord-50mb",
                "name": "Discord Nitro Basic - 50MB",
                "target_size_bytes": 52428800,
                "resolution_mode": "source",
                "max_width": 3840,
                "max_height": 2160,
                "fps_mode": "source",
                "max_fps": 30.0,
                "rate_control": "target_size",
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "keep_audio": True,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
            },
        ]
        profiles_path = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(partial), profiles_path)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        ids = {p.profile_id for p in profiles}
        assert PROFILE_ID_DISCORD_FREE in ids
        assert "discord-50mb" in ids
        assert PROFILE_ID_DISCORD_NITRO in ids

    def test_migrate_v2_to_v3_adds_workflow_fields(self, tmp_path, monkeypatch):
        """v2 profiles get workflow, rate_control_method, and qp defaults on migration."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        v2_profiles = [
            {
                "profile_id": "discord-10mb",
                "name": "Discord Free - 10MB",
                "target_size_bytes": 10485760,
                "resolution_mode": "source",
                "max_width": 3840,
                "max_height": 2160,
                "fps_mode": "source",
                "max_fps": 30.0,
                "rate_control": "target_size",
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "keep_audio": True,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
            },
        ]
        pp = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(v2_profiles), pp)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        found = None
        for p in profiles:
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                found = p
                break
        assert found is not None
        assert found.workflow == WORKFLOW_COMPRESSION
        assert found.rate_control_method == "cbr"
        assert found.qp == 23
        assert found.schema_version == PROFILE_SCHEMA_VERSION

    def test_migrate_v2_to_v3_gives_compression_cbr(self, tmp_path, monkeypatch):
        """v2 compression profiles get rate_control_method=cbr and schema_version=3."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        v2_profiles = [
            {
                "profile_id": "discord-50mb",
                "name": "Discord Nitro Basic - 50MB",
                "target_size_bytes": 52428800,
                "resolution_mode": "source",
                "max_width": 3840,
                "max_height": 2160,
                "fps_mode": "source",
                "max_fps": 30.0,
                "rate_control": "target_size",
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "keep_audio": True,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
            },
        ]
        pp = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(v2_profiles), pp)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        found = None
        for p in profiles:
            if p.profile_id == "discord-50mb":
                found = p
                break
        assert found is not None
        assert found.workflow == WORKFLOW_COMPRESSION
        assert found.rate_control_method == "cbr"
        assert found.schema_version == PROFILE_SCHEMA_VERSION

    def test_migrate_v2_upscale_profiles_get_correct_defaults(self, tmp_path, monkeypatch):
        """v2 upscale profiles get workflow=upscale, crf=18, two_pass=False on migration."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        v2_profiles = [
            {
                "profile_id": PROFILE_ID_1440P_UPSCALE,
                "name": "1440p Upscale (2560x1440)",
                "target_size_bytes": 524288000,
                "resolution_mode": "custom",
                "custom_width": 2560,
                "custom_height": 1440,
                "fps_mode": "source",
                "rate_control": "target_size",
                "scaler": "neighbor",
                "keep_audio": True,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
            },
        ]
        pp = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(v2_profiles), pp)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        found = None
        for p in profiles:
            if p.profile_id == PROFILE_ID_1440P_UPSCALE:
                found = p
                break
        assert found is not None
        assert found.workflow == WORKFLOW_UPSCALE
        assert found.rate_control_method == RCM_CRF
        assert found.crf == 18
        assert found.two_pass is False
        assert found.schema_version == PROFILE_SCHEMA_VERSION

    def test_default_profiles_have_correct_workflows(self):
        """Default profiles have correct workflow values."""
        free = None
        upscale_1440 = None
        upscale_4k = None
        for p in DEFAULT_PROFILES:
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                free = p
            elif p.profile_id == PROFILE_ID_1440P_UPSCALE:
                upscale_1440 = p
            elif p.profile_id == PROFILE_ID_4K_UPSCALE:
                upscale_4k = p

        assert free is not None
        assert free.workflow == WORKFLOW_COMPRESSION
        assert free.rate_control_method == "cbr"

        assert upscale_1440 is not None
        assert upscale_1440.workflow == WORKFLOW_UPSCALE
        assert upscale_1440.crf == 18
        assert upscale_1440.two_pass is False

        assert upscale_4k is not None
        assert upscale_4k.workflow == WORKFLOW_UPSCALE
        assert upscale_4k.crf == 18
        assert upscale_4k.two_pass is False


class TestCacheSafety:
    def test_cleanup_cache_empty_dir(self, tmp_path):
        removed = cleanup_cache(tmp_path)
        assert removed == 0

    def test_cleanup_cache_nonexistent_dir(self, tmp_path):
        removed = cleanup_cache(tmp_path / "nonexistent")
        assert removed == 0

    def test_cleanup_cache_removes_old_files(self, tmp_path):
        old_file = tmp_path / "old.txt"
        old_file.write_text("old")
        fresh_file = tmp_path / "fresh.txt"
        fresh_file.write_text("fresh")
        old_timestamp = time.time() - 48 * 3600
        os.utime(old_file, (old_timestamp, old_timestamp))

        removed = cleanup_cache(tmp_path, max_age_hours=24)

        assert removed == 1
        assert not old_file.exists()
        assert fresh_file.exists()


class TestProcessLock:
    @pytest.mark.skipif(os.name == "nt", reason="fcntl is only available on POSIX")
    def test_posix_lock_uses_flock(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        calls: list[tuple[int, int]] = []

        class Fcntl:
            LOCK_EX = 1
            LOCK_UN = 2

            @staticmethod
            def flock(fd: int, operation: int) -> None:
                calls.append((fd, operation))

        monkeypatch.setattr(settings_mod, "fcntl", Fcntl)
        lock = ProcessLock(tmp_path / "settings.lock")

        lock.acquire()
        fd = lock._fd
        lock.release()

        assert fd is not None
        assert calls == [(fd, Fcntl.LOCK_EX), (fd, Fcntl.LOCK_UN)]

    def test_acquire_and_release(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        lock = ProcessLock(lock_path)
        lock.acquire()
        assert lock._fd is not None
        lock.release()
        assert lock._fd is None

    def test_context_manager(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        with ProcessLock(lock_path) as lock:
            assert lock._fd is not None
        assert lock._fd is None

    def test_double_release_is_safe(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        lock = ProcessLock(lock_path)
        lock.acquire()
        lock.release()
        lock.release()  # should be a no-op

    def test_contention_blocks_then_proceeds(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()

        results = []
        held = threading.Event()
        waiting = threading.Event()

        def holder():
            with ProcessLock(lock_path):
                results.append("holder-acquired")
                held.set()
                assert waiting.wait(timeout=5)
                # keep holding while the waiter is inside acquire; blocking can't be observed
                time.sleep(0.2)
                results.append("holder-releasing")
            results.append("holder-released")

        def waiter():
            assert held.wait(timeout=5)
            waiting.set()
            with ProcessLock(lock_path):
                results.append("waiter-acquired")
            results.append("waiter-released")

        t1 = threading.Thread(target=holder)
        t2 = threading.Thread(target=waiter)
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)

        assert results == [
            "holder-acquired",
            "holder-releasing",
            "holder-released",
            "waiter-acquired",
            "waiter-released",
        ]

    def test_lock_file_created(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        assert not lock_path.exists()
        with ProcessLock(lock_path):
            assert lock_path.exists()

    def test_lock_does_not_leak_fd(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        lock = ProcessLock(lock_path)
        lock.acquire()
        fd = lock._fd
        assert fd is not None
        lock.release()
        assert lock._fd is None

        with __import__("pytest").raises(OSError):
            os.lseek(fd, 0, os.SEEK_SET)


class TestAtomicWrite:
    def test_write_and_read(self, tmp_path):
        target = tmp_path / "target.json"
        _atomic_write(target, '{"key": "value"}')
        assert target.exists()
        data = json.loads(target.read_text(encoding="utf-8"))
        assert data["key"] == "value"

    def test_overwrite_existing(self, tmp_path):
        target = tmp_path / "target.json"
        target.write_text("old", encoding="utf-8")
        _atomic_write(target, '{"new": true}')
        assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}

    def test_temp_file_cleaned_on_success(self, tmp_path):

        target = tmp_path / "target.json"
        _atomic_write(target, "{}")
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert len(tmp_files) == 0

    def test_temp_file_cleaned_on_failure(self, tmp_path):

        target = tmp_path / "subdir" / "target.json"

        with contextlib.suppress(OSError, FileNotFoundError):
            _atomic_write(target, "{}")

        tmp_files = list(tmp_path.glob("*.tmp"))
        assert len(tmp_files) == 0

    def test_no_partial_file_on_failure(self, tmp_path):

        target = tmp_path / "target.json"
        target.write_text("original", encoding="utf-8")

        target.unlink()
        target.mkdir()
        with contextlib.suppress(OSError):
            _atomic_write(target, "should not appear")

        assert target.is_dir()


class TestBackupRecovery:
    @staticmethod
    def _configure_dirs(tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

    def test_second_save_preserves_previous_settings_and_profiles(self, tmp_path, monkeypatch):
        self._configure_dirs(tmp_path, monkeypatch)
        manager = SettingsManager()
        manager.load()
        manager.save()
        first_settings = settings_path().read_text(encoding="utf-8")
        first_profiles = profiles_path().read_text(encoding="utf-8")

        manager.set_setting("encoder_cache_days", 30)
        manager.set_profiles([Profile(name="Custom Profile", profile_id="custom-1")])
        manager.save()

        assert (
            settings_path().with_suffix(".json.bak").read_text(encoding="utf-8") == first_settings
        )
        assert (
            profiles_path().with_suffix(".json.bak").read_text(encoding="utf-8") == first_profiles
        )

    def test_corrupt_settings_primary_recovers_generated_backup(self, tmp_path, monkeypatch):
        self._configure_dirs(tmp_path, monkeypatch)
        manager = SettingsManager()
        manager.load()
        manager.set_setting("encoder_cache_days", 14)
        manager.save()
        manager.set_setting("encoder_cache_days", 30)
        manager.save()
        settings_path().write_text("not valid json", encoding="utf-8")

        recovered = SettingsManager().load()

        assert recovered.encoder_cache_days == 14

    def test_corrupt_profiles_primary_recovers_generated_backup(self, tmp_path, monkeypatch):
        self._configure_dirs(tmp_path, monkeypatch)
        manager = SettingsManager()
        manager.load()
        manager.set_profiles([Profile(name="First Profile", profile_id="custom-1")])
        manager.save()
        manager.set_profiles([Profile(name="Second Profile", profile_id="custom-2")])
        manager.save()
        profiles_path().write_text("not valid json", encoding="utf-8")

        recovered = SettingsManager().get_profiles()

        recovered_ids = {profile.profile_id for profile in recovered}
        assert "custom-1" in recovered_ids
        assert "custom-2" not in recovered_ids

    def test_non_object_settings_primary_returns_defaults(self, tmp_path, monkeypatch):
        self._configure_dirs(tmp_path, monkeypatch)
        settings_path().write_text("[]", encoding="utf-8")

        recovered = SettingsManager().load()

        assert recovered.default_profile_id == PROFILE_ID_DISCORD_FREE

    def test_non_object_profiles_primary_returns_defaults(self, tmp_path, monkeypatch):
        self._configure_dirs(tmp_path, monkeypatch)
        profiles_path().write_text("[]", encoding="utf-8")

        recovered = SettingsManager().get_profiles()

        assert {profile.profile_id for profile in recovered} == BUILTIN_PROFILE_IDS

    def test_invalid_primary_does_not_replace_last_known_good_backup(self, tmp_path, monkeypatch):
        self._configure_dirs(tmp_path, monkeypatch)
        manager = SettingsManager()
        manager.load()
        manager.set_setting("encoder_cache_days", 14)
        manager.save()
        manager.set_setting("encoder_cache_days", 30)
        manager.save()
        backup = settings_path().with_suffix(".json.bak")
        known_good = backup.read_text(encoding="utf-8")
        settings_path().write_text("not valid json", encoding="utf-8")

        manager.set_setting("encoder_cache_days", 90)
        manager.save()

        assert backup.read_text(encoding="utf-8") == known_good
        assert SettingsManager().load().encoder_cache_days == 90


class TestStaleConcurrentMerge:
    def test_settings_merge_keeps_local_change(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("output_dir", str(tmp_path / "ours"))
        mgr.save()

        sp = settings_path()
        disk = json.loads(sp.read_text(encoding="utf-8"))
        disk["compression_suffix"] = "_disk_{size}"
        sp.write_text(json.dumps(disk), encoding="utf-8")

        mgr.set_setting("left_sidebar_width", 280)
        mgr.save()

        mgr2 = SettingsManager()
        s = mgr2.load()
        assert s.output_dir == str(tmp_path / "ours")
        assert s.left_sidebar_width == 280
        assert s.compression_suffix == "_disk_{size}"

    def test_profiles_merge_keeps_local_edit(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.save()

        pp = profiles_path()
        disk = json.loads(pp.read_text(encoding="utf-8"))
        disk["profiles"].append(
            {
                "profile_id": "other-process-profile",
                "name": "From Other Process",
                "target_size_bytes": 10485760,
                "resolution_mode": "source",
                "max_width": 1920,
                "max_height": 1080,
                "fps_mode": "source",
                "max_fps": 30.0,
                "rate_control": "target_size",
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "keep_audio": True,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
            }
        )
        pp.write_text(json.dumps(disk), encoding="utf-8")

        profiles = mgr.get_profiles()
        for p in profiles:
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                p.name = "Our Edit"
                break
        mgr.set_profiles(profiles)
        mgr.save()

        mgr2 = SettingsManager()
        reloaded = mgr2.get_profiles()
        ids = {p.profile_id for p in reloaded}
        assert "other-process-profile" in ids  # disk addition
        found = None
        for p in reloaded:
            if p.profile_id == PROFILE_ID_DISCORD_FREE:
                found = p
                break
        assert found is not None
        assert found.name == "Our Edit"  # our edit

    def test_no_merge_when_disk_unchanged(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("output_dir", str(tmp_path / "out"))
        mgr.save()

        mgr2 = SettingsManager()
        s = mgr2.load()
        assert s.output_dir == str(tmp_path / "out")

    def test_reset_clears_snapshots(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("default_profile_id", PROFILE_ID_DISCORD_NITRO)
        mgr.save()

        mgr.reset()
        mgr.save()

        mgr2 = SettingsManager()
        s = mgr2.load()
        assert s.default_profile_id == PROFILE_ID_DISCORD_FREE

    def test_absent_snapshot_field_survives_stale_merge(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr = SettingsManager()
        mgr.load()
        mgr.save()

        assert mgr._settings_snapshot is not None
        mgr._settings_snapshot.pop("compression_suffix", None)

        mgr.set_setting("compression_suffix", "_local_{size}")

        sp = settings_path()
        disk = json.loads(sp.read_text(encoding="utf-8"))
        disk["compression_suffix"] = "_disk_{size}"
        sp.write_text(json.dumps(disk), encoding="utf-8")

        mgr.save()

        mgr2 = SettingsManager()
        s = mgr2.load()
        assert s.compression_suffix == "_local_{size}"


class TestProfilesFromAnotherBuild:
    def _write_foreign_profiles(self, tmp_path, monkeypatch) -> str:
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        SettingsManager().save()
        profiles = [p.to_dict() for p in DEFAULT_PROFILES]
        for profile in profiles:
            profile["motion_exposure"] = {"enabled": False}
        raw = json.dumps({"version": PROFILE_SCHEMA_VERSION, "profiles": profiles})
        profiles_path().write_text(raw, encoding="utf-8")
        return raw

    def test_settings_save_keeps_unreadable_profiles_untouched(self, tmp_path, monkeypatch):
        raw = self._write_foreign_profiles(tmp_path, monkeypatch)
        manager = SettingsManager()
        manager.load()

        manager.set_setting("accent_color", "teal")
        manager.save()

        assert SettingsManager().load().accent_color == "teal"
        assert profiles_path().read_text(encoding="utf-8") == raw

    def test_profile_change_is_refused_instead_of_overwriting(self, tmp_path, monkeypatch):
        raw = self._write_foreign_profiles(tmp_path, monkeypatch)
        manager = SettingsManager()
        profiles = manager.get_profiles()
        profiles[0].name = "Renamed"
        manager.set_profiles(profiles)

        with pytest.raises(ProfilesUnreadableError):
            manager.save()

        assert profiles_path().read_text(encoding="utf-8") == raw
        # the refused change is undone, so later settings saves still work
        assert manager.get_profiles()[0].name != "Renamed"
        manager.set_setting("accent_color", "teal")
        manager.save()
        assert profiles_path().read_text(encoding="utf-8") == raw

    def test_profile_actions_explain_the_refusal(self, tmp_path, monkeypatch):
        from tuck.profile_service import ProfileService

        raw = self._write_foreign_profiles(tmp_path, monkeypatch)
        manager = SettingsManager()
        service = ProfileService(manager)
        profile_id = manager.get_profiles()[0].profile_id
        for result in (service.duplicate(profile_id), service.delete(profile_id)):
            assert result["ok"] is False
            assert "different version of Tuck" in result["error"]
        assert profiles_path().read_text(encoding="utf-8") == raw
        assert len(manager.get_profiles()) == len(DEFAULT_PROFILES)


class TestIndependentManagers:
    def test_two_managers_same_dir(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr1 = SettingsManager()
        mgr1.load()
        mgr1.set_setting("output_dir", str(tmp_path / "mgr1"))
        mgr1.save()

        mgr2 = SettingsManager()
        s = mgr2.load()
        assert s.output_dir == str(tmp_path / "mgr1")

    def test_two_managers_concurrent_saves(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr1 = SettingsManager()
        mgr1.load()
        mgr1.set_setting("output_dir", str(tmp_path / "mgr1"))
        mgr1.save()

        mgr2 = SettingsManager()
        mgr2.load()
        mgr2.set_setting("output_dir", str(tmp_path / "mgr2"))
        mgr2.save()

        mgr3 = SettingsManager()
        s = mgr3.load()
        assert s.output_dir in (str(tmp_path / "mgr1"), str(tmp_path / "mgr2"))

    def test_three_managers_roundtrip(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        mgr1 = SettingsManager()
        mgr1.load()
        mgr1.set_setting("compression_suffix", "_first_{size}")
        mgr1.save()

        mgr2 = SettingsManager()
        mgr2.load()
        mgr2.set_setting("left_sidebar_width", 280)
        mgr2.save()

        mgr3 = SettingsManager()
        s = mgr3.load()
        assert s.compression_suffix == "_first_{size}"
        assert s.left_sidebar_width == 280


class TestV2UserProfileMigration:
    """v2 user profiles with compression+CRF are normalized to compression+CBR."""

    def test_v2_user_compression_crf_normalized(self, tmp_path, monkeypatch):
        """A v2 user profile with compression+CRF is migrated to CBR."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        v2_user = [
            {
                "profile_id": "user-v2-crf",
                "name": "My V2 CRF Profile",
                "target_size_bytes": 104857600,
                "resolution_mode": "source",
                "max_width": 1920,
                "max_height": 1080,
                "fps_mode": "source",
                "max_fps": 30.0,
                "rate_control": "target_size",
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
                "workflow": "compression",
                "rate_control_method": "crf",
            },
        ]
        pp = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(v2_user), pp)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        found = None
        for p in profiles:
            if p.profile_id == "user-v2-crf":
                found = p
                break
        assert found is not None
        assert found.rate_control_method == "cbr", f"Expected cbr, got {found.rate_control_method}"
        assert found.workflow == "compression"
        assert found.schema_version == PROFILE_SCHEMA_VERSION

    def test_v2_user_compression_cqp_gpu_normalized(self, tmp_path, monkeypatch):
        """A v2 user profile with compression+CQP+GPU is migrated to CBR with two_pass=False."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        v2_user = [
            {
                "profile_id": "user-v2-cqp-gpu",
                "name": "My V2 CQP GPU Profile",
                "target_size_bytes": 104857600,
                "resolution_mode": "source",
                "max_width": 1920,
                "max_height": 1080,
                "fps_mode": "source",
                "max_fps": 30.0,
                "rate_control": "target_size",
                "audio_bitrate": 128000,
                "audio_channels": 2,
                "audio_sample_rate": 44100,
                "preset": "medium",
                "two_pass": True,
                "schema_version": 2,
                "workflow": "compression",
                "rate_control_method": "cqp",
                "video_encoder": "h264_nvenc",
            },
        ]
        pp = tmp_path / "profiles.json"
        import tuck.models as models_mod

        models_mod.export_profiles_json(models_mod.dicts_to_profiles(v2_user), pp)

        mgr = SettingsManager()
        profiles = mgr._load_profiles()

        found = None
        for p in profiles:
            if p.profile_id == "user-v2-cqp-gpu":
                found = p
                break
        assert found is not None
        assert found.rate_control_method == "cbr"
        assert found.two_pass is False
        assert found.schema_version == PROFILE_SCHEMA_VERSION


class TestInterfacePreferences:
    @staticmethod
    def _use(tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

    @staticmethod
    def _write_settings(document: dict) -> None:
        settings_path().parent.mkdir(parents=True, exist_ok=True)
        settings_path().write_text(json.dumps(document), encoding="utf-8")

    def test_defaults_show_everything_and_start_with_last_task(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)

        s = SettingsManager().load()

        assert s.hidden_ui == []
        assert s.start_task == "last"

    def test_round_trip(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("hidden_ui", ["upscale", "lut"])
        mgr.set_setting("start_task", "cut")
        mgr.save()

        s = SettingsManager().load()

        assert s.hidden_ui == ["upscale", "lut"]
        assert s.start_task == "cut"

    def test_older_file_without_the_keys_uses_defaults(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        self._write_settings(
            {"version": 1, "default_profile_id": PROFILE_ID_DISCORD_NITRO, "last_task": "upscale"}
        )

        s = SettingsManager().load()

        assert s.default_profile_id == PROFILE_ID_DISCORD_NITRO
        assert s.last_task == "upscale"
        assert s.hidden_ui == []
        assert s.start_task == "last"

    @pytest.mark.parametrize(
        "hidden_ui",
        [
            "lut",
            ["lut", "timeline"],
            ["lut", 3],
            ["compression", "upscale", "cut"],
            None,
        ],
    )
    def test_invalid_hidden_ui_in_file_falls_back_to_default(
        self, hidden_ui, tmp_path, monkeypatch
    ):
        self._use(tmp_path, monkeypatch)
        self._write_settings(
            {"version": 1, "default_profile_id": PROFILE_ID_DISCORD_NITRO, "hidden_ui": hidden_ui}
        )

        s = SettingsManager().load()

        assert s.hidden_ui == []
        # the rest of the file still loads
        assert s.default_profile_id == PROFILE_ID_DISCORD_NITRO

    @pytest.mark.parametrize("start_task", ["edit", "", 2, None, ["cut"]])
    def test_invalid_start_task_in_file_falls_back_to_default(
        self, start_task, tmp_path, monkeypatch
    ):
        self._use(tmp_path, monkeypatch)
        self._write_settings(
            {"version": 1, "default_profile_id": PROFILE_ID_DISCORD_NITRO, "start_task": start_task}
        )

        s = SettingsManager().load()

        assert s.start_task == "last"
        assert s.default_profile_id == PROFILE_ID_DISCORD_NITRO

    def test_file_values_are_stored_deduplicated_in_canonical_order(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        self._write_settings(
            {"version": 1, "hidden_ui": ["lut", "cut", "panel_audio", "lut", "compression"]}
        )

        s = SettingsManager().load()

        assert s.hidden_ui == ["compression", "cut", "panel_audio", "lut"]


class TestNormalizeHiddenUi:
    def test_canonical_order_and_dedupe(self):
        assert normalize_hidden_ui(
            ["lut", "frame_blending", "audio_editing", "panel_audio", "panel_video", "cut", "cut"]
        ) == ["cut", "panel_video", "panel_audio", "audio_editing", "frame_blending", "lut"]

    def test_all_parts_listed_in_the_allowed_order(self):
        assert HIDDEN_UI_PARTS == (
            "compression",
            "upscale",
            "cut",
            "panel_video",
            "panel_audio",
            "audio_editing",
            "frame_blending",
            "lut",
        )

    def test_two_tasks_may_be_hidden(self):
        assert normalize_hidden_ui(["upscale", "compression"]) == ["compression", "upscale"]

    def test_all_three_tasks_hidden_is_rejected(self):
        with pytest.raises(ValueError, match="Keep at least one of Compress, Upscale"):
            normalize_hidden_ui(["cut", "upscale", "compression", "lut"])

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("lut", "must be a list"),
            ([1], "only list interface part names"),
            (["timeline"], "unknown interface part: timeline"),
        ],
    )
    def test_invalid_values_are_rejected(self, value, message):
        with pytest.raises(ValueError, match=message):
            normalize_hidden_ui(value)

    @pytest.mark.parametrize("value", ["last", "compression", "upscale", "cut"])
    def test_start_task_accepts_allowed_values(self, value):
        assert normalize_start_task(value) == value

    @pytest.mark.parametrize("value", ["Last", "export", 0, None])
    def test_start_task_rejects_other_values(self, value):
        with pytest.raises(ValueError, match="last, compression, upscale, or cut"):
            normalize_start_task(value)


class TestEditorPreferences:
    @staticmethod
    def _use(tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

    @staticmethod
    def _write_settings(document: dict) -> None:
        settings_path().parent.mkdir(parents=True, exist_ok=True)
        settings_path().write_text(json.dumps(document), encoding="utf-8")

    def test_defaults(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)

        s = SettingsManager().load()

        assert s.cut_suffix == "_cut"
        assert s.timeline_snap is True
        assert s.timeline_keyframes is True
        assert s.shortcut_overrides == {}

    def test_round_trip(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        mgr = SettingsManager()
        mgr.load()
        mgr.set_setting("cut_suffix", " trimmed")
        mgr.set_setting("timeline_snap", False)
        mgr.set_setting("timeline_keyframes", False)
        mgr.set_setting("shortcut_overrides", {"timeline.split": ["S"], "edit.undo": []})
        mgr.save()

        s = SettingsManager().load()

        assert s.cut_suffix == " trimmed"
        assert s.timeline_snap is False
        assert s.timeline_keyframes is False
        assert s.shortcut_overrides == {"timeline.split": ["S"], "edit.undo": []}

    def test_older_file_without_the_keys_uses_defaults(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        self._write_settings({"version": 1, "default_profile_id": PROFILE_ID_DISCORD_NITRO})

        s = SettingsManager().load()

        assert s.default_profile_id == PROFILE_ID_DISCORD_NITRO
        assert (s.cut_suffix, s.timeline_snap, s.timeline_keyframes) == ("_cut", True, True)
        assert s.shortcut_overrides == {}

    def test_hand_broken_values_fall_back_without_losing_the_rest(self, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        self._write_settings(
            {
                "version": 1,
                "default_profile_id": PROFILE_ID_DISCORD_NITRO,
                "cut_suffix": "../escape",
                "timeline_snap": "no",
                "timeline_keyframes": None,
                "shortcut_overrides": {
                    "timeline.split": ["S", "Shift+S"],
                    "edit.undo": [],
                    "Bad Command": ["Ctrl+Z"],
                    "playback.toggle": ["Space", "Space"],
                    "zoom.in": "Ctrl+=",
                    "zoom.out": ["Ctrl+-", "Hyper+X"],
                    "go.start": ["Home", "Ctrl+ArrowLeft", "Alt+Home", "Meta+Home"],
                },
            }
        )

        s = SettingsManager().load()

        assert s.default_profile_id == PROFILE_ID_DISCORD_NITRO
        assert s.cut_suffix == "_cut"
        assert s.timeline_snap is True
        assert s.timeline_keyframes is True
        # a broken entry is dropped so that command keeps its default keys
        assert s.shortcut_overrides == {"timeline.split": ["S", "Shift+S"], "edit.undo": []}

    @pytest.mark.parametrize("value", ["Ctrl+Z", ["timeline.split"], 3, None])
    def test_shortcut_overrides_that_are_not_a_map_are_dropped(self, value, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        self._write_settings({"version": 1, "shortcut_overrides": value})

        assert SettingsManager().load().shortcut_overrides == {}

    def test_too_many_stored_shortcut_overrides_keep_the_first_valid_ones(
        self, tmp_path, monkeypatch
    ):
        self._use(tmp_path, monkeypatch)
        stored = {"Broken": ["A"], **{f"command-{index}": ["A"] for index in range(70)}}
        self._write_settings({"version": 1, "shortcut_overrides": stored})

        overrides = SettingsManager().load().shortcut_overrides

        assert list(overrides) == [f"command-{index}" for index in range(64)]

    @pytest.mark.parametrize("value", [5, "", "   ", "a/b", "a\\b", "cut:1", "a\x07", "{size}"])
    def test_invalid_cut_suffix_in_file_falls_back(self, value, tmp_path, monkeypatch):
        self._use(tmp_path, monkeypatch)
        self._write_settings({"version": 1, "cut_suffix": value})

        assert SettingsManager().load().cut_suffix == "_cut"


class TestNormalizeCutSuffix:
    @pytest.mark.parametrize("value", ["_cut", "-trim", " (short)", "_v2.final", "_ścięty"])
    def test_accepts_file_name_text(self, value):
        assert normalize_cut_suffix(value) == value

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            (None, "cut_suffix must be a string"),
            (3, "cut_suffix must be a string"),
            ("", "Enter a suffix for lossless cut file names."),
            ("  ", "Enter a suffix for lossless cut file names."),
            ("x" * 65, "The lossless cut suffix must be 64 characters or fewer."),
            (
                "a/b",
                'The lossless cut suffix cannot contain \\ / : * ? " < > | or control characters.',
            ),
            ("a\\b", "cannot contain"),
            ("a:b", "cannot contain"),
            ('a"b', "cannot contain"),
            ("a<b>", "cannot contain"),
            ("a|b", "cannot contain"),
            ("a?", "cannot contain"),
            ("a*", "cannot contain"),
            ("a\tb", "cannot contain"),
            ("_{size}", "The lossless cut suffix cannot use tokens like {size}."),
            ("_}", "cannot use tokens"),
        ],
    )
    def test_rejects_values_that_cannot_be_part_of_a_file_name(self, value, message):
        with pytest.raises(ValueError) as error:
            normalize_cut_suffix(value)
        assert message in str(error.value)

    def test_the_longest_allowed_suffix(self):
        assert normalize_cut_suffix("x" * 64) == "x" * 64


class TestNormalizeShortcutOverrides:
    def test_accepts_the_combos_the_frontend_writes(self):
        value = {
            "edit.undo": ["Ctrl+Z", "Meta+Z"],
            "edit.redo": ["Ctrl+Shift+Z", "Shift+Meta+Z", "Ctrl+Y"],
            "playback.toggle": ["Space"],
            "timeline.nudge-left": ["ArrowLeft", "Alt+ArrowLeft"],
            "timeline.zoom-in": ["Ctrl++", "+", "="],
            "marker.previous": ["[", ","],
            "view.help": ["F1", "F24", "?"],
            "delete-segment": ["Delete", "Backspace"],
            "go.home": ["Home", "End", "PageUp"],
            "go.other": ["PageDown", "Enter", "Tab"],
            "dialog.close": ["Escape"],
            "misc": ["Ä", "Ctrl+1"],
            "cleared": [],
        }

        assert normalize_shortcut_overrides(value) == value

    def test_returns_a_clean_copy(self):
        value = {"edit.undo": ["Ctrl+Z"]}

        clean = normalize_shortcut_overrides(value)
        value["edit.undo"].append("Ctrl+Y")

        assert clean == {"edit.undo": ["Ctrl+Z"]}

    def test_sixty_four_commands_are_allowed(self):
        value = {f"command-{index}": [] for index in range(64)}
        assert normalize_shortcut_overrides(value) == value

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("Ctrl+Z", "shortcut_overrides must map commands to lists of keys"),
            (["edit.undo"], "shortcut_overrides must map commands to lists of keys"),
            (
                {f"command-{index}": [] for index in range(65)},
                "Only 64 commands can have changed keyboard shortcuts.",
            ),
            ({"Edit.Undo": ["Ctrl+Z"]}, "A keyboard shortcut belongs to a command Tuck"),
            ({"edit..undo": []}, "belongs to a command Tuck does not know"),
            ({"-edit": []}, "belongs to a command Tuck does not know"),
            ({"edit.": []}, "belongs to a command Tuck does not know"),
            ({"": []}, "belongs to a command Tuck does not know"),
            ({"edit undo": []}, "belongs to a command Tuck does not know"),
            ({"a" * 65: []}, "belongs to a command Tuck does not know"),
            ({"edit.undo": "Ctrl+Z"}, "Keyboard shortcuts must be listed for each command."),
            ({"edit.undo": None}, "Keyboard shortcuts must be listed for each command."),
            (
                {"edit.undo": ["A", "B", "C", "D"]},
                "A command can have at most 3 keyboard shortcuts.",
            ),
            ({"edit.undo": ["Ctrl+Z", "Ctrl+Z"]}, '"Ctrl+Z" is listed twice for the same command.'),
            ({"edit.undo": ["Ctrl+Shift+Z", "Shift+Ctrl+Z"]}, "is listed twice"),
            ({"edit.undo": ["Ctrl+"]}, '"Ctrl+" is not a key combination Tuck supports.'),
            ({"edit.undo": ["ctrl+Z"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["Hyper+Z"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["Ctrl+Ctrl+Z"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["Shift+F25"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["F0"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["Esc"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["space"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["arrowleft"]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["ZZ"]}, "not a key combination Tuck supports"),
            ({"edit.undo": [" "]}, "not a key combination Tuck supports"),
            ({"edit.undo": ["\x07"]}, "not a key combination Tuck supports"),
            ({"edit.undo": [""]}, "One of the keys is not a key combination Tuck supports."),
            ({"edit.undo": [5]}, "One of the keys is not a key combination Tuck supports."),
            ({"edit.undo": [None]}, "One of the keys is not a key combination Tuck supports."),
            (
                {"edit.undo": ["Ctrl+" * 9 + "Z"]},
                "One of the keys is not a key combination Tuck supports.",
            ),
        ],
    )
    def test_rejects_invalid_payloads(self, value, message):
        with pytest.raises(ValueError) as error:
            normalize_shortcut_overrides(value)
        assert message in str(error.value)

    def test_every_modifier_with_a_long_key_name_fits(self):
        combo = "Ctrl+Alt+Shift+Meta+PageDown"
        assert normalize_shortcut_overrides({"a": [combo]}) == {"a": [combo]}

    def test_cleaning_a_stored_value_keeps_only_valid_entries(self):
        assert clean_shortcut_overrides(
            {"edit.undo": ["Ctrl+Z"], "BAD": [], "edit.redo": ["Ctrl+Z", "Ctrl+Z"]}
        ) == {"edit.undo": ["Ctrl+Z"]}
        assert clean_shortcut_overrides([]) == {}


def _isolate(tmp_path, monkeypatch):
    import tuck.settings as settings_mod

    monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)


class TestProfileDeletionAcrossProcesses:
    def test_a_deleted_profile_stays_deleted_when_another_process_saved_meanwhile(
        self, tmp_path, monkeypatch
    ):
        _isolate(tmp_path, monkeypatch)
        setup = SettingsManager()
        setup.load()
        setup.set_profiles([*setup.get_profiles(), Profile(name="Mine", profile_id="mine")])
        setup.save()

        gui = SettingsManager()
        gui.load()
        cli = SettingsManager()
        cli.load()

        gui.set_profiles([p for p in gui.get_profiles() if p.profile_id != "mine"])
        gui.save()
        # Send To or the CLI saves a setting with the profile list it loaded earlier
        cli.set_setting("check_updates", False)
        cli.save()

        ids = {p.profile_id for p in SettingsManager().get_profiles()}
        assert "mine" not in ids

    def test_a_profile_deleted_elsewhere_is_not_brought_back_by_our_save(
        self, tmp_path, monkeypatch
    ):
        _isolate(tmp_path, monkeypatch)
        setup = SettingsManager()
        setup.load()
        setup.set_profiles([*setup.get_profiles(), Profile(name="Mine", profile_id="mine")])
        setup.save()

        gui = SettingsManager()
        gui.load()
        cli = SettingsManager()
        cli.load()

        cli.set_profiles([p for p in cli.get_profiles() if p.profile_id != "mine"])
        cli.save()
        gui.set_setting("check_updates", False)
        gui.save()

        assert "mine" not in {p.profile_id for p in SettingsManager().get_profiles()}
        assert SettingsManager().load().check_updates is False

    def test_an_edit_wins_over_a_delete_from_another_process(self, tmp_path, monkeypatch):
        _isolate(tmp_path, monkeypatch)
        setup = SettingsManager()
        setup.load()
        setup.set_profiles([*setup.get_profiles(), Profile(name="Mine", profile_id="mine")])
        setup.save()

        gui = SettingsManager()
        gui.load()
        cli = SettingsManager()
        cli.load()

        cli.set_profiles([p for p in cli.get_profiles() if p.profile_id != "mine"])
        cli.save()
        edited = [
            Profile(name="Renamed", profile_id="mine") if p.profile_id == "mine" else p
            for p in gui.get_profiles()
        ]
        gui.set_profiles(edited)
        gui.save()

        reloaded = {p.profile_id: p for p in SettingsManager().get_profiles()}
        assert reloaded["mine"].name == "Renamed"

    def test_profiles_added_on_both_sides_are_kept(self, tmp_path, monkeypatch):
        _isolate(tmp_path, monkeypatch)
        gui = SettingsManager()
        gui.load()
        gui.save()
        cli = SettingsManager()
        cli.load()

        cli.set_profiles([*cli.get_profiles(), Profile(name="Theirs", profile_id="theirs")])
        cli.save()
        gui.set_profiles([*gui.get_profiles(), Profile(name="Ours", profile_id="ours")])
        gui.save()

        ids = [p.profile_id for p in SettingsManager().get_profiles()]
        assert "theirs" in ids and "ours" in ids


class TestStoredEncodeSuffixes:
    @pytest.mark.parametrize("bad", [r"\..\escape", "_v:2", "a/b", "_\x07", "", "   ", 5])
    def test_a_stored_suffix_that_breaks_file_names_falls_back_to_the_default(
        self, tmp_path, monkeypatch, caplog, bad
    ):
        from tuck.models import AppSettings

        _isolate(tmp_path, monkeypatch)
        settings_path().write_text(
            json.dumps({"version": 1, "compression_suffix": bad, "upscale_suffix": bad}),
            encoding="utf-8",
        )
        loaded = SettingsManager().load()
        assert loaded.compression_suffix == AppSettings().compression_suffix
        assert loaded.upscale_suffix == AppSettings().upscale_suffix
        assert "compression_suffix" in caplog.text

    def test_a_good_stored_suffix_is_kept(self, tmp_path, monkeypatch):
        _isolate(tmp_path, monkeypatch)
        settings_path().write_text(
            json.dumps(
                {
                    "version": 1,
                    "compression_suffix": "_small {size}",
                    "upscale_suffix": "-{width}x{height}",
                }
            ),
            encoding="utf-8",
        )
        loaded = SettingsManager().load()
        assert loaded.compression_suffix == "_small {size}"
        assert loaded.upscale_suffix == "-{width}x{height}"


class TestSavingEncodeSuffixes:
    @pytest.mark.parametrize(
        ("key", "value", "message"),
        [
            ("compression_suffix", r"\..\escape", "compress suffix cannot contain"),
            ("compression_suffix", "_v:2", "compress suffix cannot contain"),
            ("upscale_suffix", "../x_{width}", "upscale suffix cannot contain"),
            ("upscale_suffix", "_a\tb", "upscale suffix cannot contain"),
            ("compression_suffix", "  ", "Enter a suffix for compress file names."),
            ("upscale_suffix", 3, "upscale_suffix must be a string"),
        ],
    )
    def test_a_suffix_that_would_break_the_file_name_is_refused(
        self, tmp_path, monkeypatch, key, value, message
    ):
        import tuck.settings as settings_mod
        from tuck.bridge import BridgeAPI

        monkeypatch.setattr(settings_mod, "_settings_manager", None)
        monkeypatch.setattr(settings_mod, "_storage_root", tmp_path / "storage")
        api = BridgeAPI()
        before = api.get_settings()[key]
        result = api.save_settings({key: value})
        assert result["ok"] is False
        assert message in str(result["error"])
        assert api.get_settings()[key] == before

    def test_a_good_suffix_is_saved(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod
        from tuck.bridge import BridgeAPI

        monkeypatch.setattr(settings_mod, "_settings_manager", None)
        monkeypatch.setattr(settings_mod, "_storage_root", tmp_path / "storage")
        api = BridgeAPI()
        assert api.save_settings({"compression_suffix": "_small_{size}"}) == {"ok": True}
        assert api.get_settings()["compression_suffix"] == "_small_{size}"
