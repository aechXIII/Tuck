from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from .. import __version__
from ..bridge import BridgeAPI
from .protocol import Event

logger = logging.getLogger(__name__)


@dataclass
class BackendLifecycle:
    _api: BridgeAPI | None = None
    _stopped: bool = False

    def start(self) -> BridgeAPI:
        if self._api is None:
            from ..settings import configure_storage_root

            root = os.environ.get("TUCK_SIDECAR_DATA_ROOT")
            if root:
                configure_storage_root(Path(root))
            self._api = BridgeAPI()
            self._configure_file_logging(self._api.log_dir / "tuck.log")
            self._api.start_background_services()
        return self._api

    def ready_event(self) -> Event:
        return Event(
            event="backend_ready",
            payload={
                "backend_version": __version__,
                "pid": os.getpid(),
                "capabilities": {"protocol": 1},
            },
        )

    def shutdown(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self._api is None:
            return
        self._api.stop_background_services()

    @staticmethod
    def _configure_file_logging(log_file: Path) -> None:
        root = logging.getLogger()
        resolved = log_file.resolve()
        for handler in root.handlers:
            if isinstance(handler, logging.FileHandler) and handler.baseFilename == str(resolved):
                return
        handler = logging.FileHandler(resolved, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
        root.addHandler(handler)
        logger.debug("Sidecar file logging configured")
