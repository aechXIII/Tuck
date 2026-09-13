"""Build and verify Windows FFmpeg from locked sources on Ubuntu 22.04."""

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
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "packaging/ffmpeg-sources.lock.json"
BUILD = ROOT / "build/windows-ffmpeg"
SOURCE_BUNDLE = "Tuck-FFmpeg-Windows-Sources.tar.xz"
REQUIRED_SOURCES = {"ffmpeg", "x264", "x265", "nv-codec-headers", "amf", "zlib", "dav1d"}


class BuildError(RuntimeError):
    pass


def require(condition: object, message: str) -> None:
    if not condition:
        raise BuildError(message)


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hash_stream(handle)


def hash_stream(handle) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, record: dict) -> None:
    require(path.is_file(), f"Missing file: {path}")
    require(path.stat().st_size == record["size_bytes"], f"File size mismatch: {path}")
    require(sha256(path) == record["sha256"], f"File SHA-256 mismatch: {path}")


def load_lock() -> dict:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    require(
        lock["lockfile_version"] == 2 and lock["platform"] == "windows",
        "Invalid Windows source lock",
    )
    require(lock["architecture"] == "x86_64", "Wrong Windows architecture")
    require({s["name"] for s in lock["sources"]} == REQUIRED_SOURCES, "Incomplete Windows sources")
    require(len(lock["sources"]) == len(REQUIRED_SOURCES), "Duplicate Windows sources")
    for record in lock["sources"]:
        for field in ("filename", "archive_root"):
            value = record[field]
            require(
                value
                and PurePosixPath(value).name == value
                and "\\" not in value
                and value not in {".", ".."},
                "Unsafe source path",
            )
        require(record["url"].startswith("https://"), "Source URL must use HTTPS")
        require(re.fullmatch(r"[0-9a-f]{64}", record["sha256"]), "Invalid source SHA-256")
        require(
            record["size_bytes"] > 0 and record["license"]["text_path"], "Incomplete source record"
        )
    require(
        lock["recipe"]["path"] == "packaging/build-ffmpeg-windows.sh", "Unexpected build recipe"
    )
    verify_file(ROOT / lock["recipe"]["path"], lock["recipe"])
    return lock


def download(record: dict, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / record["filename"]
    if target.is_file():
        verify_file(target, record)
        return target
    print(f"Downloading {record['filename']}", flush=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    try:
        with urlopen(record["url"], timeout=120) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        verify_file(temporary, record)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def extract_source(path: Path, root: str, destination: Path) -> None:
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        require(members, f"Empty source archive: {path}")
        for member in members:
            name = PurePosixPath(member.name)
            require(
                not name.is_absolute()
                and ".." not in name.parts
                and "\\" not in member.name
                and name.parts[0] == root
                and (member.isfile() or member.isdir()),
                f"Unsafe source member: {member.name}",
            )
        archive.extractall(destination, members=members)


def write_source_bundle(lock: dict, sources: list[Path], target: Path) -> None:
    entries = {
        "ffmpeg-source/lock.json": LOCK_PATH.read_bytes(),
        "ffmpeg-source/build-ffmpeg-windows.sh": (ROOT / lock["recipe"]["path"]).read_bytes(),
    }
    entries.update({f"ffmpeg-source/sources/{path.name}": path.read_bytes() for path in sources})
    with tarfile.open(target, "w:xz", preset=0) as bundle:
        for name, data in sorted(entries.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            bundle.addfile(info, io.BytesIO(data))


def verify_source_bundle(path: Path) -> None:
    lock = load_lock()
    require(path.is_file(), f"Missing Windows FFmpeg source archive: {path}")
    records = {f"ffmpeg-source/sources/{s['filename']}": s for s in lock["sources"]}
    records["ffmpeg-source/build-ffmpeg-windows.sh"] = lock["recipe"]
    records["ffmpeg-source/lock.json"] = {
        "size_bytes": LOCK_PATH.stat().st_size,
        "sha256": sha256(LOCK_PATH),
    }
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        require(
            len(members) == len(records) and {m.name for m in members} == set(records),
            "Unexpected source archive contents",
        )
        for member in members:
            require(
                member.isfile() and member.size == records[member.name]["size_bytes"],
                f"Source size mismatch: {member.name}",
            )
            handle = archive.extractfile(member)
            require(handle is not None, f"Missing source: {member.name}")
            with handle:
                digest = hash_stream(handle)
            require(
                digest == records[member.name]["sha256"], f"Source SHA-256 mismatch: {member.name}"
            )


def verify_tools(directory: Path, source_bundle: Path, *, runtime: bool = True) -> dict:
    lock = load_lock()
    verify_source_bundle(source_bundle)
    manifest = json.loads((directory / "build-manifest.json").read_text(encoding="utf-8"))
    require(
        manifest["lock_sha256"] == sha256(LOCK_PATH),
        "Windows FFmpeg was built from a different lock",
    )
    verify_file(source_bundle, manifest["source_archive"])
    expected = {
        *lock["output"]["executables"],
        "build-environment.txt",
        "Toolchain-LICENSE.txt",
        *[f"{s['name']}-LICENSE.txt" for s in lock["sources"]],
    }
    require(set(manifest["files"]) == expected, "Incomplete Windows FFmpeg build manifest")
    require(
        {path.name for path in directory.iterdir()} == expected | {"build-manifest.json"},
        "Unexpected Windows FFmpeg files",
    )
    for name, record in manifest["files"].items():
        verify_file(directory / name, record)
    if runtime:
        validate_runtime(directory, lock)
    return manifest


def validate_runtime(directory: Path, lock: dict) -> None:
    ffmpeg = directory / "ffmpeg.exe"

    def output(*args: str) -> str:
        result = subprocess.run(
            [str(ffmpeg), "-hide_banner", *args], capture_output=True, text=True, check=True
        )
        return result.stdout + result.stderr

    flags = set(output("-buildconf").split())
    require(
        set(lock["output"]["configure_flags_required"]) <= flags,
        "Windows FFmpeg configuration is incomplete",
    )
    require("--enable-nonfree" not in flags, "Nonfree FFmpeg cannot be packaged")
    for kind in ("encoders", "decoders", "filters"):
        available = {
            line.split()[1] for line in output(f"-{kind}").splitlines() if len(line.split()) >= 2
        }
        require(
            set(lock["output"][kind]) <= available,
            f"Windows FFmpeg is missing {kind}: {set(lock['output'][kind]) - available}",
        )
    subprocess.run([str(directory / "ffprobe.exe"), "-version"], check=True, capture_output=True)


def build(work: Path, output: Path, cache: Path, jobs: int) -> None:
    require(platform.system() == "Linux", "Build Windows FFmpeg on Ubuntu 22.04 (WSL is supported)")
    release = platform.freedesktop_os_release()
    require(
        release.get("ID") == "ubuntu" and release.get("VERSION_ID") == "22.04",
        "Use Ubuntu 22.04 for Windows FFmpeg",
    )
    lock = load_lock()
    sources = [download(record, cache) for record in lock["sources"]]
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    # a fresh work directory prevents a prior configure or dependency from leaking in
    directory = Path(tempfile.mkdtemp(prefix="windows-ffmpeg-", dir=work))
    source_root = directory / "source"
    source_root.mkdir()
    for record, path in zip(lock["sources"], sources, strict=True):
        extract_source(path, record["archive_root"], source_root)
    tools = directory / "output"
    subprocess.run(
        [
            "bash",
            str(ROOT / lock["recipe"]["path"]),
            str(source_root),
            str(directory / "work"),
            str(tools),
            str(jobs),
        ],
        check=True,
    )
    for name in lock["output"]["executables"]:
        imports = (tools / name.replace(".exe", "-imports.txt")).read_text()
        dlls = {dll.lower() for dll in re.findall(r"DLL Name:\s*(\S+)", imports)}
        require(
            dlls and dlls <= set(lock["output"]["system_dlls"]),
            f"Unexpected Windows runtime DLLs: {dlls - set(lock['output']['system_dlls'])}",
        )
        (tools / name.replace(".exe", "-imports.txt")).unlink()
    for record in lock["sources"]:
        license_file = source_root / record["archive_root"] / record["license"]["text_path"]
        shutil.copy2(license_file, tools / f"{record['name']}-LICENSE.txt")
    bundle = directory / SOURCE_BUNDLE
    write_source_bundle(lock, sources, bundle)
    verify_source_bundle(bundle)
    manifest = {
        "lock_sha256": sha256(LOCK_PATH),
        "source_archive": {
            "filename": SOURCE_BUNDLE,
            "sha256": sha256(bundle),
            "size_bytes": bundle.stat().st_size,
        },
        "files": {
            path.name: {"sha256": sha256(path), "size_bytes": path.stat().st_size}
            for path in sorted(tools.iterdir())
        },
    }
    (tools / "build-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    verify_tools(tools, bundle, runtime=False)
    shutil.copytree(tools, output / "tools", dirs_exist_ok=True)
    shutil.copy2(bundle, output / SOURCE_BUNDLE)
    verify_tools(output / "tools", output / SOURCE_BUNDLE, runtime=False)
    print(f"Windows FFmpeg built: {output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-source", type=Path)
    parser.add_argument("--verify-tools", type=Path)
    parser.add_argument("--output", type=Path, default=BUILD)
    parser.add_argument("--work", type=Path, default=BUILD / "work")
    parser.add_argument(
        "--cache", type=Path, default=ROOT / "build/toolcache/ffmpeg-windows-sources"
    )
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 12))
    args = parser.parse_args()
    if args.verify_tools:
        verify_tools(args.verify_tools, args.output / SOURCE_BUNDLE)
    elif args.verify_source:
        verify_source_bundle(args.verify_source)
    else:
        require(args.jobs > 0, "Jobs must be positive")
        build(args.work.resolve(), args.output.resolve(), args.cache.resolve(), args.jobs)


if __name__ == "__main__":
    try:
        main()
    except BuildError as exc:
        raise SystemExit(f"Windows FFmpeg build failed: {exc}") from exc
