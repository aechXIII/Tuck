from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .encoding.capabilities import _find_ffmpeg, get_encoder_capabilities
from .models import EncodePlan
from .probe import is_ffprobe_available

_QUOTED_PATH_RE = re.compile(r"""(?i)(["'])(?:[a-z]:[\\/]|\\\\)[^"']*\1""")
_UNC_PATH_RE = re.compile(r"(?<!\w)\\\\.*")
_WIN_PATH_RE = re.compile(r"(?i)(?<!\w)[a-z]:[\\/].*")
_UNIX_PATH_RE = re.compile(r"(?<![\w/])/.*")


def sanitize_path(path: str | Path | None) -> str:
    if path is None:
        return ""
    text = str(path)
    text = _QUOTED_PATH_RE.sub("<path>", text)
    text = _UNC_PATH_RE.sub("<path>", text)
    text = _WIN_PATH_RE.sub("<path>", text)
    return _UNIX_PATH_RE.sub("<path>", text)


def _run_version(cmd: list[str]) -> str:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        out = (result.stderr or result.stdout or "").strip()
        if not out:
            return "unknown"
        return out.splitlines()[0].strip()
    except Exception as exc:
        return f"unavailable ({sanitize_path(str(exc))})"


def _fmt_mb(num_bytes: int | float) -> str:
    return f"{float(num_bytes) / (1024 * 1024):.2f} MB"


def build_diagnostics(
    *,
    plan: EncodePlan | None = None,
    error: str = "",
    stderr: str = "",
    selected_encoder: str = "",
    resolved_encoder: str = "",
    workflow: str = "",
    profile_name: str = "",
    extra: dict[str, Any] | None = None,
) -> str:
    ffmpeg_path = _find_ffmpeg() or ""
    caps = get_encoder_capabilities()
    packaged = bool(getattr(sys, "frozen", False) or hasattr(sys, "_MEIPACK"))

    lines: list[str] = [
        "Tuck diagnostics",
        "================",
        f"Tuck version: {__version__}",
        f"OS: {platform.system()} {platform.release()} ({platform.version()})",
        f"Architecture: {platform.machine()}",
        f"Python: {platform.python_version()}",
        f"Packaged build: {packaged}",
        "",
        "FFmpeg",
        "------",
        f"ffmpeg path: {sanitize_path(ffmpeg_path) if ffmpeg_path else 'not found'}",
        f"ffmpeg version: {_run_version([ffmpeg_path, '-version']) if ffmpeg_path else 'n/a'}",
        f"ffprobe available: {is_ffprobe_available()}",
        f"available encoders: {', '.join(sorted(caps.available)) or 'none'}",
        f"nvidia: {caps.has_nvidia} | amd: {caps.has_amd} | cpu: {caps.has_cpu}",
        "",
    ]

    has_context = bool(
        selected_encoder
        or resolved_encoder
        or workflow
        or profile_name
        or plan is not None
        or error
        or (extra and any(k != "queue_item_id" for k in extra))
    )
    if has_context:
        lines.extend(["Encode context", "--------------"])
        if profile_name:
            lines.append(f"profile: {profile_name}")
        if workflow:
            lines.append(f"workflow: {workflow}")
        if selected_encoder:
            lines.append(f"selected encoder: {selected_encoder}")
        if resolved_encoder:
            lines.append(f"effective encoder: {resolved_encoder}")
        if plan is not None:
            lines.append(f"source: {sanitize_path(plan.source)}")
            lines.append(f"output: {sanitize_path(plan.output)}")
            lines.append(f"target size: {plan.target_size} bytes ({_fmt_mb(plan.target_size)})")
            lines.append(f"video bitrate: {plan.video_bitrate} bps")
            lines.append(f"audio bitrate: {plan.audio_bitrate} bps")
            lines.append(f"two-pass: {plan.two_pass}")
            lines.append(f"preset: {plan.preset}")
            lines.append(f"scaler: {plan.scaler}")
            lines.append(f"rate control: {plan.rate_control} / {plan.rate_control_method}")
            segments = plan.effective_segments
            if len(segments) > 1:
                rendered = ", ".join(
                    f"{segment.start:.3f}s -> {segment.end:.3f}s" for segment in segments
                )
                lines.append(f"segments: {len(segments)} ({rendered})")
                lines.append(f"selected duration: {plan.effective_duration:.3f}s")
            elif plan.has_trim and segments:
                lines.append(
                    f"trim: {segments[0].start:.3f}s -> {segments[0].end:.3f}s "
                    f"({plan.effective_duration:.3f}s)"
                )
            else:
                lines.append("trim: full source")
            if plan.source_info is not None:
                info = plan.source_info
                lines.append(
                    f"media: {info.width}x{info.height} @ {info.fps:.2f}fps, "
                    f"{info.duration:.2f}s, codec={info.video_codec}"
                )
                if info.file_size:
                    lines.append(f"source size: {_fmt_mb(info.file_size)}")
        elif extra:
            if extra.get("source_name"):
                lines.append(f"source: {sanitize_path(extra['source_name'])}")
            if extra.get("target_size_mb") is not None:
                lines.append(f"target size: {extra['target_size_mb']} MB")
            if extra.get("resolution"):
                lines.append(f"resolution: {extra['resolution']}")
            if extra.get("fps") is not None:
                lines.append(f"fps: {extra['fps']}")
            if extra.get("two_pass") is not None:
                lines.append(f"two-pass: {extra['two_pass']}")
            if extra.get("preset"):
                lines.append(f"preset: {extra['preset']}")
            if extra.get("scaler"):
                lines.append(f"scaler: {extra['scaler']}")
            if extra.get("rate_control_method"):
                lines.append(f"rate control method: {extra['rate_control_method']}")
            if extra.get("keep_audio") is not None:
                lines.append(f"keep audio: {extra['keep_audio']}")
            if extra.get("audio_bitrate_kbps") is not None:
                lines.append(f"audio bitrate: {extra['audio_bitrate_kbps']} kbps")
            ts = extra.get("trim_start")
            te = extra.get("trim_end")
            segments = extra.get("segments")
            if isinstance(segments, list) and segments:
                rendered = ", ".join(
                    f"{segment.get('start')}s -> {segment.get('end')}s"
                    for segment in segments
                    if isinstance(segment, dict)
                )
                lines.append(f"segments: {len(segments)} ({rendered})")
                if extra.get("selected_duration") is not None:
                    lines.append(f"selected duration: {extra['selected_duration']}s")
            elif ts is not None or te is not None:
                lines.append(f"trim: {ts}s -> {te}s")
        if extra:
            if extra.get("queue_state"):
                lines.append(f"queue state: {extra['queue_state']}")
            if extra.get("queue_item_id"):
                lines.append(f"queue item: {extra['queue_item_id']}")
        lines.append("")

    if error:
        lines.extend(["Error", "-----", sanitize_path(error.strip()), ""])

    if stderr:
        cleaned = "\n".join(sanitize_path(line) for line in stderr.strip().splitlines()[-60:])
        lines.extend(["Recent FFmpeg output", "--------------------", cleaned, ""])

    if not error and not stderr and plan is None:
        lines.extend(
            [
                "Note",
                "----",
                "No failed job or encode plan was attached.",
                "Use Diagnostics on a failed queue item for the most useful report,",
                "or copy this after a failure so error and FFmpeg output are included.",
                "",
            ]
        )

    lines.append("Paths above are sanitized to avoid sharing personal directory names.")
    return "\n".join(lines).rstrip() + "\n"
