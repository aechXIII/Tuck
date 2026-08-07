from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

SENDTO_SHORTCUT_NAME = "Tuck.lnk"
SENDTO_BATCH_NAME = "Tuck.bat"
PROFILE_SHORTCUT_PREFIX = "Tuck - "

# embedded in .lnk Description and .bat REM lines so Tuck can tell which shortcuts it owns
_TUCK_MARKER = "TUCK_OWNER_V1"

ACTION_START = "start"
ACTION_REVIEW = "review"


def _sendto_dir() -> Path:
    if os.name == "nt":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            sendto = Path(appdata).parent / "Roaming" / "Microsoft" / "Windows" / "SendTo"
            if sendto.exists():
                return sendto
    return Path.home() / "SendTo"


def _get_target_path() -> str | None:
    if getattr(sys, "frozen", False):
        return sys.executable
    return sys.executable


def _get_args(for_profile: str | None = None, action: str = ACTION_START) -> list[str]:
    if action not in (ACTION_START, ACTION_REVIEW):
        action = ACTION_START

    prefix: list[str] = []
    if not getattr(sys, "frozen", False):
        prefix = ["-m", "tuck"]

    mid: list[str] = []
    if for_profile:
        mid.extend(["--profile-id", for_profile])
    mid.extend(["--sendto-action", action, "--sendto-files"])
    return prefix + mid


def _get_working_dir() -> str:
    if getattr(sys, "frozen", False):
        return str(Path(sys.executable).parent)
    return str(Path(__file__).resolve().parent.parent)


def _get_generic_shortcut_path() -> Path:
    return _sendto_dir() / SENDTO_SHORTCUT_NAME


def _get_profile_shortcut_path(profile_id: str) -> Path:
    return _sendto_dir() / f"{PROFILE_SHORTCUT_PREFIX}{profile_id}.lnk"


def _get_profile_batch_path(profile_id: str) -> Path:
    return _sendto_dir() / f"{PROFILE_SHORTCUT_PREFIX}{profile_id}.bat"


def _get_batch_path() -> Path:
    return _sendto_dir() / SENDTO_BATCH_NAME


def _can_create_shortcuts() -> bool:
    try:
        import pythoncom  # noqa: F401
    except ImportError:
        return False
    return os.name == "nt"


def install_sendto() -> Path:
    target = _get_target_path()
    if not target:
        raise RuntimeError("Cannot determine Tuck executable path")

    sendto = _sendto_dir()
    sendto.mkdir(parents=True, exist_ok=True)
    shortcut_path = _get_generic_shortcut_path()

    batch_path = _get_batch_path()
    if batch_path.exists():
        batch_path.unlink()
        logger.info("Removed old batch fallback: %s", batch_path)

    if _can_create_shortcuts():
        args = _get_args()
        _create_windows_shortcut(
            target,
            shortcut_path,
            arguments=args,
            working_dir=_get_working_dir(),
            description="Compress with Tuck",
            shortcut_type="generic",
        )
        _update_shortcut_setting(True)
        logger.info("Send To shortcut created at %s", shortcut_path)
        return shortcut_path
    else:
        args = _get_args()
        batch = _create_batch_fallback(target, args, sendto)
        _update_shortcut_setting(True)
        logger.info("Send To batch fallback created at %s", batch)
        return batch


def install_profile_shortcut(
    profile_id: str,
    profile_name: str,
    action: str = ACTION_START,
) -> Path:
    target = _get_target_path()
    if not target:
        raise RuntimeError("Cannot determine Tuck executable path")

    sendto = _sendto_dir()
    sendto.mkdir(parents=True, exist_ok=True)
    shortcut_path = _get_profile_shortcut_path(profile_id)

    if _can_create_shortcuts():
        args = _get_args(for_profile=profile_id, action=action)
        desc = f"Compress with Tuck ({profile_name})"
        _create_windows_shortcut(
            target,
            shortcut_path,
            arguments=args,
            working_dir=_get_working_dir(),
            description=desc,
            shortcut_type="profile",
            profile_id=profile_id,
        )
        logger.info("Profile shortcut created: %s", shortcut_path)
        return shortcut_path
    else:
        args = _get_args(for_profile=profile_id, action=action)
        batch_path = sendto / f"{PROFILE_SHORTCUT_PREFIX}{profile_id}.bat"
        _write_batch_file(batch_path, target, args)
        logger.info("Profile batch fallback created: %s", batch_path)
        return batch_path


def uninstall_sendto() -> None:
    sendto = _sendto_dir()
    for name in (SENDTO_SHORTCUT_NAME, SENDTO_BATCH_NAME):
        p = sendto / name
        if p.exists() and _is_tuck_shortcut(p):
            p.unlink()
            logger.info("Removed %s", p)

    _update_shortcut_setting(False)


def uninstall_profile_shortcut(profile_id: str) -> bool:
    removed = False
    shortcut_path = _get_profile_shortcut_path(profile_id)
    if shortcut_path.exists() and _is_tuck_shortcut(shortcut_path):
        shortcut_path.unlink()
        logger.info("Removed profile shortcut: %s", shortcut_path)
        removed = True
    batch_path = _get_profile_batch_path(profile_id)
    if batch_path.exists() and _is_tuck_shortcut(batch_path):
        batch_path.unlink()
        logger.info("Removed profile batch fallback: %s", batch_path)
        removed = True
    return removed


def remove_all_profile_shortcuts() -> int:
    sendto = _sendto_dir()
    count = 0
    for entry in sendto.iterdir():
        if (
            entry.name.startswith(PROFILE_SHORTCUT_PREFIX)
            and entry.suffix in (".lnk", ".bat")
            and _is_tuck_shortcut(entry)
        ):
            entry.unlink()
            count += 1
    return count


def repair_sendto() -> bool:
    if not _can_create_shortcuts():
        logger.debug("pywin32 COM not available; cannot repair .lnk shortcuts")
        return False

    shortcut_path = _get_generic_shortcut_path()
    if not shortcut_path.exists():
        return False
    if not _is_tuck_shortcut(shortcut_path):
        return False
    target = _get_target_path()
    if not target:
        return False

    try:
        import pythoncom
        from win32com.client import Dispatch

        pythoncom.CoInitialize()
        try:
            shell = Dispatch("WScript.Shell")
            sc = shell.CreateShortCut(str(shortcut_path))
            expected_args = " ".join(_get_args())
            if sc.TargetPath == target and (sc.Arguments or "") == expected_args:
                return False
            _create_windows_shortcut(
                target,
                shortcut_path,
                arguments=_get_args(),
                working_dir=_get_working_dir(),
                description="Compress with Tuck",
                shortcut_type="generic",
            )
            logger.info("Repaired Send To shortcut: %s", shortcut_path)
            return True
        finally:
            pythoncom.CoUninitialize()
    except Exception:
        return False


def repair_profile_shortcut(
    profile_id: str,
    profile_name: str,
    action: str = ACTION_START,
) -> bool:
    shortcut_path = _get_profile_shortcut_path(profile_id)
    batch_path = _get_profile_batch_path(profile_id)

    if batch_path.exists() and _is_tuck_shortcut(batch_path):
        target = _get_target_path()
        if not target:
            return False
        args = _get_args(for_profile=profile_id, action=action)
        _write_batch_file(batch_path, target, args)
        logger.info("Repaired profile batch fallback: %s", batch_path)
        return True

    if not _can_create_shortcuts():
        logger.debug("pywin32 COM not available; cannot repair .lnk shortcuts")
        return False
    if not shortcut_path.exists():
        return False
    if not _is_tuck_shortcut(shortcut_path):
        return False
    target = _get_target_path()
    if not target:
        return False

    try:
        import pythoncom
        from win32com.client import Dispatch

        pythoncom.CoInitialize()
        try:
            shell = Dispatch("WScript.Shell")
            sc = shell.CreateShortCut(str(shortcut_path))
            expected_args = " ".join(_get_args(for_profile=profile_id, action=action))
            if sc.TargetPath == target and (sc.Arguments or "") == expected_args:
                return False
            _create_windows_shortcut(
                target,
                shortcut_path,
                arguments=_get_args(for_profile=profile_id, action=action),
                working_dir=_get_working_dir(),
                description=f"Compress with Tuck ({profile_name})",
                shortcut_type="profile",
                profile_id=profile_id,
            )
            logger.info("Repaired profile shortcut: %s", shortcut_path)
            return True
        finally:
            pythoncom.CoUninitialize()
    except Exception:
        return False


def list_sendto_shortcuts() -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    sendto = _sendto_dir()
    if not sendto.exists():
        return result
    for entry in sorted(sendto.iterdir()):
        if (entry.name == SENDTO_SHORTCUT_NAME and entry.suffix == ".lnk") or (
            entry.name == SENDTO_BATCH_NAME and entry.suffix == ".bat"
        ):
            result.append({"name": "Tuck (default)", "path": str(entry), "type": "generic"})
        elif (
            entry.name.startswith(PROFILE_SHORTCUT_PREFIX)
            and entry.suffix in (".lnk", ".bat")
            and _is_tuck_shortcut(entry)
        ):
            profile_id = entry.stem[len(PROFILE_SHORTCUT_PREFIX) :]
            result.append(
                {
                    "name": profile_id,
                    "profile_id": profile_id,
                    "path": str(entry),
                    "type": "profile",
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
    if not path.is_file() or not _can_create_shortcuts():
        return False
    try:
        import pythoncom
        from win32com.client import Dispatch

        pythoncom.CoInitialize()
        try:
            shell = Dispatch("WScript.Shell")
            sc = shell.CreateShortCut(str(path))
            desc = (sc.Description or "").strip()
            if not desc.startswith(_TUCK_MARKER):
                return False
            args = (sc.Arguments or "").lower()
            if "--sendto-files" not in args:
                return False
            target = (sc.TargetPath or "").lower()
            target_base = Path(target).name if target else ""
            return "tuck" in target_base or "python" in target_base
        finally:
            pythoncom.CoUninitialize()
    except Exception:
        return False


def _verify_bat_ownership(path: Path) -> bool:
    try:
        content = path.read_text(encoding="ascii", errors="replace")
    except Exception:
        return False
    if _TUCK_MARKER not in content:
        return False
    return "--sendto-files" in content


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

    parts = [_TUCK_MARKER, shortcut_type]
    if profile_id:
        parts.append(profile_id)
    parts.append(description)
    marked_desc = "|".join(parts)

    pythoncom.CoInitialize()
    try:
        shell = Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(str(shortcut_path))
        shortcut.TargetPath = target
        shortcut.Arguments = " ".join(f'"{a}"' if " " in a else a for a in arguments)
        shortcut.WorkingDirectory = working_dir or str(Path(target).parent)
        shortcut.Description = marked_desc
        shortcut.Save()
    finally:
        pythoncom.CoUninitialize()


def _create_batch_fallback(
    target: str,
    arguments: list[str],
    sendto_dir: Path,
    suffix: str = "",
) -> Path:
    batch_name = f"{SENDTO_BATCH_NAME[:-4]}{suffix}.bat" if suffix else SENDTO_BATCH_NAME
    batch_path = sendto_dir / batch_name
    _write_batch_file(batch_path, target, arguments)
    return batch_path


def _write_batch_file(batch_path: Path, target: str, arguments: list[str]) -> None:
    args_str = " ".join(f'"{a}"' if " " in a else a for a in arguments)
    batch_path.write_text(
        (
            "@echo off\r\n"
            f"REM {_TUCK_MARKER}\r\n"
            f'"{target}" {args_str} %*\r\n'
            "set ERR=%ERRORLEVEL%\r\n"
            "echo.\r\n"
            "if %ERR% neq 0 (\r\n"
            "  echo Tuck finished with errors ^(exit %ERR%^).\r\n"
            ") else (\r\n"
            "  echo Tuck finished successfully.\r\n"
            ")\r\n"
            "pause\r\n"
            "exit /b %ERR%\r\n"
        ),
        encoding="ascii",
    )


def _update_shortcut_setting(installed: bool) -> None:
    from .settings import get_settings_manager

    mgr = get_settings_manager()
    mgr.set_setting("shortcut_installed", installed)
    mgr.save()
