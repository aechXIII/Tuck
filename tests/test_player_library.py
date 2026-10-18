"""The native player's source lock names verifiable inputs and reuses the export FFmpeg sources."""

import importlib.util
import json
import re
import sys
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
    assert {"libplacebo", "glslang", "SPIRV-Cross", "meson"} <= set(names)
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
