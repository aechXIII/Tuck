import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tuck.bridge import BridgeAPI
from tuck.models import EncodePlan, Profile, QueueState, VideoInfo
from tuck.models.export_preferences import (
    normalize_output_subfolder,
    output_targets,
)
from tuck.models.ui_preferences import (
    SESSION_FILES_MAX,
    clean_session_files,
    normalize_choice,
    normalize_session_files,
)
from tuck.output_paths import copy_file_dates, export_directory
from tuck.planner import plan
from tuck.planner_options import output_options
from tuck.queue import ProcessingQueue


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    import tuck.settings as settings

    monkeypatch.setattr(settings, "_settings_manager", None)
    monkeypatch.setattr(settings, "_storage_root", tmp_path / "storage")


def _write_settings(tmp_path: Path, data: dict) -> None:
    config = tmp_path / "storage" / "config"
    config.mkdir(parents=True, exist_ok=True)
    (config / "settings.json").write_text(json.dumps(data), encoding="utf-8")


class TestPreferenceValues:
    @pytest.mark.parametrize(
        ("key", "value"),
        [("accent_color", "teal"), ("interface_size", "compact"), ("time_format", "frames")],
    )
    def test_known_choices_pass(self, key, value):
        assert normalize_choice(key, value) == value

    @pytest.mark.parametrize(
        ("key", "value"),
        [("accent_color", "purple"), ("interface_size", 1.1), ("time_format", None)],
    )
    def test_unknown_choices_are_rejected(self, key, value):
        with pytest.raises(ValueError, match=key):
            normalize_choice(key, value)

    def test_session_files_drop_repeats_and_keep_order(self):
        assert normalize_session_files(["b.mp4", "a.mp4", "b.mp4"]) == ["b.mp4", "a.mp4"]

    @pytest.mark.parametrize("value", ["a.mp4", [1], [""], ["a\x00b"], ["x" * 4097]])
    def test_bad_session_files_are_rejected(self, value):
        with pytest.raises(ValueError):
            normalize_session_files(value)

    def test_too_many_session_files_are_rejected(self):
        with pytest.raises(ValueError, match="500"):
            normalize_session_files([f"{i}.mp4" for i in range(SESSION_FILES_MAX + 1)])

    def test_a_stored_list_keeps_what_it_can(self):
        assert clean_session_files(["a.mp4", 3, "", "a.mp4", "b.mp4"]) == ["a.mp4", "b.mp4"]
        assert clean_session_files("a.mp4") == []

    @pytest.mark.parametrize("name", ["Tucked", "  exports  ", "My clips.v2"])
    def test_good_folder_names(self, name):
        assert normalize_output_subfolder(name) == name.strip()

    @pytest.mark.parametrize(
        "name", ["", "   ", "..", "a/b", "a\\b", "what?", "trailing.", "CON", "con.txt", "x" * 65]
    )
    def test_folder_names_that_could_escape_or_fail_are_rejected(self, name):
        with pytest.raises(ValueError):
            normalize_output_subfolder(name)

    def test_output_targets_follow_the_location(self):
        assert output_targets("source", "D:/out", "Tucked") == ("", "")
        assert output_targets("folder", "D:/out", "Tucked") == ("D:/out", "")
        assert output_targets("folder", "", "Tucked") == ("", "")
        assert output_targets("subfolder", "D:/out", "Clips") == ("", "Clips")
        # a broken stored name still keeps exports beside the source, in the default folder
        assert output_targets("subfolder", "", "../escape") == ("", "Tucked")


class TestSettingsFile:
    def test_new_settings_have_their_defaults(self):
        settings = BridgeAPI().get_settings()
        assert settings["accent_color"] == "violet"
        assert settings["interface_size"] == "default"
        assert settings["animations"] is True
        assert settings["time_format"] == "seconds"
        assert settings["output_location"] == "source"
        assert settings["output_subfolder"] == "Tucked"
        assert settings["keep_file_dates"] is False
        assert settings["notify_when_done"] is True
        assert settings["keep_awake"] is True
        assert settings["background_exports"] is False
        assert settings["reopen_last_videos"] is False
        assert settings["last_session_files"] == []

    def test_a_chosen_folder_from_before_the_location_choice_stays_in_use(self, tmp_path):
        out = tmp_path / "exports"
        out.mkdir()
        _write_settings(tmp_path, {"version": 1, "output_dir": str(out)})
        assert BridgeAPI().get_settings()["output_location"] == "folder"

    def test_hand_edited_values_fall_back_without_stopping_tuck(self, tmp_path):
        _write_settings(
            tmp_path,
            {
                "version": 1,
                "accent_color": "neon",
                "animations": "yes",
                "output_location": "cloud",
                "output_subfolder": "../../etc",
                "last_session_files": ["a.mp4", 5],
            },
        )
        settings = BridgeAPI().get_settings()
        assert settings["accent_color"] == "violet"
        assert settings["animations"] is True
        assert settings["output_location"] == "source"
        assert settings["output_subfolder"] == "Tucked"

    def test_reopen_list_only_offers_files_that_still_exist(self, tmp_path):
        here = tmp_path / "here.mp4"
        here.write_bytes(b"x")
        api = BridgeAPI()
        result = api.save_settings(
            {
                "reopen_last_videos": True,
                "last_session_files": [str(here), str(tmp_path / "gone.mp4")],
            }
        )
        assert result == {"ok": True}
        assert api.get_settings()["last_session_files"] == [str(here)]


class TestSavingPreferences:
    def test_new_preferences_save_and_read_back(self, tmp_path):
        api = BridgeAPI()
        patch = {
            "accent_color": "rose",
            "interface_size": "large",
            "animations": False,
            "time_format": "timecode",
            "output_location": "subfolder",
            "output_subfolder": "Clips",
            "keep_file_dates": True,
            "notify_when_done": False,
            "keep_awake": False,
            "background_exports": True,
            "reopen_last_videos": True,
        }
        assert api.save_settings(patch) == {"ok": True}
        settings = api.get_settings()
        for key, value in patch.items():
            assert settings[key] == value

    @pytest.mark.parametrize(
        ("patch", "message"),
        [
            ({"accent_color": "neon"}, "accent_color"),
            ({"animations": "on"}, "animations must be boolean"),
            ({"output_location": "cloud"}, "output_location"),
            ({"output_subfolder": "a/b"}, "export folder name"),
            ({"last_session_files": "a.mp4"}, "last_session_files"),
        ],
    )
    def test_bad_values_are_rejected(self, patch, message):
        result = BridgeAPI().save_settings(patch)
        assert result["ok"] is False
        assert message in result["error"]

    def test_a_rejected_value_changes_nothing_else(self):
        api = BridgeAPI()
        result = api.save_settings({"keep_awake": False, "accent_color": "neon"})
        assert result["ok"] is False
        assert api.get_settings()["keep_awake"] is True

    def test_one_folder_needs_a_folder(self):
        result = BridgeAPI().save_settings({"output_location": "folder", "output_dir": ""})
        assert result == {"ok": False, "error": "Choose a folder for your exports."}

    def test_a_saved_folder_that_went_missing_doesnt_block_other_changes(self, tmp_path):
        folder = tmp_path / "exports"
        folder.mkdir()
        api = BridgeAPI()
        assert api.save_settings({"output_location": "folder", "output_dir": str(folder)})["ok"]
        folder.rmdir()
        # the Files page saves every field together, including the folder it already had
        result = api.save_settings(
            {"output_location": "folder", "output_dir": str(folder), "keep_file_dates": True}
        )
        assert result == {"ok": True}
        # choosing it again is still checked
        assert api.save_settings({"output_dir": str(tmp_path / "other")})["ok"] is False

    def test_a_folder_value_that_isnt_text_is_rejected(self):
        for value in (0, False, [], None):
            assert BridgeAPI().save_settings({"output_dir": value})["ok"] is False

    def test_folder_without_a_folder_on_disk_doesnt_block_saves(self, tmp_path):
        _write_settings(tmp_path, {"version": 1, "output_location": "folder", "output_dir": ""})
        api = BridgeAPI()
        assert api.get_settings()["output_location"] == "source"
        assert api.save_settings({"last_task": "cut"}) == {"ok": True}

    def test_a_failed_save_leaves_nothing_behind_in_memory(self, monkeypatch):
        import tuck.settings as settings_mod

        api = BridgeAPI()
        real_write = settings_mod._atomic_write

        def full_disk(*args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(settings_mod, "_atomic_write", full_disk)
        with pytest.raises(OSError):
            api.save_settings({"accent_color": "teal"})
        assert api.get_settings()["accent_color"] == "violet"
        monkeypatch.setattr(settings_mod, "_atomic_write", real_write)
        assert api.save_settings({"animations": False}) == {"ok": True}
        assert api.get_settings()["accent_color"] == "violet"

    def test_reopen_paths_are_only_checked_on_disk_when_reopening_is_on(
        self, tmp_path, monkeypatch
    ):
        missing = str(tmp_path / "gone.mp4")
        api = BridgeAPI()
        api.save_settings({"last_session_files": [missing]})
        checked: list[Path] = []
        real_is_file = Path.is_file
        monkeypatch.setattr(
            Path, "is_file", lambda self: checked.append(self) or real_is_file(self)
        )
        assert api.get_settings()["last_session_files"] == [missing]
        assert Path(missing) not in checked
        api.save_settings({"reopen_last_videos": True})
        assert api.get_settings()["last_session_files"] == []

    def test_saving_applies_run_preferences_to_the_queue(self, monkeypatch):
        api = BridgeAPI()
        applied: list[dict] = []
        monkeypatch.setattr(api._queue, "set_run_preferences", lambda **kw: applied.append(kw))
        api.save_settings({"background_exports": True, "keep_awake": False})
        assert applied[-1] == {"keep_awake": False, "low_priority": True}


class TestWhereExportsGo:
    def test_export_directory(self, tmp_path):
        source = tmp_path / "clips" / "a.mp4"
        assert export_directory(source) == source.parent
        assert export_directory(source, subfolder="Tucked") == source.parent / "Tucked"
        assert export_directory(source, "D:/out", "Tucked") == Path("D:/out")

    def test_output_options_follow_the_stored_location(self, tmp_path):
        api = BridgeAPI()
        api.save_settings(
            {"output_location": "subfolder", "output_subfolder": "Small", "keep_file_dates": True}
        )
        options = output_options(api._settings.load())
        assert options["output_dir"] == ""
        assert options["output_subfolder"] == "Small"
        assert options["keep_file_dates"] is True

    def test_a_remembered_folder_is_ignored_while_saving_next_to_the_source(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        api = BridgeAPI()
        api.save_settings({"output_location": "folder", "output_dir": str(out)})
        assert output_options(api._settings.load())["output_dir"] == str(out)
        api.save_settings({"output_location": "source"})
        assert output_options(api._settings.load())["output_dir"] == ""

    def test_encodes_go_into_the_subfolder_and_carry_the_date_choice(self, tmp_path):
        source = tmp_path / "a.mp4"
        source.write_bytes(b"x")
        info = VideoInfo(
            path=str(source), duration=10.0, width=1280, height=720, fps=30.0, video_codec="h264"
        )
        profile = Profile(name="t", profile_id="t", target_size_bytes=10 * 1024 * 1024)
        result = plan(
            source, profile, source_info=info, output_subfolder="Tucked", keep_file_dates=True
        )
        assert Path(result.output).parent == tmp_path / "Tucked"
        assert result.keep_file_dates is True

    def test_cuts_use_the_same_location(self, tmp_path):
        from tuck.cutting.planner import parse_cut_request

        source = tmp_path / "clip.mp4"
        raw = {
            "operation": "cut",
            "source": str(source),
            "segments": [
                {
                    "start": {"ticks": "0", "time_base_num": 1, "time_base_den": 1},
                    "end": {"ticks": "1", "time_base_num": 1, "time_base_den": 1},
                }
            ],
        }
        request = parse_cut_request(raw, output_subfolder="Tucked")
        assert request.output_dir == str((tmp_path / "Tucked").resolve())
        folder = tmp_path / "elsewhere"
        request = parse_cut_request(raw, output_folder=str(folder), output_subfolder="Tucked")
        assert request.output_dir == str(folder.resolve())

    def test_copy_file_dates(self, tmp_path):
        source = tmp_path / "a.mp4"
        output = tmp_path / "b.mp4"
        source.write_bytes(b"x")
        output.write_bytes(b"y")
        os.utime(source, (1_600_000_000, 1_600_000_000))
        copy_file_dates(source, output)
        assert int(output.stat().st_mtime) == 1_600_000_000

    @pytest.mark.skipif(sys.platform != "win32", reason="creation dates are a Windows thing")
    def test_copy_file_dates_keeps_the_creation_date_on_windows(self, tmp_path):
        from tuck import output_paths

        source = tmp_path / "a.mp4"
        output = tmp_path / "b.mp4"
        source.write_bytes(b"x")
        output.write_bytes(b"y")
        output_paths._set_creation_time(source, 1_500_000_000 * 10**9)
        copy_file_dates(source, output)
        created = getattr(output.stat(), "st_birthtime", output.stat().st_ctime)
        assert int(created) == 1_500_000_000

    def test_copy_file_dates_never_fails_the_export(self, tmp_path):
        output = tmp_path / "b.mp4"
        output.write_bytes(b"y")
        copy_file_dates(tmp_path / "missing.mp4", output)
        assert output.read_bytes() == b"y"


class TestRunPreferences:
    def _run(self, q: ProcessingQueue, tmp_path: Path, monkeypatch, count: int = 1) -> list[str]:
        events: list[str] = []

        class Recorder:
            def __init__(self, enabled: bool) -> None:
                assert enabled

            def __enter__(self):
                events.append("hold")
                return self

            def __exit__(self, *exc):
                events.append("release")
                return False

        monkeypatch.setattr("tuck.queue.keep_awake", Recorder)

        def fake_encode(attempt, on_progress=None):
            events.append("export")
            output = Path(attempt.output)
            output.write_bytes(b"ok")
            return output

        monkeypatch.setattr(q._engine, "encode", fake_encode)
        items = [
            q.enqueue(
                EncodePlan(
                    source=str(tmp_path / f"{index}.mp4"), output=str(tmp_path / f"{index}_out.mp4")
                )
            )
            for index in range(count)
        ]
        q.start()

        def settled() -> bool:
            done = all(item.state == QueueState.COMPLETED for item in items)
            return done and ("release" in events or not q._keep_awake)

        deadline = time.time() + 3
        while not settled() and time.time() < deadline:
            time.sleep(0.01)
        q.stop()
        assert all(item.state == QueueState.COMPLETED for item in items)
        return events

    def test_the_queue_keeps_the_computer_awake_while_exporting(self, tmp_path, monkeypatch):
        events = self._run(ProcessingQueue(), tmp_path, monkeypatch)
        assert events == ["hold", "export", "release"]

    def test_one_lock_covers_exports_that_run_back_to_back(self, tmp_path, monkeypatch):
        events = self._run(ProcessingQueue(), tmp_path, monkeypatch, count=3)
        assert events == ["hold", "export", "export", "export", "release"]

    def test_keeping_awake_can_be_turned_off(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        q.set_run_preferences(keep_awake=False, low_priority=False)
        assert self._run(q, tmp_path, monkeypatch) == ["export"]

    def test_background_exports_start_ffmpeg_below_normal_priority(self, monkeypatch):
        from tuck.encoding.runner import FFmpegEngine

        started: list[dict] = []

        class FakeProcess:
            pid = 4242

        def fake_popen(cmd, **kwargs):
            started.append(kwargs)
            return FakeProcess()

        lowered: list[tuple] = []
        monkeypatch.setattr(subprocess, "Popen", fake_popen)
        if sys.platform != "win32":
            monkeypatch.setattr(os, "setpriority", lambda *args: lowered.append(args))
        engine = FFmpegEngine()
        engine._spawn_ffmpeg(["ffmpeg"], 0)
        engine.set_low_priority(True)
        engine._spawn_ffmpeg(["ffmpeg"], 0)
        if sys.platform == "win32":
            assert not started[0]["creationflags"] & subprocess.BELOW_NORMAL_PRIORITY_CLASS
            assert started[1]["creationflags"] & subprocess.BELOW_NORMAL_PRIORITY_CLASS
        else:
            assert lowered == [(os.PRIO_PROCESS, 4242, 10)]


class TestKeepAwake:
    def test_off_does_nothing(self, monkeypatch):
        from tuck import power

        monkeypatch.setattr(power.shutil, "which", lambda _: pytest.fail("should not look"))
        with power.keep_awake(False):
            pass

    @pytest.mark.skipif(sys.platform != "win32", reason="Windows power requests")
    def test_windows_holds_and_releases_a_power_request(self):
        from tuck import power

        request = power._WindowsPowerRequest()
        request.release()

    def test_linux_lock_lives_only_as_long_as_tuck_holds_its_pipe(self, monkeypatch):
        from tuck import power

        class FakeHelper:
            def __init__(self, args, **kwargs):
                self.args = args
                self.kwargs = kwargs
                self.stdin = self
                self.closed = False
                self.killed = False

            def close(self):
                self.closed = True

            def wait(self, timeout=None):
                return 0

            def kill(self):
                self.killed = True

        helpers = []
        monkeypatch.setattr(
            power.subprocess,
            "Popen",
            lambda args, **kw: helpers.append(FakeHelper(args, **kw)) or helpers[-1],
        )
        lock = power._LinuxInhibitor("systemd-inhibit")
        helper = helpers[0]
        # the helper ends on its own once the pipe closes, even if Tuck never gets to release
        assert helper.args[-1] == "cat"
        assert helper.kwargs["stdin"] is subprocess.PIPE
        lock.release()
        assert helper.closed and not helper.killed

    @pytest.mark.skipif(sys.platform == "win32", reason="Linux sleep inhibitor")
    def test_linux_without_systemd_inhibit_still_exports(self, monkeypatch, caplog):
        from tuck import power

        monkeypatch.setattr(power.shutil, "which", lambda _: None)
        ran = []
        with caplog.at_level("INFO"), power.keep_awake(True):
            ran.append(True)
        assert ran == [True]
        assert "systemd-inhibit" in caplog.text


class TestSettingsBackup:
    def _profile(self, api: BridgeAPI, name: str) -> str:
        result = api.create_profile({"name": name, "workflow": "compression", "target_size_mb": 30})
        assert result["ok"], result
        return str(result["profile_id"])

    def test_a_backup_restores_settings_and_profiles_without_duplicates(self, tmp_path):
        api = BridgeAPI()
        profile_id = self._profile(api, "Clips")
        api.save_settings(
            {
                "accent_color": "teal",
                "default_profile_id": profile_id,
                "shortcut_overrides": {"timeline.split": ["X"]},
            }
        )
        backup = tmp_path / "backup.json"
        assert api.export_settings_to_file(str(backup)) == {"ok": True}
        document = json.loads(backup.read_text(encoding="utf-8"))
        assert document["format"] == "tuck-settings"
        assert "window_width" not in document["settings"]
        assert "last_session_files" not in document["settings"]

        api.reset_settings()
        assert api.get_settings()["accent_color"] == "violet"

        result = api.import_settings_from_file(str(backup))
        assert result["ok"] is True
        settings = api.get_settings()
        assert settings["accent_color"] == "teal"
        assert settings["default_profile_id"] == profile_id
        assert settings["shortcut_overrides"] == {"timeline.split": ["X"]}
        names = [p["name"] for p in api.get_profiles_json()]
        assert names.count("Clips") == 1

    def test_paths_that_are_not_on_this_computer_are_skipped(self, tmp_path):
        backup = tmp_path / "backup.json"
        backup.write_text(
            json.dumps(
                {
                    "format": "tuck-settings",
                    "version": 1,
                    "settings": {
                        "output_location": "folder",
                        "output_dir": str(tmp_path / "missing"),
                        "ffmpeg_path": str(tmp_path / "missing.exe"),
                        "accent_color": "amber",
                    },
                    "profiles": [],
                }
            ),
            encoding="utf-8",
        )
        api = BridgeAPI()
        result = api.import_settings_from_file(str(backup))
        assert result["ok"] is True
        assert sorted(result["skipped"]) == ["ffmpeg_path", "output_dir"]
        settings = api.get_settings()
        assert settings["accent_color"] == "amber"
        assert settings["output_location"] == "source"

    def test_a_missing_backup_folder_keeps_the_folder_in_use_here(self, tmp_path):
        here = tmp_path / "exports"
        here.mkdir()
        api = BridgeAPI()
        api.save_settings({"output_location": "folder", "output_dir": str(here)})
        backup = tmp_path / "backup.json"
        backup.write_text(
            json.dumps(
                {
                    "format": "tuck-settings",
                    "version": 1,
                    "settings": {"output_location": "folder", "output_dir": str(tmp_path / "x")},
                    "profiles": [],
                }
            ),
            encoding="utf-8",
        )
        assert api.import_settings_from_file(str(backup))["skipped"] == ["output_dir"]
        settings = api.get_settings()
        assert (settings["output_location"], settings["output_dir"]) == ("folder", str(here))

    @pytest.mark.parametrize(
        ("content", "message"),
        [
            ("not json", "can't be read"),
            (json.dumps({"format": "other"}), "isn't a Tuck settings backup"),
            (json.dumps({"format": "tuck-settings", "version": 99}), "newer version"),
            (json.dumps({"format": "tuck-settings", "version": 1, "settings": []}), "damaged"),
        ],
    )
    def test_files_that_are_not_backups_change_nothing(self, tmp_path, content, message):
        backup = tmp_path / "backup.json"
        backup.write_text(content, encoding="utf-8")
        api = BridgeAPI()
        before = api.get_settings()
        result = api.import_settings_from_file(str(backup))
        assert result["ok"] is False
        assert message in result["error"]
        assert api.get_settings() == before

    def test_a_backup_with_a_bad_value_leaves_profiles_as_they_were(self, tmp_path):
        backup = tmp_path / "backup.json"
        backup.write_text(
            json.dumps(
                {
                    "format": "tuck-settings",
                    "version": 1,
                    "settings": {"accent_color": "neon"},
                    "profiles": [
                        {"profile_id": "imported", "name": "Imported", "workflow": "compression"}
                    ],
                }
            ),
            encoding="utf-8",
        )
        api = BridgeAPI()
        result = api.import_settings_from_file(str(backup))
        assert result["ok"] is False
        assert all(p["profile_id"] != "imported" for p in api.get_profiles_json())

    def test_reset_keeps_profiles(self):
        api = BridgeAPI()
        profile_id = self._profile(api, "Mine")
        api.save_settings({"default_profile_id": profile_id, "time_format": "frames"})
        assert api.reset_settings() == {"ok": True}
        settings = api.get_settings()
        assert settings["time_format"] == "seconds"
        assert any(p["profile_id"] == profile_id for p in api.get_profiles_json())
