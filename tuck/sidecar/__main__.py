from __future__ import annotations

import argparse
import io
import logging
import os
import sys
from typing import TextIO

from .protocol import PROTOCOL_VERSION
from .server import run_server


def claim_protocol_output() -> TextIO:
    """Keep fd 1 for protocol frames only and send everything else written there to stderr.

    One stray ``print`` or a native library writing to stdout would break the frame stream, and
    the shell ends the backend on the first bad line. Frames go to a private copy of fd 1; fd 1
    and ``sys.stdout`` then point at stderr.
    """
    sys.stdout.flush()
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    # frames end in a bare newline on every platform, and each one leaves at once
    return io.TextIOWrapper(
        io.FileIO(protocol_fd, "wb"),
        encoding="utf-8",
        errors="strict",
        newline="\n",
        write_through=True,
    )


def claim_protocol_input() -> TextIO:
    """Read request frames from a private copy of fd 0 and point fd 0 at the null device.

    On Windows, while the server waits in a read on the stdin pipe, every other synchronous call
    on that pipe waits too. A DLL that starts up meanwhile (PyAV and NumPy load in the background)
    asks for the standard input handle and would hang until the next request arrived.
    """
    protocol_fd = os.dup(0)
    null_fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null_fd, 0)
    os.close(null_fd)
    sys.stdin = open(os.devnull, encoding="utf-8")  # noqa: SIM115 - stays open for the process
    return io.TextIOWrapper(io.FileIO(protocol_fd, "rb"), encoding="utf-8", errors="strict")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tuck.sidecar")
    parser.add_argument("--protocol", type=int, required=True)
    args = parser.parse_args(argv)
    if args.protocol != PROTOCOL_VERSION:
        print("Unsupported sidecar protocol version.", file=sys.stderr)
        return 2
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="strict")
    protocol_input = claim_protocol_input()
    protocol_output = claim_protocol_output()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stderr)],
        force=True,
    )
    return run_server(protocol_input, protocol_output, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
