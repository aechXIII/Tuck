from __future__ import annotations

import re
from collections import deque

from ..models.progress import EncodeProgress, EncodeStage

_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")
_SPEED_RE = re.compile(r"speed=\s*([0-9.]+)x")


def parse_ffmpeg_time(line: str) -> float | None:
    m = _TIME_RE.search(line)
    if not m:
        return None
    h, mn, s = m.groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)


def parse_ffmpeg_speed(line: str) -> float | None:
    m = _SPEED_RE.search(line)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


class ProgressTracker:
    def __init__(
        self,
        duration: float,
        *,
        total_passes: int = 1,
        retry_number: int | None = None,
        max_retries: int | None = None,
        window: int = 8,
    ) -> None:
        self.duration = max(0.0, float(duration))
        self.total_passes = max(1, int(total_passes))
        self.retry_number = retry_number
        self.max_retries = max_retries
        self.pass_number = 1
        self.stage = EncodeStage.ENCODING
        self._samples: deque[float] = deque(maxlen=max(3, window))
        self._last_percent = 0.0
        self._last_time = 0.0
        self._last_speed: float | None = None
        self._record_time: float | None = None
        self._record_speed: float | None = None

    def set_pass(self, pass_number: int) -> None:
        self.pass_number = max(1, int(pass_number))
        if self.total_passes > 1:
            self.stage = EncodeStage.PASS_1 if self.pass_number == 1 else EncodeStage.PASS_2
            if self.pass_number > 1:
                self._last_percent = max(self._last_percent, 50.0)
        else:
            self.stage = EncodeStage.ENCODING

    def update_from_line(self, line: str) -> EncodeProgress | None:
        key, _, value = line.strip().partition("=")
        if key == "out_time_us":
            try:
                self._record_time = int(value) / 1_000_000
            except ValueError:
                self._record_time = None
            return None
        if key == "speed":
            self._record_speed = parse_ffmpeg_speed(line)
            return None
        if key in ("out_time", "out_time_ms"):
            return None
        if key == "progress" and value in ("continue", "end"):
            current, speed = self._record_time, self._record_speed
            self._record_time = None
            self._record_speed = None
            return self.update(current, speed=speed) if current is not None else None
        current = parse_ffmpeg_time(line)
        if current is None:
            return None
        speed = parse_ffmpeg_speed(line)
        if speed is not None:
            self._last_speed = speed
        return self.update(current, speed=self._last_speed)

    def update(self, current_time: float, speed: float | None = None) -> EncodeProgress:
        current_time = max(0.0, float(current_time))
        self._last_time = current_time
        if speed is not None and speed > 0:
            self._last_speed = speed
            self._samples.append(speed)

        pass_frac = 0.0
        if self.duration > 0:
            pass_frac = min(current_time / self.duration, 1.0)

        if self.total_passes <= 1:
            percent = pass_frac * 100.0
        elif self.pass_number <= 1:
            percent = pass_frac * 50.0
        else:
            percent = 50.0 + pass_frac * 50.0

        if percent < self._last_percent:
            percent = self._last_percent
        self._last_percent = percent

        eta = self._estimate_eta(pass_frac)
        if self.total_passes > 1:
            self.stage = EncodeStage.PASS_1 if self.pass_number == 1 else EncodeStage.PASS_2
        else:
            self.stage = EncodeStage.ENCODING

        return EncodeProgress(
            percent=min(percent, 100.0),
            stage=self.stage,
            current_time=current_time,
            duration=self.duration,
            speed=self._last_speed,
            eta_seconds=eta,
            pass_number=self.pass_number,
            total_passes=self.total_passes,
            retry_number=self.retry_number,
            max_retries=self.max_retries,
        )

    def snapshot(self, message: str = "", percent: float | None = None) -> EncodeProgress:
        pct = self._last_percent if percent is None else percent
        return EncodeProgress(
            percent=min(max(pct, 0.0), 100.0),
            stage=self.stage,
            current_time=self._last_time,
            duration=self.duration,
            speed=self._last_speed,
            eta_seconds=self._estimate_eta(
                (self._last_time / self.duration) if self.duration > 0 else 0.0
            ),
            pass_number=self.pass_number,
            total_passes=self.total_passes,
            retry_number=self.retry_number,
            max_retries=self.max_retries,
            message=message,
        )

    def _estimate_eta(self, pass_frac: float) -> float | None:
        if self.duration <= 0:
            return None
        avg_speed = self._avg_speed()
        if avg_speed is None or avg_speed <= 0:
            return None

        remaining_in_pass = max(0.0, self.duration * (1.0 - min(pass_frac, 1.0)))
        remaining_passes = max(0, self.total_passes - self.pass_number)
        remaining_total = remaining_in_pass + remaining_passes * self.duration
        return remaining_total / avg_speed

    def _avg_speed(self) -> float | None:
        if self._samples:
            return sum(self._samples) / len(self._samples)
        return self._last_speed
