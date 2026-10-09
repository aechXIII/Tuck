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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tuck.sidecar")
    parser.add_argument("--protocol", type=int, required=True)
    args = parser.parse_args(argv)
    if args.protocol != PROTOCOL_VERSION:
        print("Unsupported sidecar protocol version.", file=sys.stderr)
        return 2
    for stream in (sys.stdin, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8", errors="strict")
    protocol_output = claim_protocol_output()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stderr)],
        force=True,
    )
    return run_server(sys.stdin, protocol_output, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
