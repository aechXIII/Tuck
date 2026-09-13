"""Reject missing or altered inputs before packaging Windows media tools."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def builder():
    spec = importlib.util.spec_from_file_location(
        "windows_ffmpeg_test", ROOT / "scripts" / "windows_ffmpeg.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_windows_lock_pins_sources_and_hardware_support():
    module = builder()
    lock = module.load_lock()
    assert {source["name"] for source in lock["sources"]} == {
        "ffmpeg",
        "x264",
        "x265",
        "nv-codec-headers",
        "amf",
        "zlib",
        "dav1d",
    }
    assert {"libx264", "libx265", "h264_nvenc", "hevc_nvenc", "h264_amf", "hevc_amf", "aac"} <= set(
        lock["output"]["encoders"]
    )


def test_missing_source_bundle_blocks_release(tmp_path):
    module = builder()
    with pytest.raises(module.BuildError, match="source archive"):
        module.verify_source_bundle(tmp_path / module.SOURCE_BUNDLE)


def test_changed_recipe_is_rejected(tmp_path):
    module = builder()
    lock = module.load_lock()
    recipe = tmp_path / "recipe.sh"
    recipe.write_text("exit 0\n")
    with pytest.raises(module.BuildError, match=r"SHA-256|size"):
        module.verify_file(recipe, lock["recipe"])


def test_unsafe_source_member_is_rejected(tmp_path):
    import io
    import tarfile

    module = builder()
    path = tmp_path / "unsafe.tar"
    with tarfile.open(path, "w") as archive:
        info = tarfile.TarInfo("source/../../escape")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(module.BuildError, match="Unsafe"):
        module.extract_source(path, "source", tmp_path / "extracted")
    assert not (tmp_path / "escape").exists()


@pytest.fixture
def source_bundle(tmp_path, monkeypatch):
    module = builder()
    lock = module.load_lock()
    sources = []
    for record in lock["sources"]:
        path = tmp_path / record["filename"]
        data = record["name"].encode()
        path.write_bytes(data)
        record["size_bytes"] = len(data)
        record["sha256"] = hashlib.sha256(data).hexdigest()
        sources.append(path)
    lock_path = tmp_path / "lock.json"
    lock_path.write_text(json.dumps(lock))
    monkeypatch.setattr(module, "LOCK_PATH", lock_path)
    bundle = tmp_path / module.SOURCE_BUNDLE
    module.write_source_bundle(lock, sources, bundle)
    return module, bundle, sources


def test_source_archive_matches_every_locked_input(source_bundle):
    module, bundle, _sources = source_bundle
    module.verify_source_bundle(bundle)


def test_changed_source_bytes_are_rejected(source_bundle):
    module, bundle, sources = source_bundle
    sources[0].write_bytes(b"X" * sources[0].stat().st_size)
    module.write_source_bundle(module.load_lock(), sources, bundle)
    with pytest.raises(module.BuildError, match="Source SHA-256 mismatch"):
        module.verify_source_bundle(bundle)


def test_mismatched_binary_is_rejected(source_bundle, tmp_path):
    module, bundle, _sources = source_bundle
    lock = module.load_lock()
    names = {
        *lock["output"]["executables"],
        "build-environment.txt",
        "Toolchain-LICENSE.txt",
        *[f"{s['name']}-LICENSE.txt" for s in lock["sources"]],
    }
    tools = tmp_path / "tools"
    tools.mkdir()
    files = {}
    for name in names:
        path = tools / name
        path.write_bytes(b"original")
        files[name] = {"size_bytes": path.stat().st_size, "sha256": module.sha256(path)}
    manifest = {
        "lock_sha256": module.sha256(module.LOCK_PATH),
        "source_archive": {"size_bytes": bundle.stat().st_size, "sha256": module.sha256(bundle)},
        "files": files,
    }
    (tools / "build-manifest.json").write_text(json.dumps(manifest))
    module.verify_tools(tools, bundle, runtime=False)
    extra = tools / "unexpected.dll"
    extra.write_bytes(b"untracked runtime")
    with pytest.raises(module.BuildError, match="Unexpected Windows FFmpeg files"):
        module.verify_tools(tools, bundle, runtime=False)
    extra.unlink()
    (tools / "ffmpeg.exe").write_bytes(b"tampered")
    with pytest.raises(module.BuildError, match="File SHA-256 mismatch"):
        module.verify_tools(tools, bundle, runtime=False)
