"""Own one analysis worker so scans never occupy sidecar request workers."""

from __future__ import annotations

import logging
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from functools import partial
from itertools import count
from pathlib import Path
from threading import Condition, Event, Thread

from ..models.cutting import (
    AnalysisProgress,
    CutAnalysis,
    CutIssue,
    CutPlan,
    CutRequest,
    MediaTime,
    SourceIdentity,
)
from .analysis import (
    CutAnalysisError,
    ProgressCallback,
    analysis_version,
    analyze_source,
    preview_keyframes,
    source_identity,
)
from .planner import CutPlanChanged, plan_cut

# the scanner is given the hash just taken, so the bytes are not hashed twice before the scan
Scanner = Callable[[Path, Event, ProgressCallback, SourceIdentity], CutAnalysis]
# shows keyframes while the checked scan waits for the file hash; nothing it finds is used to plan
Previewer = Callable[[Path, Callable[[], bool], ProgressCallback], None]
logger = logging.getLogger(__name__)

# keyframes of the videos people opened, kept as before
FOREGROUND_KEPT = 2
# and of videos read ahead while the Lossless cut task is open; an analysis holds every packet's
# timing, so this stays small and an older one is read again when it's needed
BACKGROUND_KEPT = 4


@dataclass(frozen=True)
class AnalysisSnapshot:
    work_id: str
    status: str
    progress: AnalysisProgress
    analysis: CutAnalysis | None = None
    issue: CutIssue | None = None
    # changes whenever the keyframe list is replaced rather than extended, so a reader that
    # already holds part of the list knows to read it again from the start
    keyframes_revision: int = 0


def _extends(shown: tuple[MediaTime, ...], keyframes: tuple[MediaTime, ...]) -> bool:
    # one pass reports the same objects again with more on the end, so this is mostly an
    # identity check
    return len(keyframes) >= len(shown) and keyframes[: len(shown)] == shown


@dataclass
class _Work:
    path: Path
    snapshot: AnalysisSnapshot
    cancel: Event = field(default_factory=Event)
    # read ahead for a video nobody is looking at; it waits its turn and never stops other work
    background: bool = False


class CutAnalysisService:
    def __init__(
        self,
        *,
        scanner: Scanner = analyze_source,
        version: Callable[[], str] = analysis_version,
        previewer: Previewer = preview_keyframes,
    ) -> None:
        self._scanner = scanner
        self._previewer = previewer
        self._version = version
        self._condition = Condition()
        self._thread: Thread | None = None
        self._current: _Work | None = None
        self._pending: deque[_Work] = deque()
        self._closed = False
        self._history: OrderedDict[str, _Work] = OrderedDict()
        self._cache: OrderedDict[tuple[SourceIdentity, str], CutAnalysis] = OrderedDict()
        self._revisions = count(1)

    def start(self, path: Path, work_id: str, *, background: bool = False) -> AnalysisSnapshot:
        """Read a video's keyframes.

        A read for the video on screen goes first and stops whatever is being read; a
        background read waits behind other work and is the one stopped when they meet.
        """
        if not work_id or len(work_id) > 128:
            raise ValueError("Analysis work ID must contain 1 to 128 characters")
        resolved = path.resolve()
        with self._condition:
            if self._closed:
                raise ValueError("Cut analysis is closed")
            if any(w.snapshot.work_id == work_id for w in self._history.values()):
                raise ValueError("Analysis work ID must be new")
            snapshot = AnalysisSnapshot(
                work_id,
                "pending",
                AnalysisProgress(None, MediaTime(0)),
                keyframes_revision=next(self._revisions),
            )
            work = _Work(resolved, snapshot, background=background)
            replaced = self._history.get(str(resolved))
            if replaced is not None and replaced.snapshot.status in {"reading", "pending"}:
                self._cancel_work(replaced)
            if background:
                self._pending.append(work)
            else:
                # one video is on screen at a time, so an older read for the screen is dropped
                for other in (self._current, *self._pending):
                    if (
                        other
                        and (other is self._current or not other.background)
                        and other.snapshot.status in {"reading", "pending"}
                    ):
                        self._cancel_work(other)
                self._pending.appendleft(work)
            self._history[str(resolved)] = work
            self._history.move_to_end(str(resolved))
            self._forget_old_work()
            if self._thread is None:
                self._thread = Thread(target=self._run, name="tuck-cut-analysis", daemon=True)
                self._thread.start()
            self._condition.notify_all()
            return snapshot

    def _forget_old_work(self) -> None:
        # reads ahead only ever push out other reads ahead, so a video someone opened keeps
        # its keyframes however many others are read meanwhile
        for background, kept in ((False, FOREGROUND_KEPT), (True, BACKGROUND_KEPT)):
            paths = [key for key, work in self._history.items() if work.background is background]
            for key in paths[: max(0, len(paths) - kept)]:
                work = self._history.pop(key)
                if work.snapshot.status in {"reading", "pending"}:
                    self._cancel_work(work)

    def get(self, path: Path) -> AnalysisSnapshot:
        with self._condition:
            key = str(path.resolve())
            work = self._history.get(key)
            if work is None:
                return AnalysisSnapshot("", "missing", AnalysisProgress(None, MediaTime(0)))
            # a video still being planned or exported stays among the ones kept
            self._history.move_to_end(key)
            snapshot = work.snapshot
            if snapshot.analysis is not None:
                try:
                    stat = work.path.stat()
                    identity = snapshot.analysis.identity
                    changed = (stat.st_size, stat.st_mtime_ns) != (identity.size, identity.mtime_ns)
                except OSError:
                    changed = True
                if changed:
                    work.snapshot = replace(
                        snapshot,
                        status="failed",
                        analysis=None,
                        issue=CutIssue(
                            "source_changed", "The video changed. Read its keyframes again."
                        ),
                    )
            return work.snapshot

    def result(self, path: Path) -> CutAnalysis:
        snapshot = self.get(path)
        if snapshot.status == "ready" and snapshot.analysis is not None:
            return snapshot.analysis
        if snapshot.issue:
            raise CutAnalysisError(snapshot.issue.code, snapshot.issue.message)
        raise CutAnalysisError(
            "analysis_required", "Read this video's keyframes before planning a cut."
        )

    def plan_for_export(self, request: CutRequest, fingerprint: str, cancel: Event) -> CutPlan:
        analysis = self.result(Path(request.source))
        if source_identity(Path(request.source), cancel) != analysis.identity:
            raise CutAnalysisError("source_changed", "The video changed. Read its keyframes again.")
        current = plan_cut(request, analysis)
        if current.fingerprint != fingerprint:
            raise CutPlanChanged(current)
        if current.issues:
            raise CutAnalysisError(current.issues[0].code, current.issues[0].message)
        return current

    def cancel(self, work_id: str) -> bool:
        with self._condition:
            for work in self._history.values():
                if work.snapshot.work_id == work_id and work.snapshot.status in {
                    "pending",
                    "reading",
                }:
                    self._cancel_work(work)
                    return True
            return False

    @staticmethod
    def _cancel_work(work: _Work) -> None:
        work.cancel.set()
        work.snapshot = replace(
            work.snapshot,
            status="cancelled",
            analysis=None,
            issue=CutIssue("analysis_cancelled", "Keyframe analysis was cancelled."),
        )

    def close(self) -> None:
        with self._condition:
            self._closed = True
            for work in self._history.values():
                work.cancel.set()
            if self._current:
                self._current.cancel.set()
            self._condition.notify_all()
        if self._thread:
            self._thread.join()
        with self._condition:
            self._history.clear()
            self._cache.clear()

    def _start_preview(self, work: _Work, report: ProgressCallback) -> None:
        # the preview stops as soon as this work is cancelled or has an answer
        def stopped() -> bool:
            return work.cancel.is_set() or work.snapshot.status != "reading"

        Thread(
            target=self._previewer,
            args=(work.path, stopped, report),
            name="tuck-cut-preview",
            daemon=True,
        ).start()

    def _run(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or bool(self._pending))
                if self._closed:
                    return
                pending = self._pending.popleft()
                if pending.cancel.is_set():
                    continue
                work: _Work = pending
                self._current = work
                work.snapshot = replace(work.snapshot, status="reading")

            def progress(
                value: AnalysisProgress, active_work: _Work = work, checked: bool = True
            ) -> None:
                with self._condition:
                    if (
                        self._current is active_work
                        and not active_work.cancel.is_set()
                        and active_work.snapshot.status == "reading"
                    ):
                        shown = active_work.snapshot.progress
                        revision = active_work.snapshot.keyframes_revision
                        # the preview and the checked scan both find keyframes; the one further
                        # along is shown, so keyframes already on screen are never taken back
                        if value.coverage_end.seconds >= shown.coverage_end.seconds:
                            if not _extends(shown.keyframes, value.keyframes):
                                revision = next(self._revisions)
                            shown = replace(
                                shown, coverage_end=value.coverage_end, keyframes=value.keyframes
                            )
                        # only the checked scan moves the progress, since export waits for it
                        if checked:
                            shown = replace(shown, progress=value.progress)
                        active_work.snapshot = replace(
                            active_work.snapshot, progress=shown, keyframes_revision=revision
                        )

            self._start_preview(work, partial(progress, checked=False))
            try:
                key = (source_identity(work.path, work.cancel), self._version())
                result = self._cache.get(key)
                if result is None:
                    result = self._scanner(work.path, work.cancel, progress, key[0])
                if result.identity != key[0]:
                    raise CutAnalysisError(
                        "source_changed", "The video changed. Read its keyframes again."
                    )
                with self._condition:
                    if self._current is work and not work.cancel.is_set():
                        self._cache[key] = result
                        self._cache.move_to_end(key)
                        while len(self._cache) > 2:
                            self._cache.popitem(last=False)
                        revision = work.snapshot.keyframes_revision
                        if not _extends(work.snapshot.progress.keyframes, result.keyframes):
                            revision = next(self._revisions)
                        work.snapshot = replace(
                            work.snapshot,
                            status="ready",
                            analysis=result,
                            progress=AnalysisProgress(1, result.duration, result.keyframes),
                            keyframes_revision=revision,
                        )
                    self._condition.notify_all()
            except (CutAnalysisError, OSError, ValueError) as exc:
                with self._condition:
                    if self._current is work and not work.cancel.is_set():
                        code = exc.code if isinstance(exc, CutAnalysisError) else "analysis_failed"
                        work.snapshot = replace(
                            work.snapshot, status="failed", issue=CutIssue(code, str(exc))
                        )
                    self._condition.notify_all()
            except Exception:
                logger.exception("Cut analysis worker failed")
                with self._condition:
                    if self._current is work and not work.cancel.is_set():
                        work.snapshot = replace(
                            work.snapshot,
                            status="failed",
                            issue=CutIssue(
                                "analysis_failed",
                                "Keyframes could not be read. Try the video again.",
                            ),
                        )
                    self._condition.notify_all()
