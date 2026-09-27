from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from types import TracebackType

from .output_paths import reservation_path, resolve_output_collision

logger = logging.getLogger(__name__)


class OutputTransaction:
    """Own a reserved name and scratch files until one finished file is published."""

    def __init__(self, output: Path) -> None:
        self.output = output.absolute()
        self._requested = self.output
        self._reservation: Path | None = None
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._published = False

    @property
    def workspace(self) -> Path:
        if self._directory is None:
            raise RuntimeError("The output transaction is not open.")
        return Path(self._directory.name)

    def _reserve(self) -> None:
        for _ in range(101):
            output = resolve_output_collision(self._requested)
            marker = reservation_path(output)
            try:
                descriptor = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                continue
            os.close(descriptor)
            self.output = output
            self._reservation = marker
            return
        raise FileExistsError("Cannot reserve an output name. Try another output folder.")

    def _release(self) -> None:
        if self._reservation is not None:
            try:
                self._reservation.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("Could not remove the export reservation: %s", exc)
            finally:
                self._reservation = None

    def __enter__(self) -> OutputTransaction:
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self._reserve()
        try:
            self._directory = tempfile.TemporaryDirectory(prefix=".tuck-", dir=self.output.parent)
        except BaseException:
            self._release()
            raise
        return self

    def publish(self, result: Path) -> Path:
        if self._published:
            raise RuntimeError("This output has already been published.")
        if not result.resolve().is_relative_to(self.workspace.resolve()) or result.is_symlink():
            raise ValueError("The result must be a file inside the output workspace.")
        for _ in range(101):
            if self.output.exists():
                self._release()
                self._reserve()
            try:
                # Windows rename refuses replacement; POSIX link provides the same guarantee
                if os.name == "nt":
                    os.rename(result, self.output)
                else:
                    os.link(result, self.output)
            except FileExistsError:
                self._release()
                self._reserve()
                continue
            self._published = True
            self._release()
            return self.output
        raise FileExistsError("Cannot publish the output. Try another output folder.")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            if self._directory is not None:
                try:
                    self._directory.cleanup()
                except OSError as exc:
                    # cleanup must not change a saved result or hide the original failure
                    logger.warning("Could not remove the export workspace: %s", exc)
                finally:
                    self._directory = None
        finally:
            self._release()
