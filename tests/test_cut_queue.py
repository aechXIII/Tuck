import os
from dataclasses import replace
from pathlib import Path
from threading import Event, Thread

import pytest
from media.cut_fixtures import create_source, find_tools

from tuck.bridge_serialization import queue_item_dict
from tuck.cutting.analysis import CutAnalysisError, analyze_source
from tuck.cutting.exact import exact_encoder_available
from tuck.cutting.planner import parse_cut_request, plan_cut
from tuck.diagnostics import build_diagnostics
from tuck.encoding.runner import EncodeCancelled, FFmpegEngine
from tuck.models import EncodePlan, QueueState
from tuck.models.cutting import MediaTime
from tuck.models.progress import EncodeProgress, EncodeStage
from tuck.queue import ProcessingQueue


@pytest.fixture
def cut(tmp_path):
    tools = find_tools()
    if tools is None:
        pytest.skip("FFmpeg and ffprobe are required")
    source = create_source(tools, tmp_path / "source.mp4", duration=4)
    analysis = analyze_source(source, Event(), lambda _: None, ffprobe=tools.ffprobe)
    raw = {
        "operation": "cut",
        "source": str(source),
        "segments": [{"start": MediaTime(0).to_dict(), "end": MediaTime(2).to_dict()}],
    }
    plan = plan_cut(parse_cut_request(raw), analysis, exact_encoder=exact_encoder_available())
    return analysis, raw, plan


def finish(queue, items):
    with queue._condition:
        assert queue._condition.wait_for(
            lambda: all(
                i.state in {QueueState.COMPLETED, QueueState.FAILED, QueueState.CANCELLED}
                for i in items
            ),
            timeout=20,
        )


def test_engine_dispatches_cuts_without_encoder_discovery(cut, monkeypatch):
    from tuck.encoding import runner

    _, _, plan = cut
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: pytest.fail("copy needs no encoder"))
    engine = FFmpegEngine()
    updates = []
    output = engine.encode(plan, updates.append)
    assert output.is_file()
    assert updates[-1].stage == EncodeStage.COMPLETED
    copying = [p for p in updates if p.stage == EncodeStage.COPYING]
    assert any(0 < p.percent < 99 for p in copying)
    assert all(p.percent < 100 and not p.indeterminate for p in copying)
    for stage in (EncodeStage.PREPARING, EncodeStage.JOINING, EncodeStage.VERIFYING):
        assert all(p.to_dict()["indeterminate"] for p in updates if p.stage == stage)
    engine.cancel()
    with pytest.raises(EncodeCancelled):
        engine.encode(plan)
    engine.reset_cancel()
    assert engine.encode(plan) != output


def test_cut_diagnostics_preserve_export_context_without_private_paths(cut):
    _, _, plan = cut
    report = build_diagnostics(plan=plan, error="The source changed")
    assert "operation: cut" in report
    assert "precision: keyframes" in report
    assert "container: mp4" in report
    assert "selected duration: 2.000s" in report
    assert plan.identity.path not in report


def test_mixed_queue_finishes_and_serializes_the_published_cut_path(cut, tmp_path, monkeypatch):
    _, _, plan = cut
    queue = ProcessingQueue()
    encode = EncodePlan(source=plan.identity.path, output=str(tmp_path / "encoded.mp4"))
    original = queue._engine.encode

    def run(attempt, on_progress=None):
        if isinstance(attempt, EncodePlan):
            Path(attempt.output).write_bytes(b"encoded")
            return Path(attempt.output)
        return original(attempt, on_progress)

    monkeypatch.setattr(queue._engine, "encode", run)
    Path(plan.output_path).write_bytes(b"existing export")
    first, second = queue.enqueue(encode), queue.enqueue(plan)
    queue.start()
    try:
        finish(queue, [first, second])
        assert first.state == second.state == QueueState.COMPLETED
        snapshot = queue_item_dict(second)
        assert snapshot["operation"] == "cut"
        assert snapshot["precision"] == "keyframes" and snapshot["container"] == "mp4"
        assert snapshot["exported_duration"] == plan.exported_duration.to_dict()
        assert snapshot["result_path"] != plan.output_path
        assert snapshot["output"] == Path(second.result_path).name
        assert Path(plan.output_path).read_bytes() == b"existing export"
        assert second.plan == plan and second.plan is not plan
    finally:
        queue.stop()


def test_replaced_source_fails_while_queued_and_cannot_be_retried(cut):
    _, _, plan = cut
    source = Path(plan.identity.path)
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    data = bytearray(source.read_bytes())
    data[-1] ^= 1
    source.write_bytes(data)
    os.utime(source, ns=(plan.identity.mtime_ns, plan.identity.mtime_ns))
    queue.start()
    try:
        finish(queue, [item])
        assert item.state == QueueState.FAILED
        assert item.error_code == "source_changed"
        assert not Path(plan.output_path).exists()
        with pytest.raises(CutAnalysisError) as error:
            queue.retry(item.id)
        assert error.value.code == "source_changed"
        assert len(queue.items) == 1
    finally:
        queue.stop()


def test_retry_reanalyzes_and_rebuilds_the_cut_outside_queue_lock(cut, monkeypatch):
    from tuck.cutting import packets

    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    queue.cancel(item.id)
    scan = packets.analyze_source
    calls = []

    def analyze(*args, **kwargs):
        read = Event()
        thread = Thread(target=lambda: (queue.snapshot(), read.set()))
        thread.start()
        assert read.wait(2), "analysis must not hold the queue lock"
        thread.join()
        calls.append(args[0])
        return scan(*args, **kwargs)

    monkeypatch.setattr(packets, "analyze_source", analyze)
    retry = queue.retry(item.id)
    assert calls and retry is not None and retry.plan is not item.plan
    assert retry.plan == item.plan
    assert item.state == QueueState.CANCELLED


def test_retry_returns_the_current_plan_when_boundaries_changed(cut):
    from tuck.cutting.planner import CutPlanChanged

    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(replace(plan, exported_duration=MediaTime(1)))
    queue.cancel(item.id)
    with pytest.raises(CutPlanChanged) as error:
        queue.retry(item.id)
    assert error.value.current_plan == plan
    assert not queue.pending_ids


def test_retry_reports_a_removed_source_as_changed(cut):
    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    queue.cancel(item.id)
    Path(plan.source).unlink()
    with pytest.raises(CutAnalysisError) as error:
        queue.retry(item.id)
    assert error.value.code == "source_changed"
    assert not queue.pending_ids


def test_expired_retry_cannot_enqueue_late(cut, monkeypatch):
    import tuck.queue as module
    from tuck.cutting import analysis

    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    queue.cancel(item.id)
    clock = [0.0]
    monkeypatch.setattr(analysis, "monotonic", lambda: clock[0], raising=False)

    def rebuild(*args, **kwargs):
        clock[0] = 121.0
        return plan

    monkeypatch.setattr(module, "rebuild_cut_plan", rebuild)
    with pytest.raises(CutAnalysisError) as error:
        queue.retry(item.id)
    assert error.value.code == "cut_timed_out"
    assert not queue.pending_ids and len(queue.items) == 1


def test_cancel_all_reaches_retry_reanalysis(cut, monkeypatch):
    import tuck.queue as module

    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    queue.cancel(item.id)

    def rebuild(plan, cancel):
        queue.cancel_all()
        assert cancel.is_set()
        return plan

    monkeypatch.setattr(module, "rebuild_cut_plan", rebuild)
    assert queue.retry(item.id) is None


def test_snapshot_and_progress_values_cannot_mutate_queue_state(cut):
    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    progress = EncodeProgress(percent=25, stage=EncodeStage.COPYING)
    queue._on_progress(item, progress)
    progress.percent = 99
    items, _, pending = queue.snapshot()
    items[0].progress = 100
    items[0].plan = replace(plan, output_path="changed.mp4")
    pending.clear()
    assert item.progress == 25 and item.progress_info.percent == 25
    assert item.plan == plan and queue.pending_ids == [item.id]


def test_source_replaced_during_output_checks_is_not_published(cut, monkeypatch):
    _, _, plan = cut
    queue = ProcessingQueue()
    update = queue._on_progress

    def progress(item, value):
        update(item, value)
        if value.stage == EncodeStage.VERIFYING:
            source = Path(plan.source)
            data = bytearray(source.read_bytes())
            data[-1] ^= 1
            source.write_bytes(data)
            os.utime(source, ns=(plan.identity.mtime_ns, plan.identity.mtime_ns))

    monkeypatch.setattr(queue, "_on_progress", progress)
    item = queue.enqueue(plan)
    queue.start()
    try:
        finish(queue, [item])
        assert item.state == QueueState.FAILED and item.error_code == "source_changed"
        assert not item.result_path and not Path(plan.output).exists()
    finally:
        queue.stop()


@pytest.mark.parametrize("action", ["remove", "cancel_all", "stop_after_current"])
def test_retry_does_not_enqueue_after_queue_changes_during_analysis(cut, monkeypatch, action):
    import tuck.queue as module

    _, _, plan = cut
    queue = ProcessingQueue()
    item = queue.enqueue(plan)
    queue.cancel(item.id)

    def rebuild(*args, **kwargs):
        if action == "remove":
            queue.remove(item.id)
        else:
            getattr(queue, action)()
        return plan

    monkeypatch.setattr(module, "rebuild_cut_plan", rebuild)
    assert queue.retry(item.id) is None
    assert not queue.pending_ids


def test_cancel_releases_queue_lock_and_finishes_before_the_next_job(cut, monkeypatch):
    _, _, plan = cut
    queue = ProcessingQueue()
    first_started, cancel_started, release_job, release_cancel, next_started = (
        Event() for _ in range(5)
    )
    calls = []

    def run(attempt, on_progress=None):
        calls.append(attempt)
        if len(calls) == 1:
            first_started.set()
            assert release_job.wait(5)
            raise EncodeCancelled()
        next_started.set()
        raise EncodeCancelled()

    def cancel():
        queue.snapshot()
        cancel_started.set()
        assert release_cancel.wait(5)

    monkeypatch.setattr(queue._engine, "encode", run)
    monkeypatch.setattr(queue._engine, "cancel", cancel)
    first, second = queue.enqueue(plan), queue.enqueue(plan)
    queue.start()
    cancel_thread = Thread(target=lambda: queue.cancel(first.id))
    try:
        assert first_started.wait(5)
        cancel_thread.start()
        assert cancel_started.wait(5)
        read = Event()
        reader = Thread(target=lambda: (queue.snapshot(), read.set()))
        reader.start()
        assert read.wait(2), "engine cancellation must not hold the queue lock"
        reader.join()
        release_job.set()
        finish(queue, [first])
        assert not next_started.is_set()
        release_cancel.set()
        cancel_thread.join(5)
        finish(queue, [second])
        assert next_started.is_set()
    finally:
        release_job.set()
        release_cancel.set()
        cancel_thread.join(5)
        queue.stop()


@pytest.mark.parametrize("action", ["cancel", "cancel_all", "stop_after_current"])
def test_mixed_queue_cancellation_does_not_affect_the_next_job(cut, tmp_path, monkeypatch, action):
    _, _, plan = cut
    queue = ProcessingQueue()
    entered, release = Event(), Event()
    encode = EncodePlan(source=plan.identity.path, output=str(tmp_path / "encoded.mp4"))
    original = queue._engine.encode
    first_call = True

    def run(attempt, on_progress=None):
        nonlocal first_call
        if first_call:
            first_call = False
            entered.set()
            assert release.wait(10)
            if queue._engine._cancel_event.is_set():
                raise EncodeCancelled()
            path = Path(attempt.output_path)
            path.write_bytes(b"first")
            return path
        if isinstance(attempt, EncodePlan):
            assert not queue._engine._cancel_event.is_set()
            Path(attempt.output).write_bytes(b"next")
            return Path(attempt.output)
        return original(attempt, on_progress)

    monkeypatch.setattr(queue._engine, "encode", run)
    first, second = queue.enqueue(plan), queue.enqueue(encode)
    queue.start()
    try:
        assert entered.wait(5)
        if action == "cancel":
            queue.cancel(first.id)
        else:
            getattr(queue, action)()
        release.set()
        finish(queue, [first, second])
        assert first.state == (
            QueueState.COMPLETED if action == "stop_after_current" else QueueState.CANCELLED
        )
        assert second.state == (
            QueueState.COMPLETED if action == "cancel" else QueueState.CANCELLED
        )
    finally:
        release.set()
        queue.stop()
