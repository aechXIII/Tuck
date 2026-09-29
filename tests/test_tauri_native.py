"""Test native desktop services and explicit Send To targets."""

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
    _validate_executable_path,
    install_generic_shortcut,
    install_profile_shortcut,
    repair_generic_shortcut,
    repair_profile_shortcut,
)


class TestValidateExecutablePath:
    def test_valid_absolute_tuck_path(self, tmp_path):
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        # Should validate without error
        result = _validate_executable_path(str(exe))
        assert result == str(exe)

    def test_valid_python_path(self, tmp_path):
        exe = tmp_path / "python.exe"
        exe.write_text("dummy")
        result = _validate_executable_path(str(exe))
        assert result == str(exe)

    def test_empty_rejected(self):
        with pytest.raises(ValueError, match="non-empty"):
            _validate_executable_path("")

    def test_none_returns_empty(self):
        assert _validate_executable_path(None) == ""

    def test_relative_rejected(self):
        with pytest.raises(ValueError, match="absolute"):
            _validate_executable_path("relative/Tuck.exe")

    def test_parent_missing_rejected(self, tmp_path):
        bad = tmp_path / "nope" / "Tuck.exe"
        with pytest.raises(ValueError, match="parent does not exist"):
            _validate_executable_path(str(bad))

    def test_non_tuck_name_rejected(self, tmp_path):
        exe = tmp_path / "notvalid.exe"
        exe.write_text("dummy")
        with pytest.raises(ValueError, match="does not look like"):
            _validate_executable_path(str(exe))

    def test_null_byte_rejected(self, tmp_path):
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        with pytest.raises(ValueError, match="invalid characters"):
            _validate_executable_path(str(exe) + "\x00")


class TestInstallSendtoExplicit:
    def test_install_uses_explicit_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        # Also need to ensure parent exists for validation
        result = install_generic_shortcut("open", executable_path=str(exe))
        assert result.exists()
        content = result.read_text()
        assert str(exe) in content
        assert "TUCK_OWNER_V1" in content

    def test_install_rejects_invalid_explicit_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        with pytest.raises(ValueError):
            install_generic_shortcut("open", executable_path="relative/path.exe")

    def test_install_rejects_non_absolute(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        with pytest.raises(ValueError):
            install_generic_shortcut("open", executable_path="not-absolute.exe")

    def test_install_profile_uses_explicit_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        result = install_profile_shortcut("my-profile", "My Profile", executable_path=str(exe))
        assert result.exists()
        content = result.read_text()
        assert str(exe) in content

    def test_repair_rejects_invalid_explicit_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        # repair should return False on invalid path, not raise
        result = repair_generic_shortcut("open", executable_path="bad/relative.exe")
        assert result is False

    def test_repair_profile_rejects_invalid(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        # Create a batch to trigger batch path
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        batch = tmp_path / "Tuck - my-profile.bat"
        batch.write_text(
            "@echo off\r\nREM TUCK_OWNER_V1\r\necho --profile-id my-profile --sendto-files %*\r\n"
        )
        before = batch.read_bytes()
        # Now repair with invalid path should return False
        result = repair_profile_shortcut("my-profile", "My Profile", executable_path="bad.exe")
        assert result is False
        # a bad target leaves the old shortcut exactly as it was
        assert sorted(path.name for path in tmp_path.iterdir()) == [batch.name, exe.name]
        assert batch.read_bytes() == before


class TestBridgeExplicitSendTo:
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

    def test_bridge_install_generic_uses_explicit(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

        from tuck.bridge import BridgeAPI

        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        api = BridgeAPI()
        result = api.install_generic_sendto("cut", executable_path=str(exe))
        assert result["ok"] is True
        assert result["kind"] == "cut"
        content = (tmp_path / "Tuck Lossless Cut.bat").read_text()
        assert "--sendto-action review --sendto-task cut --sendto-files" in content

    def test_bridge_rejects_unknown_kind(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        for method in (api.install_generic_sendto, api.remove_generic_sendto):
            result = method("trim")
            assert result == {
                "ok": False,
                "error": "Send To shortcut kind must be open, compress, upscale, or cut.",
            }
        assert api.repair_generic_sendto(None)["ok"] is False
        assert list(tmp_path.glob("*.bat")) == []

    def test_bridge_repair_generic_reports_each_kind(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

        from tuck.bridge import BridgeAPI

        exe = tmp_path / "TuckCli.exe"
        exe.write_text("dummy")
        api = BridgeAPI()
        assert api.repair_generic_sendto("upscale") == {
            "ok": True,
            "kind": "upscale",
            "repaired": False,
        }
        assert api.install_generic_sendto("upscale", executable_path=str(exe))["ok"]
        other = tmp_path / "Other" / "TuckCli.exe"
        other.parent.mkdir()
        other.write_text("dummy")
        assert api.repair_generic_sendto("upscale", executable_path=str(other)) == {
            "ok": True,
            "kind": "upscale",
            "repaired": True,
        }
        assert api.remove_generic_sendto("upscale") == {
            "ok": True,
            "kind": "upscale",
            "removed": True,
        }

    def test_bridge_install_generic_rejects_invalid(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        result = api.install_generic_sendto("open", executable_path="relative.exe")
        assert result["ok"] is False
        assert "absolute" in result["error"].lower() or "invalid" in result["error"].lower()

    def test_sidecar_handler_accepts_explicit(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        api = BridgeAPI()
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        req = Request(
            request_id="test-1",
            method="install_generic_sendto",
            params={"kind": "upscale", "executable_path": str(exe)},
        )
        resp = dispatch(api, req)
        assert resp.ok is True
        assert (tmp_path / "Tuck Upscale.bat").exists()

    def test_sidecar_handler_rejects_bad_type(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        api = BridgeAPI()
        req = Request(
            request_id="test-2",
            method="install_generic_sendto",
            params={"kind": "open", "executable_path": 123},
        )
        resp = dispatch(api, req)
        assert resp.ok is False
        assert resp.error.code == "INVALID_REQUEST"

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
        ],
    )
    def test_sidecar_generic_handlers_allowlist_kind(self, method, params, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.sidecar.handlers import dispatch
        from tuck.sidecar.protocol import Request

        resp = dispatch(BridgeAPI(), Request(request_id="kind", method=method, params=params))
        assert resp.ok is False
        assert resp.error.code == "INVALID_REQUEST"

    def test_sidecar_repair_and_remove_generic(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)

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
