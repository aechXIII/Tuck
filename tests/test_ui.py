from __future__ import annotations

from pathlib import Path

WEB_DIR = Path("tuck/web")


def _asset(name: str) -> str:
    return (WEB_DIR / name).read_text(encoding="utf-8")


def _web_source() -> str:
    return "\n".join(
        _asset(name)
        for name in (
            "index.html",
            "styles.css",
            "settings.css",
            "player.css",
            "queue.css",
            "transform.css",
            "app.js",
            "encoding-ui.js",
            "segments.js",
            "player.js",
            "queue.js",
            "settings.js",
            "transform.js",
        )
    )


def test_web_ui_is_packaged_source_asset() -> None:
    html = _asset("index.html")
    app_js = _asset("app.js")

    for asset in (
        "styles.css",
        "settings.css",
        "player.css",
        "queue.css",
        "transform.css",
        "app.js",
        "encoding-ui.js",
        "segments.js",
        "player.js",
        "queue.js",
        "settings.js",
        "crop.js",
        "transform.js",
    ):
        assert asset in html
        assert (WEB_DIR / asset).is_file()
    assert "window.pywebview.api" in app_js
    assert "pywebviewready" in app_js


def test_web_ui_uses_python_managed_drop_paths() -> None:
    html = _web_source()

    assert "postMessageWithAdditionalObjects" not in html
    assert "chrome.webview" not in html


def test_web_ui_forwards_start_metadata_and_releases_old_media_tokens() -> None:
    html = _web_source()

    assert "metadata.files = files" in html
    assert "releaseMediaToken(clips[selPath].mediaToken)" in html
    assert "api.closeWindow()" in html


def test_web_ui_starts_if_python_calls_init_after_bridge_injection() -> None:
    html = _web_source()

    assert "if (window.pywebview && window.pywebview.api)" in html
    assert "var p = paths[i];" in html


def test_web_ui_contains_visual_crop_overlay_and_request_state() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")
    encoding_js = _asset("encoding-ui.js")
    crop_js = _asset("crop.js")
    transform_js = _asset("transform.js")
    styles = _asset("transform.css")

    assert 'id="crop-selection"' in html
    assert "event.target.dataset.handle" in transform_js
    assert html.count('class="crop-handle" data-handle=') == 8
    assert '.crop-handle[data-handle="nw"] {' in styles
    assert '.crop-handle[data-handle="se"] {' in styles
    assert 'class="segment-quick-actions"' in html
    assert 'id="btn-segments-reset"' in html
    assert 'id="segment-menu"' not in html
    assert 'id="crop-edit-group"' in html
    assert "cropTransformForRequest(c)" in encoding_js
    assert "new ResizeObserver(paintCropOverlay)" in transform_js
    assert "api.createPlan" not in crop_js
    assert "api.createPlan" not in transform_js


def test_web_ui_contains_complete_transform_controls() -> None:
    html = Path("tuck/web/index.html").read_text(encoding="utf-8")
    transform_js = _asset("transform.js")
    for value in ("free", "16:9", "9:16", "1:1", "4:3"):
        assert f'data-aspect="{value}"' in html
    assert 'data-sizing="fit"' in html
    assert 'data-sizing="fill"' in html
    assert 'data-sizing="stretch"' in html
    assert '<details id="transform-toolbar"' in html
    assert "<summary>Transform</summary>" in html
    assert 'class="transform-controls"' in html
    assert 'role="toolbar"' in html
    assert '<details id="transform-toolbar" open' not in html
    assert 'id="media-viewport"' in html
    assert html.index('id="transform-toolbar"') < html.index('id="timeline"')
    assert 'data-rotation="90"' in html
    assert 'data-rotation="270"' in html
    assert 'id="flip-horizontal"' in html
    assert 'id="flip-vertical"' in html
    assert html.count('data-tip="') >= 8
    assert 'data-sizing="fit"' in html and 'title="Keep the entire' not in html
    assert 'sizing_mode: clip.sizingMode || "fit"' in transform_js
    assert "flip_horizontal: !!clip.flipHorizontal" in transform_js
    assert "plannedGeometry.oriented_width" in transform_js
    assert "paintTransformPreview(clip, size)" in transform_js
    assert "cropEditorGeometry(clip, size)" in transform_js
    assert "sourceHandleForDisplay(displayHandle, origin, editor)" in transform_js
    assert 'tooltip.id = "transform-tooltip"' in transform_js
    assert 'button.setAttribute("aria-pressed", String(active))' in transform_js


def test_preview_responses_are_bound_to_the_source_and_request_snapshot() -> None:
    encoding_js = _asset("encoding-ui.js")
    transform_js = _asset("transform.js")

    assert "var path = selPath;" in encoding_js
    assert "req._request_id = requestId;" in encoding_js
    assert "clips[path] === clip" in encoding_js
    assert "clip._previewRequestId === requestId" in encoding_js
    assert "r._request_id === requestId" in encoding_js
    assert 'document.getElementById("res-mode")' not in transform_js


def test_web_ui_allows_manual_target_size_entry() -> None:
    html = _web_source()

    assert 'id="sz-badge"' in html
    assert 'type="number"' in html
    assert 'min="2"' in html
    assert "#sz-badge {" in html
    assert "color: #c4b5fd;" in html
    assert "function onBadgeSize(v)" in html
    assert 'byId("sz-slider").max = Math.max(500, size)' in html
    assert "if (!size || size < 2)" in html


def test_web_ui_checks_for_updates_on_startup_when_enabled() -> None:
    html = _web_source()

    assert "if (appSettings.check_updates !== false) checkUpdates(true);" in html
    assert "async function checkUpdates(silent)" in html
    assert 'if (!silent) toast("Running latest version.", "ok");' in html


def test_web_ui_shows_release_notes_in_an_update_modal() -> None:
    html = _web_source()

    assert "function showUpdateModal(update)" in html
    assert 'id="update-notes"' in html
    assert "function renderUpdateNotes(notes)" in html
    assert 'document.createElement(block.type === "heading" ? "h4" : "p")' in html
    assert "item.textContent = block.text" in html
    assert "renderUpdateNotes(update.notes);" in html
    assert "showUpdateModal(r);" in html


def test_update_download_starts_the_installer_without_a_second_prompt() -> None:
    html = _web_source()

    assert "Download &amp; install" in html
    assert "async function downloadAndInstallUpdate()" in html
    assert "var installed = await api.installUpdate();" in html
    assert "await api.closeWindow();" in html
    assert "Update downloaded. Install now?" not in html


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
