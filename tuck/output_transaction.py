from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from types import TracebackType

from .output_paths import reservation_path, resolve_output_collision

logger = logging.getLogger(__name__)


class OutputTransaction:
    """Own a reserved name and scratch files until one finished file is published.

    With ``replace`` an existing file at the requested name is swapped for the finished
    one when it is published; until then the old file is left alone.
    """

    def __init__(self, output: Path, *, replace: bool = False) -> None:
        self.output = output.absolute()
        self._requested = self.output
        self._replace = replace
        self._reservation: Path | None = None
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._published = False

    @property
    def workspace(self) -> Path:
        if self._directory is None:
            raise RuntimeError("The output transaction is not open.")
        return Path(self._directory.name)

    def _reserve(self) -> None:
        # another export writing the same name right now gets a number either way
        if self._replace and self._claim(self._requested):
            return
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

    def _claim(self, output: Path) -> bool:
        marker = reservation_path(output)
        try:
            descriptor = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return False
        os.close(descriptor)
        self.output = output
        self._reservation = marker
        return True

    def _publish_over_existing(self, result: Path) -> bool:
        """Swap the finished file in for the old one; False when the old one can't be replaced."""
        if self.output != self._requested or self.output.is_dir():
            return False
        try:
            # one atomic step, so a failure leaves either the old file or the new one
            os.replace(result, self.output)
        except OSError as exc:
            # a file open in another program can't be replaced on Windows; the export
            # is kept under a numbered name instead of being lost
            logger.warning("Could not replace %s, keeping both: %s", self.output, exc)
            self._replace = False
            self._release()
            self._reserve()
            return False
        return True

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
        if self._replace and self._publish_over_existing(result):
            self._published = True
            self._release()
            return self.output
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
