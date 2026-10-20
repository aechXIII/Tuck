"""The native player's source lock names verifiable inputs and reuses the export FFmpeg sources."""

import hashlib
import importlib.util
import io
import json
import re
import sys
import tarfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


def _player_library() -> ModuleType:
    # the script imports its sibling builder by name, as it does when run directly
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location(
            "player_library_for_test", SCRIPTS / "player_library.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


@pytest.mark.parametrize(
    ("target", "reused"),
    [
        ("windows", ["ffmpeg", "dav1d", "zlib", "mingw-dxva"]),
        ("linux", ["ffmpeg", "dav1d", "libva", "libdrm"]),
    ],
)
def test_player_sources_reuse_the_export_ffmpeg_and_pin_the_rest(
    target: str, reused: list[str]
) -> None:
    sources = _player_library().load_lock(target)["sources"]
    names = [record["name"] for record in sources]
    assert names[:4] == reused
    assert {"libplacebo", "glslang", "SPIRV-Cross", "meson", "pipewire"} <= set(names)
    assert next(record for record in sources if record["name"] == "ffmpeg")["version"] == "7.1.1"
    for record in sources:
        assert record["url"].startswith("https://")
        assert re.fullmatch(r"[0-9a-f]{64}", record["sha256"])
        assert record["size_bytes"] > 0
        assert record["license"]["spdx"] and record["license"]["text_path"]


@pytest.mark.parametrize("destination", ["../outside", "/root/3rdparty", "3rdparty\\glad"])
def test_sources_that_would_land_outside_the_tree_are_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, destination: str
) -> None:
    module = _player_library()
    lock = json.loads(module.LOCK_PATH.read_text(encoding="utf-8"))
    lock["sources"][1]["destination"] = destination
    path = tmp_path / "player-sources.lock.json"
    path.write_text(json.dumps(lock), encoding="utf-8")
    monkeypatch.setattr(module, "LOCK_PATH", path)
    with pytest.raises(module.BuildError):
        module.load_lock("windows")


@pytest.mark.parametrize("target", ["windows", "linux"])
def test_the_player_ffmpeg_carries_its_own_lgpl_license(target: str) -> None:
    sources = _player_library().load_lock(target)["sources"]
    ffmpeg = next(record for record in sources if record["name"] == "ffmpeg")
    assert ffmpeg["license"] == {"spdx": "LGPL-2.1-or-later", "text_path": "COPYING.LGPLv2.1"}


def _archive(cache: Path, root: str, files: dict[str, bytes]) -> dict:
    path = cache / f"{root}.tar.gz"
    with tarfile.open(path, "w:gz") as bundle:
        for name, contents in files.items():
            info = tarfile.TarInfo(f"{root}/{name}")
            info.size = len(contents)
            bundle.addfile(info, io.BytesIO(contents))
    return {
        "name": root.split("-")[0],
        "version": "1.0",
        "filename": path.name,
        "url": "https://example.invalid/" + path.name,
        "size_bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "archive_root": root,
        "license": {"spdx": "MIT", "text_path": "COPYING"},
    }


def test_license_texts_come_out_of_the_verified_archives(tmp_path: Path) -> None:
    module = _player_library()
    cache = tmp_path / "cache"
    cache.mkdir()
    lock = {"sources": [_archive(cache, "alpha-1.0", {"COPYING": b"alpha terms"})]}

    written = module.write_licenses(lock, cache, tmp_path / "out")

    assert written[0]["file"] == "licenses/alpha/COPYING"
    assert (tmp_path / "out/licenses/alpha/COPYING").read_bytes() == b"alpha terms"
    assert written[0]["sha256"] == hashlib.sha256(b"alpha terms").hexdigest()
    lock["sources"][0]["license"]["text_path"] = "LICENSE"
    with pytest.raises(module.BuildError, match="no license text"):
        module.write_licenses(lock, cache, tmp_path / "out")


def test_the_source_archive_holds_everything_to_build_the_library_again(tmp_path: Path) -> None:
    module = _player_library()
    cache = tmp_path / "cache"
    cache.mkdir()
    record = _archive(cache, "alpha-1.0", {"COPYING": b"alpha terms"})
    lock = {"sources": [record], "ffmpeg_lock": "packaging/ffmpeg-linux-sources.lock.json"}
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()

    archive = module.write_source_archive("linux", lock, cache, first)

    with tarfile.open(archive) as bundle:
        names = set(bundle.getnames())
    assert {
        "player-source/sources/alpha-1.0.tar.gz",
        "player-source/packaging/build-player-sdk-linux.sh",
        "player-source/packaging/build-player-linux.sh",
        "player-source/packaging/player-sources.lock.json",
        "player-source/packaging/ffmpeg-linux-sources.lock.json",
        "player-source/scripts/player_library.py",
        "player-source/src-tauri/native/player/engine.c",
        "player-source/src-tauri/native/player/tuck_video.h",
    } <= names
    again = module.write_source_archive("linux", lock, cache, second)
    assert again.read_bytes() == archive.read_bytes(), "the same inputs give the same archive"
