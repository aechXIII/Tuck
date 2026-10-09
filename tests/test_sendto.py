import json
import logging
import sys
from pathlib import Path

import pytest

from tuck.sendto import (
    _SHELL_LINK_HEADER,
    _TUCK_MARKER,
    ACTION_REVIEW,
    ACTION_START,
    PROFILE_SHORTCUT_PREFIX,
    SENDTO_KINDS,
    _batch_content,
    _create_windows_shortcut,
    _generic_paths,
    _get_args,
    _get_target_path,
    _get_working_dir,
    _is_tuck_shortcut,
    _LinkFields,
    _sendto_dir,
    _verify_bat_ownership,
    _verify_lnk_ownership,
    _write_batch_file,
    generic_shortcut,
    install_generic_shortcut,
    install_profile_shortcut,
    list_sendto_shortcuts,
    profile_shortcut_stems,
    remove_all_profile_shortcuts,
    rename_profile_shortcut,
    repair_generic_shortcut,
    repair_profile_shortcut,
    uninstall_generic_shortcut,
    uninstall_profile_shortcut,
    uninstall_sendto,
)

# these names are what Explorer shows, and older installs already use the first two
SENDTO_SHORTCUT_NAME = "Tuck.lnk"
SENDTO_BATCH_NAME = "Tuck.bat"
SENDTO_COMPRESS_SHORTCUT_NAME = "Tuck Compress.lnk"
SENDTO_COMPRESS_BATCH_NAME = "Tuck Compress.bat"

requires_windows_com = pytest.mark.skipif(
    sys.platform != "win32", reason="Windows shortcut tests require pywin32 COM"
)


def _make_marker_bat(path: Path, extra: str = "", profile_id: str = "") -> None:
    # batch files from older installs carry the profile id only in their arguments
    profile = f"--profile-id {profile_id} " if profile_id else ""
    path.write_text(
        f"@echo off\r\nREM {_TUCK_MARKER}\r\necho {profile}--sendto-files %*\r\n{extra}",
        encoding="ascii",
    )


def _fake_profile_links(monkeypatch, links: dict[Path, str]) -> None:
    """Treat each path as an owned profile .lnk that belongs to the given profile id."""
    monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda path: path in links)
    monkeypatch.setattr(
        "tuck.sendto._read_link",
        lambda path: (
            _LinkFields(
                r"C:\Tuck\TuckCli.exe",
                f"--profile-id {links[path]} --sendto-action start --sendto-files",
                f"{_TUCK_MARKER}|profile|{links[path]}|Compress with Tuck (Name)",
            )
            if path in links
            else None
        ),
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
        _make_marker_bat(owned, profile_id="owned")
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

    def test_single_owned_generic_batch_is_ok_on_its_own(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / SENDTO_BATCH_NAME)

        result = list_sendto_shortcuts()

        assert [(item["kind"], item["status"]) for item in result] == [("open", "ok")]

    def test_reports_each_generic_kind_separately(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / SENDTO_BATCH_NAME)
        _make_marker_bat(tmp_path / "Tuck Upscale.bat")
        _make_foreign_bat(tmp_path / "Tuck Lossless Cut.bat")

        generic = [item for item in list_sendto_shortcuts() if item["type"] == "generic"]

        assert generic == [
            {
                "name": "Tuck",
                "type": "generic",
                "kind": "open",
                "status": "ok",
                "path": str(tmp_path / SENDTO_BATCH_NAME),
            },
            {
                "name": "Tuck Upscale",
                "type": "generic",
                "kind": "upscale",
                "status": "ok",
                "path": str(tmp_path / "Tuck Upscale.bat"),
            },
            {
                "name": "Tuck Lossless Cut",
                "type": "generic",
                "kind": "cut",
                "status": "broken",
                "path": str(tmp_path / "Tuck Lossless Cut.bat"),
            },
        ]

    def test_old_paired_shortcuts_list_as_open_and_compress(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._verify_lnk_ownership", lambda p: True)
        (tmp_path / SENDTO_SHORTCUT_NAME).write_text("old pair")
        (tmp_path / SENDTO_COMPRESS_SHORTCUT_NAME).write_text("old pair")

        generic = [item for item in list_sendto_shortcuts() if item["type"] == "generic"]

        assert [(item["kind"], item["status"]) for item in generic] == [
            ("open", "ok"),
            ("compress", "ok"),
        ]

    def test_finds_owned_profile_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Test Profile.bat"
        _make_marker_bat(p, profile_id="test-profile")
        result = list_sendto_shortcuts()
        assert result == [
            {
                "name": "Tuck - Test Profile",
                "profile_id": "test-profile",
                "path": str(p),
                "type": "profile",
                "status": "ok",
            }
        ]

    def test_profile_is_read_from_the_marker_not_the_file_name(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}other-profile.bat"
        _write_batch_file(
            p,
            r"C:\Tuck\TuckCli.exe",
            _get_args(for_profile="real-id"),
            marker_type="profile",
            profile_id="real-id",
        )

        [entry] = list_sendto_shortcuts()

        assert entry["profile_id"] == "real-id"
        assert entry["name"] == "Tuck - other-profile"

    def test_skips_owned_profile_file_without_a_profile_id(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / f"{PROFILE_SHORTCUT_PREFIX}mystery.bat")

        assert list_sendto_shortcuts() == []

    def test_ignores_unowned_profile_bat(self, tmp_path, monkeypatch):

        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}ghost.bat"
        _make_foreign_bat(p)
        result = list_sendto_shortcuts()
        assert not any(r["name"] == "ghost" for r in result)

    def test_finds_owned_profile_lnk(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        p = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}Test Profile.lnk"
        p.write_text("dummy")
        _fake_profile_links(monkeypatch, {p: "test-profile"})
        result = list_sendto_shortcuts()
        assert result == [
            {
                "name": "Tuck - Test Profile",
                "profile_id": "test-profile",
                "path": str(p),
                "type": "profile",
                "status": "ok",
            }
        ]


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

    def test_target_is_never_supplied_by_the_caller(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        desktop = tmp_path / "Tuck.exe"
        desktop.touch()
        with pytest.raises(TypeError):
            _get_target_path(desktop, ACTION_REVIEW)

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


class TestGenericShortcutSpecs:
    def test_generic_paths_use_the_kind_file_names(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        names = [
            tuple(path.name for path in _generic_paths(generic_shortcut(kind)))
            for kind in SENDTO_KINDS
        ]
        assert names == [
            (SENDTO_SHORTCUT_NAME, SENDTO_BATCH_NAME),
            (SENDTO_COMPRESS_SHORTCUT_NAME, SENDTO_COMPRESS_BATCH_NAME),
            ("Tuck Upscale.lnk", "Tuck Upscale.bat"),
            ("Tuck Lossless Cut.lnk", "Tuck Lossless Cut.bat"),
        ]

    @pytest.mark.parametrize("kind", ["", "Open", "trim", None, 1])
    def test_unknown_kind_is_rejected(self, kind):
        with pytest.raises(ValueError, match="open, compress, upscale, or cut"):
            generic_shortcut(kind)

    @pytest.mark.parametrize(
        ("kind", "arguments"),
        [
            ("open", ["--sendto-action", "review", "--sendto-files"]),
            ("compress", ["--sendto-action", "start", "--sendto-files"]),
            (
                "upscale",
                ["--sendto-action", "start", "--sendto-task", "upscale", "--sendto-files"],
            ),
            (
                "cut",
                ["--sendto-action", "review", "--sendto-task", "cut", "--sendto-files"],
            ),
        ],
    )
    def test_packaged_arguments_per_kind(self, kind, arguments, monkeypatch):
        monkeypatch.setattr("sys.frozen", True, raising=False)
        spec = generic_shortcut(kind)
        assert _get_args(action=spec.action, task=spec.task) == arguments

    def test_source_start_shortcuts_run_the_python_module(self, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        spec = generic_shortcut("upscale")
        assert _get_args(action=spec.action, task=spec.task)[:2] == ["-m", "tuck"]

    def test_source_cut_shortcut_requires_desktop_app(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

        with pytest.raises(RuntimeError, match="desktop app"):
            install_generic_shortcut("cut")

        assert list(tmp_path.iterdir()) == []


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

    def test_install_each_kind_writes_only_its_own_batch(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: sys.executable)
        monkeypatch.setattr("tuck.sendto._get_working_dir", lambda: str(tmp_path))

        result = install_generic_shortcut("open")
        assert result == tmp_path / SENDTO_BATCH_NAME
        assert [path.name for path in tmp_path.iterdir()] == [SENDTO_BATCH_NAME]
        review_content = result.read_text()
        assert "--sendto-action review" in review_content
        assert "--sendto-files" in review_content
        assert f"REM {_TUCK_MARKER}|generic-open" in review_content

        upscale = install_generic_shortcut("upscale")
        assert upscale.name == "Tuck Upscale.bat"
        upscale_content = upscale.read_text()
        assert "--sendto-action start --sendto-task upscale --sendto-files" in upscale_content
        assert f"REM {_TUCK_MARKER}|generic-upscale" in upscale_content
        assert _is_tuck_shortcut(upscale)

    def test_batch_file_uses_exact_crlf_line_endings(self, tmp_path):
        batch_path = tmp_path / "Tuck.bat"
        _write_batch_file(batch_path, r"C:\Tuck\Tuck.exe", ["--sendto-files"])
        content = batch_path.read_bytes()
        assert b"\r\r\n" not in content
        assert content.startswith(b"@echo off\r\nREM TUCK_OWNER_V1\r\n")

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

    def test_install_rejects_foreign_collision_for_its_kind_only(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: sys.executable)
        foreign_path = tmp_path / SENDTO_COMPRESS_BATCH_NAME
        _make_foreign_bat(foreign_path)
        original = foreign_path.read_bytes()

        with pytest.raises(FileExistsError, match=SENDTO_COMPRESS_BATCH_NAME):
            install_generic_shortcut("compress")

        assert foreign_path.read_bytes() == original
        # another kind installs fine next to the foreign file
        assert install_generic_shortcut("open").name == SENDTO_BATCH_NAME
        assert foreign_path.read_bytes() == original

    def test_uninstall_one_kind_leaves_the_others(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        _make_marker_bat(tmp_path / SENDTO_BATCH_NAME)
        _make_marker_bat(tmp_path / SENDTO_COMPRESS_BATCH_NAME)
        _make_foreign_bat(tmp_path / "Tuck Upscale.bat")

        assert uninstall_generic_shortcut("compress") is True
        assert uninstall_generic_shortcut("upscale") is False
        assert uninstall_generic_shortcut("cut") is False

        assert {path.name for path in tmp_path.iterdir()} == {
            SENDTO_BATCH_NAME,
            "Tuck Upscale.bat",
        }

    def test_uninstall_all_generic_kinds_keeps_profiles(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        for name in ("Tuck.bat", "Tuck Compress.bat", "Tuck Upscale.bat", "Tuck Lossless Cut.bat"):
            _make_marker_bat(tmp_path / name)
        profile = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}keep.bat"
        _make_marker_bat(profile)

        uninstall_sendto()

        assert list(tmp_path.iterdir()) == [profile]


class TestRepairGenericShortcuts:
    def test_source_review_repair_reports_unsupported_target(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", False, raising=False)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
        monkeypatch.setattr("tuck.sendto._is_tuck_shortcut", lambda path: True)
        shortcut = tmp_path / SENDTO_SHORTCUT_NAME
        shortcut.write_bytes(_SHELL_LINK_HEADER)

        with pytest.raises(RuntimeError, match="desktop app"):
            repair_generic_shortcut("open")

        assert shortcut.read_bytes() == _SHELL_LINK_HEADER

    def test_missing_kind_does_not_need_repair(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

        assert repair_generic_shortcut("upscale") is False
        assert list(tmp_path.iterdir()) == []

    def test_repairs_owned_batch_for_its_kind_only(self, tmp_path, monkeypatch):
        monkeypatch.setattr("sys.frozen", True, raising=False)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: r"C:\New\TuckCli.exe")
        stale = tmp_path / "Tuck Upscale.bat"
        _write_batch_file(stale, r"C:\Old\TuckCli.exe", ["--sendto-files"])
        other = tmp_path / SENDTO_COMPRESS_BATCH_NAME
        _write_batch_file(other, r"C:\Old\TuckCli.exe", ["--sendto-files"])
        other_before = other.read_bytes()

        assert repair_generic_shortcut("upscale") is True
        content = stale.read_text()
        assert r"C:\New\TuckCli.exe" in content
        assert "--sendto-task upscale" in content
        assert repair_generic_shortcut("upscale") is False
        assert other.read_bytes() == other_before

    @requires_windows_com
    def test_repairs_legacy_shortcut_into_open_shortcut(self, tmp_path, monkeypatch):
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

        assert repair_generic_shortcut("open")
        repaired = shell.shortcuts[str(legacy_path)]
        assert repaired.Arguments == "--sendto-action review --sendto-files"
        assert repaired.Description == f"{_TUCK_MARKER}|generic-open|Open in Tuck"
        assert not (tmp_path / SENDTO_COMPRESS_SHORTCUT_NAME).exists()

    @requires_windows_com
    def test_repair_leaves_a_foreign_shortcut_of_another_kind_alone(self, tmp_path, monkeypatch):
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

        assert repair_generic_shortcut("open")
        assert repair_generic_shortcut("compress") is False
        assert shell.shortcuts[str(foreign_path)].Arguments == "--foreign-action"
        assert foreign_path.read_bytes() == _SHELL_LINK_HEADER


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


class TestUninstallProfileRemovesBatch:
    def test_removes_owned_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        bat_path = tmp_path / "Tuck - My Profile.bat"
        _make_marker_bat(bat_path, profile_id="my-profile")
        assert bat_path.exists()
        removed = uninstall_profile_shortcut("my-profile")
        assert removed
        assert not bat_path.exists()

    def test_keeps_unowned_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        bat_path = tmp_path / "Tuck - my-profile.bat"
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
        lnk_path = tmp_path / "Tuck - my-profile.lnk"
        lnk_path.write_text("tuck")
        _fake_profile_links(monkeypatch, {lnk_path: "my-profile"})
        assert lnk_path.exists()
        removed = uninstall_profile_shortcut("my-profile")
        assert removed
        assert not lnk_path.exists()

    def test_removes_both_lnk_and_bat(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        lnk_path = tmp_path / "Tuck - My Profile.lnk"
        bat_path = tmp_path / "Tuck - my-profile.bat"
        other_path = tmp_path / "Tuck - Other.bat"
        lnk_path.write_text("tuck")
        _fake_profile_links(monkeypatch, {lnk_path: "my-profile"})
        _make_marker_bat(bat_path, profile_id="my-profile")
        _make_marker_bat(other_path, profile_id="other")
        removed = uninstall_profile_shortcut("my-profile")
        assert removed
        assert not lnk_path.exists()
        assert not bat_path.exists()
        assert other_path.exists()


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

        bat_path = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}ToDelete.bat"
        _make_marker_bat(bat_path, profile_id="to-delete-bat")
        resp = api.delete_profile("to-delete-bat")
        assert resp["ok"]
        assert not bat_path.exists()

    def test_delete_profile_removes_owned_lnk(self, tmp_path, monkeypatch):
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
        custom = Profile(name="ToDeleteLnk", profile_id="to-delete-lnk")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        lnk_path = tmp_path / f"{PROFILE_SHORTCUT_PREFIX}to-delete-lnk.lnk"
        lnk_path.write_text("tuck")
        _fake_profile_links(monkeypatch, {lnk_path: "to-delete-lnk"})
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

        resp = api.remove_generic_sendto("open")
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
        resp = api.remove_generic_sendto("open")
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

        resp = api.remove_generic_sendto("open")
        assert resp["ok"]

        assert not owned_lnk.exists()

        assert foreign_lnk.exists()


NEW_TARGET = r"C:\New\TuckCli.exe"


def _profile_bat_mode(monkeypatch, sendto: Path) -> None:
    monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: sendto)
    monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
    monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: NEW_TARGET)


def _legacy_profile_bat(path: Path, profile_id: str, target: str = r"C:\Old\TuckCli.exe") -> None:
    # older installs named the file after the id and left the id out of the marker
    _write_batch_file(path, target, _get_args(for_profile=profile_id))


class TestProfileShortcutNames:
    def test_uses_the_profile_name_then_adds_the_id(self):
        assert profile_shortcut_stems("my-profile", "Discord Free - 20MB") == (
            "Tuck - Discord Free - 20MB",
            "Tuck - Discord Free - 20MB (my-profile)",
        )

    def test_characters_windows_rejects_become_spaces(self):
        stem = profile_shortcut_stems("p", 'Clips: 1080p/60 "fast" <best>|a\\b?*')[0]
        assert stem == "Tuck - Clips 1080p 60 fast best a b"

    def test_control_characters_and_extra_spaces_are_removed(self):
        assert profile_shortcut_stems("p", "  One\ttwo\x01three  ")[0] == "Tuck - One two three"

    def test_trailing_dots_and_spaces_are_removed(self):
        assert profile_shortcut_stems("p", "Final cut.. . ")[0] == "Tuck - Final cut"

    @pytest.mark.parametrize("name", ["CON", "nul", "LPT1", "com9.mp4"])
    def test_device_names_are_safe_behind_the_prefix(self, name):
        assert profile_shortcut_stems("p", name)[0] == f"Tuck - {name}"

    @pytest.mark.parametrize("name", ["???", "...", "  ", '<>:"/\\|?*'])
    def test_a_name_with_nothing_usable_falls_back_to_the_id(self, name):
        assert profile_shortcut_stems("my-profile", name) == ("Tuck - my-profile",)

    def test_long_names_are_capped(self):
        assert profile_shortcut_stems("p", "a" * 120)[0] == "Tuck - " + "a" * 80
        # a cut that lands on a space does not leave a trailing space
        assert profile_shortcut_stems("p", "a" * 79 + " bcd")[0] == "Tuck - " + "a" * 79


class TestProfileShortcutFiles:
    def test_install_names_the_shortcut_after_the_profile(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)

        result = install_profile_shortcut("my-profile", "My Profile")

        assert result == tmp_path / "Tuck - My Profile.bat"
        content = result.read_bytes()
        assert f"REM {_TUCK_MARKER}|profile|my-profile\r\n".encode() in content
        assert b"--profile-id my-profile" in content
        assert [entry["name"] for entry in list_sendto_shortcuts()] == ["Tuck - My Profile"]

    def test_reinstall_keeps_a_single_file(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)

        install_profile_shortcut("my-profile", "My Profile")
        install_profile_shortcut("my-profile", "My Profile")

        assert [path.name for path in tmp_path.iterdir()] == ["Tuck - My Profile.bat"]

    def test_foreign_file_with_the_name_moves_the_shortcut_to_the_id_name(
        self, tmp_path, monkeypatch
    ):
        _profile_bat_mode(monkeypatch, tmp_path)
        foreign = tmp_path / "Tuck - My Profile.bat"
        _make_foreign_bat(foreign)
        before = foreign.read_bytes()

        result = install_profile_shortcut("my-profile", "My Profile")

        assert result.name == "Tuck - My Profile (my-profile).bat"
        assert foreign.read_bytes() == before

    def test_a_link_with_the_name_also_blocks_it(self, tmp_path, monkeypatch):
        # Explorer hides extensions, so both files would show the same name
        _profile_bat_mode(monkeypatch, tmp_path)
        (tmp_path / "Tuck - My Profile.lnk").write_text("someone else's link")

        result = install_profile_shortcut("my-profile", "My Profile")

        assert result.name == "Tuck - My Profile (my-profile).bat"

    def test_another_profiles_shortcut_keeps_its_name(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        other = install_profile_shortcut("other", "Clips")
        other_before = other.read_bytes()

        result = install_profile_shortcut("mine", "Clips")

        assert result.name == "Tuck - Clips (mine).bat"
        assert other.read_bytes() == other_before
        assert {entry["profile_id"]: entry["name"] for entry in list_sendto_shortcuts()} == {
            "other": "Tuck - Clips",
            "mine": "Tuck - Clips (mine)",
        }

    def test_install_refuses_when_both_names_are_taken(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        _make_foreign_bat(tmp_path / "Tuck - My Profile.bat")
        _make_foreign_bat(tmp_path / "Tuck - My Profile (my-profile).bat")

        with pytest.raises(FileExistsError, match='named "Tuck - My Profile"'):
            install_profile_shortcut("my-profile", "My Profile")

        assert len(list(tmp_path.iterdir())) == 2
        assert list_sendto_shortcuts() == []

    def test_install_replaces_a_legacy_id_named_shortcut(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        _legacy_profile_bat(tmp_path / "Tuck - my-profile.bat", "my-profile")

        install_profile_shortcut("my-profile", "My Profile")

        assert [path.name for path in tmp_path.iterdir()] == ["Tuck - My Profile.bat"]

    def test_legacy_shortcut_is_listed_and_removed_by_id(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        legacy = tmp_path / "Tuck - my-profile.bat"
        _legacy_profile_bat(legacy, "my-profile")

        assert list_sendto_shortcuts() == [
            {
                "name": "Tuck - my-profile",
                "profile_id": "my-profile",
                "path": str(legacy),
                "type": "profile",
                "status": "ok",
            }
        ]
        assert uninstall_profile_shortcut("other-profile") is False
        assert uninstall_profile_shortcut("my-profile") is True
        assert not legacy.exists()

    def test_repair_renames_a_legacy_shortcut(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        _legacy_profile_bat(tmp_path / "Tuck - my-profile.bat", "my-profile")

        assert repair_profile_shortcut("my-profile", "My Profile") is True

        repaired = tmp_path / "Tuck - My Profile.bat"
        assert list(tmp_path.iterdir()) == [repaired]
        assert repaired.read_bytes() == _batch_content(
            NEW_TARGET,
            _get_args(for_profile="my-profile"),
            marker_type="profile",
            profile_id="my-profile",
        )
        assert repair_profile_shortcut("my-profile", "My Profile") is False

    def test_repair_does_nothing_without_a_shortcut(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)

        assert repair_profile_shortcut("my-profile", "My Profile") is False
        assert list(tmp_path.iterdir()) == []

    def test_repair_refuses_when_both_names_are_taken(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        legacy = tmp_path / "Tuck - my-profile.bat"
        _legacy_profile_bat(legacy, "my-profile")
        before = legacy.read_bytes()
        _make_foreign_bat(tmp_path / "Tuck - My Profile.bat")
        _make_foreign_bat(tmp_path / "Tuck - My Profile (my-profile).bat")

        with pytest.raises(FileExistsError):
            repair_profile_shortcut("my-profile", "My Profile")

        assert legacy.read_bytes() == before

    def test_rename_moves_the_file_and_keeps_its_target(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        legacy = tmp_path / "Tuck - my-profile.bat"
        _legacy_profile_bat(legacy, "my-profile")
        before = legacy.read_bytes()

        assert rename_profile_shortcut("my-profile", "Renamed") is True

        renamed = tmp_path / "Tuck - Renamed.bat"
        assert list(tmp_path.iterdir()) == [renamed]
        assert renamed.read_bytes() == before
        assert rename_profile_shortcut("my-profile", "Renamed") is False

    def test_rename_follows_a_change_in_letter_case(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        install_profile_shortcut("clip-id", "clip")

        assert rename_profile_shortcut("clip-id", "Clip") is True

        assert [path.name for path in tmp_path.iterdir()] == ["Tuck - Clip.bat"]

    def test_rename_drops_a_duplicate_from_an_older_install(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        current = install_profile_shortcut("my-profile", "Renamed")
        current_bytes = current.read_bytes()
        _legacy_profile_bat(tmp_path / "Tuck - my-profile.bat", "my-profile")

        assert rename_profile_shortcut("my-profile", "Renamed") is True

        assert list(tmp_path.iterdir()) == [current]
        assert current.read_bytes() == current_bytes

    def test_rename_without_a_shortcut_does_nothing(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        _make_foreign_bat(tmp_path / "Tuck - my-profile.bat")

        assert rename_profile_shortcut("my-profile", "Renamed") is False
        assert [path.name for path in tmp_path.iterdir()] == ["Tuck - my-profile.bat"]

    def test_profile_shortcuts_are_refused_on_linux(self, tmp_path, monkeypatch):
        _profile_bat_mode(monkeypatch, tmp_path)
        monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")

        for call in (
            lambda: install_profile_shortcut("my-profile", "My Profile"),
            lambda: rename_profile_shortcut("my-profile", "My Profile"),
            lambda: repair_profile_shortcut("my-profile", "My Profile"),
        ):
            with pytest.raises(OSError, match="only available on Windows"):
                call()
        assert list(tmp_path.iterdir()) == []


class _FileBackedLink:
    """Stands in for a WScript shortcut and keeps its fields in the file itself."""

    def __init__(self, path: Path):
        self._path = path
        fields = {}
        if path.is_file():
            data = path.read_bytes()
            if data.startswith(_SHELL_LINK_HEADER):
                fields = json.loads(data[len(_SHELL_LINK_HEADER) :] or b"{}")
        self.TargetPath = fields.get("target", "")
        self.Arguments = fields.get("arguments", "")
        self.WorkingDirectory = fields.get("working_dir", "")
        self.Description = fields.get("description", "")

    def Save(self):  # noqa: N802  # COM interface method
        fields = {
            "target": self.TargetPath,
            "arguments": self.Arguments,
            "working_dir": self.WorkingDirectory,
            "description": self.Description,
        }
        self._path.write_bytes(_SHELL_LINK_HEADER + json.dumps(fields).encode())


class _FileBackedShell:
    def CreateShortCut(self, path):  # noqa: N802  # COM interface method
        return _FileBackedLink(Path(path))


@pytest.fixture
def file_links(tmp_path, monkeypatch):
    monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
    monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: True)
    monkeypatch.setattr("tuck.sendto._get_target_path", lambda *a, **k: NEW_TARGET)
    monkeypatch.setattr("win32com.client.Dispatch", lambda _name: _FileBackedShell())
    return tmp_path


def _write_link(path: Path, target: str, arguments: str, description: str) -> None:
    link = _FileBackedLink(path)
    link.TargetPath = target
    link.Arguments = arguments
    link.Description = description
    link.Save()


@requires_windows_com
class TestProfileShortcutLinks:
    def test_compression_and_upscale_profiles_get_their_own_description(self, file_links):
        compress = install_profile_shortcut("small", "Small")
        upscale = install_profile_shortcut("big", "Big", workflow="upscale")

        assert compress == file_links / "Tuck - Small.lnk"
        assert _FileBackedLink(compress).Description == (
            f"{_TUCK_MARKER}|profile|small|Compress with Tuck (Small)"
        )
        assert _FileBackedLink(upscale).Description == (
            f"{_TUCK_MARKER}|profile|big|Upscale with Tuck (Big)"
        )
        assert {entry["profile_id"]: entry["name"] for entry in list_sendto_shortcuts()} == {
            "big": "Tuck - Big",
            "small": "Tuck - Small",
        }

    def test_installing_a_link_removes_the_batch_fallback(self, file_links):
        _legacy_profile_bat(file_links / "Tuck - my-profile.bat", "my-profile")

        result = install_profile_shortcut("my-profile", "My Profile")

        assert list(file_links.iterdir()) == [result]
        assert result.name == "Tuck - My Profile.lnk"

    def test_repair_renames_a_legacy_link_and_fixes_it(self, file_links):
        legacy = file_links / "Tuck - my-profile.lnk"
        _write_link(
            legacy,
            r"C:\Old\TuckCli.exe",
            "--profile-id my-profile --sendto-action start --sendto-files",
            f"{_TUCK_MARKER}|profile|my-profile|Compress with Tuck (Old name)",
        )

        assert repair_profile_shortcut("my-profile", "Sharp", workflow="upscale") is True

        repaired = file_links / "Tuck - Sharp.lnk"
        assert list(file_links.iterdir()) == [repaired]
        link = _FileBackedLink(repaired)
        assert link.TargetPath == NEW_TARGET
        assert link.Description == f"{_TUCK_MARKER}|profile|my-profile|Upscale with Tuck (Sharp)"
        assert repair_profile_shortcut("my-profile", "Sharp", workflow="upscale") is False

    def test_rename_updates_the_description_and_keeps_the_target(self, file_links):
        legacy = file_links / "Tuck - my-profile.lnk"
        _write_link(
            legacy,
            r"C:\Old\TuckCli.exe",
            "--profile-id my-profile --sendto-action start --sendto-files",
            f"{_TUCK_MARKER}|profile|my-profile|Compress with Tuck (Old name)",
        )

        assert rename_profile_shortcut("my-profile", "New name") is True

        renamed = file_links / "Tuck - New name.lnk"
        assert list(file_links.iterdir()) == [renamed]
        link = _FileBackedLink(renamed)
        assert link.TargetPath == r"C:\Old\TuckCli.exe"
        assert link.Description == (
            f"{_TUCK_MARKER}|profile|my-profile|Compress with Tuck (New name)"
        )
        assert rename_profile_shortcut("my-profile", "New name") is False

    def test_bridge_describes_an_upscale_profile_as_upscale(self, file_links, monkeypatch):
        import tuck.settings as settings_mod

        config = file_links / "config"
        config.mkdir()
        monkeypatch.setattr(settings_mod, "_settings_manager", None)
        monkeypatch.setattr(settings_mod, "_config_dir", lambda: config)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: config)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: config)
        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        resp = api.install_profile_sendto("4k-upscale")

        assert resp["ok"], resp
        path = Path(resp["path"])
        assert path.name == "Tuck - 4K Upscale (3840x2160).lnk"
        assert _FileBackedLink(path).Description.endswith(
            "|Upscale with Tuck (4K Upscale (3840x2160))"
        )


class TestProfileUpdateRenamesShortcut:
    @staticmethod
    def _api(tmp_path, monkeypatch):
        import tuck.settings as settings_mod
        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        monkeypatch.setattr(settings_mod, "_settings_manager", None)
        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        sendto = tmp_path / "SendTo"
        sendto.mkdir()
        _profile_bat_mode(monkeypatch, sendto)
        api = BridgeAPI()
        profiles = api._settings.get_profiles()
        profiles.append(Profile(name="Clips", profile_id="clips"))
        api._settings.set_profiles(profiles)
        return api, sendto

    def test_renaming_a_profile_renames_its_shortcut(self, tmp_path, monkeypatch):
        api, sendto = self._api(tmp_path, monkeypatch)
        assert api.install_profile_sendto("clips")["ok"]

        assert api.update_profile("clips", {"name": "Short clips"}) == {"ok": True}

        assert [path.name for path in sendto.iterdir()] == ["Tuck - Short clips.bat"]
        assert api.list_sendto_shortcuts()["shortcuts"] == [
            {
                "name": "Tuck - Short clips",
                "profile_id": "clips",
                "path": str(sendto / "Tuck - Short clips.bat"),
                "type": "profile",
                "status": "ok",
            }
        ]
        assert api.delete_profile("clips") == {"ok": True}
        assert list(sendto.iterdir()) == []

    def test_other_changes_leave_the_shortcut_alone(self, tmp_path, monkeypatch):
        api, _ = self._api(tmp_path, monkeypatch)
        calls = []
        monkeypatch.setattr("tuck.sendto.rename_profile_shortcut", lambda *a, **k: calls.append(a))

        assert api.update_profile("clips", {"keep_audio": False}) == {"ok": True}

        assert calls == []

    def test_a_rename_failure_does_not_fail_the_profile_update(self, tmp_path, monkeypatch, caplog):
        api, _ = self._api(tmp_path, monkeypatch)

        def fail(*args, **kwargs):
            raise FileExistsError("taken")

        monkeypatch.setattr("tuck.sendto.rename_profile_shortcut", fail)

        with caplog.at_level(logging.WARNING, logger="tuck.profile_service"):
            assert api.update_profile("clips", {"name": "Taken"}) == {"ok": True}

        profiles = {profile.profile_id: profile.name for profile in api._settings.get_profiles()}
        assert profiles["clips"] == "Taken"
        assert "Could not rename Send To shortcut for profile clips" in caplog.text

    def test_linux_skips_the_shortcut_rename(self, tmp_path, monkeypatch):
        api, _ = self._api(tmp_path, monkeypatch)
        calls = []
        monkeypatch.setattr("tuck.sendto.rename_profile_shortcut", lambda *a, **k: calls.append(a))
        monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")

        assert api.update_profile("clips", {"name": "Renamed"}) == {"ok": True}

        assert calls == []
