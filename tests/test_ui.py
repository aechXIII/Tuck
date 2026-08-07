from __future__ import annotations

from pathlib import Path


def test_web_ui_is_packaged_source_asset() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "window.pywebview.api" in html
    assert "pywebviewready" in html


def test_web_ui_uses_python_managed_drop_paths() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "postMessageWithAdditionalObjects" not in html
    assert "chrome.webview" not in html


def test_web_ui_forwards_start_metadata_and_releases_old_media_tokens() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "metadata.files = files" in html
    assert "releaseMediaToken(clips[selPath].mediaToken)" in html
    assert "api.closeWindow()" in html


def test_web_ui_starts_if_python_calls_init_after_bridge_injection() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "if (window.pywebview && window.pywebview.api)" in html
    assert "var p = paths[i];" in html


def test_web_ui_allows_manual_target_size_entry() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert 'id="sz-badge" type="number"' in html
    assert "#sz-badge { width:48px;" in html
    assert "color:#c4b5fd;" in html
    assert "function onBadgeSize(v)" in html
    assert "byId('sz-slider').max=Math.max(500,size)" in html


def test_installer_exposes_tuck_command_on_path() -> None:
    installer = Path("scripts/installer.iss").read_text(encoding="utf-8")
    wrapper = Path("scripts/tuck.cmd").read_text(encoding="utf-8")

    assert "ChangesEnvironment=yes" in installer
    assert "procedure AddTuckToPath;" in installer
    assert "procedure RemoveTuckFromPath;" in installer
    assert 'Source: "tuck.cmd"; DestDir: "{app}"' in installer
    assert '"%~dp0TuckCli.exe" %*' in wrapper
