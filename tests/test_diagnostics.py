from pathlib import Path

import pytest

from tuck.diagnostics import _run_version, build_diagnostics, preview_report, sanitize_path
from tuck.models import EncodePlan, Segment, VideoInfo


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

    def test_multi_segment_plan_reports_ranges_and_summed_duration(self):
        plan = EncodePlan(
            source=r"C:\Users\Bob\clip.mp4",
            output=r"C:\Users\Bob\out.mp4",
            segments=[Segment(0.5, 1.5), Segment(4, 6.25)],
            source_info=VideoInfo(
                path=r"C:\Users\Bob\clip.mp4",
                duration=10,
                width=1280,
                height=720,
                fps=30,
                video_codec="h264",
            ),
        )
        text = build_diagnostics(plan=plan)
        assert "segments: 2" in text
        assert "0.500s -> 1.500s" in text
        assert "4.000s -> 6.250s" in text
        assert "selected duration: 3.250s" in text
        assert "trim: 0.500s -> 6.250s" not in text

    def test_includes_encoder_fallback_and_plan_warnings(self):
        plan = EncodePlan(
            source="clip.mp4",
            output="out.mp4",
            video_encoder="auto",
            tone_map_hdr=True,
            warnings=["Subtitles aren't kept when the video is cut into several parts."],
        )
        text = build_diagnostics(
            plan=plan,
            resolved_encoder="libx264",
            encoder_fallback="Used software encoding because the NVIDIA encoder couldn't start",
        )
        assert "effective encoder: libx264" in text
        assert "encoder fallback: Used software encoding" in text
        assert "hdr: tone-mapped to SDR" in text
        assert "plan warning: Subtitles aren't kept when the video is cut" in text


class TestPreviewReport:
    def _report(self, **video: object) -> dict:
        return {
            "mode": "player",
            "library": {"loaded": True, "interface": 8, "error": ""},
            "status": {
                "video": {
                    "decoder": "h264 vaapi",
                    "hardware": True,
                    "softwareReason": None,
                    "frameRate": 60,
                    "failed": False,
                    "error": "",
                    "sound": {"state": "playing", "underruns": 2, "error": ""},
                    **video,
                }
            },
        }

    def test_the_native_player_section_names_decoder_sound_and_library(self):
        text = build_diagnostics(preview=preview_report(self._report()))
        assert "preview: native player" in text
        assert "player library: loaded (interface 8)" in text
        assert "decoder: h264 vaapi (GPU)" in text
        assert "frame rate: 60 fps" in text
        assert "sound: playing, 2 underruns" in text

    def test_software_decoding_says_why(self):
        report = self._report(decoder="h264 software", hardware=False, softwareReason="no-device")
        text = build_diagnostics(preview=preview_report(report))
        assert "decoder: h264 software (no GPU decoding device)" in text

    def test_a_library_that_did_not_load_says_why(self):
        report = {
            "mode": "player",
            "library": {
                "loaded": False,
                "interface": 8,
                "error": "The native player library is from another Tuck version.",
            },
            "status": None,
        }
        text = build_diagnostics(preview=preview_report(report))
        assert (
            "player library: not loaded, The native player library is from another Tuck "
            "version. (needs interface 8)"
        ) in text
        assert "video: none open" in text

    def test_the_built_in_player_gets_one_line(self):
        text = build_diagnostics(preview=preview_report({"mode": "off"}))
        assert "Video preview\n-------------\npreview: built-in player\n" in text

    def test_page_values_are_checked_and_paths_hidden(self):
        report = self._report(
            softwareReason="<script>",
            failed=True,
            error="Could not read /home/alice/Videos/clip.mp4",
            sound={"state": "loud", "underruns": -4, "error": ""},
        )
        parsed = preview_report(report)
        assert parsed is not None
        assert parsed.software_reason == ""
        assert parsed.sound_state == "" and parsed.sound_underruns == 0
        text = build_diagnostics(preview=parsed)
        assert "alice" not in text and "player error: Could not read <path>" in text
        assert preview_report({"mode": "native"}) is None
        assert preview_report("player") is None
