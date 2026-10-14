"""Reject missing or altered inputs before packaging Windows media tools."""

from __future__ import annotations

import hashlib
import importlib.util
import io
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
        "zimg",
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


def test_download_retries_a_truncated_response(tmp_path, monkeypatch):
    module = builder()
    content = b"verified source archive"
    record = {
        "filename": "source.tar.gz",
        "url": "https://example.test/source.tar.gz",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    responses = iter((io.BytesIO(content[:-1]), io.BytesIO(content)))
    calls = 0

    def open_source(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    monkeypatch.setattr(module, "urlopen", open_source)

    assert module.download(record, tmp_path).read_bytes() == content
    assert calls == 2


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


def test_source_links_are_never_extracted(tmp_path):
    import io
    import tarfile

    module = builder()
    path = tmp_path / "links.tar"
    with tarfile.open(path, "w") as archive:
        info = tarfile.TarInfo("source/src/header.h")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
        link = tarfile.TarInfo("source/doc/header.h")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        archive.addfile(link)
    module.extract_source(path, "source", tmp_path / "extracted")

    assert (tmp_path / "extracted/source/src/header.h").read_bytes() == b"x"
    assert not (tmp_path / "extracted/source/doc/header.h").exists()
    assert not (tmp_path / "extracted/source/doc/header.h").is_symlink()


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


def test_source_archive_includes_verified_mixing_code(source_bundle):
    import tarfile

    module, bundle, _sources = source_bundle
    inputs = module.load_lock()["recipe"].get("inputs", [])
    assert {record["path"] for record in inputs} == {
        "packaging/ffmpeg-mix-integer.h",
        "packaging/ffmpeg-mix-integer.patch",
    }
    with tarfile.open(bundle) as archive:
        for record in inputs:
            member = archive.extractfile(f"ffmpeg-source/{Path(record['path']).name}")
            assert member is not None
            contents = member.read()
            assert len(contents) == record["size_bytes"]
            assert hashlib.sha256(contents).hexdigest() == record["sha256"]


def test_changed_mixing_code_in_source_archive_is_rejected(source_bundle, tmp_path):
    import tarfile

    module, bundle, _sources = source_bundle
    altered = tmp_path / "altered.tar.xz"
    with tarfile.open(bundle) as original, tarfile.open(altered, "w:xz") as output:
        for member in original.getmembers():
            contents = original.extractfile(member).read()
            if member.name.endswith("ffmpeg-mix-integer.h"):
                contents = b"X" * len(contents)
            output.addfile(member, io.BytesIO(contents))
    with pytest.raises(module.BuildError, match="Source SHA-256 mismatch"):
        module.verify_source_bundle(altered)


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
