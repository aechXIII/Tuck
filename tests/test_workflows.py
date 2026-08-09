from __future__ import annotations

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


def test_pyinstaller_spec_builds_a_real_one_folder_app() -> None:
    spec = Path("scripts/tuck.spec").read_text(encoding="utf-8")

    assert spec.count("exclude_binaries=True") == 2
    assert "a.zipfiles" in spec
    assert "upx=True" not in spec
