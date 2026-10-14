"""Build the Linux x86_64 sidecar resource tree for Tuck's AppImage.

Run this on native Ubuntu 22.04 x86_64. It needs Python 3.10+, venv support,
network access to the locked FFmpeg, x264, x265, zimg, and dav1d source archives and the
locked dav1d GStreamer plugin crate, Cargo, the GStreamer development files, and the native
compiler toolchain required by PyInstaller. This script builds the media tools and the plugin
from those verified sources, preserves the exact FFmpeg inputs and recipe in the staging tree,
and builds the Python sidecar. ``scripts/build-linux.sh`` builds
the AppImage from that tree.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "packaging" / "ffmpeg-linux-sources.lock.json"
GST_DAV1D_LOCK_PATH = ROOT / "packaging" / "gst-dav1d-linux.lock.json"
CONSTRAINTS = ROOT / "packaging" / "sidecar-constraints.txt"
BUILD_REQUIREMENTS = ROOT / "packaging" / "build-requirements.txt"
SPEC = ROOT / "scripts" / "tuck-sidecar-linux.spec"
LICENSE = ROOT / "LICENSE"
THIRD_PARTY_NOTICES = ROOT / "packaging" / "THIRD_PARTY_NOTICES_LINUX.md"

CACHE_DIR = ROOT / "build" / "toolcache"
FFMPEG_SOURCE_CACHE = CACHE_DIR / "ffmpeg-linux-sources"
FFMPEG_BUILD = ROOT / "build" / "ffmpeg-linux-sources"
# the FFmpeg recipe installs its static libraries here, dav1d among them
FFMPEG_PREFIX = FFMPEG_BUILD / "work" / "prefix"
GST_DAV1D_SOURCE_CACHE = CACHE_DIR / "gst-dav1d"
GST_DAV1D_BUILD = ROOT / "build" / "gst-dav1d"
BUILD_VENV = ROOT / "build" / "linux-sidecar-venv"
DIST_ROOT = ROOT / "dist" / "linux"
DIST = DIST_ROOT / "sidecar"
STAGING = ROOT / "packaging" / "staging" / "linux"
STAGING_APP = STAGING / "app"
STAGING_FFMPEG = STAGING / "ffmpeg"
STAGING_GSTREAMER = STAGING / "gstreamer"
STAGING_PLUGIN_LICENSES = STAGING / "licenses"
SOURCE_BUNDLE_NAME = "ffmpeg-source.tar.xz"
# zimg keeps its own permissive license inside the GPL build
SOURCE_LICENSES = {
    "ffmpeg": "GPL-2.0-or-later",
    "x264": "GPL-2.0-or-later",
    "x265": "GPL-2.0-or-later",
    "zimg": "WTFPL",
    "dav1d": "BSD-2-Clause",
}
GST_DAV1D_LICENSE = "MIT OR Apache-2.0"
GST_DAV1D_URL_PREFIX = "https://static.crates.io/crates/gst-plugin-dav1d/"


class BuildError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildError(message)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_native_platform() -> None:
    _require(sys.platform == "linux", "build_linux.py must run on native Linux")
    machine = platform.machine().lower()
    _require(machine in {"x86_64", "amd64"}, f"Linux AppImage target is x86_64, not {machine}")
    os_release = platform.freedesktop_os_release()
    _require(
        os_release.get("ID") == "ubuntu" and os_release.get("VERSION_ID") == "22.04",
        "build_linux.py must run on native Ubuntu 22.04",
    )


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _validate_file_record(record: object, label: str) -> dict[str, object]:
    _require(isinstance(record, dict), f"{label} must be an object")
    filename = record.get("filename")
    url = record.get("url")
    size = record.get("size_bytes")
    digest = record.get("sha256")
    _require(
        isinstance(filename, str)
        and filename == Path(filename).name
        and filename
        and isinstance(url, str)
        and url.startswith("https://")
        and isinstance(size, int)
        and size > 0
        and _valid_sha256(digest),
        f"{label} is incomplete",
    )
    return record


def _source_entries(lock: dict[str, object]) -> list[dict[str, object]]:
    sources = lock.get("sources")
    _require(isinstance(sources, list) and sources, "Linux FFmpeg sources are invalid")
    entries: list[dict[str, object]] = []
    names: set[str] = set()
    filenames: set[str] = set()
    for source in sources:
        entry = _validate_file_record(source, "Linux FFmpeg source")
        name = entry.get("name")
        root = entry.get("archive_root")
        version = entry.get("version")
        license_info = entry.get("license")
        _require(
            isinstance(name, str)
            and name in SOURCE_LICENSES
            and name not in names
            and isinstance(version, str)
            and version
            and isinstance(root, str)
            and root == Path(root).name
            and root
            and isinstance(license_info, dict)
            and license_info.get("spdx") == SOURCE_LICENSES[name]
            and isinstance(license_info.get("text_path"), str)
            and license_info["text_path"],
            "Linux FFmpeg source provenance is incomplete",
        )
        if name in {"x265", "zimg"}:
            revision = entry.get("revision")
            _require(
                isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision) is not None,
                f"{name} source must record an immutable revision",
            )
            _require(
                revision in str(entry["url"]),
                f"{name} source URL must name its immutable revision",
            )
        names.add(name)
        filename = str(entry["filename"])
        _require(filename not in filenames, "Linux FFmpeg source filenames must be unique")
        filenames.add(filename)
        entries.append(entry)
    _require(
        names == set(SOURCE_LICENSES),
        "Linux FFmpeg lock must include FFmpeg, x264, x265, zimg, and dav1d",
    )
    return entries


def load_lock() -> dict[str, object]:
    _require(LOCK_PATH.is_file(), f"Missing FFmpeg lock file: {LOCK_PATH}")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    _require(isinstance(lock, dict), "Linux FFmpeg lock must be a JSON object")
    _require(lock.get("lockfile_version") == 2, "Unsupported FFmpeg lock file version")
    _require(lock.get("platform") == "linux", "FFmpeg lock is not for Linux")
    _require(lock.get("architecture") == "x86_64", "FFmpeg lock is not for x86_64")
    build_platform = lock.get("build_platform")
    _require(
        isinstance(build_platform, dict)
        and build_platform.get("distribution") == "Ubuntu"
        and build_platform.get("version") == "22.04"
        and build_platform.get("native_only") is True
        and build_platform.get("libc_linkage") == "dynamic",
        "Linux FFmpeg lock must require a native Ubuntu 22.04 dynamic-libc build",
    )
    recipe = lock.get("recipe")
    _require(isinstance(recipe, dict), "Linux FFmpeg recipe is invalid")
    recipe_path = recipe.get("path")
    _require(
        isinstance(recipe_path, str)
        and recipe_path == "packaging/build-ffmpeg-linux.sh"
        and isinstance(recipe.get("size_bytes"), int)
        and recipe["size_bytes"] > 0
        and _valid_sha256(recipe.get("sha256")),
        "Linux FFmpeg recipe provenance is incomplete",
    )
    recipe_file = ROOT / recipe_path
    _require(recipe_file.is_file(), f"Missing locked FFmpeg recipe: {recipe_file}")
    _require(
        recipe_file.stat().st_size == recipe["size_bytes"], "FFmpeg recipe size does not match lock"
    )
    _require(_sha256(recipe_file) == recipe["sha256"], "FFmpeg recipe SHA-256 does not match lock")
    inputs = recipe.get("inputs", [])
    _require(
        isinstance(inputs, list)
        and len(inputs) == 2
        and all(isinstance(record, dict) for record in inputs)
        and {record.get("path") for record in inputs}
        == {"packaging/ffmpeg-mix-integer.h", "packaging/ffmpeg-mix-integer.patch"},
        "Incomplete FFmpeg mixing inputs",
    )
    for record in inputs:
        path = ROOT / str(record["path"])
        _require(
            path.is_file()
            and path.stat().st_size == record.get("size_bytes")
            and _sha256(path) == record.get("sha256"),
            "FFmpeg mixing input does not match lock",
        )
    _source_entries(lock)
    output = lock.get("output")
    _require(isinstance(output, dict), "Linux FFmpeg output requirements are invalid")
    license_info = output.get("license")
    _require(
        isinstance(license_info, dict)
        and license_info.get("spdx") == "GPL-2.0-or-later"
        and isinstance(license_info.get("configure_flags_required"), list)
        and isinstance(license_info.get("configure_flags_forbidden"), list),
        "Linux FFmpeg output licensing requirements are incomplete",
    )
    for key in ("executables", "required_encoders", "required_decoders", "required_filters"):
        _require(
            isinstance(output.get(key), list)
            and all(isinstance(item, str) for item in output[key]),
            f"Linux FFmpeg output {key} are invalid",
        )
    _require(
        output.get("runtime_dependency") == "libc.so.6", "Linux FFmpeg must retain libc dependency"
    )
    _require(
        output.get("forbidden_runtime_dependencies")
        == ["libx264", "libx265", "libzimg", "libdav1d"],
        "Linux FFmpeg must statically link x264, x265, zimg, and dav1d",
    )
    _require(
        output.get("unused_runtime_dependencies") == ["libdrm", "libxcb"],
        "Linux FFmpeg must not need libdrm or libxcb",
    )
    return lock


def _ensure_download(record: dict[str, object], cache_dir: Path) -> Path:
    filename = str(record["filename"])
    expected_hash = str(record["sha256"])
    expected_size = int(record["size_bytes"])
    url = str(record["url"])
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / filename
    if (
        target.is_file()
        and _sha256(target) == expected_hash
        and target.stat().st_size == expected_size
    ):
        print(f"  cached  {target.name}")
        return target
    target.unlink(missing_ok=True)
    print(f"  fetch   {url}")
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        with urlopen(url) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        _require(_sha256(temporary) == expected_hash, f"Archive SHA-256 mismatch: {filename}")
        _require(
            temporary.stat().st_size == expected_size,
            f"Archive size mismatch: expected {expected_size}, got {temporary.stat().st_size}",
        )
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"  ok      {target.name} ({expected_size} bytes)")
    return target


def ensure_source_archives(lock: dict[str, object]) -> list[tuple[dict[str, object], Path]]:
    return [
        (source, _ensure_download(source, FFMPEG_SOURCE_CACHE)) for source in _source_entries(lock)
    ]


def _extract_archive(archive_path: Path, root: str, destination: Path) -> None:
    with tarfile.open(archive_path, "r:*") as archive:
        members = archive.getmembers()
        _require(members, f"Source archive is empty: {archive_path.name}")
        for member in members:
            member_path = Path(member.name)
            _require(
                not member_path.is_absolute()
                and ".." not in member_path.parts
                and member_path.parts
                and member_path.parts[0] == root
                and (member.isfile() or member.isdir() or member.issym()),
                f"Unsafe or unexpected source archive member: {member.name}",
            )
        # zimg links a few example sources from its docs; no recipe builds them, so links
        # are never written and can't point a later write outside the source tree
        archive.extractall(
            destination, members=[member for member in members if not member.issym()]
        )


def _extract_sources(sources: list[tuple[dict[str, object], Path]]) -> Path:
    source_root = FFMPEG_BUILD / "source"
    shutil.rmtree(source_root, ignore_errors=True)
    source_root.mkdir(parents=True)
    for source, archive_path in sources:
        root = str(source["archive_root"])
        _extract_archive(archive_path, root, source_root)
        license_info = source["license"]
        _require(isinstance(license_info, dict), "Linux FFmpeg source license is invalid")
        license_path = source_root / root / str(license_info["text_path"])
        _require(license_path.is_file(), f"Locked license text missing from {archive_path.name}")
    return source_root


def build_source_archive(
    lock: dict[str, object], sources: list[tuple[dict[str, object], Path]]
) -> Path:
    FFMPEG_BUILD.mkdir(parents=True, exist_ok=True)
    target = FFMPEG_BUILD / SOURCE_BUNDLE_NAME
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    recipe = lock["recipe"]
    _require(isinstance(recipe, dict), "Linux FFmpeg recipe is invalid")
    manifest = {
        "lock_sha256": _sha256(LOCK_PATH),
        "recipe": recipe,
        "sources": [source for source, _archive in sources],
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        with tarfile.open(temporary, "w:xz") as bundle:
            entries: list[tuple[str, bytes]] = [
                ("ffmpeg-source/manifest.json", manifest_bytes),
                ("ffmpeg-source/build-ffmpeg-linux.sh", (ROOT / str(recipe["path"])).read_bytes()),
            ]
            entries.extend(
                (f"ffmpeg-source/sources/{source['filename']}", archive.read_bytes())
                for source, archive in sources
            )
            entries.extend(
                (
                    f"ffmpeg-source/{Path(str(record['path'])).name}",
                    (ROOT / str(record["path"])).read_bytes(),
                )
                for record in recipe["inputs"]
            )
            for name, contents in sorted(entries):
                info = tarfile.TarInfo(name)
                info.size = len(contents)
                info.mode = 0o644
                info.mtime = 0
                bundle.addfile(info, fileobj=io.BytesIO(contents))
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def _build_ffmpeg(lock: dict[str, object], source_root: Path) -> Path:
    recipe = lock["recipe"]
    _require(isinstance(recipe, dict), "Linux FFmpeg recipe is invalid")
    output = FFMPEG_BUILD / "output"
    jobs = str(os.cpu_count() or 1)
    print("  build   FFmpeg, x264, x265, zimg, and dav1d from locked sources")
    subprocess.run(
        [
            "bash",
            str(ROOT / str(recipe["path"])),
            str(source_root),
            str(FFMPEG_BUILD / "work"),
            str(output),
            jobs,
        ],
        check=True,
        cwd=ROOT,
    )
    for name in ("ffmpeg", "ffprobe"):
        tool = output / name
        _require(
            tool.is_file() and os.access(tool, os.X_OK), f"Source build did not produce {name}"
        )
    return output


def _tool_output(tool: Path, *arguments: str) -> str:
    result = subprocess.run([str(tool), *arguments], capture_output=True, text=True, check=True)
    return result.stdout + result.stderr


def validate_ffmpeg_runtime(lock: dict[str, object], directory: Path) -> None:
    output = lock["output"]
    _require(isinstance(output, dict), "Linux FFmpeg output requirements are invalid")
    ffmpeg = directory / "ffmpeg"
    buildconf = _tool_output(ffmpeg, "-hide_banner", "-buildconf")
    configure_flags = {line.strip() for line in buildconf.splitlines()}
    license_info = output["license"]
    _require(
        isinstance(license_info, dict), "Linux FFmpeg output licensing requirements are invalid"
    )
    for flag in license_info["configure_flags_required"]:
        _require(flag in configure_flags, f"FFmpeg build configuration is missing {flag}")
    for flag in license_info["configure_flags_forbidden"]:
        _require(flag not in configure_flags, f"FFmpeg build configuration must not contain {flag}")
    encoders = _tool_output(ffmpeg, "-hide_banner", "-encoders")
    for encoder in output["required_encoders"]:
        _require(f" {encoder}" in encoders, f"FFmpeg build is missing encoder {encoder}")
    decoders = _tool_output(ffmpeg, "-hide_banner", "-decoders")
    for decoder in output["required_decoders"]:
        _require(f" {decoder}" in decoders, f"FFmpeg build is missing decoder {decoder}")
    filters = _tool_output(ffmpeg, "-hide_banner", "-filters")
    for filter_name in output["required_filters"]:
        _require(f" {filter_name}" in filters, f"FFmpeg build is missing filter {filter_name}")
    ldd = subprocess.run(["ldd", str(ffmpeg)], capture_output=True, text=True, check=True)
    dependency = str(output["runtime_dependency"])
    _require(
        dependency in ldd.stdout,
        f"FFmpeg must dynamically link {dependency}, not fully static libc",
    )
    for forbidden in output["forbidden_runtime_dependencies"]:
        _require(forbidden not in ldd.stdout, f"FFmpeg must statically link {forbidden}")
    for unused in output["unused_runtime_dependencies"]:
        _require(unused not in ldd.stdout, f"FFmpeg must not need {unused}")


def stage_ffmpeg(
    lock: dict[str, object], output: Path, source_archive: Path
) -> tuple[list[dict[str, object]], dict[str, object]]:
    shutil.rmtree(STAGING_FFMPEG, ignore_errors=True)
    STAGING_FFMPEG.mkdir(parents=True)
    staged: list[dict[str, object]] = []
    for name in ("ffmpeg", "ffprobe"):
        source = output / name
        destination = STAGING_FFMPEG / name
        shutil.copy2(source, destination)
        destination.chmod(0o755)
        staged.append(
            {
                "file": f"ffmpeg/{name}",
                "sha256": _sha256(destination),
                "size_bytes": destination.stat().st_size,
                "mode": "0755",
            }
        )
        print(f"  stage   ffmpeg/{name}")
    source_directory = STAGING_FFMPEG / "source"
    source_directory.mkdir()
    staged_source = source_directory / SOURCE_BUNDLE_NAME
    shutil.copy2(source_archive, staged_source)
    recipe = lock["recipe"]
    _require(isinstance(recipe, dict), "Linux FFmpeg recipe is invalid")
    provenance = {
        "lock_file": LOCK_PATH.relative_to(ROOT).as_posix(),
        "lock_sha256": _sha256(LOCK_PATH),
        "recipe": recipe,
        "source_archive": {
            "file": f"ffmpeg/source/{SOURCE_BUNDLE_NAME}",
            "sha256": _sha256(staged_source),
            "size_bytes": staged_source.stat().st_size,
        },
    }
    return staged, provenance


def load_gst_dav1d_lock() -> dict[str, object]:
    _require(
        GST_DAV1D_LOCK_PATH.is_file(), f"Missing dav1d plugin lock file: {GST_DAV1D_LOCK_PATH}"
    )
    lock = json.loads(GST_DAV1D_LOCK_PATH.read_text(encoding="utf-8"))
    _require(isinstance(lock, dict), "dav1d plugin lock must be a JSON object")
    _require(lock.get("lockfile_version") == 1, "Unsupported dav1d plugin lock file version")
    _require(
        lock.get("platform") == "linux" and lock.get("architecture") == "x86_64",
        "dav1d plugin lock is not for Linux x86_64",
    )
    source = _validate_file_record(lock.get("source"), "dav1d plugin source")
    root = source.get("archive_root")
    license_info = source.get("license")
    text_paths = license_info.get("text_paths") if isinstance(license_info, dict) else None
    _require(
        source.get("name") == "gst-plugin-dav1d"
        and isinstance(source.get("version"), str)
        and bool(source["version"])
        and str(source["url"]).startswith(GST_DAV1D_URL_PREFIX)
        and isinstance(root, str)
        and root == Path(root).name
        and bool(root)
        and isinstance(license_info, dict)
        and license_info.get("spdx") == GST_DAV1D_LICENSE
        and isinstance(text_paths, list)
        and bool(text_paths)
        and all(isinstance(path, str) and path for path in text_paths),
        "dav1d plugin source provenance is incomplete",
    )
    output = lock.get("output")
    _require(
        isinstance(output, dict)
        and output.get("file") == "libgstdav1d.so"
        and output.get("element") == "dav1ddec"
        and output.get("forbidden_runtime_dependencies") == ["libdav1d"],
        "dav1d plugin output requirements are incomplete",
    )
    return lock


def build_gst_dav1d(lock: dict[str, object]) -> tuple[Path, Path]:
    """Build the dav1d GStreamer plugin against the static dav1d from the FFmpeg build.

    WebKitGTK otherwise decodes AV1 with the bundled libaom decoder, which is several times
    slower. Returns the plugin and its extracted crate, which holds the license texts.
    """
    source = lock["source"]
    _require(isinstance(source, dict), "dav1d plugin source is invalid")
    archive = _ensure_download(source, GST_DAV1D_SOURCE_CACHE)
    source_root = GST_DAV1D_BUILD / "source"
    shutil.rmtree(source_root, ignore_errors=True)
    source_root.mkdir(parents=True)
    _extract_archive(archive, str(source["archive_root"]), source_root)
    crate = source_root / str(source["archive_root"])
    # the crate's own lock file pins every dependency, so --locked builds the same tree
    _require((crate / "Cargo.lock").is_file(), "dav1d plugin crate has no Cargo.lock")
    pkgconfig = FFMPEG_PREFIX / "lib" / "pkgconfig"
    _require(
        (pkgconfig / "dav1d.pc").is_file() and (FFMPEG_PREFIX / "lib" / "libdav1d.a").is_file(),
        "The FFmpeg build did not leave a static dav1d for the plugin",
    )
    target = GST_DAV1D_BUILD / "target"
    print("  build   dav1d GStreamer plugin from the locked crate")
    subprocess.run(
        [
            "cargo",
            "build",
            "--release",
            "--locked",
            "--manifest-path",
            str(crate / "Cargo.toml"),
        ],
        check=True,
        cwd=crate,
        env={
            **os.environ,
            "PKG_CONFIG_PATH": str(pkgconfig),
            "SYSTEM_DEPS_DAV1D_LINK": "static",
            "CARGO_TARGET_DIR": str(target),
        },
    )
    output = lock["output"]
    _require(isinstance(output, dict), "dav1d plugin output requirements are invalid")
    plugin = target / "release" / str(output["file"])
    _require(plugin.is_file(), "The dav1d plugin build did not produce libgstdav1d.so")
    ldd = subprocess.run(["ldd", str(plugin)], capture_output=True, text=True, check=True)
    _require("libgstreamer-1.0" in ldd.stdout, "The dav1d plugin must link GStreamer")
    for forbidden in output["forbidden_runtime_dependencies"]:
        _require(forbidden not in ldd.stdout, f"The dav1d plugin must statically link {forbidden}")
    return plugin, crate


def stage_gst_dav1d(lock: dict[str, object], plugin: Path, crate: Path) -> dict[str, object]:
    source = lock["source"]
    output = lock["output"]
    _require(isinstance(source, dict), "dav1d plugin source is invalid")
    _require(isinstance(output, dict), "dav1d plugin output requirements are invalid")
    license_info = source["license"]
    _require(isinstance(license_info, dict), "dav1d plugin license is invalid")
    shutil.rmtree(STAGING_GSTREAMER, ignore_errors=True)
    shutil.rmtree(STAGING_PLUGIN_LICENSES, ignore_errors=True)
    STAGING_GSTREAMER.mkdir(parents=True)
    destination = STAGING_GSTREAMER / plugin.name
    shutil.copy2(plugin, destination)
    destination.chmod(0o755)
    license_dir = STAGING_PLUGIN_LICENSES / str(source["name"])
    license_dir.mkdir(parents=True)
    for text_path in license_info["text_paths"]:
        license_file = crate / str(text_path)
        _require(license_file.is_file(), f"dav1d plugin license text missing: {text_path}")
        shutil.copy2(license_file, license_dir / Path(str(text_path)).name)
    print(f"  stage   gstreamer/{plugin.name}")
    return {
        "file": f"gstreamer/{plugin.name}",
        "sha256": _sha256(destination),
        "size_bytes": destination.stat().st_size,
        "element": output["element"],
        "source": {
            "name": source["name"],
            "version": source["version"],
            "sha256": source["sha256"],
            "lock_file": GST_DAV1D_LOCK_PATH.relative_to(ROOT).as_posix(),
            "lock_sha256": _sha256(GST_DAV1D_LOCK_PATH),
        },
    }


def _venv_python(venv: Path) -> Path:
    return venv / "bin" / "python"


def create_build_env(base_python: str) -> Path:
    _require(CONSTRAINTS.is_file(), f"Missing {CONSTRAINTS}")
    _require(BUILD_REQUIREMENTS.is_file(), f"Missing {BUILD_REQUIREMENTS}")
    shutil.rmtree(BUILD_VENV, ignore_errors=True)
    print(f"  venv    {BUILD_VENV}")
    subprocess.run([base_python, "-m", "venv", str(BUILD_VENV)], check=True)
    python = _venv_python(BUILD_VENV)
    subprocess.run([str(python), "-m", "pip", "install", "--upgrade", "--quiet", "pip"], check=True)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--quiet",
            "--require-hashes",
            "-r",
            str(CONSTRAINTS),
        ],
        check=True,
    )
    subprocess.run(
        [str(python), "-m", "pip", "install", "--quiet", "-r", str(BUILD_REQUIREMENTS)],
        check=True,
    )
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--quiet",
            "--no-deps",
            "--no-build-isolation",
            str(ROOT),
        ],
        check=True,
    )
    return python


def run_pyinstaller(python: Path) -> Path:
    work = ROOT / "build" / "linux-sidecar-pyinstaller"
    shutil.rmtree(DIST_ROOT, ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)
    print("  pyinstaller ...")
    subprocess.run(
        [
            str(python),
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(DIST_ROOT),
            "--workpath",
            str(work),
            str(SPEC),
        ],
        check=True,
        cwd=ROOT,
    )
    sidecar = DIST / "tuck-sidecar"
    _require(sidecar.is_file(), "PyInstaller did not produce tuck-sidecar")
    _require(os.access(sidecar, os.X_OK), "PyInstaller sidecar is not executable")
    _require(not (DIST / "TuckCli").exists(), "Linux staging must not contain a CLI executable")
    return DIST


def _copytree(source: Path, destination: Path) -> None:
    shutil.copytree(source, destination, copy_function=shutil.copy2)


def assemble_app(
    dist: Path,
    staged_ffmpeg: list[dict[str, object]],
    provenance: dict[str, object],
    staged_plugin: dict[str, object],
) -> dict[str, object]:
    shutil.rmtree(STAGING_APP, ignore_errors=True)
    _copytree(dist, STAGING_APP)
    _copytree(STAGING_FFMPEG, STAGING_APP / "ffmpeg")
    # the GStreamer plugin stays out of the bundled resources: the AppImage bundler would
    # rewrite it, so build-linux.sh adds it to the finished payload byte for byte
    _copytree(STAGING_PLUGIN_LICENSES, STAGING_APP / "licenses")
    shutil.copy2(LICENSE, STAGING_APP / "LICENSE")
    shutil.copy2(THIRD_PARTY_NOTICES, STAGING_APP / "THIRD_PARTY_NOTICES.md")
    sidecar = STAGING_APP / "tuck-sidecar"
    _require(sidecar.is_file() and os.access(sidecar, os.X_OK), "Staged sidecar is not executable")
    for name in ("ffmpeg", "ffprobe"):
        _require(
            os.access(STAGING_APP / "ffmpeg" / name, os.X_OK),
            f"Staged ffmpeg/{name} is not executable",
        )

    manifest: dict[str, object] = {
        "platform": "linux",
        "architecture": "x86_64",
        "sidecar_executable": "tuck-sidecar",
        "ffmpeg": staged_ffmpeg,
        "ffmpeg_provenance": provenance,
        "gstreamer_plugins": [staged_plugin],
        "expected_present": [
            "tuck-sidecar",
            "_internal",
            "ffmpeg/ffmpeg",
            "ffmpeg/ffprobe",
            "ffmpeg/source/ffmpeg-source.tar.xz",
            "gstreamer/libgstdav1d.so",
            "licenses/gst-plugin-dav1d/LICENSE-MIT",
            "licenses/gst-plugin-dav1d/LICENSE-APACHE",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
            "_internal/licenses/av/LICENSE.txt",
            "_internal/licenses/numpy/LICENSE.txt",
        ],
        "denied_substrings": [
            "pythoncom",
            "pywin32",
            "tuckcli",
            "tuck.cmd",
            "tuck-path.ps1",
            "webview/",
            "pythonnet",
            "clr.pyd",
            ".pyc",
            "__pycache__",
            "pytest",
            "site-packages",
            ".venv",
            "frontend/src",
            ".map",
        ],
    }
    STAGING.mkdir(parents=True, exist_ok=True)
    (STAGING / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def _reuse_build_env() -> Path:
    python = _venv_python(BUILD_VENV)
    _require(python.is_file(), "No existing Linux sidecar build environment to reuse")
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--quiet",
            "--no-deps",
            "--force-reinstall",
            "--no-build-isolation",
            str(ROOT),
        ],
        check=True,
    )
    return python


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--python", default=sys.executable, help="Base Python used to create the build venv."
    )
    parser.add_argument(
        "--skip-pyinstaller",
        action="store_true",
        help="Build and verify media tools without PyInstaller.",
    )
    parser.add_argument("--assemble-only", action="store_true", help="Reuse dist/linux/sidecar.")
    parser.add_argument("--reuse-env", action="store_true", help="Reuse build/linux-sidecar-venv.")
    args = parser.parse_args()
    try:
        _validate_native_platform()
        print("[1/6] verify Linux FFmpeg source lock")
        lock = load_lock()
        print("[2/6] fetch locked media sources")
        sources = ensure_source_archives(lock)
        print("[3/6] archive + build locked media sources")
        source_archive = build_source_archive(lock, sources)
        output = _build_ffmpeg(lock, _extract_sources(sources))
        validate_ffmpeg_runtime(lock, output)
        staged, provenance = stage_ffmpeg(lock, output, source_archive)
        if args.skip_pyinstaller:
            print("done (media tools only)")
            return 0
        plugin_lock = load_gst_dav1d_lock()
        staged_plugin = stage_gst_dav1d(plugin_lock, *build_gst_dav1d(plugin_lock))
        if args.assemble_only:
            _require(
                (DIST / "tuck-sidecar").is_file(), "No existing dist/linux/sidecar build to reuse"
            )
            dist = DIST
            print("[4/6] reuse dist/linux/sidecar")
            print("[5/6] skipped")
        else:
            print("[4/6] isolated build environment")
            python = _reuse_build_env() if args.reuse_env else create_build_env(args.python)
            print("[5/6] PyInstaller")
            dist = run_pyinstaller(python)
        print("[6/6] assemble Linux staging tree")
        assemble_app(dist, staged, provenance, staged_plugin)
        print(f"\nOK  staging tree at {STAGING_APP}")
        return 0
    except (BuildError, OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        print(f"\nBUILD FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
