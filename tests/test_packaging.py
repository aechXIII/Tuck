"""Packaging resource-resolution behavior.

These protect the contract that a packaged Tuck honors an explicit valid tool
choice, otherwise uses its verified bundle before machine-wide discovery.
Build-artifact inspection lives in ``scripts/verify_package.py``; this file
covers the pure resolution logic that both the sidecar and the CLI depend on.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

import tuck.media_tools as media_tools
import tuck.packaged as packaged

_REPO = Path(__file__).resolve().parent.parent
_LOCK = _REPO / "packaging" / "ffmpeg-sources.lock.json"
_LINUX_LOCK = _REPO / "packaging" / "ffmpeg-linux-sources.lock.json"
_STAGING_MANIFEST = _REPO / "packaging" / "staging" / "manifest.json"
_WEBVIEW2_LOCK = _REPO / "packaging" / "webview2-bootstrapper.lock.json"
_VERIFY_PACKAGE = _REPO / "scripts" / "verify_package.py"
_BUILD_LINUX = _REPO / "scripts" / "build_linux.py"


def _player_build(root: Path, target: str) -> Path:
    """A finished player library build as scripts/player_library.py leaves it"""
    import player_library

    folder = root / target
    (folder / "licenses/libplacebo").mkdir(parents=True)
    files = {
        player_library.OUTPUTS[target]: b"player library",
        "player-source.tar.xz": b"player sources",
        "licenses/libplacebo/LICENSE": b"lgpl terms",
    }
    for name, contents in files.items():
        (folder / name).write_bytes(contents)
    digest = {name: hashlib.sha256(contents).hexdigest() for name, contents in files.items()}
    manifest = {
        "target": target,
        "library": player_library.OUTPUTS[target],
        "size_bytes": len(b"player library"),
        "sha256": digest[player_library.OUTPUTS[target]],
        "player_source_sha256": player_library.player_source_sha256(),
        "sources": [{"name": "libplacebo", "version": "7.360.1"}],
        "licenses": [
            {
                "name": "libplacebo",
                "version": "7.360.1",
                "spdx": "LGPL-2.1-or-later",
                "file": "licenses/libplacebo/LICENSE",
                "sha256": digest["licenses/libplacebo/LICENSE"],
            }
        ],
        "source_archive": {
            "file": "player-source.tar.xz",
            "size_bytes": len(b"player sources"),
            "sha256": digest["player-source.tar.xz"],
        },
    }
    (folder / "player-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


def test_the_player_library_is_staged_with_its_licenses_and_sources(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(_REPO / "scripts"))
    import player_package

    _player_build(tmp_path / "builds", "linux")
    app, held = tmp_path / "app", tmp_path / "held"
    staged = player_package.stage_player("linux", app, tmp_path / "builds", library_folder=held)

    assert (held / "libtuck_player.so").read_bytes() == b"player library"
    assert not (app / "libtuck_player.so").exists(), "the AppImage adds the library itself"
    assert (app / "licenses/native-player/libplacebo/LICENSE").read_bytes() == b"lgpl terms"
    assert (app / "native-player/player-source.tar.xz").read_bytes() == b"player sources"
    assert staged.expected_present() == [
        "libtuck_player.so",
        "native-player/player-source.tar.xz",
        "licenses/native-player/libplacebo/LICENSE",
    ]


def test_a_player_build_that_does_not_match_is_refused(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(_REPO / "scripts"))
    import player_library
    import player_package

    builds = tmp_path / "builds"
    with pytest.raises(player_library.BuildError, match=r"run scripts/player_library\.py"):
        player_package.stage_player("windows", tmp_path / "app", builds)
    folder = _player_build(builds, "windows")
    (folder / "tuck_player.dll").write_bytes(b"changed after the build")
    with pytest.raises(player_library.BuildError, match="does not match"):
        player_package.stage_player("windows", tmp_path / "app", builds)
    manifest = json.loads((folder / "player-manifest.json").read_text(encoding="utf-8"))
    manifest["player_source_sha256"] = "0" * 64
    (folder / "player-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(player_library.BuildError, match="other player sources"):
        player_package.stage_player("windows", tmp_path / "app", builds)


def test_windows_staging_puts_only_the_cli_wrapper_in_bin(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(_REPO / "scripts"))
    import build_sidecar

    staging = tmp_path / "staging"
    ffmpeg = staging / "ffmpeg"
    ffmpeg.mkdir(parents=True)
    (ffmpeg / "ffmpeg.exe").write_bytes(b"media tool")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "TuckCli.exe").write_bytes(b"cli")
    (dist / "tuck-sidecar.exe").write_bytes(b"sidecar")
    bootstrapper = tmp_path / "webview.exe"
    bootstrapper.write_bytes(b"bootstrapper")
    lock = tmp_path / "webview.json"
    lock.write_text(
        json.dumps(
            {
                "filename": bootstrapper.name,
                "size_bytes": bootstrapper.stat().st_size,
                "sha256": hashlib.sha256(bootstrapper.read_bytes()).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(build_sidecar, "STAGING", staging)
    monkeypatch.setattr(build_sidecar, "STAGING_APP", staging / "app")
    monkeypatch.setattr(build_sidecar, "STAGING_FFMPEG", ffmpeg)
    monkeypatch.setattr(build_sidecar, "WEBVIEW2_BOOTSTRAPPER", bootstrapper)
    monkeypatch.setattr(build_sidecar, "WEBVIEW2_LOCK", lock)
    _player_build(tmp_path / "player", "windows")
    monkeypatch.setattr(build_sidecar, "PLAYER_LIBRARY_ROOT", tmp_path / "player")
    manifest = build_sidecar.assemble_app(dist, [{"file": "ffmpeg/ffmpeg.exe"}])
    assert (staging / "app/bin/tuck.cmd").read_bytes() == build_sidecar.TUCK_CMD.read_bytes()
    assert (staging / "app/tuck_player.dll").read_bytes() == b"player library"
    assert "tuck_player.dll" in manifest["expected_present"]
    assert manifest["native_player"]["file"] == "tuck_player.dll"
    assert (staging / "app/TuckCli.exe").read_bytes() == b"cli"
    assert not (staging / "app/tuck.cmd").exists()
    assert "bin/tuck.cmd" in manifest["expected_present"]
    assert "tuck.cmd" not in manifest["expected_present"]


class _Settings:
    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get_setting(self, key: str, default: str = "") -> str:
        return self._values.get(key, default)


def _make_tool(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    tool = directory / packaged._tool_filename(name)
    tool.write_bytes(b"MZ")
    return tool


def _verify_package_module():
    spec = importlib.util.spec_from_file_location("verify_package_for_test", _VERIFY_PACKAGE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_package_verifier_expects_the_current_version():
    from tuck import __version__

    assert __version__ == _verify_package_module().EXPECTED_VERSION


def _build_linux_module():
    # the script imports its sibling builders by name, as it does when run directly
    sys.path.insert(0, str(_BUILD_LINUX.parent))
    try:
        spec = importlib.util.spec_from_file_location("build_linux_for_test", _BUILD_LINUX)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(_BUILD_LINUX.parent))


def test_explicit_env_path_is_used_when_it_exists(tmp_path: Path, monkeypatch) -> None:
    ffmpeg = _make_tool(tmp_path / "tools", "ffmpeg")
    monkeypatch.setenv(packaged.FFMPEG_ENV, str(ffmpeg))

    assert packaged.bundled_media_tool("ffmpeg") == ffmpeg


def test_explicit_env_path_is_ignored_when_missing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(packaged.FFPROBE_ENV, str(tmp_path / "nope" / "ffprobe.exe"))
    monkeypatch.delenv(packaged.TOOLS_DIR_ENV, raising=False)
    monkeypatch.setattr(packaged, "is_frozen", lambda: False)

    assert packaged.bundled_media_tool("ffprobe") is None


def test_tools_dir_env_resolves_each_tool(tmp_path: Path, monkeypatch) -> None:
    tools = tmp_path / "with space" / "ünïcode"
    ffmpeg = _make_tool(tools, "ffmpeg")
    ffprobe = _make_tool(tools, "ffprobe")
    monkeypatch.delenv(packaged.FFMPEG_ENV, raising=False)
    monkeypatch.delenv(packaged.FFPROBE_ENV, raising=False)
    monkeypatch.setenv(packaged.TOOLS_DIR_ENV, str(tools))

    assert packaged.bundled_media_tool("ffmpeg") == ffmpeg
    assert packaged.bundled_media_tool("ffprobe") == ffprobe


def test_unbundled_checkout_returns_none(monkeypatch) -> None:
    monkeypatch.delenv(packaged.FFMPEG_ENV, raising=False)
    monkeypatch.delenv(packaged.FFPROBE_ENV, raising=False)
    monkeypatch.delenv(packaged.TOOLS_DIR_ENV, raising=False)
    monkeypatch.setattr(packaged, "is_frozen", lambda: False)

    assert packaged.bundled_media_tool("ffmpeg") is None


def test_frozen_layout_finds_tools_next_to_executable(tmp_path: Path, monkeypatch) -> None:
    install = tmp_path / "Program Files" / "Tuck"
    ffmpeg = _make_tool(install / "ffmpeg", "ffmpeg")
    monkeypatch.delenv(packaged.FFMPEG_ENV, raising=False)
    monkeypatch.delenv(packaged.TOOLS_DIR_ENV, raising=False)
    monkeypatch.setattr(packaged, "is_frozen", lambda: True)
    monkeypatch.setattr(packaged, "executable_dir", lambda: install)

    assert packaged.bundled_media_tool("ffmpeg") == ffmpeg


def test_unknown_tool_name_is_rejected() -> None:
    with pytest.raises(ValueError):
        packaged.bundled_media_tool("mplayer")


def test_configured_tool_beats_bundled_and_path(tmp_path: Path, monkeypatch) -> None:
    bundled = _make_tool(tmp_path / "bundle", "ffmpeg")
    configured = _make_tool(tmp_path / "user", "ffmpeg")
    monkeypatch.setattr(media_tools, "bundled_media_tool", lambda name: bundled)
    monkeypatch.setattr(
        media_tools, "get_settings_manager", lambda: _Settings({"ffmpeg_path": str(configured)})
    )
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: pytest.fail(f"PATH consulted for {name} despite a configured tool"),
    )

    assert media_tools.find_ffmpeg() == str(configured)


def test_configured_path_used_when_not_bundled(tmp_path: Path, monkeypatch) -> None:
    configured = _make_tool(tmp_path / "user", "ffprobe")
    monkeypatch.setattr(media_tools, "bundled_media_tool", lambda name: None)
    monkeypatch.setattr(
        media_tools, "get_settings_manager", lambda: _Settings({"ffprobe_path": str(configured)})
    )
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: pytest.fail("PATH consulted despite a valid configured path"),
    )

    assert media_tools.find_ffprobe() == str(configured)


def test_path_discovery_is_last_resort(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(media_tools, "bundled_media_tool", lambda name: None)
    monkeypatch.setattr(media_tools, "get_settings_manager", lambda: _Settings({}))
    monkeypatch.setattr(media_tools.shutil, "which", lambda name: str(tmp_path / f"{name}.exe"))

    assert media_tools.find_ffmpeg() == str(tmp_path / "ffmpeg.exe")


def test_ffmpeg_lock_is_complete_and_redistributable() -> None:
    module = _verify_package_module().windows_ffmpeg
    lock = module.load_lock()
    assert lock["output"]["license"] == "GPL-2.0-or-later"
    assert "--enable-gpl" in lock["output"]["configure_flags_required"]
    assert lock["output"]["executables"] == ["ffmpeg.exe", "ffprobe.exe"]


def test_linux_ffmpeg_lock_completely_pins_the_source_build() -> None:
    lock = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))

    assert lock["lockfile_version"] == 2
    assert lock["platform"] == "linux"
    assert lock["architecture"] == "x86_64"
    assert lock["build_platform"] == {
        "distribution": "Ubuntu",
        "version": "22.04",
        "native_only": True,
        "libc_linkage": "dynamic",
    }
    assert "John Van Sickle" not in _LINUX_LOCK.read_text(encoding="utf-8")

    recipe = lock["recipe"]
    recipe_path = _REPO / recipe["path"]
    assert recipe_path.is_file()
    assert recipe_path.stat().st_size == recipe["size_bytes"]
    assert hashlib.sha256(recipe_path.read_bytes()).hexdigest() == recipe["sha256"]

    sources = {source["name"]: source for source in lock["sources"]}
    assert set(sources) == {
        "ffmpeg",
        "x264",
        "x265",
        "zimg",
        "dav1d",
        "nv-codec-headers",
        "libva",
        "libdrm",
    }
    for name, source in sources.items():
        assert source["url"].startswith("https://")
        assert len(source["sha256"]) == 64
        assert source["size_bytes"] > 0
        assert source["archive_root"]
        assert source["license"] == {
            "spdx": {
                "zimg": "WTFPL",
                "dav1d": "BSD-2-Clause",
                "nv-codec-headers": "MIT",
                "libva": "MIT",
                "libdrm": "MIT",
            }.get(name, "GPL-2.0-or-later"),
            "text_path": source["license"]["text_path"],
        }
    for name in ("x265", "zimg"):
        assert len(sources[name]["revision"]) == 40
        assert sources[name]["revision"] in sources[name]["url"]

    output = lock["output"]
    assert output["executables"] == ["ffmpeg", "ffprobe"]
    assert {"--enable-gpl", "--enable-libx264", "--enable-libx265", "--enable-libzimg"} <= set(
        output["license"]["configure_flags_required"]
    )
    assert "--static" in output["license"]["configure_flags_forbidden"]
    assert output["runtime_dependency"] == "libc.so.6"
    assert output["forbidden_runtime_dependencies"] == [
        "libx264",
        "libx265",
        "libzimg",
        "libdav1d",
        "libva",
        "libdrm",
    ]
    # ffmpeg must start on systems without screen-capture libraries
    assert output["unused_runtime_dependencies"] == ["libxcb"]
    assert {"--disable-libdrm", "--disable-libxcb"} <= set(
        output["license"]["configure_flags_required"]
    )


def test_both_ffmpeg_builds_decode_av1_in_software() -> None:
    windows = json.loads(_LOCK.read_text(encoding="utf-8"))
    linux = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))

    # FFmpeg's built-in AV1 decoder needs a GPU, so without dav1d AV1 videos can't be exported
    assert "libdav1d" in windows["output"]["decoders"]
    assert "libdav1d" in linux["output"]["required_decoders"]
    for lock in (windows, linux):
        dav1d = next(source for source in lock["sources"] if source["name"] == "dav1d")
        recipe = (_REPO / lock["recipe"]["path"]).read_text(encoding="utf-8")
        assert dav1d["archive_root"] in recipe
        assert "--enable-libdav1d" in recipe


def test_linux_gpu_encoding_and_decoding_have_pinned_headers():
    windows = json.loads(_LOCK.read_text(encoding="utf-8"))
    linux = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))
    headers = next((item for item in linux["sources"] if item["name"] == "nv-codec-headers"), None)
    assert headers == next(
        item for item in windows["sources"] if item["name"] == "nv-codec-headers"
    )
    flags = set(linux["output"]["license"]["configure_flags_required"])
    assert {"--enable-ffnvcodec", "--enable-nvdec", "--enable-nvenc"} <= flags
    assert "hwdownload" in linux["output"]["required_filters"]


def test_linux_bundle_requires_h264_and_hevc_nvenc_without_av1() -> None:
    output = _build_linux_module().load_lock()["output"]
    assert {"h264_nvenc", "hevc_nvenc"} <= set(output["required_encoders"])
    assert not {"h264_nvenc", "hevc_nvenc"} & set(output["forbidden_encoders"])
    assert "av1_nvenc" in output["forbidden_encoders"]


def test_linux_vaapi_uses_locked_static_libraries() -> None:
    build_linux = _build_linux_module()
    lock = build_linux.load_lock()
    sources = {source["name"]: source for source in lock["sources"]}

    assert sources["libva"]["version"] == "2.24.1"
    assert sources["libva"]["license"]["spdx"] == "MIT"
    assert sources["libdrm"]["version"] == "2.4.124"
    assert sources["libdrm"]["license"]["spdx"] == "MIT"
    assert "--enable-vaapi" in lock["output"]["license"]["configure_flags_required"]
    assert set(lock["output"]["required_hwaccels"]) == {"cuda", "vaapi"}
    assert {"libva", "libdrm"} <= set(lock["output"]["forbidden_runtime_dependencies"])


def test_linux_vaapi_searches_system_driver_paths_across_distributions() -> None:
    recipe = (_REPO / "packaging/build-ffmpeg-linux.sh").read_text(encoding="utf-8")

    assert "-Ddriverdir=/usr/lib/x86_64-linux-gnu/dri:/usr/lib/dri:/usr/lib64/dri" in recipe


def test_linux_bundle_requires_supported_vaapi_encoders_and_upload() -> None:
    lock = _build_linux_module().load_lock()
    output = lock["output"]
    assert {"h264_vaapi", "hevc_vaapi"} <= set(output["required_encoders"])
    assert "hwupload" in output["required_filters"]
    assert not {"h264_vaapi", "hevc_vaapi"} & set(output["forbidden_encoders"])


@pytest.mark.parametrize(
    ("hardware", "forbidden_encoder", "missing_encoder"),
    [
        (None, None, None),
        ("cuda", None, None),
        ("vaapi", None, None),
        (None, "av1_vaapi", None),
        (None, "av1_nvenc", None),
        (None, None, "h264_nvenc"),
        (None, None, "hevc_nvenc"),
    ],
)
@pytest.mark.parametrize("validator", ["build", "package"])
def test_linux_runtime_validation_requires_gpu_decode_and_cpu_encoding(
    tmp_path: Path,
    monkeypatch,
    hardware: str | None,
    forbidden_encoder: str | None,
    missing_encoder: str | None,
    validator: str,
) -> None:
    build_linux = _build_linux_module()
    lock = build_linux.load_lock()
    output = lock["output"]
    output["required_hwaccels"] = ["cuda", "vaapi"]
    flags = [
        f"--disable-encoder='{flag.removeprefix('--disable-encoder=')}'"
        if flag.startswith("--disable-encoder=")
        else flag
        for flag in output["license"]["configure_flags_required"]
    ]
    responses = {
        "-buildconf": "\n".join(flags),
        "-encoders": "\n".join(
            f" {name}" for name in output["required_encoders"] if name != missing_encoder
        ),
        "-decoders": "\n".join(f" {name}" for name in output["required_decoders"]),
        "-filters": "\n".join(f" {name}" for name in output["required_filters"]),
        "-hwaccels": "Hardware acceleration methods:\n"
        + "\n".join(name for name in ("cuda", "vaapi") if name != hardware),
    }
    if forbidden_encoder:
        responses["-encoders"] += f"\n {forbidden_encoder}"
    responses[str(tmp_path / "ffmpeg")] = "libc.so.6"
    responses[str(tmp_path / "ffmpeg" / "ffmpeg")] = "libc.so.6"
    monkeypatch.setattr(
        build_linux.subprocess,
        "run",
        lambda args, **_kwargs: subprocess.CompletedProcess(args, 0, responses[args[-1]], ""),
    )

    if validator == "build":
        validate = build_linux.validate_ffmpeg_runtime
        error = build_linux.BuildError
        args = (lock, tmp_path)
    else:
        verify_package = _verify_package_module()
        validate = verify_package._validate_linux_ffmpeg_runtime
        error = verify_package.VerifyError
        args = (tmp_path, lock)
    if hardware:
        with pytest.raises(error, match=f"missing hardware acceleration {hardware}"):
            validate(*args)
    elif forbidden_encoder:
        with pytest.raises(error, match=f"must not include encoder {forbidden_encoder}"):
            validate(*args)
    elif missing_encoder:
        with pytest.raises(error, match=f"missing encoder {missing_encoder}"):
            validate(*args)
    else:
        validate(*args)


def test_both_ffmpeg_recipes_pin_the_same_mixing_code() -> None:
    records = []
    for lock_path in (_LOCK, _LINUX_LOCK):
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        inputs = lock["recipe"].get("inputs", [])
        assert {record["path"] for record in inputs} == {
            "packaging/ffmpeg-mix-integer.h",
            "packaging/ffmpeg-mix-integer.patch",
        }
        for record in inputs:
            data = (_REPO / record["path"]).read_bytes()
            assert len(data) == record["size_bytes"]
            assert hashlib.sha256(data).hexdigest() == record["sha256"]
        records.append(inputs)
    assert records[0] == records[1]


def test_both_ffmpeg_locks_require_the_tone_map_filters() -> None:
    from tuck.encoding.capabilities import TONE_MAP_FILTERS

    windows = json.loads(_LOCK.read_text(encoding="utf-8"))
    linux = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))

    # a build that drops zimg would still pass every other check and quietly lose HDR to SDR
    assert set(windows["output"]["filters"]) >= TONE_MAP_FILTERS
    assert set(linux["output"]["required_filters"]) >= TONE_MAP_FILTERS
    assert "--enable-libzimg" in windows["output"]["configure_flags_required"]
    assert "--enable-libzimg" in linux["output"]["license"]["configure_flags_required"]


def test_ffmpeg_recipes_build_the_locked_zimg() -> None:
    for lock_path in (_LOCK, _LINUX_LOCK):
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        zimg = next(source for source in lock["sources"] if source["name"] == "zimg")
        recipe = (_REPO / lock["recipe"]["path"]).read_text(encoding="utf-8")

        # the recipes name the extracted directory, so it must follow the locked revision
        assert zimg["archive_root"] in recipe
        assert "--enable-libzimg" in recipe


@pytest.mark.parametrize("license_id", ["GPL-2.0-or-later", None])
@pytest.mark.parametrize("source_name", ["zimg", "libva", "libdrm"])
def test_linux_lock_requires_each_library_under_its_own_license(
    tmp_path: Path, monkeypatch, license_id: str | None, source_name: str
) -> None:
    build_linux = _build_linux_module()
    verify_package = _verify_package_module()
    lock = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))
    library = next(source for source in lock["sources"] if source["name"] == source_name)
    if license_id is None:
        lock["sources"].remove(library)
    else:
        library["license"]["spdx"] = license_id
    lock_path = tmp_path / "ffmpeg-linux-sources.lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    monkeypatch.setattr(build_linux, "LOCK_PATH", lock_path)

    with pytest.raises(build_linux.BuildError, match=r"zimg|provenance is incomplete"):
        build_linux.load_lock()
    with pytest.raises(verify_package.VerifyError, match="incomplete"):
        verify_package._validate_linux_lock(lock)


def test_linux_build_rejects_incomplete_source_provenance(tmp_path: Path, monkeypatch) -> None:
    build_linux = _build_linux_module()
    incomplete = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))
    del incomplete["sources"][0]["archive_root"]
    lock_path = tmp_path / "ffmpeg-linux-sources.lock.json"
    lock_path.write_text(json.dumps(incomplete), encoding="utf-8")
    monkeypatch.setattr(build_linux, "LOCK_PATH", lock_path)

    with pytest.raises(build_linux.BuildError, match="provenance is incomplete"):
        build_linux.load_lock()


@pytest.mark.parametrize("tamper", [False, True])
def test_linux_source_archive_verifies_mixing_inputs(tmp_path: Path, monkeypatch, tamper) -> None:
    import io
    import tarfile

    build_linux = _build_linux_module()
    verify_package = _verify_package_module()
    lock = build_linux.load_lock()
    sources = []
    for record in lock["sources"]:
        source = tmp_path / record["filename"]
        source.write_bytes(record["name"].encode())
        record["size_bytes"] = source.stat().st_size
        record["sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        sources.append((record, source))
    lock_path = tmp_path / "packaging" / "ffmpeg-linux-sources.lock.json"
    lock_path.parent.mkdir()
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    monkeypatch.setattr(build_linux, "LOCK_PATH", lock_path)
    monkeypatch.setattr(build_linux, "FFMPEG_BUILD", tmp_path / "build")
    monkeypatch.setattr(verify_package, "ROOT", tmp_path)
    bundle = build_linux.build_source_archive(lock, sources)
    target = tmp_path / "app" / "ffmpeg" / "source" / "ffmpeg-source.tar.xz"
    target.parent.mkdir(parents=True)
    with tarfile.open(bundle) as original, tarfile.open(target, "w:xz") as output:
        for member in original.getmembers():
            contents = original.extractfile(member).read()
            if tamper and member.name.endswith("ffmpeg-mix-integer.h"):
                contents = b"X" * len(contents)
            output.addfile(member, io.BytesIO(contents))
    manifest = {
        "ffmpeg_provenance": {
            "lock_file": "packaging/ffmpeg-linux-sources.lock.json",
            "lock_sha256": hashlib.sha256(lock_path.read_bytes()).hexdigest(),
            "recipe": lock["recipe"],
            "source_archive": {
                "file": "ffmpeg/source/ffmpeg-source.tar.xz",
                "size_bytes": target.stat().st_size,
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            },
        }
    }
    if tamper:
        with pytest.raises(verify_package.VerifyError, match="mixing input does not match"):
            verify_package._validate_linux_source_archive(tmp_path / "app", manifest, lock)
    else:
        verify_package._validate_linux_source_archive(tmp_path / "app", manifest, lock)


def test_linux_build_leaves_source_links_out_of_the_extracted_tree(
    tmp_path: Path, monkeypatch
) -> None:
    import io
    import tarfile

    build_linux = _build_linux_module()
    monkeypatch.setattr(build_linux, "FFMPEG_BUILD", tmp_path / "build")
    archive_path = tmp_path / "source.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        license_file = tarfile.TarInfo("source/COPYING")
        license_file.size = 7
        archive.addfile(license_file, io.BytesIO(b"license"))
        link = tarfile.TarInfo("source/doc/example.h")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        archive.addfile(link)
    record = {"archive_root": "source", "license": {"text_path": "COPYING"}}

    source_root = build_linux._extract_sources([(record, archive_path)])

    assert (source_root / "source" / "COPYING").read_bytes() == b"license"
    assert not (source_root / "source" / "doc" / "example.h").is_symlink()
    assert not (source_root / "source" / "doc" / "example.h").exists()


def test_dav1d_plugin_lock_pins_an_immutable_crate_archive(tmp_path: Path, monkeypatch) -> None:
    build_linux = _build_linux_module()
    source = build_linux.load_gst_dav1d_lock()["source"]

    assert source["url"].startswith("https://static.crates.io/crates/gst-plugin-dav1d/")
    assert source["filename"] == source["url"].rsplit("/", 1)[1]
    assert source["license"]["spdx"] == "MIT OR Apache-2.0"

    for change in (
        {"url": "https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/archive/x.tar.gz"},
        {"license": {"spdx": "GPL-2.0-or-later", "text_paths": ["COPYING"]}},
        {"license": {"spdx": "MIT OR Apache-2.0", "text_paths": []}},
    ):
        lock = json.loads(build_linux.GST_DAV1D_LOCK_PATH.read_text(encoding="utf-8"))
        lock["source"].update(change)
        lock_path = tmp_path / "gst-dav1d-linux.lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        monkeypatch.setattr(build_linux, "GST_DAV1D_LOCK_PATH", lock_path)
        with pytest.raises(build_linux.BuildError, match="provenance is incomplete"):
            build_linux.load_gst_dav1d_lock()


def test_appimage_gui_smoke_runs_apprun_as_the_appimage_runtime_would(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location(
        "smoke_appimage_gui_for_test", _REPO / "scripts" / "smoke_appimage_gui.py"
    )
    assert spec is not None and spec.loader is not None
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    app_root = tmp_path / "squashfs-root"

    environment = smoke.launch_environment({"DISPLAY": ":0"}, app_root, tmp_path / "data")

    assert environment["APPDIR"] == str(app_root)
    assert environment["DISPLAY"] == ":0"
    assert environment["TUCK_SIDECAR_DATA_ROOT"] == str(tmp_path / "data")


def test_linux_package_verifier_requires_the_staged_dav1d_plugin(tmp_path: Path) -> None:
    verify_package = _verify_package_module()
    plugin = tmp_path / "gstreamer" / "libgstdav1d.so"
    plugin.parent.mkdir()
    plugin.write_bytes(b"plugin")
    record = {
        "file": "gstreamer/libgstdav1d.so",
        "sha256": hashlib.sha256(b"plugin").hexdigest(),
        "size_bytes": 6,
        "element": "dav1ddec",
    }

    verify_package._validate_linux_gstreamer_plugins(tmp_path, {"gstreamer_plugins": [record]})

    plugin.write_bytes(b"changed")
    with pytest.raises(verify_package.VerifyError, match="does not match the staging manifest"):
        verify_package._validate_linux_gstreamer_plugins(tmp_path, {"gstreamer_plugins": [record]})
    with pytest.raises(verify_package.VerifyError, match="must include the dav1d"):
        verify_package._validate_linux_gstreamer_plugins(tmp_path, {"gstreamer_plugins": []})


def test_linux_package_verifier_rejects_incomplete_source_provenance() -> None:
    verify_package = _verify_package_module()
    incomplete = json.loads(_LINUX_LOCK.read_text(encoding="utf-8"))
    del incomplete["recipe"]["sha256"]

    with pytest.raises(verify_package.VerifyError, match="recipe provenance is incomplete"):
        verify_package._validate_linux_lock(incomplete)


def test_linux_build_contract_has_one_sidecar_and_an_appimage_overlay() -> None:
    build_script = (_REPO / "scripts" / "build_linux.py").read_text(encoding="utf-8")
    shell_script = (_REPO / "scripts" / "build-linux.sh").read_text(encoding="utf-8")
    spec = (_REPO / "scripts" / "tuck-sidecar-linux.spec").read_text(encoding="utf-8")
    config = json.loads((_REPO / "src-tauri" / "tauri.linux.conf.json").read_text(encoding="utf-8"))

    assert "ffmpeg-linux-sources.lock.json" in build_script
    assert "ensure_source_archives" in build_script
    assert "build_source_archive" in build_script
    assert "validate_ffmpeg_runtime" in build_script
    assert "THIRD_PARTY_NOTICES_LINUX.md" in build_script
    assert "packaging" in build_script and "staging" in build_script
    assert 'name="tuck-sidecar"' in spec
    assert "tuck.cli" in spec and "pywin32" in spec
    excludes = spec.split("_excludes", maxsplit=1)[1]
    assert '"tuck.app"' in excludes and '"packaging"' in excludes
    assert "TuckCli" not in spec.split("_excludes", maxsplit=1)[0]
    assert config["bundle"]["targets"] == ["appimage"]
    assert config["bundle"]["resources"] == {"../packaging/staging/linux/app/": "./"}
    assert all(icon.endswith(".png") for icon in config["bundle"]["icon"])
    # preview playback needs the GStreamer plugins bundled into the AppImage
    assert config["bundle"]["linux"]["appimage"]["bundleMediaFramework"] is True
    assert "gst-inspect-1.0 autoaudiosink" in shell_script
    assert "npm run tauri build -- --bundles appimage" in shell_script
    assert "build-ffmpeg-linux.sh" not in shell_script
    assert "tauri.linux.conf.json" not in shell_script
    assert "verify_package.py --platform linux --artifact" in shell_script
    assert "smoke_appimage_gui.py --artifact" in shell_script
    assert "smoke_packaged.py --platform linux --artifact" in shell_script
    assert "libwayland-client.so.0" in shell_script
    assert "mksquashfs" in shell_script
    assert "host libwayland-client" in _VERIFY_PACKAGE.read_text(encoding="utf-8")


def test_webview2_bootstrapper_matches_its_lock() -> None:
    lock = json.loads(_WEBVIEW2_LOCK.read_text(encoding="utf-8"))
    bootstrapper = _REPO / "scripts" / lock["filename"]

    assert bootstrapper.stat().st_size == lock["size_bytes"]
    assert hashlib.sha256(bootstrapper.read_bytes()).hexdigest() == lock["sha256"]


def test_tauri_uses_the_pinned_webview2_bootstrapper_and_app_browser_policy() -> None:
    config = json.loads((_REPO / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    windows_config = json.loads(
        (_REPO / "src-tauri" / "tauri.windows.conf.json").read_text(encoding="utf-8")
    )
    window = config["app"]["windows"][0]
    csp = config["app"]["security"]["csp"]

    assert windows_config["bundle"]["windows"]["webviewInstallMode"]["type"] == "skip"
    assert window["devtools"] is False
    assert window["zoomHotkeysEnabled"] is False
    assert "http://localhost:*" not in csp

    windows_host = (_REPO / "src-tauri" / "src" / "platform" / "windows.rs").read_text(
        encoding="utf-8"
    )
    assert "SetAreDefaultContextMenusEnabled(false)" in windows_host
    assert "SetAreBrowserAcceleratorKeysEnabled(false)" in windows_host


def test_package_verification_times_out_when_a_living_sidecar_is_silent(
    tmp_path, monkeypatch
) -> None:
    verify_package = _verify_package_module()
    real_popen = subprocess.Popen
    monkeypatch.setattr(verify_package, "_SIDECAR_STARTUP_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(
        verify_package.subprocess,
        "Popen",
        lambda *_args, **kwargs: real_popen(
            [sys.executable, "-c", "import time; time.sleep(30)"], **kwargs
        ),
    )

    started = time.monotonic()
    with pytest.raises(verify_package.VerifyError, match="did not report readiness"):
        verify_package.start_sidecar(tmp_path)

    assert time.monotonic() - started < 2


needs_staging = pytest.mark.skipif(
    not _STAGING_MANIFEST.is_file(),
    reason="run scripts/build_sidecar.py first (packaging/staging/manifest.json absent)",
)


@needs_staging
def test_staging_tree_passes_verification() -> None:
    result = subprocess.run(
        [sys.executable, str(_REPO / "scripts" / "verify_package.py"), "--staging"],
        capture_output=True,
        text=True,
        cwd=str(_REPO),
        timeout=180,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@needs_staging
@pytest.mark.slow
@pytest.mark.ffmpeg
def test_packaged_backend_smoke() -> None:
    result = subprocess.run(
        [sys.executable, str(_REPO / "scripts" / "smoke_packaged.py"), "--staging"],
        capture_output=True,
        text=True,
        cwd=str(_REPO),
        timeout=600,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_linux_sidecar_starts_without_the_modules_its_package_leaves_out() -> None:
    spec = (_REPO / "scripts" / "tuck-sidecar-linux.spec").read_text(encoding="utf-8")
    excludes = spec.split("_excludes = [", 1)[1].split("]", 1)[0]
    left_out = [
        name.strip().strip('",')
        for name in excludes.splitlines()
        if name.strip().startswith('"tuck.')
    ]
    assert "tuck.sendto" in left_out

    # a fresh interpreter, so modules imported by other tests don't hide the import chain
    script = (
        "import sys, tuck.sidecar.__main__\n"
        f"print([name for name in {left_out!r} if name in sys.modules])\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=_REPO,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "[]"


def test_the_package_check_refuses_a_missing_or_changed_player(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(_REPO / "scripts"))
    import player_package

    verify_package = _verify_package_module()
    _player_build(tmp_path / "builds", "windows")
    app = tmp_path / "app"
    staged = player_package.stage_player("windows", app, tmp_path / "builds")
    manifest = {"native_player": staged.record()}

    verify_package._validate_native_player(app, manifest)
    with pytest.raises(verify_package.VerifyError, match="must include the native player"):
        verify_package._validate_native_player(app, {})
    (app / "tuck_player.dll").write_bytes(b"another library")
    with pytest.raises(verify_package.VerifyError, match="does not match"):
        verify_package._validate_native_player(app, manifest)
