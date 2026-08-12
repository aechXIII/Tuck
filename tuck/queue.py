from __future__ import annotations

import contextlib
import copy
import logging
import os
import threading
from collections import deque
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .engine import EncodeCancelled, FFmpegEngine
from .models import EncodePlan, QueueItem, QueueState
from .models.progress import EncodeProgress, EncodeStage

logger = logging.getLogger(__name__)


class ProcessingQueue:
    def __init__(self) -> None:
        self._items: dict[str, QueueItem] = {}
        self._pending: deque[str] = deque()
        self._condition = threading.Condition()
        self._engine = FFmpegEngine()
        self._running = False
        self._current_item: QueueItem | None = None
        self._worker_thread: threading.Thread | None = None
        self._on_item_change: Callable[[QueueItem], None] | None = None
        self._stop_after_current = False

    @property
    def items(self) -> list[QueueItem]:
        with self._condition:
            return list(self._items.values())

    @property
    def pending_ids(self) -> list[str]:
        with self._condition:
            return list(self._pending)

    @property
    def current_item(self) -> QueueItem | None:
        with self._condition:
            return self._current_item

    def snapshot(self) -> tuple[list[QueueItem], QueueItem | None, list[str]]:
        with self._condition:
            return list(self._items.values()), self._current_item, list(self._pending)

    def set_on_item_change(self, callback: Callable[[QueueItem], None]) -> None:
        self._on_item_change = callback

    def enqueue(self, plan: EncodePlan) -> QueueItem:
        item = QueueItem(
            plan=copy.deepcopy(plan),
            state=QueueState.PENDING,
            added_at=datetime.now(timezone.utc).isoformat(),
            status_text="Pending",
        )
        with self._condition:
            self._items[item.id] = item
            self._pending.append(item.id)
            self._condition.notify()
        self._notify(item)
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
                self._notify(item)
                return True
            if item.state == QueueState.RUNNING:
                self._engine.cancel()
                return True
        return False

    def cancel_all(self) -> None:
        self._engine.cancel()
        with self._condition:
            changed: list[QueueItem] = []
            for item_id in list(self._pending):
                item = self._items.get(item_id)
                if item and item.state == QueueState.PENDING:
                    item.state = QueueState.CANCELLED
                    item.status_text = "Cancelled"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                    changed.append(item)
            self._pending.clear()
            for item in changed:
                self._notify(item)

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

    def retry(self, item_id: str) -> QueueItem | None:
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
            retry_item = QueueItem(
                plan=copy.deepcopy(item.plan),
                state=QueueState.PENDING,
                added_at=datetime.now(timezone.utc).isoformat(),
                status_text="Pending",
            )
            self._items[retry_item.id] = retry_item
            self._pending.append(retry_item.id)
            self._condition.notify()
        self._notify(retry_item)
        return retry_item

    def stop_after_current(self) -> None:
        with self._condition:
            self._stop_after_current = self._current_item is not None
            changed: list[QueueItem] = []
            for item_id in list(self._pending):
                item = self._items.get(item_id)
                if item and item.state == QueueState.PENDING:
                    item.state = QueueState.CANCELLED
                    item.status_text = "Cancelled"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                    changed.append(item)
            self._pending.clear()
            if self._current_item is None:
                self._running = False
            for item in changed:
                self._notify(item)
            self._condition.notify_all()

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
            self._running = False
            self._condition.notify_all()
        self._engine.cancel()
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=10)

    def _worker(self) -> None:
        logger.info("Queue worker started")
        while True:
            with self._condition:
                while self._running and not self._pending:
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

            self._notify(item)
            try:
                plan = item.plan
                if plan is None:
                    item.state = QueueState.FAILED
                    item.error = "No plan associated with queue item"
                    item.status_text = "Failed"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                    self._notify(item)
                    with self._condition:
                        self._current_item = None
                    continue

                from .planner import _resolve_output_collision

                attempt_plan = copy.deepcopy(plan)
                attempt_plan.output = str(_resolve_output_collision(Path(attempt_plan.output)))

                _source = attempt_plan.source
                result_path = self._engine.encode(
                    attempt_plan,
                    on_progress=lambda p, _item=item: self._on_progress(_item, p),
                )
                item.state = QueueState.COMPLETED
                item.result_path = str(result_path)
                item.result_size = result_path.stat().st_size if result_path.exists() else 0
                item.progress = 100.0
                item.status_text = "Completed"
                item.progress_info = EncodeProgress(
                    percent=100.0, stage=EncodeStage.COMPLETED, message="Completed"
                )
                item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.info("Completed: %s -> %s", _source, result_path)
            except EncodeCancelled:
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
                item.state = QueueState.FAILED
                item.error = str(e)
                detail = getattr(e, "stderr", "") or ""
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

            self._notify(item)
            with self._condition:
                self._current_item = None
                stop_now = self._stop_after_current
                if stop_now:
                    self._running = False
                    self._stop_after_current = False

            self._check_terminal()
            if stop_now:
                break

        logger.info("Queue worker stopped")

    def _on_progress(self, item: QueueItem, progress: EncodeProgress | float) -> None:
        if isinstance(progress, EncodeProgress):
            item.progress = float(progress.percent)
            item.progress_info = progress
            item.status_text = progress.status_text()
        else:
            item.progress = float(progress)
            item.status_text = f"{item.progress:.0f}%"
        self._notify(item)

    def _notify(self, item: QueueItem) -> None:
        if self._on_item_change:
            with contextlib.suppress(Exception):
                self._on_item_change(item)

    def _remove_pending_id(self, item_id: str) -> None:
        with contextlib.suppress(ValueError):
            self._pending.remove(item_id)

    def _check_terminal(self) -> None:
        if os.name != "posix":
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
