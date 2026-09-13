from __future__ import annotations

import contextlib
import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_CLI_SUBCOMMANDS = frozenset(
    {
        "probe",
        "compress",
        "upscale",
        "profiles",
        "settings",
        "sendto",
    }
)

_SENDTO_FILES_FLAG = "--sendto-files"
_SENDTO_ACTION_FLAG = "--sendto-action"
_SENDTO_PROFILE_FLAG = "--profile-id"


def _is_cli_invocation(argv: list[str]) -> bool:
    if len(argv) <= 1:
        return False
    first = argv[1]
    if first in _CLI_SUBCOMMANDS:
        return True

    return first in ("--version", "--help", "-h")


def _is_sendto_invocation(argv: list[str]) -> bool:

    return _SENDTO_FILES_FLAG in argv


def _parse_sendto_args(argv: list[str]) -> tuple[list[str], str | None, str | None]:

    files: list[str] = []
    profile_id: str | None = None
    action: str | None = None
    skip_next = False
    for i, arg in enumerate(argv):
        if skip_next:
            skip_next = False
            continue
        if arg == _SENDTO_FILES_FLAG:
            files.extend(argv[i + 1 :])
            break
        if arg == _SENDTO_PROFILE_FLAG:
            if i + 1 < len(argv):
                profile_id = argv[i + 1]
                skip_next = True
            continue
        if arg == _SENDTO_ACTION_FLAG:
            if i + 1 < len(argv):
                action = argv[i + 1]
                skip_next = True
            continue
    return files, profile_id, action


def _ensure_console() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        if not kernel32.GetConsoleWindow() and not kernel32.AllocConsole():
            return

        sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace")  # noqa: SIM115
        sys.stderr = open("CONOUT$", "w", encoding="utf-8", errors="replace")  # noqa: SIM115
        sys.stdin = open("CONIN$", encoding="utf-8", errors="replace")  # noqa: SIM115
        mode = ctypes.c_uint()
        stdout_handle = kernel32.GetStdHandle(-11)
        stderr_handle = kernel32.GetStdHandle(-12)
        for handle in (stdout_handle, stderr_handle):
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        logger.debug("Could not allocate console for Send To", exc_info=True)


def run_sendto_console(
    files: list[str],
    profile_id: str | None = None,
) -> int:
    _ensure_console()

    from .settings import get_settings_manager

    mgr = get_settings_manager()
    log_file = mgr.log_dir / "tuck.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.FileHandler(log_file, encoding="utf-8")],
        force=True,
    )

    valid = [f for f in files if Path(f).is_file()]
    if not valid:
        print("Tuck Send To: no valid video files were provided.")
        print("Select one or more video files, then use Send To -> Tuck Compress.")
        with contextlib.suppress(EOFError):
            input("\nPress Enter to close...")
        return 1

    from .cli import run_console_encode

    code = run_console_encode(valid, profile_id=profile_id)
    with contextlib.suppress(EOFError):
        input("\nPress Enter to close...")
    return code


# the editor is its own desktop app now, so this entry point covers the
# command line and Send To only
_DESKTOP_APP_HINT = (
    'Open Tuck from your applications to use the editor. Run "tuck --help" for the command line.'
)


def main() -> int:
    if _is_cli_invocation(sys.argv):
        _ensure_console()

        from .cli import main as cli_main

        return cli_main(sys.argv[1:])

    if _is_sendto_invocation(sys.argv):
        files, profile_id, action = _parse_sendto_args(sys.argv)
        if (action or "start") == "start":
            logger.info(
                "Send To start: %d file arg(s), profile=%s",
                len(files),
                profile_id or "(default)",
            )
            return run_sendto_console(files, profile_id=profile_id)
        _ensure_console()
        print(
            "Could not open the selected videos from this shortcut. "
            "Install the Tuck desktop app, then repair the shortcuts "
            "in Settings > File Explorer.",
            file=sys.stderr,
        )
        return 1

    if len(sys.argv) <= 1 or sys.argv[1] == "gui":
        print(_DESKTOP_APP_HINT)
        return 0

    _ensure_console()

    from .cli import main as cli_main

    return cli_main(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
