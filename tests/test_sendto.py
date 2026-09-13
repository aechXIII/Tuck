import sys
from pathlib import Path

import pytest

from tuck.sendto import (
    _SHELL_LINK_HEADER,
    _TUCK_MARKER,
    ACTION_REVIEW,
    ACTION_START,
    PROFILE_SHORTCUT_PREFIX,
    SENDTO_BATCH_NAME,
    SENDTO_COMPRESS_BATCH_NAME,
    SENDTO_COMPRESS_SHORTCUT_NAME,
    SENDTO_SHORTCUT_NAME,
    _create_batch_fallback,
    _create_windows_shortcut,
    _get_args,
    _get_batch_path,
    _get_generic_shortcut_path,
    _get_profile_batch_path,
    _get_profile_shortcut_path,
    _get_target_path,
    _get_working_dir,
    _is_tuck_shortcut,
    _sendto_dir,
    _verify_bat_ownership,
    _verify_lnk_ownership,
    _write_batch_file,
    install_profile_shortcut,
    install_sendto,
    list_sendto_shortcuts,
    remove_all_profile_shortcuts,
    repair_sendto,
    uninstall_profile_shortcut,
    uninstall_sendto,
)

requires_windows_com = pytest.mark.skipif(
    sys.platform != "win32", reason="Windows shortcut tests require pywin32 COM"
)


def _make_marker_bat(path: Path, extra: str = "") -> None:

    path.write_text(
        f"@echo off\r\nREM {_TUCK_MARKER}\r\necho --sendto-files %*\r\n{extra}",
        encoding="ascii",
    )


def _make_foreign_bat(path: Path) -> None:

    path.write_text("@echo off\r\necho not tuck %*\r\n", encoding="ascii")


class TestSendToDir:
    def test_sendto_dir_returns_path(self):

        result = _sendto_dir()
        assert isinstance(result, Path)


class TestVerifyBatOwnership:
    def test_recognizes_marker_bat(self, tmp_path):
        f = tmp_path / "Tuck.bat"
        _make_marker_bat(f)
        assert _verify_bat_ownership(f)

    def test_rejects_no_marker(self, tmp_path):
        f = tmp_path / "Tuck.bat"
        _make_foreign_bat(f)
        assert not _verify_bat_ownership(f)

    def test_rejects_marker_without_sendto_files(self, tmp_path):
        f = tmp_path / "Tuck.bat"
        f.write_text(
            f"@echo off\r\nREM {_TUCK_MARKER}\r\necho hello",
            encoding="ascii",
        )
        assert not _verify_bat_ownership(f)

    def test_rejects_missing_file(self, tmp_path):
        assert not _verify_bat_ownership(tmp_path / "no-such-file.bat")

    def test_rejects_unreadable_file(self, tmp_path):
        f = tmp_path / "unreadable.bat"
        f.write_bytes(b"\xff\xfe\x00\x01")  # garbage bytes
        assert not _verify_bat_ownership(f)


class TestVerifyLnkOwnership:
    @requires_windows_com
    def test_nonexistent_lnk(self, tmp_path, monkeypatch):
        can_create_shortcuts = False

        def dispatch(*args):
            nonlocal can_create_shortcuts
            can_create_shortcuts = True

        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
        monkeypatch.setattr("win32com.client.Dispatch", dispatch)

        assert not _verify_lnk_ownership(tmp_path / "no-such.lnk")
        assert not can_create_shortcuts

    def test_cannot_create_shortcuts(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        f = tmp_path / "test.lnk"
        f.write_text("dummy")
        assert not _verify_lnk_ownership(f)

    @requires_windows_com
    def test_invalid_header_is_rejected_before_com(self, tmp_path, monkeypatch):
        f = tmp_path / "invalid.lnk"
        f.write_text("not a Shell Link")
        dispatched = False

        def dispatch(*args):
            nonlocal dispatched
            dispatched = True

        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
        monkeypatch.setattr("win32com.client.Dispatch", dispatch)

        assert not _verify_lnk_ownership(f)
        assert not dispatched


class TestIsTuckShortcut:
    def test_nonexistent_returns_false(self, tmp_path):
        assert not _is_tuck_shortcut(tmp_path / "nonexistent.lnk")

    def test_bat_with_marker_returns_true(self, tmp_path):
        f = tmp_path / SENDTO_BATCH_NAME
        _make_marker_bat(f)
        assert _is_tuck_shortcut(f)

    def test_bat_without_marker_returns_false(self, tmp_path):
        f = tmp_path / SENDTO_BATCH_NAME
        _make_foreign_bat(f)
        assert not _is_tuck_shortcut(f)

    def test_marker_bat_case_insensitive(self, tmp_path):
        f = tmp_path / "tuck.bat"
        _make_marker_bat(f)
        assert _is_tuck_shortcut(f)

    def test_lnk_delegates_to_verify(self, tmp_path, monkeypatch):

        f = tmp_path / SENDTO_SHORTCUT_NAME
        f.write_text("dummy")
        called = []

        def _fake_verify(p):
            called.append(p)
            return True

        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", _fake_verify)
        assert _is_tuck_shortcut(f)
        assert called == [f]

    def test_profile_bat_with_marker_returns_true(self, tmp_path):
        f = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}my-profile.bat"
        _make_marker_bat(f)
        assert _is_tuck_shortcut(f)

    def test_profile_lnk_delegates(self, tmp_path, monkeypatch):
        f = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}my-profile.lnk"
        f.write_text("dummy")
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)
        assert _is_tuck_shortcut(f)

    def test_unknown_suffix_returns_false(self, tmp_path):
        f = tmp_path / "Tuck.txt"
        f.write_text("dummy")
        assert not _is_tuck_shortcut(f)

    def test_legacy_unmarked_bat_survives(self, tmp_path):

        f = tmp_path / SENDTO_BATCH_NAME
        _make_foreign_bat(f)
        assert not _is_tuck_shortcut(f)

    def test_malformed_bat_survives(self, tmp_path):

        f = tmp_path / SENDTO_BATCH_NAME
        f.write_text("")
        assert not _is_tuck_shortcut(f)


class TestForeignCollisionSurvival:
    def test_foreign_lnk_survives_uninstall(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: False)

        foreign_lnk = tmp_path / SENDTO_SHORTCUT_NAME
        foreign_lnk.write_text("foreign")
        uninstall_sendto()
        assert foreign_lnk.exists()

    def test_foreign_bat_survives_uninstall(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        foreign_bat = tmp_path / SENDTO_BATCH_NAME
        _make_foreign_bat(foreign_bat)
        uninstall_sendto()
        assert foreign_bat.exists()

    def test_foreign_profile_bat_survives_remove_all(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        foreign = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}foreign.bat"
        _make_foreign_bat(foreign)
        count = remove_all_profile_shortcuts()
        assert count == 0
        assert foreign.exists()

    def test_foreign_profile_lnk_survives_uninstall(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: False)

        foreign = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}foreign.lnk"
        foreign.write_text("foreign")
        removed = uninstall_profile_shortcut("foreign")
        assert not removed
        assert foreign.exists()

    def test_owned_bat_deleted_uninstall(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        owned = tmp_path / SENDTO_BATCH_NAME
        _make_marker_bat(owned)
        assert owned.exists()
        uninstall_sendto()
        assert not owned.exists()

    def test_owned_profile_bat_deleted_remove_all(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        owned = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}owned.bat"
        _make_marker_bat(owned)
        count = remove_all_profile_shortcuts()
        assert count == 1
        assert not owned.exists()

    def test_owned_profile_bat_deleted_uninstall(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        owned = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}owned.bat"
        _make_marker_bat(owned)
        removed = uninstall_profile_shortcut("owned")
        assert removed
        assert not owned.exists()

    def test_mixed_owned_and_foreign_in_remove_all(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        owned_a = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}owned-a.bat"
        owned_b = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}owned-b.bat"
        foreign_c = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}foreign-c.bat"
        not_tuck = tmp_path / "Not Tuck - something.bat"
        text_file = tmp_path / "readme.txt"

        _make_marker_bat(owned_a)
        _make_marker_bat(owned_b)
        _make_foreign_bat(foreign_c)
        _make_foreign_bat(not_tuck)
        text_file.write_text("hello")

        count = remove_all_profile_shortcuts()
        assert count == 2
        assert not owned_a.exists()
        assert not owned_b.exists()
        assert foreign_c.exists()
        assert not_tuck.exists()
        assert text_file.exists()


class TestMarkerEmbeddedOnCreation:
    def test_write_batch_file_embeds_marker(self, tmp_path):
        batch_path = tmp_path / "Tuck.bat"
        _write_batch_file(batch_path, r"C:\Tuck\Tuck.exe", ["--sendto-files"])
        content = batch_path.read_text()
        assert f"REM {_TUCK_MARKER}" in content
        assert "--sendto-files" in content

    def test_write_batch_file_with_profile_embeds_marker(self, tmp_path):
        batch_path = tmp_path / "Tuck - discord-10mb.bat"
        _write_batch_file(
            batch_path,
            r"C:\Tuck\Tuck.exe",
            ["--profile-id", "discord-10mb", "--sendto-action", "start", "--sendto-files"],
        )
        content = batch_path.read_text()
        assert f"REM {_TUCK_MARKER}" in content
        assert "discord-10mb" in content

    @requires_windows_com
    def test_create_windows_shortcut_embeds_marker(self, tmp_path, monkeypatch):

        saved_desc = []

        class FakeShortcut:
            def __init__(self):
                self.TargetPath = ""
                self.Arguments = ""
                self.WorkingDirectory = ""
                self.Description = ""

            def Save(self):  # noqa: N802  # COM interface method
                saved_desc.append(self.Description)

        class FakeShell:
            def CreateShortCut(self, path):  # noqa: N802  # COM interface method
                return FakeShortcut()

        monkeypatch.setattr("win32com.client.Dispatch", lambda progid: FakeShell())

        try:
            import pythoncom  # ensure loaded

            monkeypatch.setattr(pythoncom, "CoInitialize", lambda: None)
            monkeypatch.setattr(pythoncom, "CoUninitialize", lambda: None)
        except ImportError:
            monkeypatch.setitem(
                sys.modules, "pythoncom", __import__("types").ModuleType("pythoncom")
            )
            monkeypatch.setattr("pythoncom.CoInitialize", lambda: None)
            monkeypatch.setattr("pythoncom.CoUninitialize", lambda: None)

        _create_windows_shortcut(
            r"C:\Tuck\Tuck.exe",
            tmp_path / "test.lnk",
            arguments=["--sendto-files"],
            working_dir=str(tmp_path),
            description="Compress with Tuck",
            shortcut_type="generic",
        )

        assert len(saved_desc) == 1
        desc = saved_desc[0]
        assert desc.startswith(_TUCK_MARKER)
        assert "generic" in desc
        assert "Compress with Tuck" in desc

    @requires_windows_com
    def test_create_windows_shortcut_profile_embeds_id(self, tmp_path, monkeypatch):

        saved_desc = []

        class FakeShortcut:
            TargetPath = ""
            Arguments = ""
            WorkingDirectory = ""
            Description = ""

            def Save(self):  # noqa: N802  # COM interface method
                saved_desc.append(self.Description)

        class FakeShell:
            def CreateShortCut(self, path):  # noqa: N802  # COM interface method
                return FakeShortcut()

        monkeypatch.setattr("win32com.client.Dispatch", lambda progid: FakeShell())
        try:
            import pythoncom as _pc

            monkeypatch.setattr(_pc, "CoInitialize", lambda: None)
            monkeypatch.setattr(_pc, "CoUninitialize", lambda: None)
        except ImportError:
            monkeypatch.setitem(
                sys.modules, "pythoncom", __import__("types").ModuleType("pythoncom")
            )
            monkeypatch.setattr("pythoncom.CoInitialize", lambda: None)
            monkeypatch.setattr("pythoncom.CoUninitialize", lambda: None)

        _create_windows_shortcut(
            r"C:\Tuck\Tuck.exe",
            tmp_path / "test.lnk",
            arguments=["--profile-id", "discord-10mb", "--sendto-files"],
            working_dir=str(tmp_path),
            description="Compress with Tuck (My Profile)",
            shortcut_type="profile",
            profile_id="discord-10mb",
        )

        assert len(saved_desc) == 1
        desc = saved_desc[0]
        assert desc.startswith(_TUCK_MARKER)
        assert "|profile|discord-10mb|" in desc
        assert "Compress with Tuck" in desc


class TestListShortcuts:
    def test_empty_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        result = list_sendto_shortcuts()
        assert isinstance(result, list)
        assert len(result) == 0

    def test_finds_generic_lnk(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        (tmp_path / SENDTO_SHORTCUT_NAME).write_text("dummy")
        result = list_sendto_shortcuts()
        assert any(r["type"] == "generic" for r in result)
        assert result[0]["status"] == "broken"

    def test_finds_generic_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        (tmp_path / SENDTO_BATCH_NAME).write_text("dummy")
        result = list_sendto_shortcuts()
        assert any(r["type"] == "generic" for r in result)
        assert result[0]["status"] == "broken"

    def test_reports_single_owned_generic_batch_as_needing_repair(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / SENDTO_BATCH_NAME)

        result = list_sendto_shortcuts()

        assert result[0]["status"] == "broken"

    def test_reports_generic_shortcuts_as_one_integration(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / SENDTO_BATCH_NAME)
        _make_marker_bat(tmp_path / SENDTO_COMPRESS_BATCH_NAME)

        generic = [item for item in list_sendto_shortcuts() if item["type"] == "generic"]

        assert generic == [
            {
                "name": "Tuck + Tuck Compress",
                "path": str(tmp_path / SENDTO_BATCH_NAME),
                "type": "generic",
                "status": "ok",
            }
        ]

    def test_finds_owned_profile_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Test Profile.bat"
        _make_marker_bat(p)
        result = list_sendto_shortcuts()
        assert any(
            r["type"] == "profile"
            and r["name"] == "Test Profile"
            and r["profile_id"] == "Test Profile"
            and r["status"] == "ok"
            for r in result
        )

    def test_ignores_unowned_profile_bat(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}ghost.bat"
        _make_foreign_bat(p)
        result = list_sendto_shortcuts()
        assert not any(r["name"] == "ghost" for r in result)

    def test_finds_owned_profile_lnk(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Test Profile.lnk"
        p.write_text("dummy")
        result = list_sendto_shortcuts()
        assert any(
            r["type"] == "profile"
            and r["name"] == "Test Profile"
            and r["profile_id"] == "Test Profile"
            and r["status"] == "ok"
            for r in result
        )


class TestRemoveAllProfileShortcuts:
    def test_empty_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        count = remove_all_profile_shortcuts()
        assert count == 0

    def test_removes_only_owned(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile A.bat")
        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile B.bat")

        _make_foreign_bat(tmp_path / "Not Tuck - Something.bat")
        (tmp_path / "random_file.txt").write_text("not a shortcut")

        count = remove_all_profile_shortcuts()
        assert count == 2
        assert (tmp_path / "Not Tuck - Something.bat").exists()
        assert (tmp_path / "random_file.txt").exists()

    def test_removes_mixed_lnk_and_bat(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)

        (tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile A.lnk").write_text("lnk")

        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile B.bat")

        _make_foreign_bat(tmp_path / "NotTuck.bat")

        count = remove_all_profile_shortcuts()
        assert count == 2
        assert (tmp_path / "NotTuck.bat").exists()


class TestProfileShortcutPath:
    def test_profile_shortcut_path_stable(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        path = _get_profile_shortcut_path("discord-10mb")
        assert path.name == f"{PROFILE_SHORTCUT_PREFIX}discord-10mb.lnk"
        assert path.parent == tmp_path

    def test_profile_shortcut_path_with_hyphens(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        path = _get_profile_shortcut_path("discord-10mb")
        assert path.name == f"{PROFILE_SHORTCUT_PREFIX}discord-10mb.lnk"

    def test_profile_shortcut_path_different_ids(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p1 = _get_profile_shortcut_path("profile-a")
        p2 = _get_profile_shortcut_path("profile-b")
        assert p1 != p2


class TestGetArgs:
    def test_get_args_source_generic(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        args = _get_args()
        assert "-m" in args
        assert "tuck" in args
        assert "--sendto-action" in args
        assert "start" in args
        assert "--sendto-files" in args

    def test_get_args_source_profile(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        args = _get_args(for_profile="discord-10mb", action="start")
        assert "--profile-id" in args
        assert "discord-10mb" in args
        assert "--sendto-action" in args
        assert "start" in args
        assert "--sendto-files" in args

    def test_get_args_source_review(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        args = _get_args(for_profile="discord-10mb", action="review")
        assert "review" in args
        assert "-m" not in args

    def test_get_args_frozen_generic(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", True, raising=False)
        args = _get_args()
        assert "-m" not in args
        assert "tuck" not in args
        assert "--sendto-action" in args
        assert "start" in args
        assert "--sendto-files" in args

    def test_get_args_frozen_profile(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", True, raising=False)
        args = _get_args(for_profile="discord-500mb", action="start")
        assert "--profile-id" in args
        assert "discord-500mb" in args
        assert "--sendto-action" in args
        assert "--sendto-files" in args
        assert "-m" not in args


class TestGetTargetPath:
    def test_source_compression_uses_python(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        assert _get_target_path(action=ACTION_START) == sys.executable

    def test_source_review_requires_desktop_app(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        with pytest.raises(RuntimeError, match="desktop app"):
            _get_target_path(action=ACTION_REVIEW)

    def test_source_review_accepts_explicit_desktop_target(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        desktop = tmp_path / "Tuck.exe"
        desktop.touch()
        assert _get_target_path(desktop, ACTION_REVIEW) == str(desktop)

    def test_get_target_path_frozen(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", True, raising=False)
        result = _get_target_path()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_get_target_path_frozen_cli_uses_sibling_gui(self, tmp_path, monkeypatch):
        cli_path = tmp_path / "TuckCli.exe"
        gui_path = tmp_path / "Tuck.exe"
        cli_path.touch()
        gui_path.touch()
        monkeypatch.setattr("sys.frozen", True, raising=False)
        monkeypatch.setattr("sys.executable", str(cli_path))

        assert _get_target_path() == str(gui_path)

    def test_get_target_path_frozen_uses_gui_for_review_and_cli_for_compress(
        self, tmp_path, monkeypatch
    ):
        cli_path = tmp_path / "TuckCli.exe"
        gui_path = tmp_path / "Tuck.exe"
        cli_path.touch()
        gui_path.touch()
        monkeypatch.setattr("sys.frozen", True, raising=False)
        monkeypatch.setattr("sys.executable", str(cli_path))

        assert _get_target_path(action=ACTION_REVIEW) == str(gui_path)
        assert _get_target_path(action=ACTION_START) == str(cli_path)


class TestGetWorkingDir:
    def test_get_working_dir_returns_path(self):
        result = _get_working_dir()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_get_working_dir_source_is_project_root(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        wd = Path(_get_working_dir())
        assert wd.exists()
        assert (wd / "tuck").is_dir() or (wd / "pyproject.toml").is_file()

    def test_get_working_dir_frozen_returns_parent(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", True, raising=False)
        result = _get_working_dir()
        assert isinstance(result, str)
        assert len(result) > 0


class TestGenericShortcutPath:
    def test_get_generic_shortcut_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = _get_generic_shortcut_path()
        assert p.name == SENDTO_SHORTCUT_NAME
        assert p.parent == tmp_path

    def test_get_batch_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = _get_batch_path()
        assert p.name == SENDTO_BATCH_NAME
        assert p.parent == tmp_path


class TestBatchFallback:
    def test_source_profile_review_does_not_create_shortcut(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

        with pytest.raises(RuntimeError, match="desktop app"):
            install_profile_shortcut("review-profile", "Review profile", action=ACTION_REVIEW)

        assert list(tmp_path.iterdir()) == []

    def test_write_batch_file_creates_file(self, tmp_path):
        batch_path = tmp_path / "Tuck.bat"
        _write_batch_file(batch_path, r"C:\Tuck\Tuck.exe", ["--sendto-files"])
        assert batch_path.exists()
        content = batch_path.read_text()
        assert "@echo off" in content
        assert r"C:\Tuck\Tuck.exe" in content
        assert "--sendto-files" in content
        assert f"REM {_TUCK_MARKER}" in content
        assert "%*" in content

    def test_write_batch_file_with_profile(self, tmp_path):
        batch_path = tmp_path / "Tuck - discord-10mb.bat"
        _write_batch_file(
            batch_path,
            r"C:\Tuck\Tuck.exe",
            ["--profile-id", "discord-10mb", "--sendto-action", "start", "--sendto-files"],
        )
        content = batch_path.read_text()
        assert "discord-10mb" in content
        assert "start" in content
        assert "--sendto-files" in content
        assert f"REM {_TUCK_MARKER}" in content

    def test_create_batch_fallback_returns_batch_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        batch = _create_batch_fallback(r"C:\Tuck\Tuck.exe", ["--sendto-files"], tmp_path)
        assert batch.exists()
        assert batch.suffix == ".bat"
        assert batch.name == SENDTO_BATCH_NAME
        content = batch.read_text()
        assert "--sendto-files" in content
        assert f"REM {_TUCK_MARKER}" in content

    def test_create_batch_fallback_with_suffix(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        batch = _create_batch_fallback(
            r"C:\Tuck\Tuck.exe",
            ["--profile-id", "my-id", "--sendto-files"],
            tmp_path,
            suffix="-my-id",
        )
        assert batch.exists()
        assert batch.name.startswith("Tuck")
        assert "my-id" in batch.name
        assert batch.suffix == ".bat"

    def test_install_sendto_batch_fallback(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: sys.executable)
        monkeypatch.setattr("tuck.sendto._get_working_dir", lambda: str(tmp_path))

        result = install_sendto()
        assert result.suffix == ".bat"
        assert result.name == SENDTO_BATCH_NAME
        assert result.exists()
        review_content = result.read_text()
        assert "--sendto-action review" in review_content
        assert "--sendto-files" in review_content
        assert f"REM {_TUCK_MARKER}" in review_content

        compress_path = tmp_path / SENDTO_COMPRESS_BATCH_NAME
        assert compress_path.exists()
        compress_content = compress_path.read_text()
        assert "--sendto-action start" in compress_content
        assert "--sendto-files" in compress_content
        assert f"REM {_TUCK_MARKER}" in compress_content

    def test_install_profile_shortcut_batch_fallback(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: sys.executable)

        result = install_profile_shortcut("my-profile", "My Profile", action="start")
        assert result.suffix == ".bat"
        assert result.exists()
        content = result.read_text()
        assert "my-profile" in content
        assert "--sendto-files" in content
        assert f"REM {_TUCK_MARKER}" in content

    def test_uninstall_sendto_removes_both_owned_generic_bats(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        bat_path = tmp_path / SENDTO_BATCH_NAME
        compress_path = tmp_path / SENDTO_COMPRESS_BATCH_NAME
        _make_marker_bat(bat_path)
        _make_marker_bat(compress_path)
        assert bat_path.exists()
        assert compress_path.exists()
        uninstall_sendto()
        assert not bat_path.exists()
        assert not compress_path.exists()

    def test_uninstall_sendto_keeps_foreign_bat(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        bat_path = tmp_path / SENDTO_BATCH_NAME
        _make_foreign_bat(bat_path)
        uninstall_sendto()
        assert bat_path.exists()

    def test_install_sendto_rejects_foreign_generic_collision(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: sys.executable)
        foreign_path = tmp_path / SENDTO_COMPRESS_BATCH_NAME
        _make_foreign_bat(foreign_path)
        original = foreign_path.read_bytes()

        try:
            install_sendto()
        except FileExistsError as error:
            assert SENDTO_COMPRESS_BATCH_NAME in str(error)
        else:
            raise AssertionError("foreign shortcut collision was overwritten")

        assert foreign_path.read_bytes() == original
        assert not (tmp_path / SENDTO_BATCH_NAME).exists()


class TestRepairGenericShortcuts:
    def test_source_review_repair_reports_unsupported_target(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
        monkeypatch.setattr("tuck.sendto._is_tuck_shortcut", lambda path: True)
        shortcut = tmp_path / SENDTO_SHORTCUT_NAME
        shortcut.write_bytes(_SHELL_LINK_HEADER)

        with pytest.raises(RuntimeError, match="desktop app"):
            repair_sendto()

        assert shortcut.read_bytes() == _SHELL_LINK_HEADER

    @requires_windows_com
    def test_repairs_legacy_shortcut_into_review_and_compress_pair(self, tmp_path, monkeypatch):
        legacy_path = tmp_path / SENDTO_SHORTCUT_NAME
        legacy_path.write_bytes(_SHELL_LINK_HEADER)

        class FakeShortcut:
            def __init__(self, path):
                self.path = Path(path)
                self.TargetPath = r"C:\Tuck\Tuck.exe"
                self.Arguments = "--sendto-files"
                self.WorkingDirectory = ""
                self.Description = "Compress with Tuck"

            def Save(self):  # noqa: N802
                self.path.touch()

        class FakeShell:
            def __init__(self):
                self.shortcuts = {}

            def CreateShortCut(self, path):  # noqa: N802
                return self.shortcuts.setdefault(str(path), FakeShortcut(path))

        shell = FakeShell()
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: r"C:\Tuck\Tuck.exe")
        monkeypatch.setattr("win32com.client.Dispatch", lambda _name: shell)

        assert repair_sendto()
        assert "--sendto-action review" in shell.shortcuts[str(legacy_path)].Arguments
        compress_path = tmp_path / SENDTO_COMPRESS_SHORTCUT_NAME
        assert "--sendto-action start" in shell.shortcuts[str(compress_path)].Arguments

    @requires_windows_com
    def test_repair_rejects_foreign_counterpart_before_migrating_legacy(
        self, tmp_path, monkeypatch
    ):
        legacy_path = tmp_path / SENDTO_SHORTCUT_NAME
        foreign_path = tmp_path / SENDTO_COMPRESS_SHORTCUT_NAME
        legacy_path.write_bytes(_SHELL_LINK_HEADER)
        foreign_path.write_bytes(_SHELL_LINK_HEADER)

        class FakeShortcut:
            def __init__(self, path):
                self.path = Path(path)
                self.TargetPath = r"C:\Tuck\Tuck.exe"
                self.Arguments = (
                    "--sendto-files" if self.path == legacy_path else "--foreign-action"
                )
                self.WorkingDirectory = ""
                self.Description = (
                    "Compress with Tuck" if self.path == legacy_path else "Foreign shortcut"
                )

            def Save(self):  # noqa: N802
                self.path.touch()

        class FakeShell:
            def __init__(self):
                self.shortcuts = {}

            def CreateShortCut(self, path):  # noqa: N802
                return self.shortcuts.setdefault(str(path), FakeShortcut(path))

        shell = FakeShell()
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: r"C:\Tuck\Tuck.exe")
        monkeypatch.setattr("win32com.client.Dispatch", lambda _name: shell)

        try:
            repair_sendto()
        except FileExistsError as error:
            assert SENDTO_COMPRESS_SHORTCUT_NAME in str(error)
        else:
            raise AssertionError("repair accepted a foreign counterpart")

        assert shell.shortcuts[str(legacy_path)].Arguments == "--sendto-files"


class TestBridgeSendTo:
    def test_install_profile_sendto_unknown_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()
        resp = api.install_profile_sendto("nonexistent-profile")
        assert not resp["ok"]
        assert "Profile not found" in resp["error"]

    def test_remove_profile_sendto_handles_missing(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()
        resp = api.remove_profile_sendto("No Such Profile")
        assert resp["ok"]
        assert not resp["removed"]

    def test_repair_profile_sendto_unknown_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()
        resp = api.repair_profile_sendto("nonexistent")
        assert not resp["ok"]
        assert "Profile not found" in resp["error"]

    def test_list_sendto_shortcuts_bridge(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()
        resp = api.list_sendto_shortcuts()
        assert resp["ok"]
        assert isinstance(resp["shortcuts"], list)


class TestProfileBatchPath:
    def test_profile_batch_path_stable(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        path = _get_profile_batch_path("discord-10mb")
        assert path.name == f"{PROFILE_SHORTCUT_PREFIX}discord-10mb.bat"
        assert path.parent == tmp_path

    def test_profile_batch_path_different_from_lnk(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        lnk = _get_profile_shortcut_path("my-profile")
        bat = _get_profile_batch_path("my-profile")
        assert lnk.suffix == ".lnk"
        assert bat.suffix == ".bat"
        assert lnk != bat


class TestUninstallProfileRemovesBatch:
    def test_removes_owned_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        bat_path = _get_profile_batch_path("my-profile")
        _make_marker_bat(bat_path)
        assert bat_path.exists()
        removed = uninstall_profile_shortcut("my-profile")
        assert removed
        assert not bat_path.exists()

    def test_keeps_unowned_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        bat_path = _get_profile_batch_path("my-profile")
        _make_foreign_bat(bat_path)
        removed = uninstall_profile_shortcut("my-profile")
        assert not removed
        assert bat_path.exists()

    def test_returns_false_when_nothing_exists(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        removed = uninstall_profile_shortcut("no-such-profile")
        assert not removed

    def test_removes_owned_lnk(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)
        lnk_path = _get_profile_shortcut_path("my-profile")
        lnk_path.write_text("tuck")
        assert lnk_path.exists()
        removed = uninstall_profile_shortcut("my-profile")
        assert removed
        assert not lnk_path.exists()

    def test_removes_both_lnk_and_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)

        lnk_path = _get_profile_shortcut_path("my-profile")
        bat_path = _get_profile_batch_path("my-profile")
        lnk_path.write_text("tuck")
        _make_marker_bat(bat_path)
        removed = uninstall_profile_shortcut("my-profile")
        assert removed
        assert not lnk_path.exists()
        assert not bat_path.exists()


class TestRemoveAllRemovesBatch:
    def test_removes_owned_bat_profiles(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile A.bat")
        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile B.bat")
        count = remove_all_profile_shortcuts()
        assert count == 2

    def test_removes_mixed_owned_lnk_and_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)
        (tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile A.lnk").write_text("tuck")
        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile B.bat")
        count = remove_all_profile_shortcuts()
        assert count == 2

    def test_keeps_unowned(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Profile A.bat")
        _make_foreign_bat(tmp_path / "NotTuck.bat")
        count = remove_all_profile_shortcuts()
        assert count == 1
        assert (tmp_path / "NotTuck.bat").exists()


class TestDeleteProfileRemovesBatch:
    def test_delete_profile_removes_owned_bat(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="ToDelete", profile_id="to-delete-bat")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        bat_path = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}to-delete-bat.bat"
        _make_marker_bat(bat_path)
        resp = api.delete_profile("to-delete-bat")
        assert resp["ok"]
        assert not bat_path.exists()

    def test_delete_profile_removes_owned_lnk(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="ToDeleteLnk", profile_id="to-delete-lnk")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        lnk_path = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}to-delete-lnk.lnk"
        lnk_path.write_text("tuck")
        resp = api.delete_profile("to-delete-lnk")
        assert resp["ok"]
        assert not lnk_path.exists()

    def test_delete_profile_keeps_unowned(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Keep", profile_id="keep-me")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        foreign_bat = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}keep-me.bat"
        _make_foreign_bat(foreign_bat)
        resp = api.delete_profile("keep-me")
        assert resp["ok"]
        assert foreign_bat.exists()


class TestRemoveGenericSendTo:
    def test_removes_owned_generic_bat_keeps_profiles(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()

        _make_marker_bat(tmp_path / SENDTO_BATCH_NAME)

        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}keep-me.bat")

        resp = api.remove_generic_sendto()
        assert resp["ok"]
        assert not (tmp_path / SENDTO_BATCH_NAME).exists()
        assert (tmp_path / f"{PROFILE_SHORTCUT_PREFIX}keep-me.bat").exists()

    def test_keeps_foreign_generic(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()

        _make_foreign_bat(tmp_path / SENDTO_BATCH_NAME)
        resp = api.remove_generic_sendto()
        assert resp["ok"]
        assert (tmp_path / SENDTO_BATCH_NAME).exists()

    def test_removes_owned_lnk_keeps_foreign(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api._settings.load()

        owned_lnk = tmp_path / SENDTO_SHORTCUT_NAME
        owned_lnk.write_text("dummy")

        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: p == owned_lnk)

        foreign_lnk = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}keep-me.lnk"
        foreign_lnk.write_text("foreign")

        resp = api.remove_generic_sendto()
        assert resp["ok"]

        assert not owned_lnk.exists()

        assert foreign_lnk.exists()
