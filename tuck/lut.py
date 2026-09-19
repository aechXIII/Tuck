from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from .models import VideoInfo
from .models.lut import LutSettings
from .settings import ProcessLock

MAX_IMPORT_BYTES = 16 * 1024 * 1024
FloatTable = NDArray[np.float32]
_LIBRARY_LOCK = threading.RLock()
_MAX_LIBRARY_BYTES = 1024 * 1024
_MAX_LIBRARY_ENTRIES = 4096


@dataclass(frozen=True)
class ImportedLut:
    path: Path
    table_path: Path
    name: str
    size: int


def identity_table(size: int) -> FloatTable:
    b, g, r = np.meshgrid(*(np.linspace(0, 1, size, dtype=np.float32),) * 3, indexing="ij")
    return np.stack((r, g, b), axis=-1).reshape(-1, 3)


def _discreet_cube_lines(lines: list[str], path: Path) -> list[str]:
    header = lines[0].split()
    if len(header) not in {3, 4}:
        raise ValueError("Unsupported Discreet LUT header. Export a .cube LUT")
    channels, size = int(header[1]), int(header[2])
    if channels not in {1, 3} or size not in {256, 1024, 4096}:
        raise ValueError("Discreet LUTs need 1 or 3 channels and 256, 1024 or 4096 entries")
    output_size = size
    if len(header) == 4:
        if header[3] not in {"256", "1024", "4096", "65536"}:
            raise ValueError("Floating-point Discreet LUTs are unsupported. Export a .cube LUT")
        output_size = int(header[3])
    else:
        conversion = re.search(r"to(8|10|12|16)(f?)", path.stem.lower())
        if conversion:
            if conversion[2]:
                raise ValueError("Floating-point Discreet LUTs are unsupported. Export a .cube LUT")
            output_size = 2 ** int(conversion[1])
    if len(lines) != channels * size + 1:
        raise ValueError("Discreet LUT table does not match its declared size")
    values = [int(line) for line in lines[1:]]
    if any(value < 0 or value >= output_size for value in values):
        raise ValueError("Discreet LUT entries exceed the declared output range")
    # Discreet stores complete channel tables consecutively, unlike Cube's RGB rows
    return [f"LUT_1D_SIZE {size}"] + [
        " ".join(
            str(values[(c if channels == 3 else 0) * size + i] / (output_size - 1))
            for c in range(3)
        )
        for i in range(size)
    ]


def parse_cube(path: Path) -> FloatTable:
    with path.open("rb") as source:
        data = source.read(MAX_IMPORT_BYTES + 1)
    return _parse_cube_data(data, path)


def _parse_cube_data(data: bytes, path: Path) -> FloatTable:
    if len(data) > MAX_IMPORT_BYTES:
        raise ValueError("LUT files must be no larger than 16 MiB")
    try:
        lines = data.decode("utf-8-sig").splitlines()
    except UnicodeError as exc:
        raise ValueError("Unsupported LUT format. Export a text .cube LUT and try again") from exc
    lines = [line.split("#", 1)[0].strip() for line in lines]
    lines = [line for line in lines if line]
    if lines and lines[0].lower().startswith("lut:"):
        lines = _discreet_cube_lines(lines, path)
    size = 0
    dimensions = 0
    low = np.zeros(3, dtype=np.float64)
    high = np.ones(3, dtype=np.float64)
    rows: list[list[float]] = []
    seen: set[str] = set()
    for line in lines:
        parts = line.split("#", 1)[0].strip().split()
        if not parts:
            continue
        key = parts[0]
        if key == "TITLE":
            continue
        if key in {"LUT_3D_SIZE", "LUT_1D_SIZE", "DOMAIN_MIN", "DOMAIN_MAX"}:
            if key in seen or rows:
                raise ValueError("LUT headers must appear once, before the table")
            seen.add(key)
            if key.endswith("SIZE"):
                if size or len(parts) != 2:
                    raise ValueError(
                        "Combined 1D and 3D LUTs are unsupported; export a 3D .cube LUT"
                    )
                size = int(parts[1])
                dimensions = 3 if key == "LUT_3D_SIZE" else 1
                if not 2 <= size <= (65 if dimensions == 3 else 65536):
                    raise ValueError("3D LUT size must be 2-65; 1D LUT size must be 2-65536")
            else:
                if len(parts) != 4:
                    raise ValueError("LUT domains need three finite values")
                values = np.array([float(value) for value in parts[1:]])
                if key == "DOMAIN_MIN":
                    low = values
                else:
                    high = values
            continue
        if not size or len(parts) != 3:
            raise ValueError("Unsupported LUT format. Export a 1D or 3D .cube LUT and try again")
        if len(rows) >= size**dimensions:
            raise ValueError("LUT contains more entries than its declared size")
        rows.append([float(value) for value in parts])
    if not size or len(rows) != size**dimensions:
        raise ValueError("LUT table is incomplete")
    table = np.asarray(rows, dtype=np.float64)
    if (
        not np.isfinite(table).all()
        or not np.isfinite(low).all()
        or not np.isfinite(high).all()
        or np.any(high <= low)
    ):
        raise ValueError(
            "LUT values must be finite and each maximum domain must exceed its minimum"
        )
    with np.errstate(over="ignore"):
        domain_span = high - low
    if not np.isfinite(domain_span).all():
        raise ValueError("LUT domain ranges are too large to normalize")
    # canonical Cube nodes already lie on this lattice; resampling them introduces drift
    if dimensions == 3 and np.array_equal(low, (0, 0, 0)) and np.array_equal(high, (1, 1, 1)):
        return np.clip(table, 0, 1).astype(np.float32)
    output_size = size if dimensions == 3 else 65
    axis = np.linspace(0, 1, output_size, dtype=np.float64)
    b, g, r = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack((r, g, b), axis=-1).reshape(-1, 3)
    with np.errstate(over="ignore", divide="ignore"):
        coordinates = np.clip((grid - low) / domain_span, 0, 1) * (size - 1)
    if dimensions == 1:
        result = np.column_stack(
            [np.interp(coordinates[:, c], np.arange(size), table[:, c]) for c in range(3)]
        )
    else:
        table = table.reshape(size, size, size, 3)
        lower = np.floor(coordinates).astype(np.intp)
        upper = np.minimum(lower + 1, size - 1)
        fraction = coordinates - lower
        result = np.zeros_like(grid)
        for b in range(2):
            for g in range(2):
                for r in range(2):
                    indexes = np.where((r, g, b), upper, lower)
                    weight = np.prod(np.where((r, g, b), fraction, 1 - fraction), axis=1)
                    result += table[indexes[:, 2], indexes[:, 1], indexes[:, 0]] * weight[:, None]
    return np.clip(result, 0, 1).astype(np.float32)


def _atomic_content(directory: Path, content: bytes, suffix: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (hashlib.sha256(content).hexdigest() + suffix)
    if path.exists() and path.stat().st_size == len(content) and path.read_bytes() == content:
        return path
    descriptor, temporary = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return path


def _cube_bytes(table: FloatTable) -> bytes:
    size = round(len(table) ** (1 / 3))
    content = f"LUT_3D_SIZE {size}\n" + "".join(
        " ".join(f"{value:.9g}" for value in row) + "\n" for row in table
    )
    return content.encode("ascii")


def _store_cube(table: FloatTable, directory: Path) -> Path:
    return _atomic_content(directory, _cube_bytes(table), ".cube")


def store_table(table: FloatTable, directory: Path) -> tuple[Path, Path, int]:
    binary = _atomic_content(directory, table.astype("<f4").tobytes(), ".bin")
    return _store_cube(table, directory), binary, round(len(table) ** (1 / 3))


@lru_cache(maxsize=4)
def _canonical_table(path: Path, data: bytes) -> FloatTable:
    table = _parse_cube_data(data, path)
    table.flags.writeable = False
    return table


@lru_cache(maxsize=4)
def _strength_snapshot(path: Path, data: bytes, strength: float) -> Path:
    table = _canonical_table(path, data)
    size = round(len(table) ** (1 / 3))
    mixed = identity_table(size) * (1 - strength) + table * strength
    return _store_cube(mixed.astype(np.float32), path.parent)


@dataclass
class _LutLibrary:
    entries: dict[str, str] = field(default_factory=dict)
    aliases: dict[str, str] = field(default_factory=dict)
    pending: list[str] = field(default_factory=list)
    legacy: bool = False
    recover_profiles: bool = True


def _is_digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _library_root(library: _LutLibrary, digest: str) -> str:
    seen: set[str] = set()
    while digest in library.aliases:
        if digest in seen:
            raise ValueError("The saved LUT library contains an invalid alias")
        seen.add(digest)
        digest = library.aliases[digest]
    return digest


def _read_library(directory: Path) -> _LutLibrary:
    path = directory / "library.json"
    if not path.exists():
        return _LutLibrary()
    with path.open("rb") as source:
        data = source.read(_MAX_LIBRARY_BYTES + 1)
    if len(data) > _MAX_LIBRARY_BYTES:
        raise ValueError("The saved LUT library is too large")
    try:
        raw = json.loads(data)
    except (ValueError, UnicodeError) as exc:
        raise ValueError("The saved LUT library could not be read") from exc
    if not isinstance(raw, dict):
        raise ValueError("The saved LUT library is invalid")
    legacy = "version" not in raw
    if legacy:
        entries, aliases, pending = raw, {}, list(raw)
        recover_profiles = True
    else:
        if raw.get("version") != 2 or raw.keys() - {
            "version",
            "entries",
            "aliases",
            "migration_pending",
            "recover_profiles",
        }:
            raise ValueError("The saved LUT library version is unsupported")
        entries = raw.get("entries")
        aliases = raw.get("aliases", {})
        pending = raw.get("migration_pending", [])
        recover_profiles = raw.get("recover_profiles", True)
        if type(recover_profiles) is not bool:
            raise ValueError("The saved LUT library is invalid")
    if (
        not isinstance(entries, dict)
        or not isinstance(aliases, dict)
        or not isinstance(pending, list)
        or len(entries.keys() | aliases.keys()) > _MAX_LIBRARY_ENTRIES
        or len(pending) > _MAX_LIBRARY_ENTRIES
    ):
        raise ValueError("The saved LUT library is invalid")
    for digest, name in entries.items():
        if (
            not _is_digest(digest)
            or not isinstance(name, str)
            or not name.strip()
            or len(name) > 512
        ):
            raise ValueError("The saved LUT library is invalid")
    if (
        any(not _is_digest(key) or not _is_digest(value) for key, value in aliases.items())
        or any(not _is_digest(key) or key not in entries for key in pending)
        or len(set(pending)) != len(pending)
    ):
        raise ValueError("The saved LUT library is invalid")
    library = _LutLibrary(entries, aliases, pending, legacy, recover_profiles)
    for digest in aliases:
        _library_root(library, digest)
    return library


def _save_library(directory: Path, library: _LutLibrary) -> None:
    if any(not name.strip() or len(name) > 512 for name in library.entries.values()):
        raise ValueError("LUT names must contain 1 to 512 characters")
    data = json.dumps(
        {
            "version": 2,
            "entries": library.entries,
            "aliases": library.aliases,
            "migration_pending": library.pending,
            "recover_profiles": library.recover_profiles,
        },
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    if (
        len(library.entries.keys() | library.aliases.keys()) > _MAX_LIBRARY_ENTRIES
        or len(data) > _MAX_LIBRARY_BYTES
    ):
        raise ValueError("The LUT library is full")
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, directory / "library.json")
    finally:
        Path(temporary).unlink(missing_ok=True)
    library.legacy = False


def _legacy_successor(data: bytes) -> str | None:
    header, _, body = data.partition(b"\n")
    if not header.startswith(b"LUT_3D_SIZE "):
        return None
    try:
        size = int(header.split()[1])
        if not 2 <= size <= 65:
            return None
        values = np.fromstring(body.decode("ascii"), sep=" ", dtype=np.float64)
    except (ValueError, UnicodeError):
        return None
    if values.size != size**3 * 3 or not np.isfinite(values).all():
        return None
    table = values.reshape(size, size, size, 3)
    # reproduce the old rounding bug exactly to prove ancestry, never approximate similarity
    coordinates = identity_table(size).astype(np.float64) * (size - 1)
    lower = np.floor(coordinates).astype(np.intp)
    upper = np.minimum(lower + 1, size - 1)
    fraction = coordinates - lower
    result = np.zeros((size**3, 3), dtype=np.float64)
    for b in range(2):
        for g in range(2):
            for r in range(2):
                indexes = np.where((r, g, b), upper, lower)
                weight = np.prod(np.where((r, g, b), fraction, 1 - fraction), axis=1)
                result += table[indexes[:, 2], indexes[:, 1], indexes[:, 0]] * weight[:, None]
    return hashlib.sha256(_cube_bytes(np.clip(result, 0, 1).astype(np.float32))).hexdigest()


def _migrate_library(directory: Path, library: _LutLibrary) -> bool:
    changed = library.legacy
    bytes_read = 0
    processed = 0
    while library.pending and processed < 128:
        digest = library.pending[0]
        name = library.entries[digest]
        candidates = {
            key
            for key, candidate in library.entries.items()
            if key != digest and candidate in (digest, name)
        }
        path = directory / (digest + ".cube")
        try:
            size = path.stat().st_size if candidates else 0
        except OSError:
            size = 0
        if bytes_read + size > 64 * 1024 * 1024 and processed:
            break
        library.pending.pop(0)
        processed += 1
        changed = True
        if not candidates or not 0 < size <= MAX_IMPORT_BYTES:
            continue
        try:
            with path.open("rb") as source:
                data = source.read(MAX_IMPORT_BYTES + 1)
        except OSError:
            continue
        bytes_read += len(data)
        if hashlib.sha256(data).hexdigest() != digest:
            continue
        successor = _legacy_successor(data)
        if successor not in candidates:
            continue
        target = directory / (successor + ".cube")
        try:
            target_size = target.stat().st_size
        except OSError:
            continue
        if not 0 < target_size <= MAX_IMPORT_BYTES:
            continue
        if bytes_read + target_size > 64 * 1024 * 1024:
            library.pending.insert(0, digest)
            break
        bytes_read += target_size
        if not _valid_library_asset(target, directory):
            continue
        root = _library_root(library, digest)
        if _library_root(library, successor) != root:
            library.aliases[successor] = root
    if not library.pending:
        for digest in list(library.aliases):
            library.aliases[digest] = _library_root(library, digest)
        for digest in library.aliases:
            library.entries.pop(digest, None)
    return changed


def _valid_library_asset(path: Path, directory: Path) -> bool:
    if (
        path.parent.resolve() != directory.resolve()
        or path.suffix != ".cube"
        or not re.fullmatch(r"[0-9a-f]{64}", path.stem)
    ):
        return False
    try:
        with path.open("rb") as source:
            data = source.read(MAX_IMPORT_BYTES + 1)
        return len(data) <= MAX_IMPORT_BYTES and hashlib.sha256(data).hexdigest() == path.stem
    except OSError:
        return False


def list_luts(directory: Path, profiles: Iterable[LutSettings] = ()) -> list[dict[str, str]]:
    with _LIBRARY_LOCK, ProcessLock(directory / "library.lock"):
        library = _read_library(directory)
        changed = _migrate_library(directory, library)
        for settings in profiles:
            path = Path(settings.path)
            if (
                library.recover_profiles
                and settings.name.strip()
                and len(settings.name) <= 512
                and path.stem not in library.entries
                and path.stem not in library.aliases
                and _valid_library_asset(path, directory)
            ):
                library.entries[path.stem] = settings.name
                changed = True
        if changed:
            _save_library(directory, library)
        return [
            {"path": str(directory / (digest + ".cube")), "name": name}
            for digest, name in sorted(
                library.entries.items(), key=lambda item: (item[1].casefold(), item[0])
            )
            if digest not in library.aliases
            and _valid_library_asset(directory / (digest + ".cube"), directory)
        ]


def clear_lut_history(directory: Path) -> None:
    with _LIBRARY_LOCK, ProcessLock(directory / "library.lock"):
        library = _read_library(directory)
        library.entries.clear()
        library.pending.clear()
        library.recover_profiles = False
        _save_library(directory, library)


def _load_managed_lut(path: Path, directory: Path) -> tuple[Path, Path, int]:
    with path.open("rb") as source:
        data = source.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES or hashlib.sha256(data).hexdigest() != path.stem:
        raise ValueError("This LUT has changed. Import it again before exporting")
    table = _canonical_table(path, data)
    binary = _atomic_content(directory, table.astype("<f4").tobytes(), ".bin")
    return path.resolve(), binary, round(len(table) ** (1 / 3))


def import_lut(path: Path, directory: Path, *, saved_name: str = "") -> ImportedLut:
    if path.suffix.lower() not in {".cube", ".lut"}:
        raise ValueError("Choose a .cube or supported text .lut file")
    with _LIBRARY_LOCK, ProcessLock(directory / "library.lock"):
        library = _read_library(directory)
        managed = path.parent.resolve() == directory.resolve() and re.fullmatch(
            r"[0-9a-f]{64}\.cube", path.name
        )
        if managed:
            path = directory / (_library_root(library, path.stem) + ".cube")
            cube, binary, size = _load_managed_lut(path, directory)
        else:
            cube, binary, size = store_table(parse_cube(path), directory)
            if cube.stem in library.aliases:
                canonical = directory / (_library_root(library, cube.stem) + ".cube")
                cube, binary, size = _load_managed_lut(canonical, directory)
        name = library.entries.get(cube.stem, saved_name or path.stem)
        if cube.stem not in library.entries and (
            (saved_name and library.recover_profiles) or path.resolve() != cube.resolve()
        ):
            library.entries[cube.stem] = name
            _save_library(directory, library)
    return ImportedLut(cube, binary, name, size)


def snapshot_lut(settings: LutSettings, info: VideoInfo) -> str:
    if not settings.enabled:
        return ""
    unknown = {"", "unknown", "unspecified"}
    if (
        info.color_transfer
        not in unknown | {"bt709", "smpte170m", "iec61966-2-1", "gamma22", "gamma28"}
        or info.color_primaries not in unknown | {"bt709", "bt470bg", "smpte170m"}
        or info.color_space not in unknown | {"bt709", "bt470bg", "smpte170m", "gbr"}
    ):
        raise ValueError("LUTs support SDR video. Convert this source to SDR BT.709 first")
    from .settings import get_settings_manager

    directory = get_settings_manager().data_dir / "luts"
    path = Path(settings.path).resolve()
    if path.parent != directory.resolve() or path.suffix != ".cube":
        raise ValueError("Import this LUT again before exporting")
    with _LIBRARY_LOCK, ProcessLock(directory / "library.lock"):
        library = _read_library(directory)
        path = directory / (_library_root(library, path.stem) + ".cube")
    with path.open("rb") as source:
        data = source.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise ValueError("LUT files must be no larger than 16 MiB")
    digest = hashlib.sha256(data).hexdigest()
    if digest != path.stem:
        raise ValueError("This LUT has changed. Import it again before exporting")
    if settings.strength == 1:
        return str(path)
    snapshot = _strength_snapshot(path, data, settings.strength)
    if not snapshot.is_file():
        _strength_snapshot.cache_clear()
        snapshot = _strength_snapshot(path, data, settings.strength)
    return str(snapshot)
