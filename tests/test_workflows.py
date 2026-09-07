"""CI workflow invariants.

Most release behavior is tested through the helpers in ``scripts/build_metadata.py``
and ``scripts/verify_release.py`` (see ``tests/test_release.py``). The assertions
here cover the few workflow properties that cannot be observed any other way:
which runner builds which artifact, that secrets stay inside the tag-gated
publish job, and that no generated artifact is cached across versions.
"""

from __future__ import annotations

import re
from pathlib import Path

WORKFLOWS = Path(".github/workflows")
TESTS_YML = WORKFLOWS / "tests.yml"
RELEASE_YML = WORKFLOWS / "release.yml"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _jobs(workflow_text: str) -> dict[str, str]:
    """Split a workflow into ``job name -> job block`` using indentation.

    Dependency-free and good enough for these structural checks: job keys are the
    only two-space-indented identifiers under ``jobs:``.
    """

    lines = workflow_text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.rstrip() == "jobs:")
    except StopIteration:  # pragma: no cover - a workflow always has jobs
        return {}

    jobs: dict[str, list[str]] = {}
    current: str | None = None
    for line in lines[start + 1 :]:
        if not line.strip() or line.lstrip().startswith("#"):
            if current:
                jobs[current].append(line)
            continue
        header = re.match(r"^  ([A-Za-z_][A-Za-z0-9_-]*):\s*$", line)
        if header:
            current = header.group(1)
            jobs[current] = []
            continue
        if re.match(r"^\S", line):  # dedented back out of jobs:
            break
        if current:
            jobs[current].append(line)
    return {name: "\n".join(body) for name, body in jobs.items()}


# --- FFmpeg provisioning -------------------------------------------------------


def test_workflows_never_use_the_retired_ffmpeg_action() -> None:
    for workflow in WORKFLOWS.glob("*.yml"):
        assert "AnimMouse/setup-ffmpeg" not in _read(workflow)


def test_windows_runners_install_ffmpeg_through_chocolatey() -> None:
    for workflow in (TESTS_YML, RELEASE_YML):
        assert "choco install ffmpeg --yes --no-progress" in _read(workflow)


def test_linux_runners_install_ffmpeg_for_the_test_suite() -> None:
    # The Linux AppImage compiles its own FFmpeg from locked sources; the test
    # suite only needs a system ffmpeg for the -m ffmpeg cases.
    assert "apt-get install -y ffmpeg" in _read(TESTS_YML)


# --- test coverage across both supported OSes -------------------------------


def test_tests_workflow_runs_on_windows_and_the_frozen_linux_baseline() -> None:
    text = _read(TESTS_YML)
    assert "windows-latest" in text
    assert "ubuntu-22.04" in text
    assert "ubuntu-latest" not in text, "pin the Linux runner to the frozen 22.04 baseline"


def test_tests_workflow_exercises_python_typescript_and_rust() -> None:
    text = _read(TESTS_YML)
    assert "pytest" in text
    assert "npm run typecheck" in text and "npm run test" in text
    assert "npm run test:e2e" in text, "the rendered integration suite must run in CI"
    assert "cargo clippy" in text and "cargo test" in text


def test_rust_linux_job_installs_real_webkitgtk() -> None:
    text = _read(TESTS_YML)
    assert "libwebkit2gtk-4.1-dev" in text, "the Linux platform smoke layer needs real WebKitGTK"


# --- release build jobs -----------------------------------------------------


def test_release_workflow_builds_each_artifact_on_its_native_runner() -> None:
    jobs = _jobs(_read(RELEASE_YML))
    build_windows = jobs.get("build-windows", "")
    build_linux = jobs.get("build-linux", "")
    assert "runs-on: windows-latest" in build_windows
    assert "runs-on: ubuntu-22.04" in build_linux
    assert "ubuntu-latest" not in build_linux, "build the AppImage on the frozen 22.04 baseline"
    # no cross-compilation
    assert "--target x86_64-pc-windows" not in build_linux
    assert "cross" not in build_linux.split()


def test_release_build_jobs_inspect_and_smoke_before_upload() -> None:
    jobs = _jobs(_read(RELEASE_YML))
    for name in ("build-windows", "build-linux"):
        body = jobs[name]
        verify = body.index("verify_package.py")
        smoke = body.index("smoke_packaged.py")
        upload = body.index("actions/upload-artifact")
        assert verify < upload and smoke < upload, (
            f"{name} must verify and smoke-test the package before uploading it"
        )


def test_release_workflow_uses_locked_dependency_installs() -> None:
    text = _read(RELEASE_YML)
    assert "npm ci" in text
    assert re.search(r"npm install\b", text) is None, "use the lockfile-respecting `npm ci`"
    assert 'pip install -e ".[dev]"' in text


def test_release_workflow_generates_manifest_checksums_and_notices() -> None:
    text = _read(RELEASE_YML)
    assert "scripts/build_metadata.py manifest" in text
    assert "scripts/verify_release.py" in text
    assert "THIRD_PARTY_NOTICES.md" in text and "THIRD_PARTY_NOTICES_LINUX.md" in text
    assert "SHA256SUMS" in text


def test_release_workflow_uploads_artifacts_with_bounded_retention() -> None:
    text = _read(RELEASE_YML)
    assert "actions/upload-artifact" in text
    assert "retention-days:" in text, "test/PR build artifacts must expire"


# --- secret and publish gating -------------------------------------------------


def test_release_candidate_run_never_publishes_a_github_release() -> None:
    text = _read(RELEASE_YML)
    assert "workflow_dispatch:" in text
    jobs = _jobs(text)
    publishing = [name for name, body in jobs.items() if "softprops/action-gh-release" in body]
    assert publishing, "a publish job must exist"
    for name in publishing:
        assert "startsWith(github.ref, 'refs/tags/v')" in jobs[name], (
            f"{name} may only run for a version tag, never a release-candidate dispatch"
        )


def test_secrets_are_confined_to_the_tag_gated_publish_job() -> None:
    jobs = _jobs(_read(RELEASE_YML))
    offenders = []
    for name, body in jobs.items():
        refs = set(re.findall(r"secrets\.([A-Za-z0-9_]+)", body))
        refs.discard("GITHUB_TOKEN")
        if not refs:
            continue
        if "startsWith(github.ref, 'refs/tags/v')" not in body:
            offenders.append((name, sorted(refs)))
    assert not offenders, f"secrets leaked into non-tag jobs: {offenders}"


def test_publish_job_fails_closed_without_the_updater_signing_key() -> None:
    jobs = _jobs(_read(RELEASE_YML))
    publish = next(body for body in jobs.values() if "softprops/action-gh-release" in body)
    assert "TAURI_SIGNING_PRIVATE_KEY" in publish
    gate = publish.index("TAURI_SIGNING_PRIVATE_KEY")
    release = publish.index("softprops/action-gh-release")
    assert gate < release, "check for the signing key before creating the release"
    assert "--require-signed" in publish


def test_release_notes_come_from_the_changelog() -> None:
    text = _read(RELEASE_YML)
    assert "scripts/build_metadata.py release-notes" in text
    assert "generate_release_notes" not in text


# --- no caching of generated artifacts -------------------------------------


def test_workflows_do_not_cache_generated_release_artifacts() -> None:
    generated = (
        "target/release/bundle",
        "packaging/staging",
        "dist/",
        ".AppImage",
        "-setup.exe",
        "tuck-release-manifest",
    )
    for workflow in WORKFLOWS.glob("*.yml"):
        text = _read(workflow)
        for block in re.split(r"(?=- uses: actions/cache@|- name: .*[Cc]ache)", text):
            if "actions/cache@" not in block:
                continue
            for token in generated:
                assert token not in block, (
                    f"{workflow.name}: an actions/cache step references generated output {token!r}"
                )


# --- carried over from the pywebview-era workflow tests --------------------


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
    versions = {match.group(1) for match in matches.values() if match}
    assert len(versions) == 1, f"version drift across release metadata: {versions}"
    assert f"## [{versions.pop()}]" in changelog


def test_sidecar_spec_is_gui_free_and_two_console_exes() -> None:
    spec = Path("scripts/tuck-sidecar.spec").read_text(encoding="utf-8")

    assert 'exe_sidecar = _exe(pyz_sidecar, a_sidecar, "tuck-sidecar")' in spec
    assert 'exe_cli = _exe(pyz_cli, a_cli, "TuckCli")' in spec
    assert '"sidecar_entry.py"' in spec and '"cli_entry.py"' in spec
    assert '"webview"' in spec and '"pythonnet"' in spec and '"clr"' in spec
    assert "tuck.web_ui" in spec
    assert "frontend" not in spec


def test_build_script_orchestrates_sidecar_then_tauri_then_verify() -> None:
    build_script = Path("scripts/build.ps1").read_text(encoding="utf-8")

    sidecar = build_script.index("scripts/build_sidecar.py")
    tauri = build_script.index("npm run tauri build")
    verify = build_script.index("scripts/verify_package.py")
    assert sidecar < tauri < verify, "build.ps1 must build the sidecar, then bundle, then verify"
