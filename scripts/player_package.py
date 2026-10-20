"""Stages the native player library, its license texts and its source archive into a package.

`scripts/player_library.py` builds them on Ubuntu 22.04 into `build/player-library/<target>`. The
library goes next to the sidecar, where the desktop shell loads it from and nowhere else.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from player_library import OUTPUTS, ROOT, player_source_sha256
from windows_ffmpeg import require, sha256

LIBRARY_ROOT = ROOT / "build" / "player-library"


@dataclass(frozen=True)
class StagedPlayer:
    library: str
    sha256: str
    size_bytes: int
    player_source_sha256: str
    sources: list[dict[str, str]]
    licenses: list[dict[str, str]]
    source_archive: str
    source_archive_sha256: str

    def record(self) -> dict[str, object]:
        """The player's entry in the package manifest"""
        return {
            "file": self.library,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "player_source_sha256": self.player_source_sha256,
            "sources": self.sources,
            "licenses": self.licenses,
            "source_archive": {"file": self.source_archive, "sha256": self.source_archive_sha256},
        }

    def expected_present(self) -> list[str]:
        """The package paths the verifier must find for the player"""
        return [self.library, self.source_archive, *(entry["file"] for entry in self.licenses)]


def _checked(folder: Path, name: str, expected_sha256: str) -> Path:
    path = folder / name
    require(path.is_file(), f"The player library build lacks {name}")
    require(sha256(path) == expected_sha256, f"{name} does not match its player manifest")
    return path


def stage_player(
    target: str, app: Path, library_root: Path = LIBRARY_ROOT, library_folder: Path | None = None
) -> StagedPlayer:
    """Copies the checked player build into the staged app. The library itself goes to
    `library_folder` when the package adds it to the app later, as the AppImage does."""
    folder = library_root / target
    manifest_path = folder / "player-manifest.json"
    require(
        manifest_path.is_file(),
        f"No native player library in {folder}; run scripts/player_library.py {target} "
        "on Ubuntu 22.04 first",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(
        manifest.get("target") == target and manifest.get("library") == OUTPUTS[target],
        f"{manifest_path} is not a {target} player build",
    )
    require(
        manifest.get("player_source_sha256") == player_source_sha256(),
        "The native player library was built from other player sources; build it again",
    )
    library = _checked(folder, OUTPUTS[target], manifest["sha256"])
    archive = _checked(
        folder, manifest["source_archive"]["file"], manifest["source_archive"]["sha256"]
    )
    licenses = [
        (_checked(folder, entry["file"], entry["sha256"]), entry) for entry in manifest["licenses"]
    ]

    staged_library = (library_folder or app) / library.name
    staged_library.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(library, staged_library)
    staged_library.chmod(0o755)
    staged_licenses = []
    for path, entry in licenses:
        destination = app / "licenses" / "native-player" / entry["name"] / path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        staged_licenses.append(
            {
                "name": entry["name"],
                "spdx": entry["spdx"],
                "file": destination.relative_to(app).as_posix(),
            }
        )
    source = app / "native-player" / archive.name
    source.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(archive, source)
    print(f"  stage   {library.name}")
    return StagedPlayer(
        library=library.name,
        sha256=manifest["sha256"],
        size_bytes=manifest["size_bytes"],
        player_source_sha256=manifest["player_source_sha256"],
        sources=manifest["sources"],
        licenses=staged_licenses,
        source_archive=source.relative_to(app).as_posix(),
        source_archive_sha256=manifest["source_archive"]["sha256"],
    )
