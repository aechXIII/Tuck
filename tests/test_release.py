"""Release metadata, manifest, and gating behavior.

These protect the contract that CI can only publish a complete, hash-verified,
correctly named, signed release, and that a release candidate is built and
checked without any signing secret.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent
_SCRIPTS = _REPO / "scripts"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"{name}_for_test", _SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bm = _load("build_metadata")
vr = _load("verify_release")


# --- version agreement -------------------------------------------------------


def test_all_authoritative_version_declarations_agree() -> None:
    declared = bm.collect_version_declarations(_REPO)
    assert set(declared) == set(bm.VERSION_SOURCES)
    assert len(set(declared.values())) == 1, declared
    assert bm.project_version(_REPO) == next(iter(declared.values()))


def test_project_version_reports_drift_with_every_offending_file(tmp_path: Path) -> None:
    root = tmp_path
    (root / "tuck").mkdir()
    (root / "src-tauri").mkdir()
    (root / "scripts").mkdir()
    (root / "tuck" / "__init__.py").write_text('__version__ = "0.4.0"\n', encoding="utf-8")
    (root / "pyproject.toml").write_text('version = "0.4.0"\n', encoding="utf-8")
    (root / "package.json").write_text('{"version": "9.9.9"}\n', encoding="utf-8")
    (root / "src-tauri" / "Cargo.toml").write_text('version = "0.4.0"\n', encoding="utf-8")
    (root / "src-tauri" / "tauri.conf.json").write_text('{"version": "0.4.0"}\n', encoding="utf-8")
    (root / "scripts" / "installer.iss").write_text(
        '#define MyAppVersion "0.4.0"\n', encoding="utf-8"
    )

    with pytest.raises(bm.MetadataError, match="version drift"):
        bm.project_version(root)


# --- artifact naming -------------------------------------------------------


def test_windows_artifact_name_carries_product_version_and_arch() -> None:
    assert bm.artifact_name("windows", "0.5.0") == "Tuck-Setup-0.5.0-x64.exe"


def test_linux_artifact_name_carries_product_version_and_arch() -> None:
    assert bm.artifact_name("linux", "0.5.0") == "Tuck-0.5.0-x86_64.AppImage"


def test_artifact_name_rejects_an_unknown_platform() -> None:
    with pytest.raises(bm.MetadataError):
        bm.artifact_name("darwin", "0.5.0")


# --- checksum files -------------------------------------------------------


def test_checksum_file_uses_sha256sum_format(tmp_path: Path) -> None:
    blob = tmp_path / "Tuck-Setup-0.4.0-x64.exe"
    blob.write_bytes(b"installer bytes")

    written = bm.write_checksum(blob)

    assert written.name == "Tuck-Setup-0.4.0-x64.exe.sha256"
    line = written.read_text(encoding="ascii").strip()
    digest, _, name = line.partition("  ")
    assert len(digest) == 64 and name == blob.name
    assert digest == bm.sha256_file(blob)


# --- release notes -------------------------------------------------------


def test_release_notes_extracts_only_the_matching_changelog_section() -> None:
    changelog = (
        "# Changelog\n\n"
        "## [0.5.0] - unreleased\n\n### Added\n- Linux AppImage\n\n"
        "## [0.4.0] - 2026-08-27\n\n### Added\n- Keyboard shortcuts modal\n"
    )
    notes = bm.render_release_notes(changelog, "0.5.0")
    assert notes.startswith("## [0.5.0]")
    assert "Linux AppImage" in notes
    assert "0.4.0" not in notes


def test_release_notes_fail_when_the_version_has_no_entry() -> None:
    with pytest.raises(bm.MetadataError, match="no changelog entry"):
        bm.render_release_notes("# Changelog\n\n## [0.4.0]\n- x\n", "0.5.0")


# --- manifest + verify_release -------------------------------------------------------


def _fake_artifact(directory: Path, name: str, body: bytes) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(body)
    bm.write_checksum(path)
    return path


def _candidate_manifest(tmp_path: Path, *, channel: str = "release-candidate") -> tuple[Path, Path]:
    """Build a plausible RC manifest whose artifacts live in ``tmp_path/dist``."""

    version = bm.project_version(_REPO)
    dist = tmp_path / "dist"
    win = _fake_artifact(dist, bm.artifact_name("windows", version), b"nsis installer payload")
    lin = _fake_artifact(dist, bm.artifact_name("linux", version), b"appimage payload")

    entries = [
        bm.artifact_entry(
            win, "windows", kind="nsis-installer", verified_package=True, verified_smoke=True
        ),
        bm.artifact_entry(
            lin, "linux", kind="appimage", verified_package=True, verified_smoke=True
        ),
    ]
    manifest = bm.build_manifest(channel=channel, artifacts=entries, root=_REPO)
    manifest_path = dist / bm.MANIFEST_FILENAME
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return manifest_path, dist


def test_manifest_pins_every_artifact_hash_size_and_immutable_input(tmp_path: Path) -> None:
    manifest_path, _ = _candidate_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert manifest["schema_version"] == bm.MANIFEST_SCHEMA_VERSION
    assert {a["platform"] for a in manifest["artifacts"]} == {"windows", "linux"}
    for artifact in manifest["artifacts"]:
        assert len(artifact["sha256"]) == 64
        assert artifact["size_bytes"] > 0
        assert artifact["verified"] == {"verify_package": True, "smoke": True}

    pinned = {entry["file"]: entry for entry in manifest["immutable_inputs"]}
    assert set(pinned) == set(bm.IMMUTABLE_INPUTS)
    for rel, entry in pinned.items():
        assert entry["sha256"] == bm.sha256_file(_REPO / rel)


def test_verify_release_accepts_a_well_formed_candidate(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


def test_verify_release_rejects_a_tampered_artifact(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    version = bm.project_version(_REPO)
    (dist / bm.artifact_name("linux", version)).write_bytes(b"swapped payload")

    with pytest.raises(vr.VerifyError, match=r"sha256|size"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


def test_verify_release_rejects_a_missing_artifact(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    version = bm.project_version(_REPO)
    (dist / bm.artifact_name("windows", version)).unlink()

    with pytest.raises(vr.VerifyError, match="missing"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


def test_verify_release_rejects_an_unexpected_extra_artifact(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifacts"].append({**manifest["artifacts"][0], "platform": "darwin"})
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match=r"unknown platform|unexpected"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


def test_verify_release_rejects_a_wrongly_named_artifact(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    version = bm.project_version(_REPO)
    good = dist / bm.artifact_name("windows", version)
    renamed = dist / f"Tuck-{version}-setup.exe"
    good.rename(renamed)
    bm.write_checksum(renamed)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for artifact in manifest["artifacts"]:
        if artifact["platform"] == "windows":
            artifact["name"] = renamed.name
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match="named"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


def test_verify_release_rejects_a_changed_immutable_input(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["immutable_inputs"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match="does not match the checked-in lock"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


def test_verify_release_rejects_an_unverified_artifact(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifacts"][0]["verified"]["smoke"] = False
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match="smoke"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO)


# --- signing / publish gating -------------------------------------------------------


def _signed_release(tmp_path: Path) -> tuple[Path, Path]:
    """A `release` channel manifest with a `.sig` per artifact and a latest.json."""

    version = bm.project_version(_REPO)
    dist = tmp_path / "dist"
    win = _fake_artifact(dist, bm.artifact_name("windows", version), b"nsis")
    lin = _fake_artifact(dist, bm.artifact_name("linux", version), b"appimage")
    (dist / f"{win.name}.sig").write_text("WIN-SIGNATURE-BLOB", encoding="utf-8")
    (dist / f"{lin.name}.sig").write_text("LINUX-SIGNATURE-BLOB", encoding="utf-8")

    entries = [
        bm.artifact_entry(
            win,
            "windows",
            kind="nsis-installer",
            verified_package=True,
            verified_smoke=True,
            signed=True,
        ),
        bm.artifact_entry(
            lin,
            "linux",
            kind="appimage",
            verified_package=True,
            verified_smoke=True,
            signed=True,
        ),
    ]
    manifest = bm.build_manifest(channel="release", artifacts=entries, root=_REPO)
    (dist / bm.MANIFEST_FILENAME).write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )

    feed = bm.build_updater_manifest(
        version=version,
        notes="- Something changed",
        signatures={"windows": "WIN-SIGNATURE-BLOB", "linux": "LINUX-SIGNATURE-BLOB"},
    )
    (dist / bm.UPDATER_FEED_FILENAME).write_text(json.dumps(feed), encoding="utf-8")
    return dist / bm.MANIFEST_FILENAME, dist


def test_release_candidate_passes_without_any_signing_secret(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)
    vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=False)


def test_release_candidate_artifacts_are_recorded_unsigned(tmp_path: Path) -> None:
    manifest_path, _ = _candidate_manifest(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["signing"]["tauri_updater"] == "disabled"
    assert all(a["signed"] is False for a in manifest["artifacts"])


def test_public_release_is_blocked_when_the_updater_key_is_absent(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path, channel="release")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["signing"]["tauri_updater"] == "disabled"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match="TAURI_SIGNING_PRIVATE_KEY"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=True)


def test_signed_public_release_passes_with_sig_files_and_a_matching_latest_json(
    tmp_path: Path,
) -> None:
    manifest_path, dist = _signed_release(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["signing"]["tauri_updater"] == "enabled"
    vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=True)


def test_signed_release_needs_a_signature_beside_every_artifact(tmp_path: Path) -> None:
    manifest_path, dist = _signed_release(tmp_path)
    version = bm.project_version(_REPO)
    (dist / f"{bm.artifact_name('linux', version)}.sig").unlink()

    with pytest.raises(vr.VerifyError, match="updater signature"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=True)


def test_signed_release_needs_a_latest_json(tmp_path: Path) -> None:
    manifest_path, dist = _signed_release(tmp_path)
    (dist / bm.UPDATER_FEED_FILENAME).unlink()

    with pytest.raises(vr.VerifyError, match=r"latest\.json"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=True)


def test_signed_release_rejects_a_latest_json_with_the_wrong_signature(tmp_path: Path) -> None:
    manifest_path, dist = _signed_release(tmp_path)
    feed = json.loads((dist / bm.UPDATER_FEED_FILENAME).read_text(encoding="utf-8"))
    feed["platforms"]["linux-x86_64"]["signature"] = "TAMPERED"
    (dist / bm.UPDATER_FEED_FILENAME).write_text(json.dumps(feed), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match="signature does not match"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=True)


def test_signed_release_still_requires_the_release_channel(tmp_path: Path) -> None:
    manifest_path, dist = _candidate_manifest(tmp_path)  # channel=release-candidate
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["signing"]["tauri_updater"] = "enabled"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(vr.VerifyError, match="channel"):
        vr.verify_release(manifest_path, artifacts_dir=dist, root=_REPO, require_signed=True)


def test_updater_manifest_points_each_platform_at_its_tagged_artifact(tmp_path: Path) -> None:
    feed = bm.build_updater_manifest(
        version="0.5.1",
        notes="- Linux auto-update",
        signatures={"windows": "W", "linux": "L"},
    )
    assert feed["version"] == "0.5.1"
    assert feed["notes"] == "- Linux auto-update"
    win = feed["platforms"]["windows-x86_64"]
    lin = feed["platforms"]["linux-x86_64"]
    assert win["signature"] == "W" and lin["signature"] == "L"
    assert win["url"].endswith("/v0.5.1/Tuck-Setup-0.5.1-x64.exe")
    assert lin["url"].endswith("/v0.5.1/Tuck-0.5.1-x86_64.AppImage")


def test_updater_manifest_needs_a_signature_for_every_platform() -> None:
    with pytest.raises(bm.MetadataError, match="missing updater signature"):
        bm.build_updater_manifest(version="0.5.1", notes="x", signatures={"windows": "W"})
