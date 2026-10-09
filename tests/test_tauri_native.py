"""Test native desktop services and natively resolved Send To targets."""

import sys as _sys
import types as _types

if "msvcrt" not in _sys.modules:
    _m = _types.ModuleType("msvcrt")
    _m.locking = lambda *a, **k: None
    _m.LK_NBLCK = 1
    _m.LK_UNLCK = 0
    _sys.modules["msvcrt"] = _m


import pytest

from tuck.sendto import (
    install_generic_shortcut,
    install_profile_shortcut,
    repair_generic_shortcut,
    repair_profile_shortcut,
)


@pytest.fixture
def packaged_install(tmp_path, monkeypatch):
    """Lay out a packaged install and make this process look like its sidecar."""

    install = tmp_path / "Tuck"
    install.mkdir()
    for name in ("Tuck.exe", "TuckCli.exe", "tuck-sidecar.exe"):
        (install / name).write_text("dummy")
    monkeypatch.setattr("sys.frozen", True, raising=False)
    monkeypatch.setattr("sys.executable", str(install / "tuck-sidecar.exe"))
    return install


@pytest.fixture
def sendto_dir(tmp_path, monkeypatch):
    folder = tmp_path / "SendTo"
    folder.mkdir()
    monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: folder)
    monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
    return folder


@pytest.fixture
def isolated_settings(tmp_path, monkeypatch):
    import tuck.settings as settings_mod

    monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
    monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)


class TestNativeSendToTarget:
    def test_editor_shortcut_targets_this_installs_editor(self, packaged_install, sendto_dir):
        result = install_generic_shortcut("open")
        content = result.read_text()
        assert str(packaged_install / "Tuck.exe") in content
        assert "TUCK_OWNER_V1" in content

    def test_compression_profile_targets_this_installs_cli(self, packaged_install, sendto_dir):
        result = install_profile_shortcut("my-profile", "My Profile")
        assert str(packaged_install / "TuckCli.exe") in result.read_text()

    def test_shortcut_functions_take_no_executable_path(self, packaged_install, sendto_dir):
        for call in (
            lambda: install_generic_shortcut("open", executable_path="C:\\evil.exe"),
            lambda: repair_generic_shortcut("open", executable_path="C:\\evil.exe"),
            lambda: install_profile_shortcut("p", "P", executable_path="C:\\evil.exe"),
            lambda: repair_profile_shortcut("p", "P", executable_path="C:\\evil.exe"),
        ):
            with pytest.raises(TypeError):
                call()
        assert list(sendto_dir.iterdir()) == []

    def test_source_checkout_cannot_create_an_editor_shortcut(self, sendto_dir, monkeypatch):
        monkeypatch.delattr("sys.frozen", raising=False)
        with pytest.raises(RuntimeError, match="requires the Tuck desktop app"):
            install_generic_shortcut("open")
        assert list(sendto_dir.iterdir()) == []

    def test_repair_points_a_moved_install_back_at_this_one(
        self, packaged_install, sendto_dir, monkeypatch
    ):
        batch = install_profile_shortcut("my-profile", "My Profile")
        moved = packaged_install.parent / "Moved"
        moved.mkdir()
        for name in ("Tuck.exe", "TuckCli.exe", "tuck-sidecar.exe"):
            (moved / name).write_text("dummy")
        monkeypatch.setattr("sys.executable", str(moved / "tuck-sidecar.exe"))

        assert repair_profile_shortcut("my-profile", "My Profile") is True
        assert str(moved / "TuckCli.exe") in batch.read_text()
        assert repair_profile_shortcut("my-profile", "My Profile") is False

    def test_repair_in_a_source_checkout_leaves_the_shortcut_untouched(
        self, packaged_install, sendto_dir, monkeypatch
    ):
        batch = install_generic_shortcut("open")
        before = batch.read_bytes()
        monkeypatch.delattr("sys.frozen", raising=False)
        with pytest.raises(RuntimeError, match="requires the Tuck desktop app"):
            repair_generic_shortcut("open")
        assert batch.read_bytes() == before


class TestBridgeSendTo:
    def test_sendto_module_rejects_linux(self, monkeypatch):
        monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")

        with pytest.raises(OSError, match="only available on Windows"):
            install_generic_shortcut("open")

    def test_bridge_rejects_sendto_on_linux(self, monkeypatch):
        from tuck.bridge import BridgeAPI

        monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
        api = BridgeAPI.__new__(BridgeAPI)

        assert api.install_generic_sendto("open")["ok"] is False
        assert api.repair_generic_sendto("open")["ok"] is False
        assert api.remove_generic_sendto("open")["ok"] is False

    def test_bridge_install_generic_uses_the_native_target(
        self, isolated_settings, sendto_dir, packaged_install
    ):
        from tuck.bridge import BridgeAPI

        result = BridgeAPI().install_generic_sendto("cut")
        assert result["ok"] is True
        assert result["kind"] == "cut"
        content = (sendto_dir / "Tuck Lossless Cut.bat").read_text()
        assert "--sendto-action review --sendto-task cut --sendto-files" in content
        assert str(packaged_install / "Tuck.exe") in content

    def test_bridge_rejects_unknown_kind(self, isolated_settings, sendto_dir):
        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        for method in (api.install_generic_sendto, api.remove_generic_sendto):
            result = method("trim")
            assert result == {
                "ok": False,
                "error": "Send To shortcut kind must be open, compress, upscale, or cut.",
            }
        assert api.repair_generic_sendto(None)["ok"] is False
        assert list(sendto_dir.glob("*.bat")) == []

    def test_bridge_repair_generic_reports_each_kind(
        self, isolated_settings, sendto_dir, packaged_install, monkeypatch
    ):
        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        assert api.repair_generic_sendto("upscale") == {
            "ok": True,
            "kind": "upscale",
            "repaired": False,
        }
        assert api.install_generic_sendto("upscale")["ok"]
        other = packaged_install.parent / "Other"
        other.mkdir()
        (other / "TuckCli.exe").write_text("dummy")
        monkeypatch.setattr("sys.executable", str(other / "tuck-sidecar.exe"))
        assert api.repair_generic_sendto("upscale") == {
            "ok": True,
            "kind": "upscale",
            "repaired": True,
        }
        assert api.remove_generic_sendto("upscale") == {
            "ok": True,
            "kind": "upscale",
            "removed": True,
        }

    def test_bridge_reports_a_source_checkout_editor_shortcut(
        self, isolated_settings, sendto_dir, monkeypatch
    ):
        from tuck.bridge import BridgeAPI

        monkeypatch.delattr("sys.frozen", raising=False)
        result = BridgeAPI().install_generic_sendto("open")
        assert result["ok"] is False
        assert "requires the Tuck desktop app" in result["error"]

    def test_sidecar_handler_installs_with_the_native_target(
        self, isolated_settings, sendto_dir, packaged_install
    ):
        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        req = Request(
            request_id="test-1",
            method="install_generic_sendto",
            params={"kind": "upscale"},
        )
        resp = dispatch(BridgeAPI(), req)
        assert resp.ok is True
        assert (
            str(packaged_install / "TuckCli.exe") in (sendto_dir / "Tuck Upscale.bat").read_text()
        )

    @pytest.mark.parametrize(
        ("method", "params"),
        [
            ("install_generic_sendto", {"kind": "upscale", "executable_path": "C:\\evil.exe"}),
            ("repair_generic_sendto", {"kind": "open", "executable_path": "C:\\evil.exe"}),
            ("install_profile_sendto", {"profile_id": "p", "executable_path": "C:\\evil.exe"}),
            (
                "repair_profile_sendto",
                {"profile_id": "p", "action": "start", "executable_path": "C:\\evil.exe"},
            ),
        ],
    )
    def test_sidecar_handlers_reject_an_executable_path(
        self, method, params, isolated_settings, sendto_dir
    ):
        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        resp = dispatch(BridgeAPI(), Request(request_id="exe", method=method, params=params))
        assert resp.ok is False
        assert resp.error.code == "INVALID_REQUEST"
        assert list(sendto_dir.iterdir()) == []

    @pytest.mark.parametrize(
        ("method", "params"),
        [
            ("install_generic_sendto", {}),
            ("install_generic_sendto", {"kind": "trim"}),
            ("install_generic_sendto", {"kind": 1}),
            ("install_generic_sendto", {"kind": "open", "extra": True}),
            ("remove_generic_sendto", {}),
            ("remove_generic_sendto", {"kind": "open", "executable_path": "C:\\Tuck.exe"}),
            ("repair_generic_sendto", {"kind": "Open"}),
            ("install_profile_sendto", {"profile_id": 1}),
            ("repair_profile_sendto", {"profile_id": "p", "action": 3}),
        ],
    )
    def test_sidecar_handlers_allowlist_their_parameters(self, method, params, isolated_settings):
        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        resp = dispatch(BridgeAPI(), Request(request_id="kind", method=method, params=params))
        assert resp.ok is False
        assert resp.error.code == "INVALID_REQUEST"

    def test_sidecar_repair_and_remove_generic(self, isolated_settings, sendto_dir):
        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        api = BridgeAPI()
        repair = dispatch(
            api, Request(request_id="r", method="repair_generic_sendto", params={"kind": "cut"})
        )
        remove = dispatch(
            api, Request(request_id="d", method="remove_generic_sendto", params={"kind": "cut"})
        )
        assert repair.ok is True
        assert repair.result == {"kind": "cut", "repaired": False}
        assert remove.ok is True
        assert remove.result == {"kind": "cut", "removed": False}
