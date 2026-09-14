from tuck.encoding.progress import ProgressTracker, parse_ffmpeg_speed, parse_ffmpeg_time
from tuck.models import EncodeProgress, EncodeStage


class TestParseFFmpegProgress:
    def test_parse_time(self):
        assert parse_ffmpeg_time("frame=10 fps=30 time=00:01:02.50 bitrate=1000kbits/s") == 62.5

    def test_parse_time_missing(self):
        assert parse_ffmpeg_time("frame=10 fps=30") is None

    def test_parse_speed(self):
        assert parse_ffmpeg_speed("speed=1.40x") == 1.4
        assert parse_ffmpeg_speed("speed=  2.00x") == 2.0

    def test_parse_speed_missing(self):
        assert parse_ffmpeg_speed("frame=1") is None


class TestEncodeProgressModel:
    def test_status_pass(self):
        p = EncodeProgress(stage=EncodeStage.PASS_1, pass_number=1, total_passes=2)
        assert p.status_text() == "Pass 1 of 2"

    def test_status_retry(self):
        p = EncodeProgress(
            stage=EncodeStage.RETRYING,
            retry_number=2,
            max_retries=3,
            message="Verifying target size",
        )
        assert "Attempt 2 of 3" in p.status_text()

    def test_to_dict(self):
        d = EncodeProgress(percent=63.333, stage=EncodeStage.ENCODING, speed=1.4).to_dict()
        assert d["percent"] == 63.3
        assert d["stage"] == "encoding"
        assert d["speed"] == 1.4
        assert "status_text" in d


class TestProgressTracker:
    def test_single_pass_percent(self):
        t = ProgressTracker(100.0, total_passes=1)
        p = t.update(50.0, speed=1.0)
        assert p.percent == 50.0
        assert p.stage == EncodeStage.ENCODING

    def test_two_pass_percent(self):
        t = ProgressTracker(100.0, total_passes=2)
        t.set_pass(1)
        p1 = t.update(50.0, speed=2.0)
        assert p1.percent == 25.0
        assert p1.stage == EncodeStage.PASS_1
        t.set_pass(2)
        p2 = t.update(50.0, speed=2.0)
        assert p2.percent == 75.0
        assert p2.stage == EncodeStage.PASS_2

    def test_trimmed_duration(self):
        t = ProgressTracker(10.0, total_passes=1)
        p = t.update(5.0, speed=1.0)
        assert p.percent == 50.0
        assert p.duration == 10.0
        assert p.eta_seconds is not None

    def test_summed_segment_duration_controls_progress(self):
        selected_duration = (1.5 - 0.5) + (6.0 - 4.0)
        tracker = ProgressTracker(selected_duration, total_passes=1)
        progress = tracker.update(1.5, speed=1.0)
        assert progress.percent == 50.0
        assert progress.duration == 3.0

    def test_monotonic_percent(self):
        t = ProgressTracker(100.0)
        t.update(80.0)
        p = t.update(10.0)
        assert p.percent == 80.0


def test_progress_records_update_time_speed_and_eta_together():
    tracker = ProgressTracker(20, total_passes=2)
    for line in (
        "frame=300",
        "out_time_us=10000000",
        "out_time_ms=10000000",
        "out_time=00:00:10.000000",
        "speed=2.0x",
    ):
        assert tracker.update_from_line(line) is None
    progress = tracker.update_from_line("progress=continue")
    assert progress is not None
    assert progress.percent == 25
    assert progress.speed == 2
    assert progress.eta_seconds == 15
    tracker.set_pass(2)
    tracker.update_from_line("out_time_us=20000000")
    tracker.update_from_line("speed=1.0x")
    progress = tracker.update_from_line("progress=end")
    assert progress is not None
    assert progress.percent == 100
    assert progress.eta_seconds == 0


def test_progress_records_ignore_missing_and_invalid_timestamps():
    tracker = ProgressTracker(20)
    for value in ("N/A", "invalid", "inf"):
        assert tracker.update_from_line(f"out_time_us={value}") is None
        assert tracker.update_from_line("progress=continue") is None
    tracker.update_from_line("out_time_us=-1000")
    progress = tracker.update_from_line("progress=continue")
    assert progress is not None
    assert progress.percent == 0


def test_second_pass_starts_halfway_before_ffmpeg_reports_progress():
    tracker = ProgressTracker(10, total_passes=2)
    tracker.set_pass(2)
    assert tracker.snapshot().percent == 50
