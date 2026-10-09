from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from types import TracebackType

from .output_paths import (
    WORKSPACE_PREFIX,
    HeldFile,
    hard_links_unsupported,
    hold_new_file,
    new_workspace_id,
    reservation_path,
    resolve_output_collision,
    sweep_stale_outputs,
    workspace_lock_path,
)

logger = logging.getLogger(__name__)


class Workspace:
    """A hidden scratch folder beside the export, guarded by a held lock file.

    The lock is created before the folder and removed after it, so a sweep in any
    Tuck process can tell a folder left by a crash from one still in use.
    """

    def __init__(self, path: Path, lock: HeldFile) -> None:
        self.path = path
        self._lock = lock

    def remove(self) -> None:
        try:
            shutil.rmtree(self.path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            # cleanup must not change a saved result or hide the original failure; once
            # the lock is released a later sweep removes what is left
            logger.warning("Could not remove the export workspace: %s", exc)
        finally:
            self._lock.release()


def open_workspace(folder: Path) -> Workspace:
    for _ in range(100):
        path = folder / f"{WORKSPACE_PREFIX}{new_workspace_id()}"
        try:
            lock = hold_new_file(workspace_lock_path(path))
        except FileExistsError:
            continue
        try:
            path.mkdir()
        except FileExistsError:
            lock.release()
            continue
        except BaseException:
            lock.release()
            raise
        return Workspace(path, lock)
    raise FileExistsError("Cannot create a working folder for the export. Try another folder.")


def _move_without_replacing(result: Path, output: Path) -> None:
    # Windows rename refuses replacement; POSIX link provides the same guarantee
    if os.name == "nt":
        os.rename(result, output)
        return
    try:
        os.link(result, output)
    except OSError as exc:
        if not hard_links_unsupported(exc):
            raise
        # FAT32, exFAT and many network mounts have no hard links, and rename would replace
        # a file. The held reservation keeps other Tuck exports off this name, so only an
        # outside program creating it in the instant after this check could be overwritten
        if output.exists():
            raise FileExistsError(output) from exc
        os.rename(result, output)


class OutputTransaction:
    """Own a reserved name and scratch files until one finished file is published.

    With ``replace`` an existing file at the requested name is swapped for the finished
    one when it is published; until then the old file is left alone.
    """

    def __init__(self, output: Path, *, replace: bool = False) -> None:
        self.output = output.absolute()
        self._requested = self.output
        self._replace = replace
        self._reservation: HeldFile | None = None
        self._workspace: Workspace | None = None
        self._published = False

    @property
    def workspace(self) -> Path:
        if self._workspace is None:
            raise RuntimeError("The output transaction is not open.")
        return self._workspace.path

    def _reserve(self) -> None:
        # another export writing the same name right now gets a number either way
        if self._replace and self._claim(self._requested):
            return
        for _ in range(101):
            if self._claim(resolve_output_collision(self._requested)):
                return
        raise FileExistsError("Cannot reserve an output name. Try another output folder.")

    def _claim(self, output: Path) -> bool:
        try:
            self._reservation = hold_new_file(reservation_path(output))
        except FileExistsError:
            return False
        self.output = output
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
        reservation, self._reservation = self._reservation, None
        if reservation is not None:
            reservation.release()

    def __enter__(self) -> OutputTransaction:
        folder = self.output.parent
        folder.mkdir(parents=True, exist_ok=True)
        # a crashed export can't clean up after itself; its leftovers would otherwise
        # push this export to a numbered name
        sweep_stale_outputs(folder)
        self._reserve()
        try:
            self._workspace = open_workspace(folder)
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
                _move_without_replacing(result, self.output)
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
            workspace, self._workspace = self._workspace, None
            if workspace is not None:
                workspace.remove()
        finally:
            self._release()
