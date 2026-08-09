from pathlib import Path

import pytest

from tuck.diagnostics import _run_version, build_diagnostics, sanitize_path
from tuck.models import EncodePlan, VideoInfo


class TestSanitizePath:
    def test_windows_user_path(self):
        out = sanitize_path(r"C:\Users\Alice\Videos\clip.mp4")
        assert "Alice" not in out
        assert "<path>" in out
        assert out == "<path>"

    def test_home_path(self):
        home = Path.home()
        out = sanitize_path(str(home / "Videos" / "x.mp4"))
        assert out == "<path>"
        assert str(home) not in out

    def test_empty(self):
        assert sanitize_path(None) == ""
        assert sanitize_path("") == ""

    def test_non_home_absolute_path(self):
        out = sanitize_path(r"Cannot read D:\Client\Project\clip.mp4")
        assert "D:\\Client" not in out
        assert "<path>" in out

    def test_unc_path(self):
        out = sanitize_path(r"Cannot read \\server\private\clip.mp4")
        assert "server" not in out
        assert "<path>" in out

    @pytest.mark.parametrize(
        "path",
        [r"file:C:\Users\Alice\clip.mp4", "file:/home/alice/private/clip.mp4"],
    )
    def test_uri_path(self, path):
        out = sanitize_path(path)
        assert "Alice" not in out
        assert "alice" not in out
        assert "<path>" in out

    @pytest.mark.parametrize(
        "path",
        [
            r"C:\Users\Alice Smith\Videos\clip.mp4",
            "/home/Alice Smith/Videos/clip.mp4",
            r"\\server\private share\Alice\clip.mp4",
        ],
    )
    def test_absolute_path_with_spaces(self, path):
        out = sanitize_path(f"Cannot read {path}")
        assert "Alice" not in out
        assert "<path>" in out


class TestVersionDiagnostics:
    def test_sanitizes_version_command_exception(self, monkeypatch):
        def fail(*args, **kwargs):
            raise OSError(r"Cannot execute C:\\Users\\Alice\\ffmpeg.exe")

        monkeypatch.setattr("tuck.diagnostics.subprocess.run", fail)
        text = _run_version(["ffmpeg", "-version"])
        assert "Alice" not in text
        assert "<path>" in text


class TestBuildDiagnostics:
    def test_includes_version_and_os(self):
        text = build_diagnostics(error="encode failed")
        assert "Tuck version:" in text
        assert "OS:" in text
        assert "encode failed" in text
        assert "PATH=" not in text
        assert "SECRET" not in text
        assert "Packaged build:" in text

    def test_note_when_no_failure_context(self):
        text = build_diagnostics()
        assert "No failed job or encode plan was attached" in text

    def test_sanitizes_error_path(self):
        text = build_diagnostics(error=r"Cannot read C:\Users\Bob\Videos\clip.mp4")
        assert "Bob" not in text
        assert "<path>" in text

    def test_sanitizes_paths_in_ffmpeg_output(self):
        text = build_diagnostics(stderr="open '/mnt/client/secret/clip.mp4' failed")
        assert "/mnt/client" not in text
        assert "<path>" in text

    def test_sanitizes_extra_source_name(self):
        text = build_diagnostics(extra={"source_name": r"C:\Users\Alice\Videos\clip.mp4"})
        assert "Alice" not in text
        assert "<path>" in text

    def test_includes_plan_and_trim(self):
        plan = EncodePlan(
            source=r"C:\Users\Bob\clip.mp4",
            output=r"C:\Users\Bob\out.mp4",
            target_size=10 * 1024 * 1024,
            video_bitrate=1_000_000,
            audio_bitrate=128_000,
            trim_start=1.5,
            trim_end=8.25,
            source_info=VideoInfo(
                path=r"C:\Users\Bob\clip.mp4",
                duration=10.0,
                width=1280,
                height=720,
                fps=30.0,
                video_codec="h264",
            ),
        )
        text = build_diagnostics(
            plan=plan,
            selected_encoder="auto",
            resolved_encoder="libx264",
            workflow="compression",
            profile_name="Discord Free",
            stderr="line1\n" + ("x" * 100),
        )
        assert "trim:" in text
        assert "1.500s" in text
        assert "Bob" not in text
        assert "effective encoder: libx264" in text
        assert "Discord Free" in text
        assert "Recent FFmpeg output" in text
