"""Desktop-platform policy supplied by the native shell."""

from __future__ import annotations

import os

_DESKTOP_PLATFORM_ENV = "TUCK_DESKTOP_PLATFORM"


def is_linux_desktop() -> bool:
    """Return whether the native shell has selected the Linux desktop policy."""

    return os.environ.get(_DESKTOP_PLATFORM_ENV, "").strip().casefold() == "linux"
