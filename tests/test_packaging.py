"""Packaging resource-resolution behavior.

These protect the contract that a packaged Tuck honors an explicit valid tool
choice, otherwise uses its verified bundle before machine-wide discovery.
Build-artifact inspection lives in ``scripts/verify_package.py``; this file
covers the pure resolution logic that both the sidecar and the CLI depend on.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

import tuck.media_tools as media_tools
import tuck.packaged as packaged

_REPO = Path(__file__).resolve().parent.parent
_LOCK = _REPO / "packaging" / "ffmpeg-sources.lock.json"
_STAGING_MANIFEST = _REPO / "packaging" / "staging" / "manifest.json"
_WEBVIEW2_LOCK = _REPO / "packaging" / "webview2-bootstrapper.lock.json"
_VERIFY_PACKAGE = _REPO / "scripts" / "verify_package.py"


class _Settings:
    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get_setting(self, key: str, default: str = "") -> str:
        return self._values.get(key, default)


def _make_tool(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    tool = directory / f"{name}.exe"
    tool.write_bytes(b"MZ")
    return tool


def _verify_package_module():
    spec = importlib.util.spec_from_file_location("verify_package_for_test", _VERIFY_PACKAGE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_explicit_env_path_is_used_when_it_exists(tmp_path: Path, monkeypatch) -> None:
    ffmpeg = _make_tool(tmp_path / "tools", "ffmpeg")
    monkeypatch.setenv(packaged.FFMPEG_ENV, str(ffmpeg))

    assert packaged.bundled_media_tool("ffmpeg") == ffmpeg


def test_explicit_env_path_is_ignored_when_missing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(packaged.FFPROBE_ENV, str(tmp_path / "nope" / "ffprobe.exe"))
    monkeypatch.delenv(packaged.TOOLS_DIR_ENV, raising=False)
    monkeypatch.setattr(packaged, "is_frozen", lambda: False)

    assert packaged.bundled_media_tool("ffprobe") is None


def test_tools_dir_env_resolves_each_tool(tmp_path: Path, monkeypatch) -> None:
    tools = tmp_path / "with space" / "ünïcode"
    ffmpeg = _make_tool(tools, "ffmpeg")
    ffprobe = _make_tool(tools, "ffprobe")
    monkeypatch.delenv(packaged.FFMPEG_ENV, raising=False)
    monkeypatch.delenv(packaged.FFPROBE_ENV, raising=False)
    monkeypatch.setenv(packaged.TOOLS_DIR_ENV, str(tools))

    assert packaged.bundled_media_tool("ffmpeg") == ffmpeg
    assert packaged.bundled_media_tool("ffprobe") == ffprobe


def test_unbundled_checkout_returns_none(monkeypatch) -> None:
    monkeypatch.delenv(packaged.FFMPEG_ENV, raising=False)
    monkeypatch.delenv(packaged.FFPROBE_ENV, raising=False)
    monkeypatch.delenv(packaged.TOOLS_DIR_ENV, raising=False)
    monkeypatch.setattr(packaged, "is_frozen", lambda: False)

    assert packaged.bundled_media_tool("ffmpeg") is None


def test_frozen_layout_finds_tools_next_to_executable(tmp_path: Path, monkeypatch) -> None:
    install = tmp_path / "Program Files" / "Tuck"
    ffmpeg = _make_tool(install / "ffmpeg", "ffmpeg")
    monkeypatch.delenv(packaged.FFMPEG_ENV, raising=False)
    monkeypatch.delenv(packaged.TOOLS_DIR_ENV, raising=False)
    monkeypatch.setattr(packaged, "is_frozen", lambda: True)
    monkeypatch.setattr(packaged, "executable_dir", lambda: install)

    assert packaged.bundled_media_tool("ffmpeg") == ffmpeg


def test_unknown_tool_name_is_rejected() -> None:
    with pytest.raises(ValueError):
        packaged.bundled_media_tool("mplayer")


def test_configured_tool_beats_bundled_and_path(tmp_path: Path, monkeypatch) -> None:
    bundled = _make_tool(tmp_path / "bundle", "ffmpeg")
    configured = _make_tool(tmp_path / "user", "ffmpeg")
    monkeypatch.setattr(media_tools, "bundled_media_tool", lambda name: bundled)
    monkeypatch.setattr(
        media_tools, "get_settings_manager", lambda: _Settings({"ffmpeg_path": str(configured)})
    )
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: pytest.fail(f"PATH consulted for {name} despite a configured tool"),
    )

    assert media_tools.find_ffmpeg() == str(configured)


def test_configured_path_used_when_not_bundled(tmp_path: Path, monkeypatch) -> None:
    configured = _make_tool(tmp_path / "user", "ffprobe")
    monkeypatch.setattr(media_tools, "bundled_media_tool", lambda name: None)
    monkeypatch.setattr(
        media_tools, "get_settings_manager", lambda: _Settings({"ffprobe_path": str(configured)})
    )
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: pytest.fail("PATH consulted despite a valid configured path"),
    )

    assert media_tools.find_ffprobe() == str(configured)


def test_path_discovery_is_last_resort(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(media_tools, "bundled_media_tool", lambda name: None)
    monkeypatch.setattr(media_tools, "get_settings_manager", lambda: _Settings({}))
    monkeypatch.setattr(media_tools.shutil, "which", lambda name: str(tmp_path / f"{name}.exe"))

    assert media_tools.find_ffmpeg() == str(tmp_path / "ffmpeg.exe")


def test_ffmpeg_lock_is_complete_and_redistributable() -> None:
    lock = json.loads(_LOCK.read_text(encoding="utf-8"))

    assert lock["lockfile_version"] == 1
    assert lock["license"]["spdx"] == "GPL-3.0-only"
    assert "--enable-nonfree" not in lock["license"]["configure_flags"]
    assert "--enable-gpl" in lock["license"]["configure_flags"]

    archive = lock["archive"]
    assert archive["url"].startswith("https://github.com/GyanD/codexffmpeg/releases/download/")
    assert len(archive["sha256"]) == 64
    assert archive["size_bytes"] > 0

    installed = {member["install_as"]: member for member in lock["members"]}
    assert {"ffmpeg.exe", "ffprobe.exe"} <= set(installed)
    for member in lock["members"]:
        assert len(member["sha256"]) == 64
        assert member["size_bytes"] > 0
    assert "ffplay.exe" not in installed

    assert lock["corresponding_source"]["ffmpeg_release_tarball_url"].endswith(".tar.xz")
    assert len(lock["corresponding_source"]["upstream_commit"]) == 40


def test_webview2_bootstrapper_matches_its_lock() -> None:
    lock = json.loads(_WEBVIEW2_LOCK.read_text(encoding="utf-8"))
    bootstrapper = _REPO / "scripts" / lock["filename"]

    assert bootstrapper.stat().st_size == lock["size_bytes"]
    assert hashlib.sha256(bootstrapper.read_bytes()).hexdigest() == lock["sha256"]


def test_tauri_uses_the_pinned_webview2_bootstrapper_and_app_browser_policy() -> None:
    config = json.loads((_REPO / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    window = config["app"]["windows"][0]
    csp = config["app"]["security"]["csp"]

    assert config["bundle"]["windows"]["webviewInstallMode"]["type"] == "skip"
    assert window["devtools"] is False
    assert window["zoomHotkeysEnabled"] is False
    assert "http://localhost:*" not in csp

    windows_host = (_REPO / "src-tauri" / "src" / "platform" / "windows.rs").read_text(
        encoding="utf-8"
    )
    assert "SetAreDefaultContextMenusEnabled(false)" in windows_host
    assert "SetAreBrowserAcceleratorKeysEnabled(false)" in windows_host


def test_package_verification_times_out_when_a_living_sidecar_is_silent(
    tmp_path, monkeypatch
) -> None:
    verify_package = _verify_package_module()
    real_popen = subprocess.Popen
    monkeypatch.setattr(verify_package, "_SIDECAR_STARTUP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(
        verify_package.subprocess,
        "Popen",
        lambda *_args, **kwargs: real_popen(
            [sys.executable, "-c", "import time; time.sleep(30)"], **kwargs
        ),
    )

    started = time.monotonic()
    with pytest.raises(verify_package.VerifyError, match="did not report readiness"):
        verify_package.start_sidecar(tmp_path)

    assert time.monotonic() - started < 2


needs_staging = pytest.mark.skipif(
    not _STAGING_MANIFEST.is_file(),
    reason="run scripts/build_sidecar.py first (packaging/staging/manifest.json absent)",
)


@needs_staging
def test_staging_tree_passes_verification() -> None:
    result = subprocess.run(
        [sys.executable, str(_REPO / "scripts" / "verify_package.py"), "--staging"],
        capture_output=True,
        text=True,
        cwd=str(_REPO),
        timeout=180,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@needs_staging
@pytest.mark.slow
@pytest.mark.ffmpeg
def test_packaged_backend_smoke() -> None:
    result = subprocess.run(
        [sys.executable, str(_REPO / "scripts" / "smoke_packaged.py"), "--staging"],
        capture_output=True,
        text=True,
        cwd=str(_REPO),
        timeout=600,
    )
    assert result.returncode == 0, result.stdout + result.stderr
