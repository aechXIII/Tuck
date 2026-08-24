from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def reservation_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + ".reserved")


def path_is_taken(output: Path, *, respect_reservation: bool = True) -> bool:
    if output.exists():
        return True
    return respect_reservation and reservation_path(output).exists()


def resolve_output_collision(
    output: Path,
    *,
    respect_reservation: bool = True,
) -> Path:
    if not path_is_taken(output, respect_reservation=respect_reservation):
        return output
    base = output.parent / output.stem
    suffix = output.suffix
    for counter in range(1, 101):
        candidate = base.parent / f"{base.name}_{counter}{suffix}"
        if not path_is_taken(candidate, respect_reservation=respect_reservation):
            logger.info("Output collision resolved: %s -> %s", output, candidate)
            return candidate
    raise ValueError(f"Too many output file collisions for {output}. Clean up existing files.")
