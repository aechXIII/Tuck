"""Build the native player library from locked sources on Ubuntu 22.04.

The player links the same FFmpeg and dav1d sources as the export tools (from the FFmpeg lock) plus
libplacebo and its shader compilers (from the player lock). Every archive is checked against its
recorded size and SHA-256 before it is used. The slow part, the static SDK, is kept in the work
directory, so `--library-only` rebuilds just the player from src-tauri/native/player.
`--check FOLDER` then runs the seek check over the clips scripts/player_fixtures.py made there.

Next to the library go the license text of every source and `player-source.tar.xz` (the locked
archives, the recipes and the player's own code), which the packages ship with it.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

from windows_ffmpeg import BuildError, download, extract_source, require, sha256

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "packaging/player-sources.lock.json"
PLAYER_SOURCE = ROOT / "src-tauri/native/player"
RECIPES = {
    "windows": ("packaging/build-player-sdk-windows.sh", "packaging/build-player-windows.sh"),
    "linux": ("packaging/build-player-sdk-linux.sh", "packaging/build-player-linux.sh"),
}
OUTPUTS = {"windows": "tuck_player.dll", "linux": "libtuck_player.so"}
SEEK_CHECKS = {"windows": "tuck_player_seek_check.exe", "linux": "tuck_player_seek_check"}
SOURCE_ARCHIVE = "player-source.tar.xz"


def load_lock(target: str) -> dict:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    require(lock.get("lockfile_version") == 1, "Unsupported player source lock")
    require(lock.get("architecture") == "x86_64", "Wrong player architecture")
    names = [record["name"] for record in lock["sources"]]
    require(len(names) == len(set(names)), "Duplicate player sources")
    for record in lock["sources"]:
        destination = record["destination"]
        require(
            destination == ""
            or (
                not PurePosixPath(destination).is_absolute()
                and ".." not in PurePosixPath(destination).parts
                and "\\" not in destination
            ),
            f"Unsafe destination for {record['name']}",
        )
        require(record["url"].startswith("https://"), "Source URL must use HTTPS")
        require(
            len(record["sha256"]) == 64 and record["size_bytes"] > 0, "Incomplete source record"
        )
    reuse = lock["ffmpeg_locks"][target]
    ffmpeg_lock = json.loads((ROOT / reuse["lock"]).read_text(encoding="utf-8"))
    shared = {record["name"]: record for record in ffmpeg_lock["sources"]}
    wanted = reuse["sources"]
    require(all(name in shared for name in wanted), "The FFmpeg lock lacks a player source")
    # the player builds FFmpeg without its GPL parts, so its own license differs from the export's
    licenses = reuse.get("licenses", {})
    require(set(licenses) <= set(wanted), "A player license names a source it doesn't use")
    reused = [
        dict(shared[name], destination="", license=licenses.get(name, shared[name]["license"]))
        for name in wanted
    ]
    return {"sources": reused + lock["sources"], "ffmpeg_lock": reuse["lock"]}


def stage_sources(lock: dict, cache: Path, source_dir: Path) -> list[dict]:
    if source_dir.exists():
        shutil.rmtree(source_dir)
    source_dir.mkdir(parents=True)
    staged = []
    for record in lock["sources"]:
        archive = download(record, cache)
        destination = record["destination"]
        if not destination:
            extract_source(archive, record["archive_root"], source_dir)
        else:
            # submodules arrive as commit archives and go where libplacebo's checkout keeps them
            with tempfile.TemporaryDirectory(dir=source_dir) as temporary:
                extract_source(archive, record["archive_root"], Path(temporary))
                target = source_dir / destination
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(Path(temporary) / record["archive_root"]), target)
        staged.append({key: record[key] for key in ("name", "version", "filename", "sha256")})
    return staged


def player_source_files() -> list[tuple[str, Path]]:
    """The player's own source files by their path in the tree, in a fixed order on every system"""
    files = [path for path in PLAYER_SOURCE.rglob("*") if path.is_file()]
    return sorted((path.relative_to(PLAYER_SOURCE).as_posix(), path) for path in files)


def player_source_sha256() -> str:
    digest = hashlib.sha256()
    for name, path in player_source_files():
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def write_licenses(lock: dict, cache: Path, output: Path) -> list[dict]:
    """Copies every source's license text out of its verified archive into `output/licenses`"""
    folder = output / "licenses"
    if folder.exists():
        shutil.rmtree(folder)
    written = []
    for record in lock["sources"]:
        archive = download(record, cache)
        member = f"{record['archive_root']}/{record['license']['text_path']}"
        with tarfile.open(archive) as bundle:
            try:
                handle = bundle.extractfile(member)
            except KeyError:
                handle = None
            if handle is None:
                raise BuildError(f"{record['filename']} has no license text {member}")
            text = handle.read()
        destination = folder / record["name"] / PurePosixPath(member).name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(text)
        written.append(
            {
                "name": record["name"],
                "version": record["version"],
                "spdx": record["license"]["spdx"],
                "file": destination.relative_to(output).as_posix(),
                "sha256": sha256(destination),
            }
        )
    return written


def write_source_archive(target: str, lock: dict, cache: Path, output: Path) -> Path:
    """Everything needed to build the library again: the locked archives as downloaded, the
    recipes and locks, and the player's own code. Fixed order and times, so a rebuild matches."""
    sdk_recipe, library_recipe = RECIPES[target]
    recipes = [
        sdk_recipe,
        library_recipe,
        "scripts/player_library.py",
        "scripts/windows_ffmpeg.py",
        LOCK_PATH.relative_to(ROOT).as_posix(),
        lock["ffmpeg_lock"],
    ]
    entries: list[tuple[str, bytes]] = [
        (f"player-source/{name}", (ROOT / name).read_bytes()) for name in recipes
    ]
    entries.extend(
        (f"player-source/sources/{record['filename']}", download(record, cache).read_bytes())
        for record in lock["sources"]
    )
    entries.extend(
        (f"player-source/src-tauri/native/player/{name}", path.read_bytes())
        for name, path in player_source_files()
    )
    target_path = output / SOURCE_ARCHIVE
    temporary = target_path.with_name(f".{target_path.name}.tmp")
    try:
        with tarfile.open(temporary, "w:xz") as bundle:
            for name, contents in sorted(entries):
                info = tarfile.TarInfo(name)
                info.size = len(contents)
                info.mode = 0o644
                info.mtime = 0
                bundle.addfile(info, fileobj=io.BytesIO(contents))
        temporary.replace(target_path)
    finally:
        temporary.unlink(missing_ok=True)
    return target_path


def run(*command: str) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, check=True, cwd=ROOT)


def build(target: str, work: Path, output: Path, jobs: int, library_only: bool) -> None:
    lock = load_lock(target)
    sdk_recipe, library_recipe = RECIPES[target]
    source_dir = work / "source"
    sdk = work / f"sdk-{target}"
    manifest_path = sdk / "player-sources.json"
    if library_only:
        require(
            manifest_path.is_file(),
            "No SDK in the work directory yet; build without --library-only",
        )
        staged = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        staged = stage_sources(lock, work / "cache", source_dir)
        run("bash", sdk_recipe, str(source_dir), str(work / f"build-{target}"), str(sdk), str(jobs))
        manifest_path.write_text(json.dumps(staged, indent=2) + "\n", encoding="utf-8")
    output.mkdir(parents=True, exist_ok=True)
    run("bash", library_recipe, str(sdk), str(PLAYER_SOURCE), str(output))
    library = output / OUTPUTS[target]
    require(library.is_file(), f"The recipe did not produce {library.name}")
    licenses = write_licenses(lock, work / "cache", output)
    source_archive = write_source_archive(target, lock, work / "cache", output)
    manifest = {
        "target": target,
        "library": library.name,
        "size_bytes": library.stat().st_size,
        "sha256": sha256(library),
        "player_source_sha256": player_source_sha256(),
        "sources": staged,
        "licenses": licenses,
        "source_archive": {
            "file": source_archive.name,
            "size_bytes": source_archive.stat().st_size,
            "sha256": sha256(source_archive),
        },
    }
    (output / "player-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Built {library} ({manifest['size_bytes']} bytes)", flush=True)


def run_seek_check(target: str, output: Path, fixtures: Path) -> None:
    program = output / SEEK_CHECKS[target]
    fixture_list = fixtures.resolve() / "seek-fixtures.txt"
    require(program.is_file(), f"The recipe did not produce {program.name}")
    require(fixture_list.is_file(), f"No {fixture_list}; make it with scripts/player_fixtures.py")
    if target != "windows" or os.name == "nt":
        run(str(program), str(fixture_list))
        return
    # built under WSL, the Windows program runs only where WSL can start Windows programs
    windows_path = [
        subprocess.run(
            ["wslpath", "-w", str(path)], check=True, capture_output=True, text=True
        ).stdout.strip()
        for path in (program, fixture_list)
    ]
    try:
        run(str(program), windows_path[1])
    except OSError as error:
        raise BuildError(
            f"This WSL can't start Windows programs ({error.strerror}); "
            f"run the seek check on Windows: {windows_path[0]} {windows_path[1]}"
        ) from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=sorted(RECIPES))
    parser.add_argument("--work", type=Path, default=Path.home() / ".cache/tuck-player-work")
    parser.add_argument("--output", type=Path, default=ROOT / "build/player-library")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 12))
    parser.add_argument("--library-only", action="store_true", help="reuse the SDK in --work")
    parser.add_argument(
        "--check", type=Path, metavar="FOLDER", help="run the seek check on these clips"
    )
    args = parser.parse_args()
    output = (args.output / args.target).resolve()
    try:
        build(args.target, args.work.resolve(), output, args.jobs, args.library_only)
        if args.check:
            run_seek_check(args.target, output, args.check)
    except (BuildError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Player library build failed: {error}") from error


if __name__ == "__main__":
    main()
