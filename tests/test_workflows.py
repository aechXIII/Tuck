from __future__ import annotations

import re
from pathlib import Path


def test_workflows_install_ffmpeg_without_the_retired_action() -> None:
    workflows = Path(".github/workflows")

    for workflow in workflows.glob("*.yml"):
        text = workflow.read_text(encoding="utf-8")
        assert "AnimMouse/setup-ffmpeg" not in text
        assert "choco install ffmpeg --yes --no-progress" in text


def test_release_workflow_uses_the_version_changelog_entry() -> None:
    workflow = Path(".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "CHANGELOG.md" in workflow
    assert "No changelog entry found" in workflow
    assert "body_path: release-notes.md" in workflow
    assert "generate_release_notes" not in workflow
    assert "$tag = \"${{ github.ref_name }}\".TrimStart('v')" in workflow
    assert '$expected = "Tuck $tag"' in workflow
    assert 'Get-Item "scripts/Output/Tuck-Setup-$version-x64.exe"' in workflow


def test_release_metadata_versions_match_and_have_changelog_notes() -> None:
    pyproject = Path("pyproject.toml").read_text(encoding="utf-8")
    package = Path("tuck/__init__.py").read_text(encoding="utf-8")
    installer = Path("scripts/installer.iss").read_text(encoding="utf-8")
    npm = Path("package.json").read_text(encoding="utf-8")
    cargo = Path("src-tauri/Cargo.toml").read_text(encoding="utf-8")
    tauri_conf = Path("src-tauri/tauri.conf.json").read_text(encoding="utf-8")
    changelog = Path("CHANGELOG.md").read_text(encoding="utf-8")

    matches = {
        "pyproject.version": re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE),
        "pyproject.current_version": re.search(
            r'^current_version = "([^"]+)"$', pyproject, re.MULTILINE
        ),
        "tuck.__version__": re.search(r'^__version__ = "([^"]+)"$', package, re.MULTILINE),
        "installer.iss": re.search(r'^#define MyAppVersion "([^"]+)"$', installer, re.MULTILINE),
        "package.json": re.search(r'"version": "([^"]+)"', npm),
        "Cargo.toml": re.search(r'^version = "([^"]+)"$', cargo, re.MULTILINE),
        "tauri.conf.json": re.search(r'"version": "([^"]+)"', tauri_conf),
    }
    assert all(matches.values()), {k: bool(v) for k, v in matches.items()}
    versions = {match.group(1) for match in matches.values()}
    assert len(versions) == 1, f"version drift across release metadata: {versions}"
    assert f"## [{versions.pop()}]" in changelog


def test_workflows_run_frontend_tests() -> None:
    workflows = Path(".github/workflows")

    for name in ("tests.yml", "release.yml"):
        workflow = (workflows / name).read_text(encoding="utf-8")
        assert "node --test" in workflow


def test_sidecar_spec_is_gui_free_and_two_console_exes() -> None:
    spec = Path("scripts/tuck-sidecar.spec").read_text(encoding="utf-8")

    # tuck-sidecar.exe + TuckCli.exe, each with its own entry; no pywebview shell
    assert 'exe_sidecar = _exe(pyz_sidecar, a_sidecar, "tuck-sidecar")' in spec
    assert 'exe_cli = _exe(pyz_cli, a_cli, "TuckCli")' in spec
    assert '"sidecar_entry.py"' in spec and '"cli_entry.py"' in spec
    assert '"webview"' in spec and '"pythonnet"' in spec and '"clr"' in spec
    assert "tuck.web_ui" in spec  # named only in the excludes list
    assert "frontend" not in spec  # Tauri owns the frontend; the sidecar never bundles it


def test_build_script_orchestrates_sidecar_then_tauri_then_verify() -> None:
    build_script = Path("scripts/build.ps1").read_text(encoding="utf-8")

    sidecar = build_script.index("scripts/build_sidecar.py")
    tauri = build_script.index("npm run tauri build")
    verify = build_script.index("scripts/verify_package.py")
    assert sidecar < tauri < verify, "build.ps1 must build the sidecar, then bundle, then verify"
