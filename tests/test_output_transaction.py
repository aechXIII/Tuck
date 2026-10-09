import contextlib
import errno
import os
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import wait_until

from tuck.output_paths import (
    hold_new_file,
    remove_if_unheld,
    reservation_path,
    sweep_stale_outputs,
    workspace_lock_path,
)


def transaction(path):
    from tuck.output_transaction import OutputTransaction

    return OutputTransaction(path)


def test_reserved_name_is_skipped_and_foreign_marker_preserved(tmp_path):
    output = tmp_path / "movie.mp4"
    marker = reservation_path(output)
    marker.write_text("another export")
    with transaction(output) as work:
        assert work.output == tmp_path / "movie_1.mp4"
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        published = work.publish(result)
    assert published.read_bytes() == b"finished"
    assert marker.read_text() == "another export"
    assert set(tmp_path.iterdir()) == {marker, published}


def test_destination_appearing_before_publication_is_preserved(tmp_path):
    output = tmp_path / "movie.mp4"
    with transaction(output) as work:
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        output.write_bytes(b"someone else's work")
        published = work.publish(result)
    assert output.read_bytes() == b"someone else's work"
    assert published != output
    assert published.read_bytes() == b"finished"
    assert set(tmp_path.iterdir()) == {output, published}


def test_atomic_publication_never_replaces_a_destination(tmp_path, monkeypatch):
    output = tmp_path / "movie.mp4"
    operation = "rename" if os.name == "nt" else "link"
    original = getattr(os, operation)

    def occupy(source, destination, *args, **kwargs):
        if Path(destination) == output:
            output.write_bytes(b"racing writer")
        return original(source, destination, *args, **kwargs)

    monkeypatch.setattr(os, operation, occupy)
    with transaction(output) as work:
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        published = work.publish(result)
    assert output.read_bytes() == b"racing writer"
    assert published.read_bytes() == b"finished"
    assert published != output


@pytest.mark.parametrize("failure", [OSError("disk full"), RuntimeError("cancelled")])
def test_failure_removes_workspace_and_owned_reservation(tmp_path, failure):
    with (
        pytest.raises(type(failure), match=str(failure)),
        transaction(tmp_path / "movie.mp4") as work,
    ):
        assert work.workspace.parent == tmp_path
        (work.workspace / "partial.mp4").write_bytes(b"partial")
        raise failure
    assert not list(tmp_path.iterdir())


def test_workspace_creation_failure_releases_reservation(tmp_path, monkeypatch):
    def fail(folder):
        raise OSError("disk full")

    monkeypatch.setattr("tuck.output_transaction.open_workspace", fail)
    with pytest.raises(OSError, match="disk full"), transaction(tmp_path / "movie.mp4"):
        pytest.fail("entered failed transaction")
    assert not list(tmp_path.iterdir())


def test_publication_failure_cleans_up_and_preserves_existing_files(tmp_path, monkeypatch):
    output = tmp_path / "movie.mp4"
    operation = "rename" if os.name == "nt" else "link"
    original = getattr(os, operation)

    def fail(source, destination, *args, **kwargs):
        if Path(destination) == output:
            raise OSError("write denied")
        return original(source, destination, *args, **kwargs)

    monkeypatch.setattr(os, operation, fail)
    with pytest.raises(OSError, match="write denied"), transaction(output) as work:
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        work.publish(result)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("error", [errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP])
def test_exports_work_on_drives_without_hard_links(tmp_path, monkeypatch, error):
    # FAT32, exFAT and many network mounts refuse link() outright
    def refuse(*args, **kwargs):
        raise OSError(error, os.strerror(error))

    monkeypatch.setattr(os, "link", refuse)
    output = tmp_path / "movie.mp4"
    with transaction(output) as work:
        reservation = reservation_path(output)
        lock = workspace_lock_path(work.workspace)
        # still held, so a sweep by another export leaves them alone
        assert not remove_if_unheld(reservation)
        assert not remove_if_unheld(lock)
        sweep_stale_outputs(tmp_path)
        assert reservation.exists()
        assert lock.exists()
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        published = work.publish(result)
    assert published == output
    assert output.read_bytes() == b"finished"
    assert set(tmp_path.iterdir()) == {output}


def test_drive_without_hard_links_still_numbers_a_taken_name(tmp_path, monkeypatch):
    def refuse(*args, **kwargs):
        raise OSError(errno.EPERM, os.strerror(errno.EPERM))

    monkeypatch.setattr(os, "link", refuse)
    output = tmp_path / "movie.mp4"
    with transaction(output) as work:
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        output.write_bytes(b"someone else's work")
        published = work.publish(result)
    assert output.read_bytes() == b"someone else's work"
    assert published == tmp_path / "movie_1.mp4"
    assert published.read_bytes() == b"finished"


@pytest.mark.skipif(os.name == "nt", reason="fcntl is only available on POSIX")
def test_pending_marker_locked_by_a_sweep_is_retried_under_a_new_name(tmp_path, monkeypatch):
    import fcntl

    original_open = os.open
    sweeps = []

    def open_while_another_process_sweeps(path, flags, *args, **kwargs):
        descriptor = original_open(path, flags, *args, **kwargs)
        if str(path).endswith(".pending") and not sweeps:
            # another Tuck process's sweep locks the new pending file before its owner can
            sweep = original_open(path, os.O_RDONLY)
            fcntl.flock(sweep, fcntl.LOCK_EX | fcntl.LOCK_NB)
            sweeps.append(sweep)
        return descriptor

    marker = reservation_path(tmp_path / "movie.mp4")
    monkeypatch.setattr(os, "open", open_while_another_process_sweeps)
    try:
        held = hold_new_file(marker)
    finally:
        for sweep in sweeps:
            os.close(sweep)
    monkeypatch.undo()
    assert sweeps
    assert not remove_if_unheld(marker)
    assert set(tmp_path.iterdir()) == {marker}
    held.release()
    assert not list(tmp_path.iterdir())


def test_transaction_rejects_results_outside_its_workspace(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    with transaction(tmp_path / "movie.mp4") as work, pytest.raises(ValueError, match="workspace"):
        work.publish(source)
    assert set(tmp_path.iterdir()) == {source}
    assert source.read_bytes() == b"source"


@pytest.mark.parametrize("cancel", [False, True])
def test_encode_failure_or_cancellation_leaves_no_partial_output(tmp_path, monkeypatch, cancel):
    from tuck.encoding import runner
    from tuck.models import EncodePlan

    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    engine = runner.FFmpegEngine()
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(engine, "_select_encoder_candidates", lambda _: (False, ("libx264",)))

    def attempt(*args):
        args[5].write_bytes(b"partial")
        if cancel:
            engine.cancel()
            raise runner.EncodeCancelled("cancelled")
        raise OSError("disk full")

    monkeypatch.setattr(engine, "_run_candidates", attempt)
    error = runner.EncodeCancelled if cancel else OSError
    with pytest.raises(error):
        engine.encode(EncodePlan(source=str(source), output=str(tmp_path / "movie.mp4")))
    assert set(tmp_path.iterdir()) == {source}


@pytest.mark.parametrize("cleanup", ["reservation", "workspace"])
def test_cleanup_failure_does_not_turn_a_published_export_into_a_failure(
    tmp_path, monkeypatch, caplog, cleanup
):
    import shutil

    from tuck.encoding import runner
    from tuck.models import EncodePlan
    from tuck.models.progress import EncodeStage

    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "result.mp4"
    engine = runner.FFmpegEngine()
    monkeypatch.setattr(runner, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(engine, "_select_encoder_candidates", lambda _: (False, ("libx264",)))

    def attempt(*args):
        args[5].write_bytes(b"finished")
        return args[5]

    monkeypatch.setattr(engine, "_run_candidates", attempt)
    unlink = Path.unlink

    def fail_unlink(path, *args, **kwargs):
        if path.name.endswith(".reserved"):
            raise PermissionError("reservation is locked")
        return unlink(path, *args, **kwargs)

    def fail_workspace(directory):
        raise PermissionError("workspace is locked")

    if cleanup == "reservation":
        monkeypatch.setattr(Path, "unlink", fail_unlink)
    else:
        monkeypatch.setattr(shutil, "rmtree", fail_workspace)
    updates = []
    result = engine.encode(EncodePlan(source=str(source), output=str(output)), updates.append)
    assert result == output and result.read_bytes() == b"finished"
    assert updates[-1].stage == EncodeStage.COMPLETED
    assert not any(update.stage == EncodeStage.FAILED for update in updates)
    assert "locked" in caplog.text


ROOT = Path(__file__).resolve().parents[1]
# holds markers the way an export in another Tuck process does, until stdin closes
_HOLDER = (
    "import sys\n"
    "from pathlib import Path\n"
    "from tuck.output_paths import hold_new_file\n"
    "held = [hold_new_file(Path(path)) for path in sys.argv[1:]]\n"
    "print('ready', flush=True)\n"
    "sys.stdin.read()\n"
)


@contextlib.contextmanager
def held_by_another_process(*paths):
    process = subprocess.Popen(
        [sys.executable, "-c", _HOLDER, *map(str, paths)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        cwd=ROOT,
        text=True,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "ready"
        yield process
    finally:
        # killed, like a crash: nothing gets a chance to clean up
        process.kill()
        process.wait()
        wait_until_released(*paths)


def wait_until_released(*paths):
    """Windows closes a killed process's handles just after reporting that it exited; a
    real crash happened long before the next export, so the test waits for that moment."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    invalid = wintypes.HANDLE(-1).value
    sharing_violation = 32

    def released():
        for path in paths:
            # no sharing at all, so this open only works once no other handle is left
            handle = kernel32.CreateFileW(str(path), 0x80000000, 0, None, 3, 0, None)
            if handle == invalid:
                if ctypes.get_last_error() == sharing_violation:
                    return False
                continue
            kernel32.CloseHandle(handle)
        return True

    wait_until(released, what="the killed export's handles to close")


def publish_once(output):
    with transaction(output) as work:
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        return work.publish(result)


def test_reservation_left_by_a_crashed_export_is_reclaimed(tmp_path):
    output = tmp_path / "movie.mp4"
    reservation_path(output).touch()
    assert publish_once(output) == output
    assert set(tmp_path.iterdir()) == {output}


def test_reservation_held_by_another_export_is_respected(tmp_path):
    output = tmp_path / "movie.mp4"
    marker = reservation_path(output)
    with held_by_another_process(marker):
        published = publish_once(output)
        assert published == tmp_path / "movie_1.mp4"
        assert marker.exists()


def test_leftovers_of_a_killed_export_are_cleaned_up_by_the_next_one(tmp_path):
    output = tmp_path / "movie.mp4"
    workspace = tmp_path / ".tuck-0a1b2c3d"
    with held_by_another_process(reservation_path(output), workspace_lock_path(workspace)):
        workspace.mkdir()
        (workspace / "result.mp4").write_bytes(b"partial")
    assert publish_once(output) == output
    assert set(tmp_path.iterdir()) == {output}


def test_sweep_removes_only_workspaces_nobody_holds(tmp_path):
    from tuck.output_paths import sweep_stale_outputs

    unlocked = tmp_path / ".tuck-ab12cd34"
    unlocked.mkdir()
    (unlocked / "result.mp4").write_bytes(b"partial")
    unheld = tmp_path / ".tuck-ef56ab78"
    unheld.mkdir()
    workspace_lock_path(unheld).touch()
    live = tmp_path / ".tuck-0123abcd"
    with held_by_another_process(workspace_lock_path(live)):
        live.mkdir()
        (live / "result.mp4").write_bytes(b"in progress")
        sweep_stale_outputs(tmp_path)
        assert set(tmp_path.iterdir()) == {live, workspace_lock_path(live)}
        assert (live / "result.mp4").read_bytes() == b"in progress"


def test_sweep_leaves_everything_that_is_not_tucks_alone(tmp_path):
    from tuck.output_paths import sweep_stale_outputs

    empty_files = [
        "notes.txt.reserved",
        ".reserved",
        "movie.mp4",
        ".tuck-ab12cd34.bak",
        ".tuck-ABCDEFGH.lock",
        ".tuck-short.pending",
    ]
    for name in empty_files:
        (tmp_path / name).touch()
    # a marker with content isn't one Tuck wrote
    (tmp_path / "clip.mp4.reserved").write_text("someone else's", encoding="utf-8")
    folders = ["clip.mkv.reserved", ".tuck-config", ".tuck-ABCDEFGH", ".tuck-ab12cd345"]
    for name in folders:
        (tmp_path / name).mkdir()
        (tmp_path / name / "keep.txt").write_text("keep", encoding="utf-8")
    before = sorted(tmp_path.rglob("*"))
    sweep_stale_outputs(tmp_path)
    assert sorted(tmp_path.rglob("*")) == before
    assert (tmp_path / "clip.mp4.reserved").read_text(encoding="utf-8") == "someone else's"


def test_sweep_at_startup_runs_in_the_background(tmp_path):
    from tuck.output_paths import sweep_stale_outputs_later

    reservation_path(tmp_path / "movie.mp4").touch()
    sweep_stale_outputs_later(tmp_path).join(timeout=5)
    assert not list(tmp_path.iterdir())


def test_sweep_of_a_missing_folder_does_nothing(tmp_path):
    from tuck.output_paths import sweep_stale_outputs

    sweep_stale_outputs(tmp_path / "missing")


def test_tuck_reservations_cover_every_container_a_cut_can_write():
    from tuck.cutting.planner import OUTPUT_FORMATS
    from tuck.output_paths import OUTPUT_EXTENSIONS

    assert set(OUTPUT_FORMATS) <= OUTPUT_EXTENSIONS


def test_starting_the_app_sweeps_the_chosen_export_folder(tmp_path, monkeypatch):
    import tuck.settings as settings_mod
    from tuck.bridge import BridgeAPI

    monkeypatch.setattr(settings_mod, "_settings_manager", None)
    monkeypatch.setattr(settings_mod, "_storage_root", tmp_path / "storage")
    monkeypatch.setattr("tuck.queue._queue", None)
    folder = tmp_path / "exports"
    folder.mkdir()
    swept = []
    monkeypatch.setattr("tuck.bridge.sweep_stale_outputs_later", swept.append)
    api = BridgeAPI()
    assert api.save_settings({"output_location": "folder", "output_dir": str(folder)})["ok"]
    monkeypatch.setattr(api._queue, "start", lambda: None)
    monkeypatch.setattr(api._media_server, "start", lambda: None)

    api.start_background_services()

    assert swept == [folder]
