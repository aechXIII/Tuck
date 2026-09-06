"""Frozen entry point for ``tuck-sidecar.exe``.

``tuck.sidecar.__main__`` uses package-relative imports, which fail when
PyInstaller runs it as a top-level script. This wrapper imports it as a proper
submodule so ``__package__`` is set correctly.
"""

from __future__ import annotations

from tuck.sidecar.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
