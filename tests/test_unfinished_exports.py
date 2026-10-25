"""Retry all, Clear finished, and exports that come back after Tuck closes mid-batch."""

import dataclasses
import json
import threading
from pathlib import Path

import pytest

from tuck.bridge_serialization import queue_item_dict
from tuck.models import (
    AudioClip,
    AudioTrack,
    CropRect,
    EncodePlan,
    QueueItem,
    QueueState,
    Segment,
    VideoInfo,
    VideoTransform,
)
from tuck.models.cutting import (
    CutAnalysis,
    CutIssue,
    CutPlan,
    CutRange,
    CutRequest,
    CutSegment,
    MediaTime,
    SourceIdentity,
    TrackPlan,
    TrackSegment,
)
from tuck.queue import ProcessingQueue
from tuck.queue_store import STORE_NAME, UnfinishedExportStore

_FINISHED = {QueueState.COMPLETED, QueueState.FAILED, QueueState.CANCELLED}


def _video(tmp_path: Path, name: str) -> Path:
    path = tmp_path / name
    path.write_bytes(b"video")
    return path


def _plan(tmp_path: Path, name: str) -> EncodePlan:
    source = _video(tmp_path, f"{name}.mp4")
    return EncodePlan(
        source=str(source),
        output=str(tmp_path / f"{name}_out.mp4"),
        target_size=1024 * 1024,
        source_info=VideoInfo(
            path=str(source),
            duration=10.0,
            width=1280,
            height=720,
            fps=30.0,
            video_codec="h264",
            file_size=5,
        ),
    )


def _cut_plan(tmp_path: Path) -> CutPlan:
    source = _video(tmp_path, "cut.mkv")
    edge = CutRange(MediaTime(0, 1, 1000), MediaTime(2500, 1, 1000))
    return CutPlan(
        identity=SourceIdentity(str(source), 5, 123, "ab" * 32),
        segments=(CutSegment(edge, edge, "keyframe", 0, audio_source=edge, audio_packet_count=3),),
        precision="keyframes",
        include_audio=True,
        output_path=str(tmp_path / "cut_cut.mkv"),
        exported_duration=MediaTime(2500, 1, 1000),
        estimated_bytes=4096,
        issues=(),
        exact_available=False,
        exact_reason="Exact cuts need a supported codec.",
        fingerprint="cd" * 32,
        container="mkv",
        request=CutRequest(str(source), (edge,), "keyframes", True, str(tmp_path), "cut_cut.mkv"),
        tracks=(TrackPlan(1, "audio", "aac", True, segments=(TrackSegment(0, 3, edge.start),)),),
        unverified=(CutIssue("verification_failed", "Not checked", None),),
        keep_file_dates=True,
    )


def _store(tmp_path: Path) -> UnfinishedExportStore:
    return UnfinishedExportStore(tmp_path / "data" / STORE_NAME)


def _saved(store: UnfinishedExportStore) -> list[dict]:
    if not store.path.exists():
        return []
    return json.loads(store.path.read_text(encoding="utf-8"))["exports"]


def _wait(queue: ProcessingQueue, condition, timeout: float = 5.0) -> None:
    with queue._condition:
        assert queue._condition.wait_for(condition, timeout=timeout)


class TestPlansRoundTrip:
    def test_an_encode_plan_reads_back_the_same(self, tmp_path):
        plan = _plan(tmp_path, "full")
        plan.segments = [Segment(0.5, 3.0), Segment(5.0, 8.0)]
        plan.transform = VideoTransform(crop=CropRect(4, 8, 640, 360), rotation=90)
        plan.audio_tracks = [
            AudioTrack(
                "music",
                "Music",
                clips=[AudioClip(str(_video(tmp_path, "music.mp3")), 0.0, 0.0, 2.0, 2.0)],
            )
        ]
        plan.warnings = ["Subtitles are left out."]
        text = json.dumps(plan.to_dict())
        assert EncodePlan.from_dict(json.loads(text)) == plan

    def test_a_cut_plan_reads_back_the_same_without_its_analysis(self, tmp_path):
        plan = _cut_plan(tmp_path)
        text = json.dumps(plan.to_dict())
        restored = CutPlan.from_dict(json.loads(text))
        assert restored == plan
        assert restored.keep_file_dates is True
        assert restored.analysis is None

    def test_a_damaged_cut_plan_is_refused(self, tmp_path):
        data = _cut_plan(tmp_path).to_dict()
        data["estimated_bytes"] = "lots"
        with pytest.raises(ValueError):
            CutPlan.from_dict(data)
        del data["identity"]
        with pytest.raises(ValueError):
            CutPlan.from_dict(data)


class TestRetryAll:
    def test_failed_and_canceled_exports_go_back_in_list_order_keeping_their_rows(self, tmp_path):
        q = ProcessingQueue()
        a = q.enqueue(_plan(tmp_path, "a"))
        b = q.enqueue(_plan(tmp_path, "b"))
        c = q.enqueue(_plan(tmp_path, "c"))
        d = q.enqueue(_plan(tmp_path, "d"))
        waiting = q.enqueue(_plan(tmp_path, "waiting"))
        with q._condition:
            a.state = QueueState.CANCELLED
            b.state = QueueState.COMPLETED
            c.state = QueueState.FAILED
            c.error = "Disk is full"
            c.error_code = "disk_full"
            c.progress = 40.0
            d.state = QueueState.CANCELLED
            q._pending.clear()
            q._pending.append(waiting.id)

        assert q.retry_all() == [a.id, c.id, d.id]

        assert q.pending_ids == [waiting.id, a.id, c.id, d.id]
        assert [i.id for i in q.items] == [a.id, b.id, c.id, d.id, waiting.id]
        assert a.state == c.state == d.state == QueueState.PENDING
        assert b.state == QueueState.COMPLETED
        assert (c.error, c.error_code, c.progress, c.finished_at) == ("", "", 0.0, "")
        assert q.retry_all() == []

    def test_a_retried_video_that_changed_fails_with_the_reason_when_it_starts(
        self, tmp_path, monkeypatch
    ):
        q = ProcessingQueue()
        plan = _plan(tmp_path, "changed")
        item = q.enqueue(plan)
        with q._condition:
            item.state = QueueState.CANCELLED
            q._pending.clear()
        assert plan.source_info is not None
        monkeypatch.setattr(
            "tuck.queue.probe", lambda path: dataclasses.replace(plan.source_info, file_size=9)
        )
        monkeypatch.setattr(
            q._engine, "encode", lambda *a, **k: pytest.fail("a changed video must not export")
        )
        q.retry_all()
        q.start()
        try:
            _wait(q, lambda: item.state in _FINISHED)
        finally:
            q.stop()
        assert item.state == QueueState.FAILED
        assert item.error_code == "source_changed"
        assert "changed" in item.error

    def test_an_unchanged_video_exports_after_retry_all(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        plan = _plan(tmp_path, "same")
        item = q.enqueue(plan)
        with q._condition:
            item.state = QueueState.FAILED
            q._pending.clear()
        monkeypatch.setattr("tuck.queue.probe", lambda path: plan.source_info)

        def encode(attempt, on_progress=None):
            Path(attempt.output).write_bytes(b"ok")
            return Path(attempt.output)

        monkeypatch.setattr(q._engine, "encode", encode)
        q.retry_all()
        q.start()
        try:
            _wait(q, lambda: item.state in _FINISHED)
        finally:
            q.stop()
        assert item.state == QueueState.COMPLETED

    def test_a_retried_cut_reads_its_keyframes_again(self, tmp_path):
        q = ProcessingQueue()
        plan = _cut_plan(tmp_path)
        item = q.enqueue(plan)
        with q._condition:
            zero = MediaTime(0)
            scan = CutAnalysis(plan.identity, (), zero, zero, zero, (), (), (), zero, (), "1")
            item.plan = dataclasses.replace(plan, analysis=scan)
            item.state = QueueState.CANCELLED
            q._pending.clear()
        q.retry_all()
        assert isinstance(item.plan, CutPlan)
        assert item.plan.analysis is None


class TestClearFinished:
    def test_completed_and_canceled_go_while_failed_and_unfinished_stay(self, tmp_path):
        q = ProcessingQueue()
        states = [
            QueueState.COMPLETED,
            QueueState.CANCELLED,
            QueueState.FAILED,
            QueueState.PENDING,
            QueueState.PAUSED,
        ]
        items = [q.enqueue(_plan(tmp_path, state.value)) for state in states]
        with q._condition:
            for item, state in zip(items, states, strict=True):
                item.state = state
        assert q.clear_finished() == 2
        assert [i.state for i in q.items] == states[2:]

    def test_clear_completed_still_keeps_canceled_exports_for_the_settings_option(self, tmp_path):
        q = ProcessingQueue()
        done, canceled = q.enqueue(_plan(tmp_path, "done")), q.enqueue(_plan(tmp_path, "stop"))
        with q._condition:
            done.state = QueueState.COMPLETED
            canceled.state = QueueState.CANCELLED
        assert q.clear_completed() == 1
        assert [i.id for i in q.items] == [canceled.id]


class TestSavingUnfinishedExports:
    def test_nothing_is_written_until_the_queue_has_a_store(self, tmp_path):
        q = ProcessingQueue()
        q.enqueue(_plan(tmp_path, "a"))
        assert not (tmp_path / "data").exists()

    def test_a_first_start_without_a_file_restores_nothing_and_starts_saving(self, tmp_path):
        q = ProcessingQueue()
        store = _store(tmp_path)
        assert q.restore(store) == []
        assert not store.path.exists()
        item = q.enqueue(_plan(tmp_path, "a"))
        assert [entry["id"] for entry in _saved(store)] == [item.id]

    def test_waiting_and_running_exports_are_saved_in_run_order_and_finished_ones_are_not(
        self, tmp_path
    ):
        q = ProcessingQueue()
        store = _store(tmp_path)
        q.restore(store)
        a = q.enqueue(_plan(tmp_path, "a"))
        b = q.enqueue(_plan(tmp_path, "b"))
        c = q.enqueue(_plan(tmp_path, "c"))
        assert q.move_item(c.id, 0)
        assert [entry["id"] for entry in _saved(store)] == [c.id, a.id, b.id]

        with q._condition:
            q._pending.remove(a.id)
            a.state = QueueState.RUNNING
            q._current_item = a
        q._save_unfinished()
        saved = _saved(store)
        assert [(entry["id"], entry["running"]) for entry in saved] == [
            (a.id, True),
            (c.id, False),
            (b.id, False),
        ]
        assert saved[0]["kind"] == "encode"
        assert saved[0]["plan"]["source"] == a.plan.source

        q.cancel(b.id)
        with q._condition:
            a.state = QueueState.COMPLETED
            q._current_item = None
        q._save_unfinished()
        assert [entry["id"] for entry in _saved(store)] == [c.id]
        q.remove(c.id)
        assert not store.path.exists()

    def test_stop_after_this_and_cancel_all_leave_nothing_to_restore(self, tmp_path):
        q = ProcessingQueue()
        store = _store(tmp_path)
        q.restore(store)
        q.enqueue(_plan(tmp_path, "a"))
        q.enqueue(_plan(tmp_path, "b"))
        q.stop_after_current()
        assert _saved(store) == []
        q.enqueue(_plan(tmp_path, "c"))
        q.cancel_all()
        assert _saved(store) == []

    def test_closing_tuck_keeps_the_running_export_on_disk(self, tmp_path, monkeypatch):
        q = ProcessingQueue()
        store = _store(tmp_path)
        q.restore(store)
        started = threading.Event()
        released = threading.Event()

        def encode(attempt, on_progress=None):
            from tuck.engine import EncodeCancelled

            started.set()
            released.wait(5)
            raise EncodeCancelled()

        monkeypatch.setattr(q._engine, "encode", encode)
        monkeypatch.setattr(q._engine, "cancel", released.set)
        running = q.enqueue(_plan(tmp_path, "running"))
        waiting = q.enqueue(_plan(tmp_path, "waiting"))
        q.start()
        assert started.wait(5)
        q.stop()
        assert running.state == QueueState.CANCELLED
        saved = _saved(store)
        assert [(entry["id"], entry["running"]) for entry in saved] == [
            (running.id, True),
            (waiting.id, False),
        ]

    def test_a_late_restore_after_closing_leaves_the_file_alone(self, tmp_path):
        q = ProcessingQueue()
        store = _store(tmp_path)
        q.restore(store)
        item = q.enqueue(_plan(tmp_path, "a"))
        q.stop()
        before = store.path.read_text(encoding="utf-8")
        assert ProcessingQueue.restore(q, store) == []
        assert store.path.read_text(encoding="utf-8") == before
        assert [entry["id"] for entry in _saved(store)] == [item.id]

    def test_an_older_write_never_replaces_a_newer_one(self, tmp_path):
        store = _store(tmp_path)
        older, newer = store.ticket(), store.ticket()
        store.save(newer, [{"id": "new"}])
        store.save(older, [{"id": "old"}])
        assert _saved(store) == [{"id": "new"}]

    def test_a_failed_write_is_logged_and_the_export_keeps_going(self, tmp_path, caplog):
        blocker = tmp_path / "data"
        blocker.write_text("not a folder")
        q = ProcessingQueue()
        q.restore(UnfinishedExportStore(blocker / STORE_NAME))
        item = q.enqueue(_plan(tmp_path, "a"))
        assert item.state == QueueState.PENDING
        assert "Could not save the unfinished exports" in caplog.text


class TestRestoring:
    def _previous_run(self, tmp_path: Path, *plans: EncodePlan | CutPlan, running: int = -1):
        """What an earlier Tuck left on disk, without a store attached to that queue."""
        store = _store(tmp_path)
        earlier = ProcessingQueue()
        earlier.restore(store)
        items = [earlier.enqueue(plan) for plan in plans]
        if running >= 0:
            with earlier._condition:
                earlier._pending.remove(items[running].id)
                items[running].state = QueueState.RUNNING
                earlier._current_item = items[running]
            earlier._save_unfinished()
        earlier.stop()
        return store, items

    def test_exports_come_back_paused_in_order_and_resume_queues_them(self, tmp_path):
        cut = _cut_plan(tmp_path)
        store, earlier = self._previous_run(
            tmp_path, _plan(tmp_path, "a"), cut, _plan(tmp_path, "b"), running=1
        )
        q = ProcessingQueue()
        newer = q.enqueue(_plan(tmp_path, "new"))
        restored = q.restore(store)

        # the running cut first, then the ones that waited
        assert restored == [earlier[1].id, earlier[0].id, earlier[2].id]
        items = {item.id: item for item in q.items}
        assert all(items[i].state == QueueState.PAUSED and items[i].restored for i in restored)
        assert items[earlier[1].id].plan == cut
        assert q.pending_ids == [newer.id]
        snapshot = queue_item_dict(items[restored[0]])
        assert snapshot["state"] == "paused" and snapshot["restored"] is True
        assert queue_item_dict(items[newer.id])["restored"] is False
        # paused exports are still saved, so closing again doesn't lose them
        assert [entry["id"] for entry in _saved(store)] == [newer.id, *restored]

        assert q.resume_paused() == restored
        assert q.pending_ids == [newer.id, *restored]
        assert all(q._items[i].state == QueueState.PENDING for i in restored)
        assert q.resume_paused() == []

    def test_an_interrupted_export_has_its_scratch_files_cleaned(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        plan = _plan(tmp_path, "a")
        plan.output = str(out / "a_out.mp4")
        store, _ = self._previous_run(tmp_path, plan, running=0)
        (out / "a_out.mp4.reserved").write_bytes(b"")
        scratch = out / ".tuck-abcd1234"
        scratch.mkdir()
        (scratch / "pass.log").write_text("ffmpeg")

        ProcessingQueue().restore(store)

        assert not (out / "a_out.mp4.reserved").exists()
        assert not scratch.exists()

    def test_a_missing_video_comes_back_failed_with_a_plain_reason(self, tmp_path):
        gone = _plan(tmp_path, "gone")
        kept = _plan(tmp_path, "kept")
        store, earlier = self._previous_run(tmp_path, gone, kept)
        Path(gone.source).unlink()

        q = ProcessingQueue()
        q.restore(store)

        items = {item.id: item for item in q.items}
        failed = items[earlier[0].id]
        assert failed.state == QueueState.FAILED
        assert failed.error == (
            "Tuck can't find this video any more. It may have been moved, renamed or deleted."
        )
        assert failed.error_code == "source_unavailable"
        assert items[earlier[1].id].state == QueueState.PAUSED
        # failed is finished, so it isn't saved for the next start
        assert [entry["id"] for entry in _saved(store)] == [earlier[1].id]

    def test_a_missing_added_audio_file_is_named(self, tmp_path):
        plan = _plan(tmp_path, "music")
        music = _video(tmp_path, "song.mp3")
        plan.audio_tracks = [AudioTrack("m", "Music", [AudioClip(str(music), 0.0, 0.0, 1.0, 1.0)])]
        store, _ = self._previous_run(tmp_path, plan)
        music.unlink()
        q = ProcessingQueue()
        q.restore(store)
        assert "“song.mp3”" in q.items[0].error

    def test_a_corrupt_file_restores_nothing_and_is_kept_aside(self, tmp_path, caplog):
        store = _store(tmp_path)
        store.path.parent.mkdir(parents=True)
        store.path.write_text('{"version": 1, "exports": [', encoding="utf-8")
        q = ProcessingQueue()
        assert q.restore(store) == []
        assert not store.path.exists()
        aside = store.path.with_name(STORE_NAME + ".unreadable")
        assert aside.read_text(encoding="utf-8") == '{"version": 1, "exports": ['
        assert "can't be read" in caplog.text
        q.enqueue(_plan(tmp_path, "a"))
        assert len(_saved(store)) == 1

    def test_a_file_from_an_unknown_version_is_not_guessed_at(self, tmp_path):
        store = _store(tmp_path)
        store.path.parent.mkdir(parents=True)
        store.path.write_text('{"version": 99, "exports": []}', encoding="utf-8")
        assert ProcessingQueue().restore(store) == []
        assert store.path.with_name(STORE_NAME + ".unreadable").exists()

    def test_one_unreadable_export_does_not_lose_the_others(self, tmp_path):
        store, earlier = self._previous_run(tmp_path, _plan(tmp_path, "a"), _plan(tmp_path, "b"))
        document = json.loads(store.path.read_text(encoding="utf-8"))
        document["exports"][0]["plan"]["segments"] = "broken"
        document["exports"].append({"id": "x", "kind": "mystery", "plan": {}})
        store.path.write_text(json.dumps(document), encoding="utf-8")
        q = ProcessingQueue()
        assert q.restore(store) == [earlier[1].id]

    def test_resumed_exports_check_their_video_before_running(self, tmp_path, monkeypatch):
        plan = _plan(tmp_path, "a")
        store, _ = self._previous_run(tmp_path, plan)
        q = ProcessingQueue()
        (item_id,) = q.restore(store)
        item = q._items[item_id]
        assert plan.source_info is not None
        checked: list[str] = []

        def probe(path):
            checked.append(path)
            return plan.source_info

        def encode(attempt, on_progress=None):
            Path(attempt.output).write_bytes(b"ok")
            return Path(attempt.output)

        monkeypatch.setattr("tuck.queue.probe", probe)
        monkeypatch.setattr(q._engine, "encode", encode)
        q.resume_paused()
        q.start()
        try:
            _wait(q, lambda: item.state in _FINISHED)
        finally:
            q.stop()
        assert item.state == QueueState.COMPLETED
        assert checked == [plan.source]
        assert not store.path.exists()

    def test_a_retry_of_a_restored_export_stays_apart_from_the_library(self, tmp_path, monkeypatch):
        plan = _plan(tmp_path, "a")
        store, _ = self._previous_run(tmp_path, plan)
        Path(plan.source).unlink()
        q = ProcessingQueue()
        q.restore(store)
        _video(tmp_path, "a.mp4")
        monkeypatch.setattr("tuck.queue.probe", lambda path: plan.source_info)
        retried = q.retry(q.items[0].id)
        assert retried is not None and retried.restored is True

    def test_paused_exports_are_left_alone_by_cancel_all(self, tmp_path):
        store, _ = self._previous_run(tmp_path, _plan(tmp_path, "a"))
        q = ProcessingQueue()
        q.restore(store)
        q.cancel_all()
        assert [i.state for i in q.items] == [QueueState.PAUSED]
        assert len(_saved(store)) == 1


def test_the_bridge_restores_in_the_data_folder_and_offers_the_new_actions(tmp_path, monkeypatch):
    import tuck.settings as settings_mod
    from tuck.bridge import BridgeAPI

    monkeypatch.setattr(settings_mod, "_settings_manager", None)
    monkeypatch.setattr(settings_mod, "_storage_root", tmp_path / "storage")
    monkeypatch.setattr("tuck.queue._queue", None)
    api = BridgeAPI()
    store = UnfinishedExportStore(api._settings.data_dir / STORE_NAME)
    earlier = ProcessingQueue()
    earlier.restore(store)
    saved = earlier.enqueue(_plan(tmp_path, "a"))
    earlier.stop()

    def encode(attempt, on_progress=None):
        Path(attempt.output).write_bytes(b"ok")
        return Path(attempt.output)

    monkeypatch.setattr(api._media_server, "start", lambda: None)
    monkeypatch.setattr(api._media_server, "stop", lambda: None)
    monkeypatch.setattr(api._queue._engine, "encode", encode)
    monkeypatch.setattr("tuck.queue.probe", lambda path: saved.plan.source_info)
    api.start_background_services()
    try:
        _wait(api._queue, lambda: saved.id in api._queue._items)
        state = api.get_queue_state()
        assert [(i["id"], i["state"]) for i in state["items"]] == [(saved.id, "paused")]

        assert api.resume_exports() == {"ok": True, "item_ids": [saved.id], "count": 1}
        _wait(api._queue, lambda: api._queue._items[saved.id].state in _FINISHED)
        assert api._queue._items[saved.id].state == QueueState.COMPLETED
        assert api.retry_all_items() == {"ok": True, "item_ids": [], "count": 0}
        canceled = QueueItem(plan=_plan(tmp_path, "stop"), state=QueueState.CANCELLED)
        with api._queue._condition:
            api._queue._items[canceled.id] = canceled
        assert api.clear_finished() == {"ok": True, "count": 2}
    finally:
        api.stop_background_services()
