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


def test_web_ui_contains_visual_crop_overlay_and_request_state() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")
    crop_js = Path("tuck/web/crop.js").read_text(encoding="utf-8")

    assert 'id="crop-selection"' in html
    assert "event.target.dataset.handle" in crop_js
    assert html.count('class="crop-handle" data-handle=') == 8
    assert '.crop-handle[data-handle="nw"] { left:2px; top:2px;' in html
    assert '.crop-handle[data-handle="se"] { right:2px; bottom:2px;' in html
    assert 'class="player-edit-divider"' in html
    assert 'id="trim-edit-group"' in html
    assert 'id="crop-edit-group"' in html
    assert "cropTransformForRequest(c)" in html
    assert "new ResizeObserver(paintCropOverlay)" in crop_js
    assert "api.createPlan" not in crop_js


def test_web_ui_contains_complete_transform_controls() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")
    crop_js = Path("tuck/web/crop.js").read_text(encoding="utf-8")
    for value in ("free", "16:9", "9:16", "1:1", "4:3"):
        assert f'<option value="{value}">' in html
    assert 'data-sizing="fit"' in html
    assert 'data-sizing="fill"' in html
    assert 'data-sizing="stretch"' in html
    assert '<details id="transform-toolbar"' in html
    assert '<summary>Transform</summary>' in html
    assert 'class="transform-controls" role="toolbar"' in html
    assert '<details id="transform-toolbar" open' not in html
    assert 'id="media-viewport"' in html
    assert html.index('id="transform-toolbar"') < html.index('id="timeline"')
    assert 'data-rotation="90"' in html
    assert 'data-rotation="270"' in html
    assert 'id="flip-horizontal"' in html
    assert 'id="flip-vertical"' in html
    assert "sizing_mode: clip.sizingMode || \"fit\"" in crop_js
    assert "flip_horizontal: !!clip.flipHorizontal" in crop_js
    assert "quarterTurn ? clip.probeData.height : clip.probeData.width" in crop_js
    assert "paintTransformPreview(clip, size)" in crop_js


def test_web_ui_allows_manual_target_size_entry() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert 'id="sz-badge" type="number" min="2"' in html
    assert "#sz-badge { width:48px;" in html
    assert "color:#c4b5fd;" in html
    assert "function onBadgeSize(v)" in html
    assert "byId('sz-slider').max=Math.max(500,size)" in html
    assert "if (!size || size < 2)" in html


def test_web_ui_checks_for_updates_on_startup_when_enabled() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "if (appSettings.check_updates !== false) checkUpdates(true);" in html
    assert "async function checkUpdates(silent)" in html
    assert "if (!silent) toast('Running latest version.', 'ok');" in html


def test_web_ui_shows_release_notes_in_an_update_modal() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")

    assert "function showUpdateModal(update)" in html
    assert 'id="update-notes"' in html
    assert "byId('update-notes').textContent=update.notes" in html
    assert "showUpdateModal(r);" in html


def test_installer_exposes_tuck_command_on_path() -> None:
    installer = Path("scripts/installer.iss").read_text(encoding="utf-8")
    wrapper = Path("scripts/tuck.cmd").read_text(encoding="utf-8")

    assert "ChangesEnvironment=yes" in installer
    assert "procedure AddTuckToPath;" in installer
    assert "procedure RemoveTuckFromPath;" in installer
    assert 'Source: "tuck.cmd"; DestDir: "{app}"' in installer
    assert '"%~dp0TuckCli.exe" %*' in wrapper
    assert "CloseApplications=yes" in installer
    assert "CloseApplicationsFilter=Tuck.exe,TuckCli.exe" in installer
