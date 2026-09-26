import os
from pathlib import Path

import pytest

from tuck.output_paths import reservation_path


def transaction(path):
    from tuck.encoding.output import OutputTransaction

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
    import tempfile

    def fail(**kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(tempfile, "TemporaryDirectory", fail)
    with pytest.raises(OSError, match="disk full"), transaction(tmp_path / "movie.mp4"):
        pytest.fail("entered failed transaction")
    assert not list(tmp_path.iterdir())


def test_publication_failure_cleans_up_and_preserves_existing_files(tmp_path, monkeypatch):
    operation = "rename" if os.name == "nt" else "link"

    def fail(*args, **kwargs):
        raise OSError("write denied")

    monkeypatch.setattr(os, operation, fail)
    with pytest.raises(OSError, match="write denied"), transaction(tmp_path / "movie.mp4") as work:
        result = work.workspace / "result.mp4"
        result.write_bytes(b"finished")
        work.publish(result)
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
    import tempfile

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
        monkeypatch.setattr(tempfile.TemporaryDirectory, "cleanup", fail_workspace)
    updates = []
    result = engine.encode(EncodePlan(source=str(source), output=str(output)), updates.append)
    assert result == output and result.read_bytes() == b"finished"
    assert updates[-1].stage == EncodeStage.COMPLETED
    assert not any(update.stage == EncodeStage.FAILED for update in updates)
    assert "locked" in caplog.text
