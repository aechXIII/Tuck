from __future__ import annotations

import contextlib
import copy
import logging
import os
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from .cutting.analysis import check_request
from .cutting.packets import rebuild_cut_plan
from .engine import EncodeCancelled, FFmpegEngine
from .models import EncodePlan, QueueItem, QueueState
from .models.cutting import CutPlan
from .models.progress import EncodeProgress, EncodeStage
from .output_paths import resolve_output_collision
from .power import keep_awake
from .request_work import RequestWork

logger = logging.getLogger(__name__)


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
        item = QueueItem(
            plan=copy.deepcopy(plan),
            state=QueueState.PENDING,
            added_at=datetime.now(timezone.utc).isoformat(),
            status_text="Pending",
        )
        with self._condition:
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
                item.status_text = "Cancelled"
                item.finished_at = datetime.now(timezone.utc).isoformat()
                return True
            if item.state == QueueState.RUNNING:
                self._cancelling += 1
            else:
                return False
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
                    item.status_text = "Cancelled"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
            self._pending.clear()
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
            return True

    def clear_completed(self) -> int:
        return self._clear_states({QueueState.COMPLETED})

    def _clear_states(self, states: set[QueueState]) -> int:
        with self._condition:
            to_remove = [iid for iid, item in self._items.items() if item.state in states]
            for iid in to_remove:
                del self._items[iid]
            return len(to_remove)

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
            with self._condition:
                if (
                    self._items.get(item_id) is not original
                    or original.state not in {QueueState.FAILED, QueueState.CANCELLED}
                    or generation != self._cancel_generation
                ):
                    return None
                return self.enqueue(retry_plan, work=work)
        finally:
            with self._condition:
                self._retry_work.discard(work)

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
                    item.status_text = "Cancelled"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
            self._pending.clear()
            if self._current_item is None:
                self._running = False
            self._condition.notify_all()

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
            self._stop_after_current = False
            self._worker_thread = threading.Thread(target=self._worker, daemon=True)
            self._worker_thread.start()

    def stop(self) -> None:
        with self._condition:
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

            try:
                plan = item.plan
                if plan is None:
                    raise ValueError("No plan associated with queue item")

                attempt_plan = copy.deepcopy(plan)
                if isinstance(attempt_plan, EncodePlan):
                    attempt_plan.output = str(resolve_output_collision(Path(attempt_plan.output)))

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
                    item.error = "Cancelled by user"
                    item.error_detail = ""
                    item.status_text = "Cancelled"
                    item.progress_info = EncodeProgress(
                        stage=EncodeStage.CANCELLED, message="Cancelled"
                    )
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.info("Cancelled: %s", Path(item.plan.source).name if item.plan else "?")
            except Exception as e:
                with self._condition:
                    item.state = QueueState.FAILED
                    item.error = str(e)
                    item.error_code = str(getattr(e, "code", ""))
                    detail = getattr(e, "stderr", "") or getattr(e, "detail", "") or ""
                    if not detail:
                        detail = getattr(self._engine, "last_stderr", "") or ""
                    item.error_detail = str(detail)[-4000:]
                    item.status_text = "Failed"
                    item.progress_info = EncodeProgress(stage=EncodeStage.FAILED, message=str(e))
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.error(
                    "Failed: %s: %s",
                    Path(item.plan.source).name if item.plan else "?",
                    e,
                )

            with self._condition:
                self._current_item = None
                self._condition.notify_all()
                stop_now = self._stop_after_current
                if stop_now:
                    self._running = False
                    self._stop_after_current = False
                idle = not self._pending

            # released outside the queue lock; on Linux it waits for the helper to exit
            if holding_awake and (idle or stop_now):
                awake.close()
                holding_awake = False
            self._check_terminal()
            if stop_now:
                break

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


_queue: ProcessingQueue | None = None


def get_queue() -> ProcessingQueue:
    global _queue
    if _queue is None:
        _queue = ProcessingQueue()
    return _queue
