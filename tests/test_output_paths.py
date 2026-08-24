from pathlib import Path

from tuck.output_paths import reservation_path, resolve_output_collision


def test_reservation_marker_participates_in_output_collision_resolution(tmp_path: Path) -> None:
    output = tmp_path / "clip.mp4"
    reservation_path(output).write_text("reserved", encoding="utf-8")

    assert resolve_output_collision(output) == tmp_path / "clip_1.mp4"
    assert resolve_output_collision(output, respect_reservation=False) == output


def test_existing_output_and_reserved_candidate_increment_together(tmp_path: Path) -> None:
    output = tmp_path / "clip.mp4"
    output.write_bytes(b"existing")
    reservation_path(tmp_path / "clip_1.mp4").write_text("reserved", encoding="utf-8")

    assert resolve_output_collision(output) == tmp_path / "clip_2.mp4"
