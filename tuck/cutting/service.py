"""Own one analysis worker so scans never occupy sidecar request workers."""

from __future__ import annotations

import logging
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field, replace
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
    source_identity,
)
from .planner import CutPlanChanged, plan_cut

# the scanner is given the hash just taken, so the bytes are not hashed twice before the scan
Scanner = Callable[[Path, Event, ProgressCallback, SourceIdentity], CutAnalysis]
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AnalysisSnapshot:
    work_id: str
    status: str
    progress: AnalysisProgress
    analysis: CutAnalysis | None = None
    issue: CutIssue | None = None


@dataclass
class _Work:
    path: Path
    snapshot: AnalysisSnapshot
    cancel: Event = field(default_factory=Event)


class CutAnalysisService:
    def __init__(
        self, *, scanner: Scanner = analyze_source, version: Callable[[], str] = analysis_version
    ) -> None:
        self._scanner = scanner
        self._version = version
        self._condition = Condition()
        self._thread: Thread | None = None
        self._current: _Work | None = None
        self._pending: _Work | None = None
        self._closed = False
        self._history: OrderedDict[str, _Work] = OrderedDict()
        self._cache: OrderedDict[tuple[SourceIdentity, str], CutAnalysis] = OrderedDict()

    def start(self, path: Path, work_id: str) -> AnalysisSnapshot:
        if not work_id or len(work_id) > 128:
            raise ValueError("Analysis work ID must contain 1 to 128 characters")
        resolved = path.resolve()
        with self._condition:
            if self._closed:
                raise ValueError("Cut analysis is closed")
            if any(w.snapshot.work_id == work_id for w in self._history.values()):
                raise ValueError("Analysis work ID must be new")
            if self._current and self._current.snapshot.status in {"reading", "pending"}:
                self._cancel_work(self._current)
            snapshot = AnalysisSnapshot(work_id, "pending", AnalysisProgress(None, MediaTime(0)))
            work = _Work(resolved, snapshot)
            self._current = self._pending = work
            self._history[str(resolved)] = work
            self._history.move_to_end(str(resolved))
            while len(self._history) > 2:
                self._history.popitem(last=False)
            if self._thread is None:
                self._thread = Thread(target=self._run, name="tuck-cut-analysis", daemon=True)
                self._thread.start()
            self._condition.notify_all()
            return snapshot

    def get(self, path: Path) -> AnalysisSnapshot:
        with self._condition:
            work = self._history.get(str(path.resolve()))
            if work is None:
                return AnalysisSnapshot("", "missing", AnalysisProgress(None, MediaTime(0)))
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

    def _run(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or self._pending is not None)
                if self._closed:
                    return
                pending = self._pending
                self._pending = None
                if pending is None or pending.cancel.is_set():
                    continue
                work: _Work = pending
                work.snapshot = replace(work.snapshot, status="reading")

            def progress(value: AnalysisProgress, active_work: _Work = work) -> None:
                with self._condition:
                    if (
                        self._current is active_work
                        and not active_work.cancel.is_set()
                        and active_work.snapshot.status == "reading"
                    ):
                        active_work.snapshot = replace(active_work.snapshot, progress=value)

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
                        work.snapshot = replace(
                            work.snapshot,
                            status="ready",
                            analysis=result,
                            progress=AnalysisProgress(1, result.duration, result.keyframes),
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
