"""Console entry point for the packaged Windows CLI (``TuckCli.exe``).

Tauri owns the graphical shell in 0.5.0, so the packaged CLI never starts an
in-process GUI. This wrapper routes to the same CLI and Send To behavior as
``tuck.app.main`` but replaces the GUI fall-through with CLI help.
"""

from __future__ import annotations

import sys


def main() -> int:
    argv = sys.argv

    from tuck.app import _is_sendto_invocation, _parse_sendto_args, run_sendto_console
    from tuck.cli import main as cli_main

    if _is_sendto_invocation(argv):
        files, profile_id, action = _parse_sendto_args(argv)
        if (action or "start") == "start":
            return run_sendto_console(files, profile_id=profile_id)
        # "review" Send To shortcuts target the Tauri executable, not TuckCli.exe
        print(
            "Tuck: this Send To action opens the Tuck editor; use the Tuck shortcut.",
            file=sys.stderr,
        )
        return 2

    args = argv[1:]
    if not args or args[0] == "gui":
        return cli_main(["--help"])
    return cli_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
