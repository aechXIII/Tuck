"""Generate temporary video and audio fixtures for cut regression tests."""

from __future__ import annotations

import os
import shutil
import subprocess
import wave
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class MediaTools:
    ffmpeg: str
    ffprobe: str

    def run(
        self, arguments: list[str], *, probe: bool = False
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [self.ffprobe if probe else self.ffmpeg, *arguments],
            capture_output=True,
            check=True,
            timeout=120,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )


def find_tools() -> MediaTools | None:
    ffmpeg = os.environ.get("TUCK_CUT_FFMPEG") or shutil.which("ffmpeg")
    ffprobe = os.environ.get("TUCK_CUT_FFPROBE") or shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        return None
    return MediaTools(ffmpeg, ffprobe)


def create_source(
    tools: MediaTools,
    path: Path,
    *,
    duration: Fraction | int = 12,
    audio: bool = True,
    rate: str = "30",
    gop: int = 60,
    b_frames: int = 3,
    offset: int = 0,
    variant: str = "closed",
) -> Path:
    args = [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size=160x96:rate={rate}:duration={float(duration)}",
    ]
    if audio:
        wav = path.with_suffix(".wav")
        write_markers(wav, duration)
        args += ["-i", str(wav)]
    if variant == "subtitle":
        subtitle = path.with_suffix(".srt")
        subtitle.write_text(
            "1\n00:00:01,000 --> 00:00:03,000\nRetain this subtitle\n", encoding="utf-8"
        )
        args += ["-i", str(subtitle)]
    args += ["-map", "0:v:0"]
    if audio:
        args += ["-map", "1:a:0"]
    if variant == "multiple_audio":
        args += ["-map", "1:a:0"]
    if variant == "subtitle":
        args += ["-map", "2:s:0", "-c:s", "mov_text"]
    args += [
        "-c:v",
        "libx265" if variant == "hevc" else "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-g",
        str(gop),
        "-keyint_min",
        str(gop),
        "-sc_threshold",
        "0",
        "-bf",
        str(b_frames),
    ]
    if variant == "hevc":
        args += ["-x265-params", "log-level=error:pools=1:frame-threads=1:open-gop=0"]
    else:
        args += ["-x264-params", f"open-gop={int(variant == 'open_gop')}:b-adapt=0"]
    args += ["-pix_fmt", "yuv420p10le" if variant == "hdr" else "yuv420p"]
    if variant == "hdr":
        args += ["-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"]
    if variant == "vfr":
        args += ["-vf", "select=not(eq(mod(n\\,3)\\,1))", "-fps_mode", "vfr"]
    if offset:
        args += ["-output_ts_offset", str(offset)]
    if audio:
        args += ["-c:a", "aac"]
    tools.run([*args, str(path)])
    return path


def write_markers(path: Path, duration: Fraction | int) -> None:
    """Distinct short chirps at known source times, including either side of GOP edges."""
    sample_rate = 48000
    values = np.zeros(round(duration * sample_rate), dtype=np.float64)
    chirp_time = np.arange(288) / sample_rate
    for second in range(int(duration) + 1):
        for marker_index, fraction in enumerate((0, 0.03, 0.125, 0.47, 0.97)):
            start = round((second + fraction) * sample_rate)
            stop = min(start + len(chirp_time), len(values))
            if stop <= start:
                continue
            frequency = 800 + second * 17 + marker_index * 311
            tone = np.sin(2 * np.pi * (frequency * chirp_time + 20000 * chirp_time**2))
            values[start:stop] += tone[: stop - start] * np.hanning(len(chirp_time))[: stop - start]
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
        output.writeframes((np.clip(values, -1, 1) * 22000).astype("<i2").tobytes())
