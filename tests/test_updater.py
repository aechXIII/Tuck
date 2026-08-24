import json
from unittest.mock import MagicMock, patch

import pytest
from packaging.version import Version

from tuck.updater import (
    GITHUB_REPO_NAME,
    GITHUB_REPO_OWNER,
    UpdateChecker,
    UpdateInfo,
    _sanitize_notes,
    check_for_updates,
)


class TestOwnerAndRepo:
    def test_owner_is_not_placeholder(self):

        assert GITHUB_REPO_OWNER == "aechXIII"
        assert GITHUB_REPO_OWNER != "user"

    def test_repo_is_not_placeholder(self):

        assert GITHUB_REPO_NAME == "Tuck"
        assert GITHUB_REPO_NAME != "tuck"

    def test_no_placeholder_in_pyproject(self):

        pyproject_path = __import__("pathlib").Path(__file__).parent.parent / "pyproject.toml"
        pyproject = pyproject_path.read_text(encoding="utf-8")
        assert "github.com/user/tuck" not in pyproject
        assert "github.com/aechXIII/Tuck" in pyproject


class TestSanitizeNotes:
    def test_strips_html_tags(self):
        result = _sanitize_notes("<p>Hello <b>World</b></p>")
        assert "Hello World" in result
        assert "<p>" not in result
        assert "<b>" not in result

    def test_truncates_long_text(self):
        long_text = "A" * 3000
        result = _sanitize_notes(long_text)
        assert len(result) <= 2000

    def test_handles_empty(self):
        result = _sanitize_notes("")
        assert result == ""

    def test_handles_none_like(self):
        result = _sanitize_notes("   ")
        assert result == ""


class TestUpdateChecker:
    def test_constructor_validates_checksum(self):

        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)
        assert checker._expected_sha256 == valid

    def test_constructor_rejects_invalid_checksum(self):
        with pytest.raises(ValueError, match="must be a 64-hex"):
            UpdateChecker("https://example.com/update.exe", "short")

    def test_constructor_rejects_non_hex(self):
        with pytest.raises(ValueError, match="must be a 64-hex"):
            UpdateChecker("https://example.com/update.exe", "g" * 64)

    def test_get_progress_initial(self):
        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)
        progress = checker.get_progress()
        assert progress["downloading"] is True
        assert progress["progress"] == 0

    def test_get_progress_after_error(self):
        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)
        checker._error = "Test error"
        progress = checker.get_progress()
        assert progress["downloading"] is False
        assert progress["error"] == "Test error"

    def test_cancel(self):
        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)
        checker.cancel()
        assert checker._cancelled is True

    def test_install_without_download(self):
        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)
        with pytest.raises(RuntimeError, match="No update downloaded"):
            checker.install()

    def test_install_missing_file(self, tmp_path):

        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)

        checker._downloaded_path = tmp_path
        with pytest.raises(FileNotFoundError, match="Installer not found"):
            checker.install()

    def test_install_popen_oserror(self, tmp_path):

        valid = "a" * 64
        checker = UpdateChecker("https://example.com/update.exe", valid)

        fake_installer = tmp_path / "fake_installer.exe"
        fake_installer.write_text("not a real exe")
        checker._downloaded_path = fake_installer

        with (
            patch("subprocess.Popen", side_effect=OSError("Cannot execute")),
            pytest.raises(OSError, match="Failed to launch installer"),
        ):
            checker.install()


class TestCheckForUpdates:
    def test_returns_none_on_network_error(self):
        with patch("tuck.updater.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = OSError("Network error")
            result = check_for_updates()
            assert result is None

    def test_returns_none_when_no_releases(self):
        with patch("tuck.updater.urlopen") as mock_urlopen:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps([]).encode()
            mock_urlopen.return_value.__enter__.return_value = mock_resp
            result = check_for_updates()
            assert result is None

    def test_returns_none_when_no_newer_version(self):
        with patch("tuck.updater.urlopen") as mock_urlopen:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps(
                [
                    {
                        "tag_name": "v0.1.0",
                        "draft": False,
                        "prerelease": False,
                        "body": "Old release",
                        "assets": [],
                    }
                ]
            ).encode()
            mock_urlopen.return_value.__enter__.return_value = mock_resp
            result = check_for_updates()
            assert result is None

    def test_skips_releases_without_valid_checksum(self):
        with patch("tuck.updater.urlopen") as mock_urlopen:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps(
                [
                    {
                        "tag_name": "v2.0.0",
                        "draft": False,
                        "prerelease": False,
                        "body": "New release",
                        "assets": [
                            {
                                "name": "Tuck-Setup-2.0.0-x64.exe",
                                "browser_download_url": "https://example.com/installer.exe",
                                "size": 50000000,
                            }
                        ],
                    }
                ]
            ).encode()
            mock_urlopen.return_value.__enter__.return_value = mock_resp
            result = check_for_updates()

            assert result is None

    def test_returns_update_info_with_valid_checksum(self):
        valid_sha = "a" * 64
        with patch("tuck.updater.urlopen") as mock_urlopen:
            mock_releases = MagicMock()
            mock_releases.read.return_value = json.dumps(
                [
                    {
                        "tag_name": "v2.0.0",
                        "draft": False,
                        "prerelease": False,
                        "body": "## New features\n\n- Feature 1",
                        "assets": [
                            {
                                "name": "Tuck-Setup-2.0.0-x64.exe",
                                "browser_download_url": "https://example.com/installer.exe",
                                "size": 50000000,
                            },
                            {
                                "name": "Tuck-Setup-2.0.0-x64.exe.sha256",
                                "browser_download_url": "https://example.com/installer.exe.sha256",
                            },
                        ],
                    }
                ]
            ).encode()

            mock_checksum = MagicMock()
            mock_checksum.read.return_value = f"{valid_sha} *Tuck-Setup-2.0.0-x64.exe".encode()

            mock_urlopen.return_value.__enter__.side_effect = [mock_releases, mock_checksum]

            result = check_for_updates()
            assert result is not None
            assert result.checksum == valid_sha
            assert result.version == Version("2.0.0")
            assert result.notes == "## New features\n\n- Feature 1"
            assert result.file_size == 50000000

    def test_skips_checksum_with_invalid_hash(self):
        with patch("tuck.updater.urlopen") as mock_urlopen:
            mock_releases = MagicMock()
            mock_releases.read.return_value = json.dumps(
                [
                    {
                        "tag_name": "v2.0.0",
                        "draft": False,
                        "prerelease": False,
                        "body": "Release",
                        "assets": [
                            {
                                "name": "Tuck-Setup-2.0.0-x64.exe",
                                "browser_download_url": "https://example.com/installer.exe",
                                "size": 50000000,
                            },
                            {
                                "name": "Tuck-Setup-2.0.0-x64.exe.sha256",
                                "browser_download_url": "https://example.com/installer.exe.sha256",
                            },
                        ],
                    }
                ]
            ).encode()

            mock_checksum = MagicMock()
            mock_checksum.read.return_value = b"not-a-valid-hash"

            mock_urlopen.return_value.__enter__.side_effect = [mock_releases, mock_checksum]

            result = check_for_updates()

            assert result is None


class TestUpdateInfo:
    def test_update_info_creation(self):
        info = UpdateInfo(
            version=Version("2.0.0"),
            notes="Release notes",
            download_url="https://example.com/installer.exe",
            file_size=50000000,
            checksum="a" * 64,
        )
        assert info.version == Version("2.0.0")
        assert info.notes == "Release notes"
        assert info.file_size == 50000000
        assert info.checksum == "a" * 64


class TestBridgeUpdateCheckConcurrency:
    def test_concurrent_check_returns_busy(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()

        api._checking_updates = True

        result = api.check_for_updates()
        assert not result["available"]
        assert "already in progress" in result["error"]

    def test_check_clears_guard_on_success(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        assert not api._checking_updates

        with patch("tuck.bridge._check_for_updates", return_value=None):
            api.check_for_updates()

        assert not api._checking_updates

    def test_check_clears_guard_on_exception(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        assert not api._checking_updates

        with patch("tuck.bridge._check_for_updates", side_effect=RuntimeError("boom")):
            result = api.check_for_updates()

        assert not result["available"]
        assert result.get("error") == "boom"

        assert not api._checking_updates
