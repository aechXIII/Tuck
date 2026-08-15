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

    def get(self, path: str) -> T:
        with self._lock:
            stat = Path(path).stat()
            signature = (stat.st_size, stat.st_mtime_ns)
            cached = self._entries.get(path)
            if cached is not None and cached[:2] == signature:
                return cached[2]
            info = self._probe(path)
            self._entries[path] = (signature[0], signature[1], info)
            return info
