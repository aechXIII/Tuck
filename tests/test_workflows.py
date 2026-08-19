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
    changelog = Path("CHANGELOG.md").read_text(encoding="utf-8")

    project_version = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE)
    bump_version = re.search(r'^current_version = "([^"]+)"$', pyproject, re.MULTILINE)
    package_version = re.search(r'^__version__ = "([^"]+)"$', package, re.MULTILINE)
    installer_version = re.search(r'^#define MyAppVersion "([^"]+)"$', installer, re.MULTILINE)

    assert project_version and bump_version and package_version and installer_version
    versions = {
        project_version.group(1),
        bump_version.group(1),
        package_version.group(1),
        installer_version.group(1),
    }
    assert len(versions) == 1
    assert f"## [{project_version.group(1)}]" in changelog


def test_workflows_run_frontend_tests() -> None:
    workflows = Path(".github/workflows")

    for name in ("tests.yml", "release.yml"):
        workflow = (workflows / name).read_text(encoding="utf-8")
        assert "node --test" in workflow


def test_pyinstaller_spec_builds_a_real_one_folder_app() -> None:
    spec = Path("scripts/tuck.spec").read_text(encoding="utf-8")

    assert spec.count("exclude_binaries=True") == 2
    assert "a.zipfiles" in spec
    assert "upx=True" not in spec
    assert '(str(_root / "tuck" / "web"), "tuck/web")' in spec


def test_wheel_and_build_smoke_checks_include_split_web_assets() -> None:
    pyproject = Path("pyproject.toml").read_text(encoding="utf-8")
    build_script = Path("scripts/build.ps1").read_text(encoding="utf-8")

    assert 'tuck = ["web/*"]' in pyproject
    assert 'Get-ChildItem -LiteralPath ".\\tuck\\web" -File' in build_script
    assert '".\\dist\\Tuck\\_internal\\tuck\\web\\$asset"' in build_script
