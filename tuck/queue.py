from __future__ import annotations

import contextlib
import copy
import dataclasses
import logging
import os
import subprocess
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from .cutting.analysis import check_request
from .cutting.packets import rebuild_cut_plan
from .encoding.failures import describe_file_error
from .engine import EncodeCancelled, FFmpegEngine
from .models import EncodePlan, QueueItem, QueueState
from .models.cutting import CutPlan
from .models.progress import EncodeProgress, EncodeStage
from .output_paths import resolve_output_collision, sweep_stale_outputs
from .power import keep_awake
from .probe import probe
from .queue_store import UnfinishedExportStore, export_record
from .request_work import RequestWork

logger = logging.getLogger(__name__)


# every code a refused retry carries; the desktop bridge passes these through as they are
RETRY_REFUSAL_CODES = frozenset({"source_changed", "source_unavailable"})

_SOURCE_MISSING = "Tuck can't find this video any more. It may have been moved, renamed or deleted."


class RetryRefused(Exception):
    """A failed export can't run again as planned; the message says what to do instead."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _check_source_unchanged(plan: EncodePlan) -> None:
    """Refuse a retry when the video is no longer the one the export was planned for.

    Sizes, bitrates, and segments come from the first probe, and the request that
    produced them isn't kept, so a changed video has to be added again.
    """
    if plan.source_info is None:
        return
    try:
        current = probe(plan.source)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        logger.warning("Could not read %s again for a retry: %s", plan.source, exc)
        raise RetryRefused(
            "source_unavailable",
            "This video can't be read any more. Check that it is still in place, then try again.",
        ) from exc
    # only the file itself matters, not how its path was spelled when it was added
    if dataclasses.replace(current, path=plan.source_info.path) != plan.source_info:
        raise RetryRefused(
            "source_changed",
            "This video changed after it was added to the queue. "
            "Add it again so the export is planned for the new version.",
        )


def _failure_message(exc: Exception, plan: EncodePlan | CutPlan | None) -> str:
    """What the Exports panel says about a failed export; file system errors get plain words."""
    if isinstance(exc, OSError):
        output = plan.output_path if isinstance(plan, CutPlan) else plan.output if plan else ""
        message = describe_file_error(exc, Path(output).parent if output else None)
        if message:
            return message
    return str(exc)


class ProcessingQueue:
    def __init__(self) -> None:
        self._items: dict[str, QueueItem] = {}
        self._pending: deque[str] = deque()
        self._condition = threading.Condition()
        self._engine = FFmpegEngine()
        self._keep_awake = True
        self._running = False
        self._current_item: QueueItem | None = None
        self._worker_thread: threading.Thread | None = None
        self._stop_after_current = False
        self._cancelling = 0
        self._cancel_generation = 0
        self._retry_work: set[RequestWork] = set()
        # exports queued without a fresh look at their video; it is checked when each one starts
        self._check_before_run: set[str] = set()
        self._store: UnfinishedExportStore | None = None
        self._closed = False

    @property
    def items(self) -> list[QueueItem]:
        with self._condition:
            return copy.deepcopy(list(self._items.values()))

    @property
    def pending_ids(self) -> list[str]:
        with self._condition:
            return list(self._pending)

    def snapshot(self) -> tuple[list[QueueItem], QueueItem | None, list[str]]:
        with self._condition:
            return copy.deepcopy(
                (list(self._items.values()), self._current_item, list(self._pending))
            )

    def enqueue(self, plan: EncodePlan | CutPlan, *, work: RequestWork | None = None) -> QueueItem:
        with self._condition:
            item = self._add_pending(plan, work)
        self._save_unfinished()
        return item

    def _add_pending(
        self, plan: EncodePlan | CutPlan, work: RequestWork | None, *, restored: bool = False
    ) -> QueueItem:
        # called with the queue lock held
        item = QueueItem(
            plan=copy.deepcopy(plan),
            state=QueueState.PENDING,
            added_at=datetime.now(timezone.utc).isoformat(),
            status_text="Waiting",
            restored=restored,
        )
        if work is not None:
            check_request(work)
        self._items[item.id] = item
        self._pending.append(item.id)
        self._condition.notify()
        return item

    def cancel(self, item_id: str) -> bool:
        with self._condition:
            item = self._items.get(item_id)
            if not item:
                return False
            if item.state == QueueState.PENDING:
                self._remove_pending_id(item_id)
                item.state = QueueState.CANCELLED
                item.status_text = "Canceled"
                item.finished_at = datetime.now(timezone.utc).isoformat()
                cancelled_waiting = True
            elif item.state == QueueState.RUNNING:
                self._cancelling += 1
                cancelled_waiting = False
            else:
                return False
        if cancelled_waiting:
            self._save_unfinished()
        else:
            self._cancel_engine()
        return True

    def _cancel_engine(self) -> None:
        try:
            self._engine.cancel()
        finally:
            with self._condition:
                self._cancelling -= 1
                self._condition.notify_all()

    def cancel_all(self) -> None:
        with self._condition:
            self._cancel_generation += 1
            for work in self._retry_work:
                work.set()
            self._cancelling += 1
            for item_id in list(self._pending):
                item = self._items.get(item_id)
                if item and item.state == QueueState.PENDING:
                    item.state = QueueState.CANCELLED
                    item.status_text = "Canceled"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
            self._pending.clear()
        self._save_unfinished()
        self._cancel_engine()

    def remove(self, item_id: str) -> bool:
        with self._condition:
            item = self._items.get(item_id)
            if not item:
                return False
            if item.state == QueueState.RUNNING:
                return False
            if item.state == QueueState.PENDING:
                self._remove_pending_id(item_id)
            del self._items[item_id]
            self._check_before_run.discard(item_id)
        self._save_unfinished()
        return True

    def move_item(self, item_id: str, new_index: int) -> bool:
        with self._condition:
            item = self._items.get(item_id)
            if not item or item.state != QueueState.PENDING:
                return False
            if item_id not in self._pending:
                return False
            ids = list(self._pending)
            ids.remove(item_id)
            idx = max(0, min(int(new_index), len(ids)))
            ids.insert(idx, item_id)
            self._pending = deque(ids)
        self._save_unfinished()
        return True

    def clear_completed(self) -> int:
        """What "Clear finished jobs" in Settings removes once a batch is done."""
        return self._clear_states({QueueState.COMPLETED})

    def clear_finished(self) -> int:
        """Completed and canceled exports; failed ones stay so they can be retried."""
        return self._clear_states({QueueState.COMPLETED, QueueState.CANCELLED})

    def _clear_states(self, states: set[QueueState]) -> int:
        with self._condition:
            to_remove = [iid for iid, item in self._items.items() if item.state in states]
            for iid in to_remove:
                del self._items[iid]
            return len(to_remove)

    def retry_all(self) -> list[str]:
        """Queue every failed and canceled export again, in list order, keeping each one's row.

        Unlike a single retry this doesn't read each video first, which for a cut can take a
        while; each export checks its video when it starts and fails with the reason instead.
        """
        with self._condition:
            retried = [
                item
                for item in self._items.values()
                if item.plan is not None and item.state in (QueueState.FAILED, QueueState.CANCELLED)
            ]
            for item in retried:
                self._requeue(item)
            if retried:
                self._condition.notify()
        if retried:
            self._save_unfinished()
        return [item.id for item in retried]

    def resume_paused(self) -> list[str]:
        """Queue the exports brought back from an earlier run, in the order they were queued."""
        with self._condition:
            resumed = [item for item in self._items.values() if item.state == QueueState.PAUSED]
            for item in resumed:
                self._requeue(item)
            if resumed:
                self._condition.notify()
        if resumed:
            self._save_unfinished()
        return [item.id for item in resumed]

    def _requeue(self, item: QueueItem) -> None:
        # called with the queue lock held
        if isinstance(item.plan, CutPlan):
            # the keyframes are read again rather than trusting the earlier scan
            item.plan = dataclasses.replace(item.plan, analysis=None)
        item.state = QueueState.PENDING
        item.progress = 0.0
        item.progress_info = None
        item.status_text = "Waiting"
        item.error = ""
        item.error_detail = ""
        item.error_code = ""
        item.result_path = ""
        item.result_size = 0
        item.started_at = ""
        item.finished_at = ""
        self._check_before_run.add(item.id)
        self._remove_pending_id(item.id)
        self._pending.append(item.id)

    def retry(self, item_id: str, *, work: RequestWork | None = None) -> QueueItem | None:
        work = work or RequestWork()
        with self._condition:
            item = self._items.get(item_id)
            if (
                item is None
                or item.plan is None
                or item.state
                not in (
                    QueueState.FAILED,
                    QueueState.CANCELLED,
                )
            ):
                return None
            original = item
            generation = self._cancel_generation
            retry_plan = copy.deepcopy(item.plan)
            self._retry_work.add(work)
        try:
            if isinstance(retry_plan, CutPlan):
                retry_plan = rebuild_cut_plan(retry_plan, work)
            else:
                _check_source_unchanged(retry_plan)
            with self._condition:
                if (
                    self._items.get(item_id) is not original
                    or original.state not in {QueueState.FAILED, QueueState.CANCELLED}
                    or generation != self._cancel_generation
                ):
                    return None
                check_request(work)
                # the export keeps its row, as with Retry all, and runs the plan just checked;
                # an export from an earlier run stays apart from the Library this way too
                self._requeue(original)
                original.plan = retry_plan
                self._check_before_run.discard(original.id)
                self._condition.notify()
        finally:
            with self._condition:
                self._retry_work.discard(work)
        self._save_unfinished()
        return original

    def stop_after_current(self) -> None:
        with self._condition:
            self._cancel_generation += 1
            for work in self._retry_work:
                work.set()
            self._stop_after_current = self._current_item is not None
            for item_id in list(self._pending):
                item = self._items.get(item_id)
                if item and item.state == QueueState.PENDING:
                    item.state = QueueState.CANCELLED
                    item.status_text = "Canceled"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
            self._pending.clear()
            if self._current_item is None:
                self._running = False
            self._condition.notify_all()
        self._save_unfinished()

    def set_run_preferences(self, *, keep_awake: bool, low_priority: bool) -> None:
        """Apply the user's export choices; they take effect from the next export."""
        with self._condition:
            self._keep_awake = keep_awake
        self._engine.set_low_priority(low_priority)

    def start(self) -> None:
        with self._condition:
            if self._running and self._worker_thread and self._worker_thread.is_alive():
                return
            self._running = True
            self._closed = False
            self._stop_after_current = False
            self._worker_thread = threading.Thread(target=self._worker, daemon=True)
            self._worker_thread.start()

    def stop(self) -> None:
        with self._condition:
            # closing Tuck cancels the running export, but it should come back next time
            self._store = None
            self._closed = True
            self._cancel_generation += 1
            for work in self._retry_work:
                work.set()
            self._running = False
            self._condition.notify_all()
        self._engine.cancel()
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=10)

    def _worker(self) -> None:
        logger.info("Queue worker started")
        # the sleep lock is held from the first export until the queue runs dry, so the
        # computer can't fall asleep in the gap between two exports
        awake = contextlib.ExitStack()
        try:
            self._work(awake)
        finally:
            awake.close()
        logger.info("Queue worker stopped")

    def _work(self, awake: contextlib.ExitStack) -> None:
        holding_awake = False
        while True:
            with self._condition:
                # a late cancel must finish before the next job resets the engine
                while self._running and (not self._pending or self._cancelling):
                    self._condition.wait()
                if not self._running:
                    break

                item_id = None
                while self._pending:
                    candidate_id = self._pending.popleft()
                    candidate = self._items.get(candidate_id)
                    if candidate is None:
                        continue
                    if candidate.state != QueueState.PENDING:
                        continue
                    item_id = candidate_id
                    break

                if item_id is None:
                    continue

                item = self._items[item_id]
                self._engine.reset_cancel()
                self._current_item = item
                item.state = QueueState.RUNNING
                item.progress = 0.0
                item.progress_info = EncodeProgress(stage=EncodeStage.PREPARING)
                item.status_text = "Preparing"
                item.started_at = datetime.now(timezone.utc).isoformat()
                item.error = ""
                item.error_detail = ""
                item.error_code = ""
                check_source = item_id in self._check_before_run
                self._check_before_run.discard(item_id)
            self._save_unfinished()

            try:
                plan = item.plan
                if plan is None:
                    raise ValueError("No plan associated with queue item")

                attempt_plan = copy.deepcopy(plan)
                # a cut reads its video again and refuses a changed one on its own
                if check_source and isinstance(attempt_plan, EncodePlan):
                    _check_source_unchanged(attempt_plan)
                if isinstance(attempt_plan, EncodePlan) and not attempt_plan.replace_existing:
                    output = Path(attempt_plan.output)
                    # a reservation left by a crashed export must not push this one to _1
                    sweep_stale_outputs(output.parent)
                    attempt_plan.output = str(resolve_output_collision(output))

                source = attempt_plan.source
                with self._condition:
                    stay_awake = self._keep_awake
                if stay_awake and not holding_awake:
                    awake.enter_context(keep_awake(True))
                    holding_awake = True
                elif not stay_awake and holding_awake:
                    awake.close()
                    holding_awake = False
                result_path = self._engine.encode(
                    attempt_plan,
                    on_progress=lambda p, _item=item: self._on_progress(_item, p),
                )
                result_size = result_path.stat().st_size if result_path.exists() else 0
                with self._condition:
                    item.state = QueueState.COMPLETED
                    item.result_path = str(result_path)
                    item.result_size = result_size
                    item.progress = 100.0
                    item.status_text = "Completed"
                    item.progress_info = EncodeProgress(
                        percent=100.0, stage=EncodeStage.COMPLETED, message="Completed"
                    )
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.info("Completed: %s -> %s", source, result_path)
            except EncodeCancelled:
                with self._condition:
                    item.state = QueueState.CANCELLED
                    item.error = "Canceled by user"
                    item.error_detail = ""
                    item.status_text = "Canceled"
                    item.progress_info = EncodeProgress(
                        stage=EncodeStage.CANCELLED, message="Canceled"
                    )
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.info("Cancelled: %s", Path(item.plan.source).name if item.plan else "?")
            except Exception as e:
                message = _failure_message(e, item.plan)
                with self._condition:
                    item.state = QueueState.FAILED
                    item.error = message
                    item.error_code = str(getattr(e, "code", ""))
                    if message != str(e):
                        # the system's own words stay with the export for Copy details
                        detail = f"{type(e).__name__}: {e}"
                    else:
                        detail = getattr(e, "stderr", "") or getattr(e, "detail", "") or ""
                        if not detail:
                            detail = getattr(self._engine, "last_stderr", "") or ""
                    item.error_detail = str(detail)[-4000:]
                    item.status_text = "Failed"
                    item.progress_info = EncodeProgress(stage=EncodeStage.FAILED, message=message)
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.error(
                    "Failed: %s: %s",
                    Path(item.plan.source).name if item.plan else "?",
                    e,
                )

            with self._condition:
                # Auto picks its encoder while running, so the item records what really ran
                item.effective_encoder = self._engine.resolved_encoder
                item.encoder_fallback = self._engine.encoder_fallback
                self._current_item = None
                self._condition.notify_all()
                stop_now = self._stop_after_current
                if stop_now:
                    self._running = False
                    self._stop_after_current = False
                idle = not self._pending
            self._save_unfinished()

            # released outside the queue lock; on Linux it waits for the helper to exit
            if holding_awake and (idle or stop_now):
                awake.close()
                holding_awake = False
            self._check_terminal()
            if stop_now:
                break

    def restore(self, store: UnfinishedExportStore) -> list[str]:
        """Bring back the exports an earlier run left waiting or running, paused.

        From here on every change to the waiting, running or paused exports is written to
        ``store``. Exports queued before this call are kept and saved along with the restored
        ones. A restored export whose video is gone comes back failed and is not saved again.
        """
        saved = store.load()
        restored: list[QueueItem] = []
        folders: set[Path] = set()
        for export in saved:
            item = QueueItem(
                id=export.item_id,
                plan=export.plan,
                state=QueueState.PAUSED,
                added_at=export.added_at,
                status_text="Paused",
                restored=True,
            )
            missing = _missing_input(export.plan)
            if missing:
                item.state = QueueState.FAILED
                item.status_text = "Failed"
                item.error = missing
                item.error_code = "source_unavailable"
                item.finished_at = datetime.now(timezone.utc).isoformat()
            elif export.was_running:
                folders.add(Path(export.plan.output).parent)
            restored.append(item)
        # the interrupted exports' reservations and scratch folders go before anything new starts
        for folder in folders:
            sweep_stale_outputs(folder)
        with self._condition:
            # Tuck closed while this ran; the file still holds what the next start needs
            if self._closed:
                return []
            for item in restored:
                if item.id in self._items:
                    item.id = QueueItem().id
                self._items[item.id] = item
            self._store = store
        self._save_unfinished()
        logger.info("Restored %d unfinished exports", len(restored))
        return [item.id for item in restored]

    def _save_unfinished(self) -> None:
        """Write the waiting, running and paused exports, in the order they would run."""
        with self._condition:
            store = self._store
            if store is None:
                return
            revision = store.ticket()
            ordered: list[QueueItem] = []
            if self._current_item is not None and self._current_item.state == QueueState.RUNNING:
                ordered.append(self._current_item)
            ordered += [
                item
                for item_id in self._pending
                if (item := self._items.get(item_id)) is not None
                and item.state == QueueState.PENDING
            ]
            ordered += [item for item in self._items.values() if item.state == QueueState.PAUSED]
            records = [
                export_record(
                    item.id, item.plan, item.added_at, running=item.state == QueueState.RUNNING
                )
                for item in ordered
                if item.plan is not None
            ]
        store.save(revision, records)

    def _on_progress(self, item: QueueItem, progress: EncodeProgress | float) -> None:
        with self._condition:
            if item.state in {QueueState.COMPLETED, QueueState.FAILED, QueueState.CANCELLED}:
                return
            if isinstance(progress, EncodeProgress):
                item.progress = float(progress.percent)
                item.progress_info = copy.deepcopy(progress)
                item.status_text = progress.status_text()
            else:
                item.progress = float(progress)
                item.status_text = f"{item.progress:.0f}%"

    def _remove_pending_id(self, item_id: str) -> None:
        with contextlib.suppress(ValueError):
            self._pending.remove(item_id)

    def _check_terminal(self) -> None:
        if os.name != "posix" or not os.isatty(0):
            return
        try:
            os.tcgetpgrp(0)
        except OSError:
            logger.warning("Controlling terminal lost; stopping queue")
            with self._condition:
                self._running = False
                self._condition.notify_all()
            self._engine.cancel()


def _missing_input(plan: EncodePlan | CutPlan) -> str:
    """Why a restored export can't run as saved, or "" when its files are still in place."""
    if not Path(plan.source).is_file():
        return _SOURCE_MISSING
    if isinstance(plan, EncodePlan):
        others = [clip.source for track in plan.audio_tracks for clip in track.clips]
        if plan.lut_filter_path:
            others.append(plan.lut_filter_path)
        for path in others:
            if not Path(path).is_file():
                return (
                    f"Tuck can't find “{Path(path).name}” any more, which this export uses. "
                    "Add the video again to export it."
                )
    return ""


_queue: ProcessingQueue | None = None


def get_queue() -> ProcessingQueue:
    global _queue
    if _queue is None:
        _queue = ProcessingQueue()
    return _queue
