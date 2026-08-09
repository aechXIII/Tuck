from tuck.app import _parse_sendto_args
from tuck.cli import _do_encode, _profile_with_resolution
from tuck.cli import main as cli_main
from tuck.models import EncodePlan, EncodeProgress


class TestCLISingleInstanceBypass:
    def test_cli_commands_bypass_single_instance(self):

        from tuck.app import _is_cli_invocation

        assert _is_cli_invocation(["tuck", "compress", "file.mp4"])
        assert _is_cli_invocation(["tuck", "upscale", "file.mp4", "--to", "4k"])
        assert _is_cli_invocation(["tuck", "probe", "file.mp4"])
        assert _is_cli_invocation(["tuck", "profiles", "list"])
        assert _is_cli_invocation(["tuck", "settings", "show"])
        assert _is_cli_invocation(["tuck", "sendto", "install"])

    def test_top_level_flags_bypass_single_instance(self):

        from tuck.app import _is_cli_invocation

        assert _is_cli_invocation(["tuck", "--version"])
        assert _is_cli_invocation(["tuck", "--help"])
        assert _is_cli_invocation(["tuck", "-h"])

    def test_no_args_is_not_cli_invocation(self):

        from tuck.app import _is_cli_invocation

        assert not _is_cli_invocation(["tuck"])
        assert not _is_cli_invocation([])

    def test_gui_arg_is_not_cli_invocation(self):

        from tuck.app import _is_cli_invocation

        assert not _is_cli_invocation(["tuck", "gui"])
        assert not _is_cli_invocation(["tuck", "gui", "--files", "a.mp4"])

    def test_unknown_arg_is_not_cli_invocation(self):

        from tuck.app import _is_cli_invocation

        assert not _is_cli_invocation(["tuck", "some_file.mp4"])


class TestCLIIntegration:
    def test_version_flag(self, capsys):
        code = cli_main(["--version"])
        assert code == 0
        captured = capsys.readouterr()
        assert "Tuck" in captured.out

    def test_list_profiles(self, capsys, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        code = cli_main(["profiles", "list"])
        assert code == 0
        captured = capsys.readouterr()
        assert "discord-10mb" in captured.out
        assert "discord-50mb" in captured.out
        assert "discord-500mb" in captured.out

    def test_no_args_shows_help(self, capsys):
        code = cli_main([])
        assert code == 0
        captured = capsys.readouterr()
        assert "usage:" in captured.out.lower() or "tuck" in captured.out.lower()

    def test_probe_missing_file(self, capsys):
        code = cli_main(["probe", "nonexistent_file.mp4"])
        assert code != 0  # Should error

    def test_probe_json(self, skip_if_no_ffprobe, sample_video_path, capsys):
        code = cli_main(["probe", str(sample_video_path), "--json"])

        assert code in (0, 1, 2)

    def test_compress_missing_profile(self, capsys):
        code = cli_main(["compress", "file.mp4", "--profile", "nonexistent"])
        assert code == 1

    def test_upscale_custom_resolution(self):
        from tuck.models import Profile

        profile = _profile_with_resolution(Profile(name="Upscale"), "2560x1440")
        assert (profile.custom_width, profile.custom_height) == (2560, 1440)

    def test_upscale_rejects_invalid_custom_resolution(self):
        import pytest

        from tuck.models import Profile

        with pytest.raises(ValueError, match="WIDTHxHEIGHT"):
            _profile_with_resolution(Profile(name="Upscale"), "not-a-resolution")

    def test_upscale_rejects_compression_profile(self, capsys, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        code = cli_main(["upscale", "file.mp4", "--profile", "discord-10mb"])
        assert code == 1
        assert "not upscale" in capsys.readouterr().err

    def test_compress_missing_ffmpeg(self, capsys, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        dummy = tmp_path / "dummy.mp4"
        dummy.write_text("not a real video")

        monkeypatch.setattr("tuck.engine._find_ffmpeg", lambda: None)

        code = cli_main(["compress", str(dummy)])
        assert code == 2

    def test_settings_show(self, capsys, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        code = cli_main(["settings", "show"])
        assert code == 0
        captured = capsys.readouterr()
        assert "SETTINGS" in captured.out
        assert "Default profile" in captured.out

    def test_settings_reset(self, capsys, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        code = cli_main(["settings", "reset"])
        assert code == 0

    def test_profiles_list(self, capsys, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        code = cli_main(["profiles", "list"])
        assert code == 0
        captured = capsys.readouterr()
        assert "PROFILES" in captured.out
        assert "Workflow" in captured.out

    def test_profiles_export_import(self, tmp_path, monkeypatch, capsys):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        outfile = tmp_path / "profiles.json"
        code = cli_main(["profiles", "export", str(outfile)])
        assert code == 0
        assert outfile.exists()

        code = cli_main(["profiles", "import", str(outfile)])
        assert code == 0

    def test_profiles_import_preserves_existing(self, tmp_path, monkeypatch, capsys):

        import tuck.settings as settings_mod
        from tuck.models import Profile, export_profiles_json, find_profile_by_id

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        mgr = settings_mod.get_settings_manager()
        mgr.load()

        user = Profile(name="Unique Pre-Import", profile_id="unique-pre")
        profiles = mgr.get_profiles()
        profiles.append(user)
        mgr.set_profiles(profiles)
        mgr.save()

        new_prof = Profile(name="Exported Profile", profile_id="exported-new")
        export_path = tmp_path / "unique.json"
        export_profiles_json([new_prof], export_path)

        code = cli_main(["profiles", "import", str(export_path)])
        assert code == 0

        imported_mgr = settings_mod.get_settings_manager()
        imported_mgr.load()
        final = imported_mgr.get_profiles()
        assert find_profile_by_id(final, "unique-pre") is not None
        assert find_profile_by_id(final, "exported-new") is not None

    def test_sendto_help(self, capsys):
        code = cli_main(["sendto"])
        assert code == 0

    def test_sendto_uninstall_all(self, capsys, tmp_path, monkeypatch):

        from unittest import mock

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        with (
            mock.patch("tuck.sendto.uninstall_sendto") as mock_uninstall,
            mock.patch(
                "tuck.sendto.remove_all_profile_shortcuts", return_value=3
            ) as mock_remove_all,
        ):
            code = cli_main(["sendto", "uninstall-all"])
            assert code == 0
            mock_uninstall.assert_called_once()
            mock_remove_all.assert_called_once()
            captured = capsys.readouterr()
            assert "3" in captured.out
            assert "profile shortcuts" in captured.out.lower()

    def test_sendto_uninstall_all_handles_uninstall_error(self, capsys, tmp_path, monkeypatch):

        from unittest import mock

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        with (
            mock.patch(
                "tuck.sendto.uninstall_sendto",
                side_effect=OSError("access denied"),
            ) as mock_uninstall,
            mock.patch("tuck.sendto.remove_all_profile_shortcuts", return_value=0),
        ):
            code = cli_main(["sendto", "uninstall-all"])
            assert code == 1
            mock_uninstall.assert_called_once()
            captured = capsys.readouterr()
            assert "error" in captured.err.lower() or "access denied" in captured.err.lower()

    def test_sendto_uninstall_all_handles_remove_all_error(self, capsys, tmp_path, monkeypatch):

        from unittest import mock

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        with (
            mock.patch("tuck.sendto.uninstall_sendto") as mock_uninstall,
            mock.patch(
                "tuck.sendto.remove_all_profile_shortcuts",
                side_effect=RuntimeError("cleanup failed"),
            ),
        ):
            code = cli_main(["sendto", "uninstall-all"])
            assert code == 1
            mock_uninstall.assert_called_once()
            captured = capsys.readouterr()
            assert "error" in captured.err.lower() or "cleanup failed" in captured.err.lower()


class TestCLIExitCodes:
    def test_version_returns_0(self):
        assert cli_main(["--version"]) == 0

    def test_compress_missing_profile_returns_1(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        assert cli_main(["compress", "file.mp4", "--profile", "bad"]) == 1

    def test_compress_no_ffmpeg_returns_2(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.engine._find_ffmpeg", lambda: None)
        monkeypatch.setattr("tuck.probe._find_ffprobe", lambda: None)

        dummy = tmp_path / "dummy.mp4"
        dummy.write_text("not a real video")
        code = cli_main(["compress", str(dummy)])
        assert code == 2


class TestConsoleProgress:
    def test_encode_accepts_structured_progress(self, tmp_path, monkeypatch):
        output = tmp_path / "output.mp4"

        def fake_encode(_self, _plan, on_progress=None):
            assert on_progress is not None
            on_progress(EncodeProgress(percent=50.0))
            output.write_bytes(b"ok")
            return output

        monkeypatch.setattr("tuck.engine.FFmpegEngine.encode", fake_encode)
        plan = EncodePlan(
            source=str(tmp_path / "input.mp4"),
            output=str(output),
            target_size=1024 * 1024,
        )

        assert _do_encode(plan, object()) == 0


class TestParseSendtoArgs:
    def test_parse_sendto_files_only(self):
        files, profile_id, action = _parse_sendto_args(
            ["tuck", "--sendto-files", "C:\\vids\\a.mp4", "C:\\vids\\b.mkv"]
        )
        assert files == ["C:\\vids\\a.mp4", "C:\\vids\\b.mkv"]
        assert profile_id is None
        assert action is None

    def test_parse_sendto_with_profile(self):
        files, profile_id, action = _parse_sendto_args(
            ["tuck", "--profile-id", "discord-10mb", "--sendto-files", "C:\\vids\\a.mp4"]
        )
        assert files == ["C:\\vids\\a.mp4"]
        assert profile_id == "discord-10mb"
        assert action is None

    def test_parse_sendto_with_action(self):
        files, profile_id, action = _parse_sendto_args(
            ["tuck", "--sendto-action", "start", "--sendto-files", "C:\\vids\\a.mp4"]
        )
        assert files == ["C:\\vids\\a.mp4"]
        assert profile_id is None
        assert action == "start"

    def test_parse_sendto_review_action(self):
        files, _profile_id, action = _parse_sendto_args(
            ["tuck", "--sendto-action", "review", "--sendto-files", "C:\\vids\\a.mp4"]
        )
        assert files == ["C:\\vids\\a.mp4"]
        assert action == "review"

    def test_parse_sendto_full(self):

        files, profile_id, action = _parse_sendto_args(
            [
                "tuck",
                "--profile-id",
                "discord-50mb",
                "--sendto-action",
                "start",
                "--sendto-files",
                "C:\\vids\\a.mp4",
                "C:\\vids\\b.mp4",
            ]
        )
        assert files == ["C:\\vids\\a.mp4", "C:\\vids\\b.mp4"]
        assert profile_id == "discord-50mb"
        assert action == "start"

    def test_parse_sendto_flags_after_files_still_consumed(self):

        files, profile_id, action = _parse_sendto_args(
            [
                "tuck",
                "--sendto-action",
                "review",
                "--profile-id",
                "discord-10mb",
                "--sendto-files",
                "C:\\vids\\x.mp4",
            ]
        )
        assert files == ["C:\\vids\\x.mp4"]
        assert profile_id == "discord-10mb"
        assert action == "review"

    def test_parse_sendto_no_files(self):
        files, profile_id, action = _parse_sendto_args(
            ["tuck", "--profile-id", "discord-10mb", "--sendto-files"]
        )
        assert files == []
        assert profile_id == "discord-10mb"
        assert action is None

    def test_parse_sendto_empty_argv(self):
        files, profile_id, action = _parse_sendto_args([])
        assert files == []
        assert profile_id is None
        assert action is None

    def test_parse_sendto_missing_profile_value(self):

        files, profile_id, action = _parse_sendto_args(
            ["tuck", "--profile-id", "--sendto-files", "C:\\vids\\a.mp4"]
        )

        assert files == []
        assert profile_id == "--sendto-files"
        assert action is None
