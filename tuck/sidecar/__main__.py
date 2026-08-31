from __future__ import annotations

import argparse
import io
import logging
import sys

from .protocol import PROTOCOL_VERSION
from .server import run_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tuck.sidecar")
    parser.add_argument("--protocol", type=int, required=True)
    args = parser.parse_args(argv)
    if args.protocol != PROTOCOL_VERSION:
        print("Unsupported sidecar protocol version.", file=sys.stderr)
        return 2
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8", errors="strict")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[logging.StreamHandler(sys.stderr)],
        force=True,
    )
    return run_server(sys.stdin, sys.stdout, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
