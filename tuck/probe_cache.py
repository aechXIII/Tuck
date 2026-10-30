from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Lock
from typing import Generic, TypeVar

T = TypeVar("T")


class ProbeCache(Generic[T]):
    def __init__(self, probe: Callable[[str], T]) -> None:
        self._probe = probe
        self._entries: dict[str, tuple[int, int, T]] = {}
        self._lock = Lock()

    def cached(self, path: str) -> T | None:
        """What an earlier probe found, if the file hasn't changed since; never probes."""
        signature = _signature(path)
        with self._lock:
            cached = self._entries.get(path)
        return cached[2] if cached is not None and cached[:2] == signature else None

    def get(self, path: str) -> T:
        signature = _signature(path)

        with self._lock:
            cached = self._entries.get(path)
            if cached is not None and cached[:2] == signature:
                return cached[2]

        # Probe outside the lock: it spawns an ffprobe subprocess, and holding the
        # lock across it lets one slow or stuck probe block every other caller
        # (that is how create_plan wedged after an encode left ffprobe busy).
        info = self._probe(path)

        with self._lock:
            cached = self._entries.get(path)
            if cached is not None and cached[:2] == signature:
                return cached[2]
            self._entries[path] = (signature[0], signature[1], info)
            return info


def _signature(path: str) -> tuple[int, int]:
    stat = Path(path).stat()
    return stat.st_size, stat.st_mtime_ns
