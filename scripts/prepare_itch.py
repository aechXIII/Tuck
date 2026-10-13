"""Verify a published GitHub release and prepare its individual itch.io downloads."""

from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

from scripts import build_metadata as bm
from scripts import verify_release as release_checks
from scripts import verify_updater_signatures as signatures

SOURCES = "Tuck-FFmpeg-Windows-Sources.tar.xz"
CHANNELS = {"windows": "windows-installer", "linux": "linux-appimage"}


def validate_tag(tag: str) -> str:
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Expected a stable version tag such as v0.6.1")
    return tag[1:]


def validate_project(project: str) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*", project):
        raise ValueError("ITCH_PROJECT must be an itch.io owner/project name")


def verify_checksums(downloads: Path, names: set[str]) -> None:
    remaining = names.copy()
    for line in (downloads / bm.CHECKSUMS_FILENAME).read_text(encoding="ascii").splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})  (.+)", line)
        if match is None or match[2] not in remaining:
            raise ValueError("Unexpected or duplicate entry in the release checksum list")
        digest, name = match.groups()
        if bm.sha256_file(downloads / name) != digest.lower():
            raise ValueError(f"SHA256 checksum mismatch: {name}")
        remaining.remove(name)
    if remaining:
        raise ValueError("The release checksum list is incomplete")


def prepare(downloads: Path, metadata: Path, root: Path, output: Path, tag: str) -> None:
    version = validate_tag(tag)
    if output.exists():
        raise ValueError("The upload directory already exists; choose a fresh directory")
    release = json.loads(metadata.read_text(encoding="utf-8"))
    if (
        release.get("tagName") != tag
        or release.get("isDraft") is not False
        or release.get("isPrerelease") is not False
    ):
        raise ValueError(
            "The GitHub release must be published, marked as stable, and match the requested tag"
        )
    manifest = release_checks.verify_release(
        downloads / bm.MANIFEST_FILENAME,
        artifacts_dir=downloads,
        root=root,
        require_signed=True,
    )
    if manifest["version"] != version:
        raise ValueError("The requested tag does not match the release version")
    names = {bm.artifact_name(platform, version) for platform in CHANNELS}
    verify_checksums(downloads, names | {SOURCES})
    for notice in bm.NOTICES.values():
        if (downloads / notice).read_bytes() != (root / "packaging" / notice).read_bytes():
            raise ValueError(f"The downloaded notice does not match the release source: {notice}")
    signatures.verify(config=root / "src-tauri/tauri.conf.json", artifacts=downloads)

    # licenses are inside the packages; one file per channel avoids a ZIP wrapper
    for platform, channel in CHANNELS.items():
        folder = output / channel
        folder.mkdir(parents=True)
        name = bm.artifact_name(platform, version)
        shutil.copyfile(downloads / name, folder / name)
        if platform == "linux":
            (folder / name).chmod(0o755)
    folder = output / "ffmpeg-sources"
    folder.mkdir()
    shutil.copyfile(downloads / SOURCES, folder / SOURCES)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--downloads", type=Path, default=Path("downloads"))
    parser.add_argument("--metadata", type=Path, default=Path("release.json"))
    parser.add_argument("--release-root", type=Path, default=Path("release-source"))
    parser.add_argument("--output", type=Path, default=Path("itch-upload"))
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    validate_tag(args.tag)
    validate_project(args.project)
    if not args.validate_only:
        prepare(args.downloads, args.metadata, args.release_root, args.output, args.tag)


if __name__ == "__main__":
    main()
