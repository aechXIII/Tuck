import os
import threading
import time
from collections import deque
from pathlib import Path

import pytest

from tuck.models import (
    AudioClip,
    AudioTrack,
    CropRect,
    EncodePlan,
    OutputGeometry,
    QueueItem,
    QueueState,
    Segment,
    VideoTransform,
)
from tuck.queue import ProcessingQueue


def _plan(name: str) -> EncodePlan:
    return EncodePlan(source=f"{name}.mp4", output=f"{name}_out.mp4", target_size=1024 * 1024)


_FINISHED = {QueueState.COMPLETED, QueueState.FAILED, QueueState.CANCELLED}


def _wait_until_finished(q: ProcessingQueue, *items: QueueItem, timeout: float = 5.0) -> None:
    # the worker notifies the queue condition after every item it finishes
    with q._condition:
        finished = q._condition.wait_for(
            lambda: all(item.state in _FINISHED for item in items), timeout=timeout
        )
    assert finished, [item.state for item in items]


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

    def test_enqueue_snapshots_complete_transform_state(self):
        q = ProcessingQueue()
        plan = _plan("transform")
        transform = VideoTransform(
            crop=CropRect(10, 20, 800, 600),
            crop_aspect="4:3",
            rotation=90,
            flip_horizontal=True,
            flip_vertical=True,
            sizing_mode="fill",
            output=OutputGeometry(1080, 1920),
        )
        plan.transform = transform
        item = q.enqueue(plan)
        plan.transform = VideoTransform()
        assert item.plan is not None
        assert item.plan.transform == transform

    def test_enqueue_snapshots_timeline_and_audio_state(self):
        q = ProcessingQueue()
        plan = _plan("timeline")
        plan.segments = [Segment(1, 4)]
        plan.source_audio_segments = [Segment(1, 4)]
        plan.audio_tracks = [
            AudioTrack(
                track_id="music",
                name="Music",
                clips=[
                    AudioClip(
                        source="music.wav",
                        timeline_start=0,
                        source_in=0,
                        source_out=3,
                        timeline_duration=3,
                    )
                ],
            )
        ]

        item = q.enqueue(plan)
        plan.segments[0] = Segment(5, 8)
        plan.source_audio_segments[0] = Segment(5, 8)
        plan.audio_tracks[0].clips[0] = AudioClip(
            source="replacement.wav",
            timeline_start=0,
            source_in=0,
            source_out=2,
            timeline_duration=2,
        )

        assert item.plan is not None
        assert item.plan.segments == [Segment(1, 4)]
        assert item.plan.source_audio_segments == [Segment(1, 4)]
        assert item.plan.audio_tracks[0].clips[0].source == "music.wav"

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
        assert retry is not None and retry is item
        assert retry.state == QueueState.PENDING
        assert retry.error == ""
        assert retry.plan is not plan
        assert retry.plan == plan
        assert retry.plan.trim_start == 1.0
        assert retry.plan.transform.crop == crop
        assert retry.progress == 0.0
        assert retry.id in q.pending_ids

    def test_a_single_retry_keeps_the_row_as_retry_all_does(self):
        q = ProcessingQueue()
        failed = q.enqueue(_plan("a"))
        waiting = q.enqueue(_plan("b"))
        failed.state = QueueState.FAILED
        q._pending.remove(failed.id)
        retry = q.retry(failed.id)
        # one row for the export, where it was, and it runs after what was already waiting
        assert retry is failed
        assert [item.id for item in q.items] == [failed.id, waiting.id]
        assert q.pending_ids == [waiting.id, failed.id]
        # its video was read just now, so it isn't read again when it starts
        assert failed.id not in q._check_before_run

    def test_retry_preserves_canonical_segments_and_selected_duration(self):
        q = ProcessingQueue()
        plan = _plan("segments")
        plan.segments = [Segment(0, 1.5), Segment(4, 6)]
        item = q.enqueue(plan)
        item.state = QueueState.FAILED
        q._pending.clear()

        retry = q.retry(item.id)

        assert retry is not None and retry.plan is not None
        assert retry.plan.segments == plan.segments
        assert retry.plan.segments is not plan.segments
        assert retry.plan.effective_duration == 3.5

    def test_retry_retains_complete_transform_state(self):
        q = ProcessingQueue()
        plan = _plan("retry-transform")
        transform = VideoTransform(
            crop=CropRect(10, 20, 800, 600),
            crop_aspect="4:3",
            rotation=270,
            flip_horizontal=True,
            flip_vertical=True,
            sizing_mode="fit",
            output=OutputGeometry(1000, 1000),
        )
        plan.transform = transform
        plan.trim_start = 1.5
        plan.trim_end = 7.5
        item = q.enqueue(plan)
        item.state = QueueState.FAILED
        q._pending.clear()
        retry = q.retry(item.id)
        assert retry is not None and retry.plan is not None
        assert retry.plan.transform == transform
        assert (retry.plan.trim_start, retry.plan.trim_end) == (1.5, 7.5)

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
        _wait_until_finished(q, retry)
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
        idle = threading.Event()
        wait = q._condition.wait

        def wait_while_idle(timeout: float | None = None) -> bool:
            idle.set()
            return wait(timeout)

        monkeypatch.setattr(q._condition, "wait", wait_while_idle)
        q.start()
        assert idle.wait(timeout=5)
        item = q.enqueue(
            EncodePlan(
                source=str(tmp_path / "clip.mp4"),
                output=str(tmp_path / "out.mp4"),
                target_size=1024 * 1024,
            )
        )
        _wait_until_finished(q, item)
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
        _wait_until_finished(q, *items)
        q.stop()
        assert counts == {"c0.mp4": 1, "c1.mp4": 1, "c2.mp4": 1}

    @pytest.mark.skipif(os.name == "nt", reason="POSIX terminal handling is not available")
    def test_piped_posix_queue_processes_each_item(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        processed: list[str] = []

        def fake_encode(plan, on_progress=None):
            processed.append(Path(plan.source).name)
            output = Path(plan.output)
            output.write_bytes(b"ok")
            return output

        monkeypatch.setattr(os, "isatty", lambda _fd: False)
        monkeypatch.setattr(q._engine, "encode", fake_encode)
        q.start()
        items = [
            q.enqueue(
                EncodePlan(
                    source=str(tmp_path / f"clip-{index}.mp4"),
                    output=str(tmp_path / f"out-{index}.mp4"),
                    target_size=1024 * 1024,
                )
            )
            for index in range(2)
        ]
        _wait_until_finished(q, *items)
        q.stop()

        assert processed == ["clip-0.mp4", "clip-1.mp4"]
        assert [item.state for item in items] == [QueueState.COMPLETED, QueueState.COMPLETED]

    def test_cancel_running_before_encode_is_preserved(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        entered = threading.Event()
        release = threading.Event()
        from tuck.queue import resolve_output_collision

        def delayed_output_path(path):
            entered.set()
            assert release.wait(timeout=5)
            return resolve_output_collision(path)

        monkeypatch.setattr("tuck.queue.resolve_output_collision", delayed_output_path)

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
        _wait_until_finished(q, item)
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
        _wait_until_finished(q, a)
        q.stop()
        assert "a.mp4" in ran
        assert "b.mp4" not in ran
        assert b.state == QueueState.CANCELLED


class TestRetryRereadsTheVideo:
    @staticmethod
    def _failed_item(q: ProcessingQueue, tmp_path: Path):
        import dataclasses

        from tuck.models import VideoInfo

        source = tmp_path / "clip.mp4"
        source.write_bytes(b"video")
        info = VideoInfo(
            path=str(source),
            duration=10.0,
            width=1280,
            height=720,
            fps=30.0,
            video_codec="h264",
            file_size=5,
        )
        plan = EncodePlan(
            source=str(source),
            output=str(tmp_path / "clip_out.mp4"),
            target_size=1024 * 1024,
            source_info=dataclasses.replace(info),
        )
        item = q.enqueue(plan)
        item.state = QueueState.FAILED
        q._pending.clear()
        return item, info

    def test_an_unchanged_video_is_queued_again(self, tmp_path, monkeypatch):
        import dataclasses

        q = ProcessingQueue()
        item, info = self._failed_item(q, tmp_path)
        # the same file reached through another spelling of its path
        monkeypatch.setattr(
            "tuck.queue.probe", lambda path: dataclasses.replace(info, path=str(path).upper())
        )
        retry = q.retry(item.id)
        assert retry is not None and retry.plan is not None
        assert retry.plan.source_info == info
        assert q.pending_ids == [retry.id]

    def test_a_changed_video_is_not_retried_with_the_old_plan(self, tmp_path, monkeypatch):
        import dataclasses

        from tuck.queue import RetryRefused

        q = ProcessingQueue()
        item, info = self._failed_item(q, tmp_path)
        monkeypatch.setattr(
            "tuck.queue.probe", lambda path: dataclasses.replace(info, duration=4.0, file_size=9)
        )
        with pytest.raises(RetryRefused, match="Add it again") as error:
            q.retry(item.id)
        assert error.value.code == "source_changed"
        assert q.pending_ids == []
        assert len(q.items) == 1

    def test_a_missing_video_is_not_retried(self, tmp_path, monkeypatch):
        from tuck.queue import RetryRefused

        q = ProcessingQueue()
        item, _ = self._failed_item(q, tmp_path)

        def gone(path):
            raise FileNotFoundError(f"Source file not found: {path}")

        monkeypatch.setattr("tuck.queue.probe", gone)
        with pytest.raises(RetryRefused) as error:
            q.retry(item.id)
        assert error.value.code == "source_unavailable"
        assert q.pending_ids == []

    def test_cancel_all_while_the_video_is_reread_keeps_the_retry_out(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        item, info = self._failed_item(q, tmp_path)

        def probe_then_cancel(path):
            q.cancel_all()
            return info

        monkeypatch.setattr("tuck.queue.probe", probe_then_cancel)
        assert q.retry(item.id) is None
        assert q.pending_ids == []
        assert [i.id for i in q.items] == [item.id]

    def test_the_bridge_explains_a_refused_retry(self, tmp_path, monkeypatch):
        import dataclasses

        import tuck.settings as settings_mod
        from tuck.bridge import BridgeAPI

        monkeypatch.setattr(settings_mod, "_settings_manager", None)
        monkeypatch.setattr(settings_mod, "_storage_root", tmp_path / "storage")
        monkeypatch.setattr("tuck.queue._queue", None)
        api = BridgeAPI()
        item, info = self._failed_item(api._queue, tmp_path)
        monkeypatch.setattr("tuck.queue.probe", lambda path: dataclasses.replace(info, file_size=9))
        response = api.retry_item(item.id)
        assert response["ok"] is False
        assert response["code"] == "source_changed"
        assert "changed" in str(response["error"])


def test_finished_item_records_the_encoder_auto_really_used(tmp_path, monkeypatch):
    q = ProcessingQueue()
    fallback = "Used software encoding because the NVIDIA encoder couldn't start"

    def fake_encode(plan, on_progress=None):
        q._engine._resolved_encoder = "libx264"
        q._engine._encoder_fallback = fallback
        out = Path(plan.output)
        out.write_bytes(b"ok")
        return out

    monkeypatch.setattr(q._engine, "encode", fake_encode)
    item = q.enqueue(
        EncodePlan(
            source=str(tmp_path / "clip.mp4"),
            output=str(tmp_path / "out.mp4"),
            target_size=1024 * 1024,
            video_encoder="auto",
        )
    )
    q.start()
    with q._condition:
        # the encoder is recorded as the worker lets go of the item
        done = q._condition.wait_for(
            lambda: item.state in _FINISHED and q._current_item is None, timeout=5
        )
    q.stop()
    assert done
    assert item.effective_encoder == "libx264"
    assert item.encoder_fallback == fallback


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="needs POSIX folder permissions")
def test_an_export_folder_that_cannot_be_created_is_explained(tmp_path, monkeypatch):
    from tuck.encoding.failures import NO_PERMISSION_MESSAGE
    from tuck.output_transaction import OutputTransaction

    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    q = ProcessingQueue()

    def fake_encode(plan, on_progress=None):
        # the real export opens its output the same way before FFmpeg starts
        with OutputTransaction(Path(plan.output)):
            raise AssertionError("the folder should not have been created")

    monkeypatch.setattr(q._engine, "encode", fake_encode)
    item = q.enqueue(
        EncodePlan(
            source=str(tmp_path / "clip.mp4"),
            output=str(locked / "Tucked" / "clip_tucked.mp4"),
            target_size=1024 * 1024,
        )
    )
    try:
        q.start()
        _wait_until_finished(q, item)
    finally:
        q.stop()
        locked.chmod(0o700)
    assert item.state == QueueState.FAILED
    assert item.error == NO_PERMISSION_MESSAGE
    assert item.progress_info is not None
    assert item.progress_info.message == NO_PERMISSION_MESSAGE
    # the system's own words stay for Copy details
    assert item.error_detail.startswith("PermissionError: [Errno 13]")
    assert str(locked / "Tucked") in item.error_detail


def test_a_failure_in_tucks_own_words_is_kept(tmp_path, monkeypatch):
    q = ProcessingQueue()

    def fake_encode(plan, on_progress=None):
        raise FileExistsError("Cannot reserve an output name. Try another output folder.")

    monkeypatch.setattr(q._engine, "encode", fake_encode)
    item = q.enqueue(
        EncodePlan(
            source=str(tmp_path / "clip.mp4"),
            output=str(tmp_path / "clip_tucked.mp4"),
            target_size=1024 * 1024,
        )
    )
    try:
        q.start()
        _wait_until_finished(q, item)
    finally:
        q.stop()
    assert item.error == "Cannot reserve an output name. Try another output folder."
