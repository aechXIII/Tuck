import contextlib
import json
import os
import threading
import time

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
from tuck.settings import (
    SettingsManager,
    _atomic_write,
    _get_lock_path,
    _map_old_default_name,
    _ProcessLock,
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
        assert result == "discord-10mb"

    def test_map_old_default_name_discord_free_10mb(self):
        result = _map_old_default_name("Discord Free (10 MB)")
        assert result == "discord-10mb"

    def test_map_old_default_name_nitro_basic(self):
        result = _map_old_default_name("Discord Nitro Basic (50 MB)")
        assert result == "discord-50mb"

    def test_map_old_default_name_nitro(self):
        result = _map_old_default_name("Discord Nitro (500 MB)")
        assert result == "discord-500mb"

    def test_map_old_default_name_custom(self):
        result = _map_old_default_name("Custom")
        assert result == "discord-10mb"

    def test_map_old_default_name_unknown(self):
        result = _map_old_default_name("Unknown Profile")
        assert result == "discord-10mb"

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
            if p.profile_id == "discord-10mb":
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
            if p.profile_id == "discord-10mb":
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
    def test_acquire_and_release(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        lock = _ProcessLock(lock_path)
        lock.acquire()
        assert lock._fd is not None
        lock.release()
        assert lock._fd is None

    def test_context_manager(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        with _ProcessLock(lock_path) as lock:
            assert lock._fd is not None
        assert lock._fd is None

    def test_double_release_is_safe(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        lock = _ProcessLock(lock_path)
        lock.acquire()
        lock.release()
        lock.release()  # should be a no-op

    def test_contention_blocks_then_proceeds(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()

        results = []

        def holder():
            with _ProcessLock(lock_path):
                results.append("holder-acquired")
                time.sleep(0.3)
                results.append("holder-releasing")
            results.append("holder-released")

        def waiter():
            time.sleep(0.05)  # ensure holder acquires first
            with _ProcessLock(lock_path):
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
        with _ProcessLock(lock_path):
            assert lock_path.exists()

    def test_lock_does_not_leak_fd(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        lock_path = _get_lock_path()
        lock = _ProcessLock(lock_path)
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
