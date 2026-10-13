from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from scripts import build_metadata as bm

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def release_files(tmp_path: Path) -> tuple[Path, Path, str]:
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    version = bm.project_version(ROOT)
    signatures = {"windows": "windows signature", "linux": "linux signature"}
    entries = []
    for platform in bm.PLATFORMS:
        package = downloads / bm.artifact_name(platform, version)
        package.write_bytes(f"{platform} package".encode())
        bm.write_checksum(package)
        package.with_name(package.name + ".sig").write_text(signatures[platform])
        entries.append(
            bm.artifact_entry(
                package,
                platform,
                kind="nsis-installer" if platform == "windows" else "appimage",
                verified_package=True,
                verified_smoke=True,
                signed=True,
            )
        )
    manifest = bm.build_manifest(
        channel="release", artifacts=entries, git={"ref": f"refs/tags/v{version}"}
    )
    (downloads / bm.MANIFEST_FILENAME).write_text(json.dumps(manifest))
    (downloads / bm.UPDATER_FEED_FILENAME).write_text(
        json.dumps(
            bm.build_updater_manifest(version=version, notes="Release notes", signatures=signatures)
        )
    )
    for notice in bm.NOTICES.values():
        (downloads / notice).write_bytes((ROOT / "packaging" / notice).read_bytes())
    source = downloads / "Tuck-FFmpeg-Windows-Sources.tar.xz"
    source.write_bytes(b"corresponding FFmpeg sources")
    packages = [downloads / bm.artifact_name(p, version) for p in bm.PLATFORMS]
    (downloads / "SHA256SUMS").write_text(
        "\n".join(bm.checksum_line(p) for p in [*packages, source]) + "\n"
    )
    metadata = tmp_path / "release.json"
    metadata.write_text(
        json.dumps({"tagName": f"v{version}", "isDraft": False, "isPrerelease": False})
    )
    return downloads, metadata, version


def publisher():
    assert (ROOT / "scripts/prepare_itch.py").is_file(), "The itch release helper is missing"
    return importlib.import_module("scripts.prepare_itch")


def test_prepares_verified_single_file_downloads(release_files, tmp_path, monkeypatch):
    module = publisher()
    calls = []
    monkeypatch.setattr(module.signatures, "verify", lambda **kwargs: calls.append(kwargs))
    downloads, metadata, version = release_files
    output = tmp_path / "upload"
    module.prepare(downloads, metadata, ROOT, output, f"v{version}")
    assert len(calls) == 1
    for platform, channel in (("windows", "windows-installer"), ("linux", "linux-appimage")):
        name = bm.artifact_name(platform, version)
        assert [file.name for file in (output / channel).iterdir()] == [name]
        assert (output / channel / name).read_bytes() == (downloads / name).read_bytes()
    source = "Tuck-FFmpeg-Windows-Sources.tar.xz"
    assert [file.name for file in (output / "ffmpeg-sources").iterdir()] == [source]
    assert (output / "ffmpeg-sources" / source).read_bytes() == (downloads / source).read_bytes()


@pytest.mark.parametrize("name", ["windows", "sources"])
def test_rejects_modified_downloads_before_staging(release_files, tmp_path, monkeypatch, name):
    module = publisher()
    monkeypatch.setattr(module.signatures, "verify", lambda **kwargs: None)
    downloads, metadata, version = release_files
    file = (
        bm.artifact_name("windows", version)
        if name == "windows"
        else "Tuck-FFmpeg-Windows-Sources.tar.xz"
    )
    (downloads / file).write_bytes(b"changed")
    output = tmp_path / "upload"
    with pytest.raises(
        (ValueError, module.release_checks.VerifyError), match=r"sha256|checksum|size"
    ):
        module.prepare(downloads, metadata, ROOT, output, f"v{version}")
    assert not output.exists()


@pytest.mark.parametrize("field", ["isDraft", "isPrerelease"])
def test_refuses_unpublished_or_preview_releases(release_files, tmp_path, field):
    module = publisher()
    downloads, metadata, version = release_files
    data = json.loads(metadata.read_text())
    data[field] = True
    metadata.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="must be published, marked as stable"):
        module.prepare(downloads, metadata, ROOT, tmp_path / "upload", f"v{version}")


def test_signature_failure_prevents_staging(release_files, tmp_path, monkeypatch):
    module = publisher()

    def reject(**kwargs):
        raise ValueError("Invalid updater signature")

    monkeypatch.setattr(module.signatures, "verify", reject)
    downloads, metadata, version = release_files
    with pytest.raises(ValueError, match="signature"):
        module.prepare(downloads, metadata, ROOT, tmp_path / "upload", f"v{version}")
    assert not (tmp_path / "upload").exists()


def test_rejects_changed_notices(release_files, tmp_path, monkeypatch):
    module = publisher()
    monkeypatch.setattr(module.signatures, "verify", lambda **kwargs: None)
    downloads, metadata, version = release_files
    (downloads / bm.NOTICES["windows"]).write_text("unrelated notice")
    with pytest.raises(ValueError, match="notice"):
        module.prepare(downloads, metadata, ROOT, tmp_path / "upload", f"v{version}")


@pytest.mark.parametrize("tag", ["--help", "v0.6.1-rc1", "main", "v0.6.1\nOTHER=value"])
def test_accepts_only_stable_version_tags(tag):
    module = publisher()
    with pytest.raises(ValueError, match="stable version tag"):
        module.validate_tag(tag)


@pytest.mark.parametrize("project", ["", "aechxiii/tuck:windows", "../tuck", "a/b\nOTHER=value"])
def test_rejects_invalid_destinations(project):
    with pytest.raises(ValueError, match="owner/project"):
        publisher().validate_project(project)


@pytest.mark.parametrize("change", ["missing", "duplicate", "unsafe"])
def test_rejects_invalid_checksum_lists(release_files, tmp_path, monkeypatch, change):
    module = publisher()
    monkeypatch.setattr(module.signatures, "verify", lambda **kwargs: None)
    downloads, metadata, version = release_files
    checksum = downloads / bm.CHECKSUMS_FILENAME
    lines = checksum.read_text().splitlines()
    if change == "missing":
        lines.pop()
    elif change == "duplicate":
        lines.append(lines[0])
    else:
        lines[-1] = "0" * 64 + "  ../outside"
    checksum.write_text("\n".join(lines) + "\n")
    with pytest.raises(ValueError, match="checksum list"):
        module.prepare(downloads, metadata, ROOT, tmp_path / "upload", f"v{version}")
    assert not (tmp_path / "upload").exists()


def test_leaves_existing_output_untouched(release_files, tmp_path):
    downloads, metadata, version = release_files
    output = tmp_path / "upload"
    output.mkdir()
    sentinel = output / "existing.txt"
    sentinel.write_text("keep")
    with pytest.raises(ValueError, match="already exists"):
        publisher().prepare(downloads, metadata, ROOT, output, f"v{version}")
    assert sentinel.read_text() == "keep"
