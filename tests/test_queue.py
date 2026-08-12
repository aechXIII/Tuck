import threading
import time
from collections import deque
from pathlib import Path

from tuck.models import CropRect, EncodePlan, QueueState, VideoTransform
from tuck.queue import ProcessingQueue


def _plan(name: str) -> EncodePlan:
    return EncodePlan(source=f"{name}.mp4", output=f"{name}_out.mp4", target_size=1024 * 1024)


class TestQueueOrdering:
    def test_insertion_order(self):
        q = ProcessingQueue()
        a = q.enqueue(_plan("a"))
        b = q.enqueue(_plan("b"))
        c = q.enqueue(_plan("c"))
        assert q.pending_ids == [a.id, b.id, c.id]

    def test_enqueue_snapshots_crop_state(self):
        q = ProcessingQueue()
        plan = _plan("crop")
        original_crop = CropRect(10, 20, 200, 100)
        plan.transform = VideoTransform(crop=original_crop)

        item = q.enqueue(plan)
        plan.transform = VideoTransform(crop=CropRect(30, 40, 120, 80))

        assert item.plan is not None
        assert item.plan is not plan
        assert item.plan.transform.crop == original_crop

    def test_move_item_index(self):
        q = ProcessingQueue()
        a = q.enqueue(_plan("a"))
        b = q.enqueue(_plan("b"))
        c = q.enqueue(_plan("c"))
        assert q.move_item(c.id, 0)
        assert q.pending_ids == [c.id, a.id, b.id]

    def test_reordering_does_not_change_crop(self):
        q = ProcessingQueue()
        first_plan = _plan("a")
        crop = CropRect(11, 13, 200, 100)
        first_plan.transform = VideoTransform(crop=crop)
        first = q.enqueue(first_plan)
        second = q.enqueue(_plan("b"))

        assert q.move_item(first.id, 1)

        assert q.pending_ids == [second.id, first.id]
        assert first.plan is not None
        assert first.plan.transform.crop == crop

    def test_snapshot_is_consistent(self):
        q = ProcessingQueue()
        item = q.enqueue(_plan("a"))
        items, current, pending_ids = q.snapshot()
        assert items == [item]
        assert current is None
        assert pending_ids == [item.id]

    def test_running_not_reorderable(self):
        q = ProcessingQueue()
        item = q.enqueue(_plan("a"))
        with q._condition:
            item.state = QueueState.RUNNING
            q._current_item = item
            q._pending.clear()
        assert not q.move_item(item.id, 0)

    def test_remove_pending(self):
        q = ProcessingQueue()
        a = q.enqueue(_plan("a"))
        b = q.enqueue(_plan("b"))
        assert q.remove(a.id)
        assert a.id not in q.pending_ids
        assert b.id in q.pending_ids
        assert a.id not in {i.id for i in q.items}

    def test_cancel_pending(self):
        q = ProcessingQueue()
        a = q.enqueue(_plan("a"))
        assert q.cancel(a.id)
        assert a.state == QueueState.CANCELLED
        assert a.id not in q.pending_ids

    def test_clear_completed_keeps_failed_and_cancelled_jobs(self):
        q = ProcessingQueue()
        a = q.enqueue(_plan("a"))
        b = q.enqueue(_plan("b"))
        c = q.enqueue(_plan("c"))
        a.state = QueueState.COMPLETED
        b.state = QueueState.FAILED
        c.state = QueueState.CANCELLED
        q._pending.clear()
        assert q.clear_completed() == 1
        assert {item.id for item in q.items} == {b.id, c.id}

    def test_retry_preserves_plan(self):
        q = ProcessingQueue()
        plan = _plan("src")
        plan.trim_start = 1.0
        plan.trim_end = 5.0
        crop = CropRect(11, 13, 200, 100)
        plan.transform = VideoTransform(crop=crop)
        item = q.enqueue(plan)
        item.state = QueueState.FAILED
        item.error = "boom"
        item.progress = 40.0
        q._pending.clear()
        retry = q.retry(item.id)
        assert retry is not None
        assert retry.id != item.id
        assert retry.state == QueueState.PENDING
        assert retry.plan is not plan
        assert retry.plan == plan
        assert retry.plan.trim_start == 1.0
        assert retry.plan.transform.crop == crop
        assert retry.progress == 0.0
        assert retry.id in q.pending_ids

    def test_retry_does_not_mutate_historical_plan(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        plan = _plan("auto")
        plan.video_encoder = "auto"
        plan.two_pass = True
        plan.rate_control_method = "cbr"
        plan.output = str(tmp_path / "auto.mp4")
        original = q.enqueue(plan)
        original.state = QueueState.CANCELLED
        q._pending.clear()
        retry = q.retry(original.id)
        assert retry is not None

        def fake_encode(attempt, on_progress=None):
            attempt.video_encoder = "libx264"
            attempt.two_pass = False
            attempt.rate_control_method = "crf"
            output = Path(attempt.output)
            output.write_bytes(b"ok")
            return output

        monkeypatch.setattr(q._engine, "encode", fake_encode)
        q.start()
        deadline = time.time() + 2
        while retry.state == QueueState.PENDING and time.time() < deadline:
            time.sleep(0.01)
        while retry.state == QueueState.RUNNING and time.time() < deadline:
            time.sleep(0.01)
        q.stop()
        assert original.plan is not None
        assert original.plan.video_encoder == "auto"
        assert original.plan.two_pass is True
        assert original.plan.rate_control_method == "cbr"
        assert retry.plan is not None
        assert retry.plan.video_encoder == "auto"
        assert retry.plan.two_pass is True
        assert retry.plan.rate_control_method == "cbr"

    def test_retry_cancelled(self):
        q = ProcessingQueue()
        item = q.enqueue(_plan("x"))
        item.state = QueueState.CANCELLED
        q._pending.clear()
        retry = q.retry(item.id)
        assert retry is not None
        assert retry.state == QueueState.PENDING

    def test_stop_after_current_cancels_pending(self):
        q = ProcessingQueue()
        a = q.enqueue(_plan("a"))
        b = q.enqueue(_plan("b"))
        with q._condition:
            a.state = QueueState.RUNNING
            q._current_item = a
            q._pending = deque([b.id])
        q.stop_after_current()
        assert b.state == QueueState.CANCELLED
        assert q.pending_ids == []


class TestQueueWorker:
    def test_empty_queue_waits_then_processes(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        processed: list[str] = []

        def fake_encode(plan, on_progress=None):
            processed.append(Path(plan.source).name)
            out = Path(plan.output)
            out.write_bytes(b"ok")
            if on_progress:
                on_progress(100.0)
            return out

        monkeypatch.setattr(q._engine, "encode", fake_encode)
        q.start()
        time.sleep(0.05)
        item = q.enqueue(
            EncodePlan(
                source=str(tmp_path / "clip.mp4"),
                output=str(tmp_path / "out.mp4"),
                target_size=1024 * 1024,
            )
        )
        deadline = time.time() + 2
        while item.state == QueueState.PENDING and time.time() < deadline:
            time.sleep(0.02)
        deadline = time.time() + 2
        while item.state == QueueState.RUNNING and time.time() < deadline:
            time.sleep(0.02)
        q.stop()
        assert processed == ["clip.mp4"]
        assert item.state == QueueState.COMPLETED

    def test_no_duplicate_processing(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        counts: dict[str, int] = {}
        lock = threading.Lock()

        def fake_encode(plan, on_progress=None):
            name = Path(plan.source).name
            with lock:
                counts[name] = counts.get(name, 0) + 1
            time.sleep(0.05)
            out = Path(plan.output)
            out.write_bytes(b"ok")
            return out

        monkeypatch.setattr(q._engine, "encode", fake_encode)
        q.start()
        items = [
            q.enqueue(
                EncodePlan(
                    source=str(tmp_path / f"c{i}.mp4"),
                    output=str(tmp_path / f"o{i}.mp4"),
                    target_size=1024 * 1024,
                )
            )
            for i in range(3)
        ]
        deadline = time.time() + 3
        while any(i.state not in (QueueState.COMPLETED, QueueState.FAILED) for i in items):
            if time.time() > deadline:
                break
            time.sleep(0.02)
        q.stop()
        assert counts == {"c0.mp4": 1, "c1.mp4": 1, "c2.mp4": 1}

    def test_cancel_running_before_encode_is_preserved(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        entered = threading.Event()
        release = threading.Event()
        original_reset = q._engine.reset_cancel

        def delayed_reset():
            entered.set()
            release.wait(timeout=2)
            original_reset()

        monkeypatch.setattr(q._engine, "reset_cancel", delayed_reset)

        def fake_encode(_plan, on_progress=None):
            if q._engine._cancel_event.is_set():
                from tuck.engine import EncodeCancelled

                raise EncodeCancelled("cancelled")
            raise AssertionError("cancel was lost before encode")

        monkeypatch.setattr(q._engine, "encode", fake_encode)
        q.start()
        item = q.enqueue(
            EncodePlan(
                source=str(tmp_path / "clip.mp4"),
                output=str(tmp_path / "out.mp4"),
                target_size=1024 * 1024,
            )
        )
        assert entered.wait(timeout=2)
        assert q.cancel(item.id)
        release.set()
        deadline = time.time() + 2
        while (
            item.state not in (QueueState.CANCELLED, QueueState.FAILED) and time.time() < deadline
        ):
            time.sleep(0.01)
        q.stop()
        assert item.state == QueueState.CANCELLED

    def test_cancelled_pending_never_runs(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        ran: list[str] = []

        def fake_encode(plan, on_progress=None):
            ran.append(Path(plan.source).name)
            out = Path(plan.output)
            out.write_bytes(b"ok")
            return out

        monkeypatch.setattr(q._engine, "encode", fake_encode)
        a = q.enqueue(
            EncodePlan(
                source=str(tmp_path / "a.mp4"),
                output=str(tmp_path / "ao.mp4"),
                target_size=1024 * 1024,
            )
        )
        b = q.enqueue(
            EncodePlan(
                source=str(tmp_path / "b.mp4"),
                output=str(tmp_path / "bo.mp4"),
                target_size=1024 * 1024,
            )
        )
        q.cancel(b.id)
        q.start()
        deadline = time.time() + 2
        while a.state not in (QueueState.COMPLETED, QueueState.FAILED) and time.time() < deadline:
            time.sleep(0.02)
        q.stop()
        assert "a.mp4" in ran
        assert "b.mp4" not in ran
        assert b.state == QueueState.CANCELLED
