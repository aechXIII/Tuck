from __future__ import annotations

import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from .desktop_platform import is_linux_desktop
from .models.encoding_policy import WORKFLOW_COMPRESSION, WORKFLOW_UPSCALE

logger = logging.getLogger(__name__)

PROFILE_SHORTCUT_PREFIX = "Tuck - "
_PROFILE_MARKER_TYPE = "profile"
_PROFILE_NAME_MAX_LENGTH = 80
_INVALID_FILE_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_PROFILE_ID_PATTERN = r"[a-z0-9][a-z0-9-]{0,63}"
_PROFILE_ID_ARGUMENT = re.compile(rf'(?:^|\s)--profile-id\s+"?({_PROFILE_ID_PATTERN})"?(?=\s|$)')

# embedded in .lnk Description and .bat REM lines so Tuck can tell which shortcuts it owns
_TUCK_MARKER = "TUCK_OWNER_V1"
_SHELL_LINK_HEADER = (
    b"\x4c\x00\x00\x00\x01\x14\x02\x00\x00\x00\x00\x00\xc0\x00\x00\x00\x00\x00\x00\x46"
)

ACTION_START = "start"
ACTION_REVIEW = "review"


@dataclass(frozen=True)
class GenericShortcut:
    kind: str
    stem: str
    action: str
    task: str | None
    description: str

    @property
    def marker_type(self) -> str:
        return f"generic-{self.kind}"


# the file stem identifies the kind, so shortcuts made by the older paired
# install (marker type "generic") still count as "open" and "compress"
_GENERIC_SHORTCUTS: dict[str, GenericShortcut] = {
    spec.kind: spec
    for spec in (
        GenericShortcut("open", "Tuck", ACTION_REVIEW, None, "Open in Tuck"),
        GenericShortcut("compress", "Tuck Compress", ACTION_START, None, "Compress with Tuck"),
        GenericShortcut("upscale", "Tuck Upscale", ACTION_START, "upscale", "Upscale with Tuck"),
        GenericShortcut(
            "cut", "Tuck Lossless Cut", ACTION_REVIEW, "cut", "Open in Tuck Lossless Cut"
        ),
    )
}
SENDTO_KINDS: tuple[str, ...] = tuple(_GENERIC_SHORTCUTS)
_LEGACY_SHORTCUT_NAME = "Tuck.lnk"


def generic_shortcut(kind: object) -> GenericShortcut:
    if not isinstance(kind, str) or kind not in _GENERIC_SHORTCUTS:
        raise ValueError("Send To shortcut kind must be open, compress, upscale, or cut.")
    return _GENERIC_SHORTCUTS[kind]


def _require_sendto_support() -> None:
    if is_linux_desktop():
        raise OSError("Send To shortcuts are only available on Windows.")


def _sendto_dir() -> Path:
    if os.name == "nt":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            sendto = Path(appdata).parent / "Roaming" / "Microsoft" / "Windows" / "SendTo"
            if sendto.exists():
                return sendto
    return Path.home() / "SendTo"


def _validate_executable_path(executable_path: str | Path | None) -> str:
    if executable_path is None:
        return ""
    if not isinstance(executable_path, (str, Path)):
        raise TypeError("executable_path must be a string path")
    text = str(executable_path).strip()
    if not text:
        raise ValueError("executable_path must be a non-empty string")
    if "\x00" in text:
        raise ValueError("executable_path contains invalid characters")
    candidate = Path(text)
    if not candidate.is_absolute():
        raise ValueError(f"executable_path must be absolute: {text}")
    if not candidate.parent.exists():
        raise ValueError(f"executable_path parent does not exist: {text}")
    name = candidate.name.lower()
    if "tuck" not in name and "python" not in name:
        raise ValueError(f"executable_path does not look like a Tuck executable: {text}")
    return str(candidate)


def _get_target_path(
    executable_path: str | Path | None = None,
    action: str = ACTION_REVIEW,
) -> str | None:
    if executable_path is not None:
        validated = _validate_executable_path(executable_path)
        if validated:
            return validated
    if getattr(sys, "frozen", False):
        # in a packaged install Tuck.exe (editor), TuckCli.exe (headless console
        # encode) and tuck-sidecar.exe share one directory; "review" opens the
        # editor and "start" runs the encoder, so resolve by sibling name and
        # the shortcut works whichever process created it
        exe_dir = Path(sys.executable).parent
        preferred = "TuckCli.exe" if action == ACTION_START else "Tuck.exe"
        for name in (preferred, "Tuck.exe", "TuckCli.exe"):
            candidate = exe_dir / name
            if candidate.is_file():
                return str(candidate)
        return str(Path(sys.executable))
    if action == ACTION_REVIEW:
        raise RuntimeError(
            "Opening videos from Send To requires the Tuck desktop app. "
            "Install it, then add the shortcuts in Settings > File Explorer."
        )
    return sys.executable


def _get_args(
    for_profile: str | None = None,
    action: str = ACTION_START,
    task: str | None = None,
) -> list[str]:
    if action not in (ACTION_START, ACTION_REVIEW):
        action = ACTION_START

    prefix: list[str] = []
    if not getattr(sys, "frozen", False) and action != ACTION_REVIEW:
        prefix = ["-m", "tuck"]

    mid: list[str] = []
    if for_profile:
        mid.extend(["--profile-id", for_profile])
    mid.extend(["--sendto-action", action])
    if task:
        mid.extend(["--sendto-task", task])
    mid.append("--sendto-files")
    return prefix + mid


def _get_working_dir() -> str:
    if getattr(sys, "frozen", False):
        return str(Path(sys.executable).parent)
    return str(Path(__file__).resolve().parent.parent)


def _generic_paths(spec: GenericShortcut) -> tuple[Path, Path]:
    sendto = _sendto_dir()
    return sendto / f"{spec.stem}.lnk", sendto / f"{spec.stem}.bat"


def profile_shortcut_stems(profile_id: str, profile_name: str) -> tuple[str, ...]:
    """Return the file stems a profile shortcut may use, in order of preference.

    Explorer shows the stem in the Send To menu. The "Tuck - " prefix also
    means a stem can never be a reserved device name such as CON.
    """
    safe = " ".join(_INVALID_FILE_NAME_CHARS.sub(" ", profile_name).split())
    safe = safe[:_PROFILE_NAME_MAX_LENGTH].rstrip(". ")
    if not safe:
        return (f"{PROFILE_SHORTCUT_PREFIX}{profile_id}",)
    return (
        f"{PROFILE_SHORTCUT_PREFIX}{safe}",
        f"{PROFILE_SHORTCUT_PREFIX}{safe} ({profile_id})",
    )


def _profile_description(profile_name: str, workflow: str) -> str:
    verb = "Upscale" if workflow == WORKFLOW_UPSCALE else "Compress"
    return f"{verb} with Tuck ({profile_name})"


def _profile_shortcut_entries() -> list[Path]:
    sendto = _sendto_dir()
    if not sendto.is_dir():
        return []
    return sorted(
        entry
        for entry in sendto.iterdir()
        if entry.name.startswith(PROFILE_SHORTCUT_PREFIX) and entry.suffix in (".lnk", ".bat")
    )


def _marker_profile_id(marker: str) -> str | None:
    parts = marker.strip().split("|")
    if (
        len(parts) >= 3
        and parts[0] == _TUCK_MARKER
        and parts[1] == _PROFILE_MARKER_TYPE
        and re.fullmatch(_PROFILE_ID_PATTERN, parts[2])
    ):
        return parts[2]
    return None


def _argument_profile_id(arguments: str) -> str | None:
    match = _PROFILE_ID_ARGUMENT.search(arguments)
    return match.group(1) if match else None


def _owned_profile_id(path: Path) -> str | None:
    """Return the profile an owned shortcut belongs to, read from its contents.

    The file name is never trusted: it follows the profile name and can be
    anything. Batch files from older installs have no id in their marker, so
    their --profile-id argument is used instead.
    """
    suffix = path.suffix.lower()
    if suffix == ".bat":
        if not _verify_bat_ownership(path):
            return None
        try:
            text = path.read_text(encoding="ascii", errors="replace")
        except OSError:
            return None
        marker = next(
            (line[4:] for line in text.splitlines() if line.startswith(f"REM {_TUCK_MARKER}")), ""
        )
        return _marker_profile_id(marker) or _argument_profile_id(text)
    if suffix == ".lnk":
        if not _verify_lnk_ownership(path):
            return None
        link = _read_link(path)
        if link is None:
            return None
        return _marker_profile_id(link.description) or _argument_profile_id(link.arguments)
    return None


def _owned_profile_files(profile_id: str) -> list[Path]:
    return [path for path in _profile_shortcut_entries() if _owned_profile_id(path) == profile_id]


def _choose_profile_stem(profile_id: str, profile_name: str, owned: list[Path]) -> str:
    sendto = _sendto_dir()
    owned_names = {path.name.casefold() for path in owned}
    stems = profile_shortcut_stems(profile_id, profile_name)
    for stem in stems:
        # Explorer hides extensions, so a .bat and a .lnk with one stem look like duplicates
        paths = (sendto / f"{stem}.lnk", sendto / f"{stem}.bat")
        if all(not path.exists() or path.name.casefold() in owned_names for path in paths):
            return stem
    raise FileExistsError(
        f'Send To already has a shortcut named "{stems[0]}". '
        "Rename the profile or remove that shortcut, then try again."
    )


def _move_profile_files(owned: list[Path], stem: str) -> tuple[list[Path], bool]:
    """Rename a profile's shortcut files to stem and drop duplicates.

    Returns the files now in place and whether anything changed on disk.
    """
    placed: dict[str, Path] = {}
    changed = False
    # a file already at its new name goes first, so a stray older copy is the one removed
    for path in sorted(owned, key=lambda item: item.stem.casefold() != stem.casefold()):
        suffix = path.suffix.lower()
        destination = path.with_name(f"{stem}{suffix}")
        if suffix in placed:
            path.unlink()
            logger.info("Removed duplicate profile shortcut: %s", path)
            changed = True
            continue
        if path.name != destination.name:
            # a plain rename also handles a change in letter case only
            path.rename(destination)
            logger.info("Renamed profile shortcut: %s -> %s", path, destination)
            changed = True
        placed[suffix] = destination
    return list(placed.values()), changed


def _can_create_shortcuts() -> bool:
    try:
        import pythoncom  # noqa: F401
    except ImportError:
        return False
    return os.name == "nt"


def _is_legacy_generic_shortcut(path: Path) -> bool:
    if path.name != _LEGACY_SHORTCUT_NAME or not path.is_file() or not _can_create_shortcuts():
        return False
    try:
        with path.open("rb") as shortcut_file:
            if shortcut_file.read(len(_SHELL_LINK_HEADER)) != _SHELL_LINK_HEADER:
                return False

        import pythoncom
        from win32com.client import Dispatch

        pythoncom.CoInitialize()
        try:
            shell = Dispatch("WScript.Shell")
            shortcut = shell.CreateShortCut(str(path))
            target = _get_target_path()
            return bool(
                target
                and (shortcut.TargetPath or "").casefold() == target.casefold()
                and (shortcut.Arguments or "").strip() == "--sendto-files"
                and (shortcut.Description or "").strip() == "Compress with Tuck"
            )
        finally:
            shortcut = None
            shell = None
            pythoncom.CoUninitialize()
    except Exception:
        return False


def _is_owned_generic_file(path: Path) -> bool:
    return path.exists() and (_is_tuck_shortcut(path) or _is_legacy_generic_shortcut(path))


def _ensure_generic_destination_available(spec: GenericShortcut) -> None:
    for path in _generic_paths(spec):
        if path.exists() and not _is_owned_generic_file(path):
            raise FileExistsError(
                f"Explorer shortcut already exists and is not owned by Tuck: {path}"
            )


def install_generic_shortcut(kind: str, executable_path: str | Path | None = None) -> Path:
    _require_sendto_support()
    spec = generic_shortcut(kind)
    target = _get_target_path(executable_path, spec.action)
    if not target:
        raise RuntimeError("Cannot determine Tuck executable path")

    _sendto_dir().mkdir(parents=True, exist_ok=True)
    _ensure_generic_destination_available(spec)
    shortcut_path, batch_path = _generic_paths(spec)
    arguments = _get_args(action=spec.action, task=spec.task)

    if not _can_create_shortcuts():
        _write_batch_file(batch_path, target, arguments, marker_type=spec.marker_type)
        logger.info("Send To batch fallback created: %s", batch_path)
        return batch_path

    if batch_path.exists() and _is_tuck_shortcut(batch_path):
        batch_path.unlink()
        logger.info("Removed old batch fallback: %s", batch_path)
    _create_windows_shortcut(
        target,
        shortcut_path,
        arguments=arguments,
        working_dir=_get_working_dir(),
        description=spec.description,
        shortcut_type=spec.marker_type,
    )
    logger.info("Send To shortcut created: %s", shortcut_path)
    return shortcut_path


def install_profile_shortcut(
    profile_id: str,
    profile_name: str,
    action: str = ACTION_START,
    executable_path: str | Path | None = None,
    *,
    workflow: str = WORKFLOW_COMPRESSION,
) -> Path:
    _require_sendto_support()
    target = _get_target_path(executable_path, action)
    if not target:
        raise RuntimeError("Cannot determine Tuck executable path")

    sendto = _sendto_dir()
    sendto.mkdir(parents=True, exist_ok=True)
    owned = _owned_profile_files(profile_id)
    stem = _choose_profile_stem(profile_id, profile_name, owned)
    placed, _ = _move_profile_files(owned, stem)
    args = _get_args(for_profile=profile_id, action=action)

    if _can_create_shortcuts():
        path = sendto / f"{stem}.lnk"
        _create_windows_shortcut(
            target,
            path,
            arguments=args,
            working_dir=_get_working_dir(),
            description=_profile_description(profile_name, workflow),
            shortcut_type=_PROFILE_MARKER_TYPE,
            profile_id=profile_id,
        )
        logger.info("Profile shortcut created: %s", path)
    else:
        path = sendto / f"{stem}.bat"
        _write_batch_file(
            path, target, args, marker_type=_PROFILE_MARKER_TYPE, profile_id=profile_id
        )
        logger.info("Profile batch fallback created: %s", path)

    # one shortcut per profile, so an older batch fallback goes once the link exists
    for old in placed:
        if old.name.casefold() != path.name.casefold() and old.exists():
            old.unlink()
            logger.info("Removed old profile shortcut: %s", old)
    return path


def uninstall_generic_shortcut(kind: str) -> bool:
    _require_sendto_support()
    spec = generic_shortcut(kind)
    removed = False
    for path in _generic_paths(spec):
        if path.exists() and _is_tuck_shortcut(path):
            path.unlink()
            logger.info("Removed %s", path)
            removed = True
    return removed


def uninstall_sendto() -> None:
    """Remove every Tuck-owned generic shortcut; profile shortcuts stay."""
    _require_sendto_support()
    for kind in SENDTO_KINDS:
        uninstall_generic_shortcut(kind)


def uninstall_profile_shortcut(profile_id: str) -> bool:
    _require_sendto_support()
    removed = False
    for path in _owned_profile_files(profile_id):
        path.unlink()
        logger.info("Removed profile shortcut: %s", path)
        removed = True
    return removed


def rename_profile_shortcut(
    profile_id: str, profile_name: str, *, workflow: str = WORKFLOW_COMPRESSION
) -> bool:
    """Give a profile's shortcut the profile's current name and description.

    The shortcut keeps its target and arguments. Returns False when the
    profile has no shortcut or it already matches.
    """
    _require_sendto_support()
    owned = _owned_profile_files(profile_id)
    if not owned:
        return False
    stem = _choose_profile_stem(profile_id, profile_name, owned)
    placed, changed = _move_profile_files(owned, stem)
    description = _marked_description(
        _PROFILE_MARKER_TYPE, _profile_description(profile_name, workflow), profile_id
    )
    for path in placed:
        if path.suffix.lower() == ".lnk" and _set_link_description(path, description):
            changed = True
    return changed


def remove_all_profile_shortcuts() -> int:
    _require_sendto_support()
    count = 0
    for entry in _profile_shortcut_entries():
        if _is_tuck_shortcut(entry):
            entry.unlink()
            count += 1
    return count


def repair_generic_shortcut(kind: str, executable_path: str | Path | None = None) -> bool:
    """Point an installed generic shortcut back at this Tuck install.

    Returns False when the kind is not installed or already correct. Only files
    Tuck owns are rewritten.
    """
    _require_sendto_support()
    spec = generic_shortcut(kind)
    shortcut_path, batch_path = _generic_paths(spec)
    shortcut_owned = _is_owned_generic_file(shortcut_path)
    batch_owned = batch_path.exists() and _is_tuck_shortcut(batch_path)
    if not shortcut_owned and not batch_owned:
        return False

    # resolve before touching files so an unsupported editor target is reported
    try:
        target = _get_target_path(executable_path, spec.action)
    except (ValueError, TypeError):
        return False
    if not target:
        return False
    arguments = _get_args(action=spec.action, task=spec.task)

    repaired = False
    if batch_owned:
        expected = _batch_content(target, arguments, marker_type=spec.marker_type)
        if batch_path.read_bytes() != expected:
            batch_path.write_bytes(expected)
            logger.info("Repaired Send To batch fallback: %s", batch_path)
            repaired = True
    if shortcut_owned and not _windows_shortcut_matches(shortcut_path, target, arguments):
        _create_windows_shortcut(
            target,
            shortcut_path,
            arguments=arguments,
            working_dir=_get_working_dir(),
            description=spec.description,
            shortcut_type=spec.marker_type,
        )
        logger.info("Repaired Send To shortcut: %s", shortcut_path)
        repaired = True
    return repaired


def _windows_shortcut_matches(shortcut_path: Path, target: str, arguments: list[str]) -> bool:
    import pythoncom
    from win32com.client import Dispatch

    pythoncom.CoInitialize()
    try:
        shell = Dispatch("WScript.Shell")
        sc = shell.CreateShortCut(str(shortcut_path))
        return sc.TargetPath == target and (sc.Arguments or "") == _join_arguments(arguments)
    finally:
        sc = None
        shell = None
        pythoncom.CoUninitialize()


def repair_profile_shortcut(
    profile_id: str,
    profile_name: str,
    action: str = ACTION_START,
    executable_path: str | Path | None = None,
    *,
    workflow: str = WORKFLOW_COMPRESSION,
) -> bool:
    """Point a profile's shortcut at this Tuck install under the current name.

    Returns False when the profile has no shortcut or it is already correct.
    Raises FileExistsError when the new name is taken by a file Tuck does not
    own or by another profile's shortcut.
    """
    _require_sendto_support()
    owned = _owned_profile_files(profile_id)
    if not owned:
        return False
    # resolve before touching files so a bad executable path changes nothing
    try:
        target = _get_target_path(executable_path, action)
    except (ValueError, TypeError):
        return False
    if not target:
        return False

    stem = _choose_profile_stem(profile_id, profile_name, owned)
    placed, repaired = _move_profile_files(owned, stem)
    args = _get_args(for_profile=profile_id, action=action)
    description = _profile_description(profile_name, workflow)
    marked = _marked_description(_PROFILE_MARKER_TYPE, description, profile_id)
    for path in placed:
        if path.suffix.lower() == ".bat":
            expected = _batch_content(
                target, args, marker_type=_PROFILE_MARKER_TYPE, profile_id=profile_id
            )
            if path.read_bytes() != expected:
                path.write_bytes(expected)
                logger.info("Repaired profile batch fallback: %s", path)
                repaired = True
            continue
        link = _read_link(path)
        if (
            link is not None
            and link.target == target
            and link.arguments == _join_arguments(args)
            and link.description == marked
        ):
            continue
        _create_windows_shortcut(
            target,
            path,
            arguments=args,
            working_dir=_get_working_dir(),
            description=description,
            shortcut_type=_PROFILE_MARKER_TYPE,
            profile_id=profile_id,
        )
        logger.info("Repaired profile shortcut: %s", path)
        repaired = True
    return repaired


def list_sendto_shortcuts() -> list[dict[str, str]]:
    _require_sendto_support()
    result: list[dict[str, str]] = []
    sendto = _sendto_dir()
    if not sendto.exists():
        return result
    for spec in _GENERIC_SHORTCUTS.values():
        existing = [path for path in _generic_paths(spec) if path.exists()]
        if not existing:
            continue
        # a file Tuck cannot prove it owns needs a repair or a manual cleanup
        owned = all(_is_tuck_shortcut(path) for path in existing)
        result.append(
            {
                "name": spec.stem,
                "type": "generic",
                "kind": spec.kind,
                "status": "ok" if owned else "broken",
                "path": str(existing[0]),
            }
        )
    for entry in _profile_shortcut_entries():
        profile_id = _owned_profile_id(entry)
        if profile_id is None:
            continue
        result.append(
            {
                "name": entry.stem,
                "profile_id": profile_id,
                "path": str(entry),
                "type": "profile",
                "status": "ok",
            }
        )
    return result


def _is_tuck_shortcut(path: Path) -> bool:
    if not path.exists():
        return False

    suffix = path.suffix.lower()
    if suffix == ".lnk":
        return _verify_lnk_ownership(path)
    if suffix == ".bat":
        return _verify_bat_ownership(path)
    return False


def _verify_lnk_ownership(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        with path.open("rb") as shortcut_file:
            if shortcut_file.read(len(_SHELL_LINK_HEADER)) != _SHELL_LINK_HEADER:
                return False
    except OSError:
        return False
    if not _can_create_shortcuts():
        return False
    link = _read_link(path)
    if link is None:
        return False
    if not link.description.strip().startswith(_TUCK_MARKER):
        return False
    if "--sendto-files" not in link.arguments.lower():
        return False
    target_base = Path(link.target.lower()).name if link.target else ""
    return "tuck" in target_base or "python" in target_base


def _verify_bat_ownership(path: Path) -> bool:
    try:
        content = path.read_text(encoding="ascii", errors="replace")
    except Exception:
        return False
    if _TUCK_MARKER not in content:
        return False
    return "--sendto-files" in content


def _join_arguments(arguments: list[str]) -> str:
    return " ".join(f'"{a}"' if " " in a else a for a in arguments)


def _marked_description(shortcut_type: str, description: str, profile_id: str = "") -> str:
    parts = [_TUCK_MARKER, shortcut_type]
    if profile_id:
        parts.append(profile_id)
    parts.append(description)
    return "|".join(parts)


@dataclass(frozen=True)
class _LinkFields:
    target: str
    arguments: str
    description: str


def _read_link(path: Path) -> _LinkFields | None:
    try:
        import pythoncom
        from win32com.client import Dispatch

        pythoncom.CoInitialize()
        try:
            shell = Dispatch("WScript.Shell")
            sc = shell.CreateShortCut(str(path))
            return _LinkFields(sc.TargetPath or "", sc.Arguments or "", sc.Description or "")
        finally:
            sc = None
            shell = None
            pythoncom.CoUninitialize()
    except Exception:
        return None


def _set_link_description(path: Path, description: str) -> bool:
    import pythoncom
    from win32com.client import Dispatch

    pythoncom.CoInitialize()
    try:
        shell = Dispatch("WScript.Shell")
        sc = shell.CreateShortCut(str(path))
        if (sc.Description or "") == description:
            return False
        sc.Description = description
        sc.Save()
        return True
    finally:
        sc = None
        shell = None
        pythoncom.CoUninitialize()


def _create_windows_shortcut(
    target: str,
    shortcut_path: Path,
    arguments: list[str],
    working_dir: str = "",
    description: str = "Compress with Tuck",
    shortcut_type: str = "generic",
    profile_id: str = "",
) -> None:
    import pythoncom
    from win32com.client import Dispatch

    pythoncom.CoInitialize()
    try:
        shell = Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(str(shortcut_path))
        shortcut.TargetPath = target
        shortcut.Arguments = _join_arguments(arguments)
        shortcut.WorkingDirectory = working_dir or str(Path(target).parent)
        shortcut.Description = _marked_description(shortcut_type, description, profile_id)
        shortcut.Save()
    finally:
        shortcut = None
        shell = None
        pythoncom.CoUninitialize()


def _batch_content(
    target: str, arguments: list[str], marker_type: str = "", profile_id: str = ""
) -> bytes:
    marker = "|".join(part for part in (_TUCK_MARKER, marker_type, profile_id) if part)
    return (
        "@echo off\r\n"
        f"REM {marker}\r\n"
        f'"{target}" {_join_arguments(arguments)} %*\r\n'
        "set ERR=%ERRORLEVEL%\r\n"
        "echo.\r\n"
        "if %ERR% neq 0 (\r\n"
        "  echo Tuck finished with errors ^(exit %ERR%^).\r\n"
        ") else (\r\n"
        "  echo Tuck finished successfully.\r\n"
        ")\r\n"
        "pause\r\n"
        "exit /b %ERR%\r\n"
    ).encode("ascii")


def _write_batch_file(
    batch_path: Path,
    target: str,
    arguments: list[str],
    marker_type: str = "",
    profile_id: str = "",
) -> None:
    # bytes keep the CRLF line endings exact so repair can compare contents
    batch_path.write_bytes(_batch_content(target, arguments, marker_type, profile_id))
