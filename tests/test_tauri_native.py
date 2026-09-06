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
    install_profile_shortcut,
    install_sendto,
    repair_profile_shortcut,
    repair_sendto,
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
        result = install_sendto(executable_path=str(exe))
        assert result.exists()
        content = result.read_text()
        assert str(exe) in content
        assert "TUCK_OWNER_V1" in content

    def test_install_rejects_invalid_explicit_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        with pytest.raises(ValueError):
            install_sendto(executable_path="relative/path.exe")

    def test_install_rejects_non_absolute(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        with pytest.raises(ValueError):
            install_sendto(executable_path="not-absolute.exe")

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
        result = repair_sendto(executable_path="bad/relative.exe")
        assert result is False

    def test_repair_profile_rejects_invalid(self, tmp_path, monkeypatch):
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._can_create_shortcuts", lambda: False)
        # Create a batch to trigger batch path
        exe = tmp_path / "Tuck.exe"
        exe.write_text("dummy")
        batch = tmp_path / "Tuck - my-profile.bat"
        batch.write_text("@echo off\r\nREM TUCK_OWNER_V1\r\necho --sendto-files %*\r\n")
        # Now repair with invalid path should return False
        result = repair_profile_shortcut("my-profile", "My Profile", executable_path="bad.exe")
        assert result is False


class TestBridgeExplicitSendTo:
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
        result = api.install_generic_sendto(executable_path=str(exe))
        assert result["ok"] is True

    def test_bridge_install_generic_rejects_invalid(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        result = api.install_generic_sendto(executable_path="relative.exe")
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
            params={"executable_path": str(exe)},
        )
        resp = dispatch(api, req)
        assert resp.ok is True

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
            request_id="test-2", method="install_generic_sendto", params={"executable_path": 123}
        )
        resp = dispatch(api, req)
        assert resp.ok is False
        assert resp.error.code == "INVALID_REQUEST"
