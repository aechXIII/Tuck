"""PyAV and NumPy, loaded when they are first needed instead of when the backend starts.

Reading and scanning their libraries is most of a cold start on Windows, and of the first start
after an update, so the sidecar starts without them and loads them in the background. PyAV's
modules import each other while they load, so two threads importing it at the same time can leave
one with a half-loaded module ("cannot import name FFmpegError"). Every function that imports
either of them calls load_media_libraries() first, which loads them once, under one lock.
"""

from __future__ import annotations

import importlib
import threading

_lock = threading.Lock()
_loaded = threading.Event()


def load_media_libraries() -> None:
    if _loaded.is_set():
        return
    with _lock:
        if not _loaded.is_set():
            for name in ("av", "numpy"):
                importlib.import_module(name)
            _loaded.set()
