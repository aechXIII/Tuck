from __future__ import annotations

import contextlib
import logging
import os
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from queue import Queue as ThreadQueue

from .engine import EncodeCancelled, FFmpegEngine
from .models import EncodePlan, QueueItem, QueueState

logger = logging.getLogger(__name__)


class ProcessingQueue:
    def __init__(self) -> None:
        self._queue: ThreadQueue[QueueItem] = ThreadQueue()
        self._items: dict[str, QueueItem] = {}
        self._lock = threading.Lock()
        self._engine = FFmpegEngine()
        self._running = False
        self._current_item: QueueItem | None = None
        self._worker_thread: threading.Thread | None = None
        self._on_item_change: Callable[[QueueItem], None] | None = None
        self._stop_after_current = False

    @property
    def items(self) -> list[QueueItem]:
        with self._lock:
            return list(self._items.values())

    @property
    def current_item(self) -> QueueItem | None:
        return self._current_item

    def set_on_item_change(self, callback: Callable[[QueueItem], None]) -> None:
        self._on_item_change = callback

    def enqueue(self, plan: EncodePlan) -> QueueItem:
        item = QueueItem(
            plan=plan,
            state=QueueState.PENDING,
            added_at=datetime.now(timezone.utc).isoformat(),
        )
        with self._lock:
            self._items[item.id] = item
        self._queue.put(item)
        return item

    def cancel(self, item_id: str) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item:
                return False
            if item.state == QueueState.PENDING:
                item.state = QueueState.CANCELLED
                self._notify(item)
                return True
            if item.state == QueueState.RUNNING:
                self._engine.cancel()
                return True
        return False

    def cancel_all(self) -> None:
        self._engine.cancel()
        with self._lock:
            for item in self._items.values():
                if item.state == QueueState.PENDING:
                    item.state = QueueState.CANCELLED
                    self._notify(item)

    def clear_completed(self) -> None:
        with self._lock:
            to_remove = [
                iid
                for iid, item in self._items.items()
                if item.state in (QueueState.COMPLETED, QueueState.FAILED, QueueState.CANCELLED)
            ]
            for iid in to_remove:
                del self._items[iid]

    def retry(self, item_id: str) -> QueueItem | None:
        with self._lock:
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
                plan=item.plan,
                state=QueueState.PENDING,
                added_at=datetime.now(timezone.utc).isoformat(),
            )
            self._items[retry_item.id] = retry_item
        self._queue.put(retry_item)
        return retry_item

    def stop_after_current(self) -> None:
        with self._lock:
            self._stop_after_current = self._current_item is not None
            for item in self._items.values():
                if item.state == QueueState.PENDING:
                    item.state = QueueState.CANCELLED
                    self._notify(item)
            if self._current_item is None:
                self._running = False

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._stop_after_current = False
        self._worker_thread = threading.Thread(target=self._worker, daemon=True)
        self._worker_thread.start()

    def stop(self) -> None:
        self._running = False
        self._engine.cancel()
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=10)

    def _worker(self) -> None:
        """re-checks for output filename collisions right before encoding,
        since another item may have claimed the same name"""
        logger.info("Queue worker started")
        while self._running:
            try:
                item = self._queue.get(timeout=1)
            except Exception:
                continue

            if item.state == QueueState.CANCELLED:
                self._queue.task_done()
                continue

            self._current_item = item
            item.state = QueueState.RUNNING
            item.started_at = datetime.now(timezone.utc).isoformat()
            self._notify(item)

            try:
                plan = item.plan
                if plan is None:
                    item.state = QueueState.FAILED
                    item.error = "No plan associated with queue item"
                    item.finished_at = datetime.now(timezone.utc).isoformat()
                    self._notify(item)
                    self._current_item = None
                    self._queue.task_done()
                    continue

                from .planner import _resolve_output_collision

                plan.output = str(_resolve_output_collision(Path(plan.output)))

                _source = plan.source
                result_path = self._engine.encode(
                    plan,
                    on_progress=lambda p, _item=item: self._on_progress(_item, p),
                )
                item.state = QueueState.COMPLETED
                item.result_path = str(result_path)
                item.result_size = result_path.stat().st_size if result_path.exists() else 0
                item.progress = 100.0
                item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.info("Completed: %s -> %s", _source, result_path)
            except EncodeCancelled:
                item.state = QueueState.CANCELLED
                item.error = "Cancelled by user"
                item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.info("Cancelled: %s", _source)
            except Exception as e:
                item.state = QueueState.FAILED
                item.error = str(e)
                item.finished_at = datetime.now(timezone.utc).isoformat()
                logger.error("Failed: %s: %s", _source, e)

            self._notify(item)
            self._current_item = None
            self._queue.task_done()

            if self._stop_after_current:
                self._running = False
                self._stop_after_current = False
                break

            self._check_terminal()

        logger.info("Queue worker stopped")

    def _on_progress(self, item: QueueItem, progress: float) -> None:
        item.progress = progress
        self._notify(item)

    def _notify(self, item: QueueItem) -> None:
        if self._on_item_change:
            with contextlib.suppress(Exception):
                self._on_item_change(item)

    def _check_terminal(self) -> None:
        """on Linux/macOS, stops the queue if the terminal that launched
        the process disappears"""
        if os.name != "posix":
            return
        try:
            os.tcgetpgrp(0)
        except OSError:
            logger.warning("Controlling terminal lost; stopping queue")
            self._running = False
            self._engine.cancel()


_queue: ProcessingQueue | None = None


def get_queue() -> ProcessingQueue:
    global _queue
    if _queue is None:
        _queue = ProcessingQueue()
    return _queue
