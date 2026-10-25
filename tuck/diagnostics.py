from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import __version__
from .encoding.capabilities import get_encoder_capabilities
from .media_tools import find_ffmpeg, media_tool_environment
from .models import EncodePlan
from .models.cutting import CutPlan
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
            env=media_tool_environment(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        out = (result.stderr or result.stdout or "").strip()
        if not out:
            return "unknown"
        return out.splitlines()[0].strip()
    except Exception as exc:
        return f"unavailable ({sanitize_path(str(exc))})"


_PREVIEW_MODES = {
    "off": "built-in player",
    "surface": "native preview test picture",
    "engine": "native player clock only",
    "player": "native player",
}
_SOFTWARE_REASONS = {
    "no-device": "no GPU decoding device",
    "codec": "the GPU doesn't decode this codec",
    "start-failed": "the GPU decoder could not start",
    "stream": "the GPU can't decode this stream",
}
_SOUND_STATES = {"none", "playing", "unavailable"}
_MAX_TEXT = 300


@dataclass(frozen=True)
class PreviewReport:
    """The preview as the desktop shell reports it, checked field by field"""

    mode: str
    # what the run asked for, from Hardware playback or the developer switch
    requested: str = ""
    hardware_playback: bool | None = None
    # why the page plays the selected video in the built-in player instead
    video_fallback: str = ""
    library_loaded: bool | None = None
    library_interface: int | None = None
    library_error: str = ""
    video_open: bool = False
    decoder: str = ""
    hardware: bool = False
    software_reason: str = ""
    frame_rate: float = 0.0
    failed: bool = False
    error: str = ""
    sound_state: str = ""
    sound_underruns: int = 0
    sound_error: str = ""


def _text(value: object) -> str:
    return sanitize_path(value.strip()[:_MAX_TEXT]) if isinstance(value, str) else ""


def _count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def preview_report(value: object) -> PreviewReport | None:
    """Reads the page's copy of the shell's player report; anything malformed is left out"""
    if not isinstance(value, Mapping) or value.get("mode") not in _PREVIEW_MODES:
        return None
    fields: dict[str, Any] = {"mode": value["mode"]}
    requested = value.get("requested")
    if requested in _PREVIEW_MODES:
        fields["requested"] = requested
    hardware_playback = value.get("hardwarePlayback")
    if isinstance(hardware_playback, bool):
        fields["hardware_playback"] = hardware_playback
    fields["video_fallback"] = _text(value.get("videoFallback"))
    library = value.get("library")
    if isinstance(library, Mapping) and isinstance(library.get("loaded"), bool):
        fields["library_loaded"] = library["loaded"]
        fields["library_interface"] = _count(library.get("interface")) or None
        fields["library_error"] = _text(library.get("error"))
    status = value.get("status")
    video = status.get("video") if isinstance(status, Mapping) else None
    if isinstance(video, Mapping) and isinstance(video.get("decoder"), str):
        sound_value = video.get("sound")
        sound: Mapping[str, object] = sound_value if isinstance(sound_value, Mapping) else {}
        state = sound.get("state")
        reason = video.get("softwareReason")
        frame_rate = video.get("frameRate")
        fields.update(
            video_open=True,
            decoder=_text(video["decoder"]),
            hardware=video.get("hardware") is True,
            software_reason=reason
            if isinstance(reason, str) and reason in _SOFTWARE_REASONS
            else "",
            frame_rate=float(frame_rate)
            if isinstance(frame_rate, (int, float)) and not isinstance(frame_rate, bool)
            else 0.0,
            failed=video.get("failed") is True,
            error=_text(video.get("error")),
            sound_state=state if isinstance(state, str) and state in _SOUND_STATES else "",
            sound_underruns=_count(sound.get("underruns")),
            sound_error=_text(sound.get("error")),
        )
    elif isinstance(status, Mapping):
        fields["video_open"] = True
    return PreviewReport(**fields)


def _preview_mode(preview: PreviewReport) -> str:
    mode = _PREVIEW_MODES[preview.mode]
    if preview.mode != "off":
        return mode
    if preview.requested == "player":
        return f"{mode}, the native player library could not be used"
    if preview.hardware_playback is False:
        return f"{mode}, Hardware playback is off in Settings"
    return mode


def _preview_lines(preview: PreviewReport) -> list[str]:
    lines = ["Video preview", "-------------", f"preview: {_preview_mode(preview)}"]
    if preview.video_fallback:
        lines.append(
            f"this video: built-in player, the native player couldn't play it "
            f"({preview.video_fallback})"
        )
    if preview.library_loaded is not None:
        expected = f"interface {preview.library_interface}" if preview.library_interface else ""
        if preview.library_loaded:
            lines.append(f"player library: loaded{f' ({expected})' if expected else ''}")
        else:
            reason = preview.library_error or "unknown reason"
            lines.append(
                f"player library: not loaded, {reason}{f' (needs {expected})' if expected else ''}"
            )
    if preview.mode in ("engine", "player") and not preview.video_open:
        lines.append("video: none open")
    if preview.decoder:
        if preview.hardware:
            lines.append(f"decoder: {preview.decoder} (GPU)")
        else:
            why = _SOFTWARE_REASONS.get(preview.software_reason, "software")
            lines.append(f"decoder: {preview.decoder} ({why})")
        if preview.frame_rate > 0:
            lines.append(f"frame rate: {preview.frame_rate:g} fps")
        if preview.sound_state == "playing":
            lines.append(f"sound: playing, {preview.sound_underruns} underruns")
        elif preview.sound_state == "unavailable":
            lines.append(f"sound: can't play, {preview.sound_error or 'unknown reason'}")
        elif preview.sound_state == "none":
            lines.append("sound: none in this video")
        if preview.failed:
            lines.append(f"player error: {preview.error or 'unknown error'}")
    lines.append("")
    return lines


def _fmt_mb(num_bytes: int | float) -> str:
    return f"{float(num_bytes) / (1024 * 1024):.2f} MB"


def build_diagnostics(
    *,
    plan: EncodePlan | CutPlan | None = None,
    error: str = "",
    stderr: str = "",
    selected_encoder: str = "",
    resolved_encoder: str = "",
    encoder_fallback: str = "",
    workflow: str = "",
    profile_name: str = "",
    extra: dict[str, Any] | None = None,
    preview: PreviewReport | None = None,
) -> str:
    ffmpeg_path = find_ffmpeg() or ""
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
    if preview is not None:
        lines.extend(_preview_lines(preview))

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
        if encoder_fallback:
            lines.append(f"encoder fallback: {encoder_fallback}")
        if isinstance(plan, CutPlan):
            lines.extend(
                [
                    "operation: cut",
                    f"source: {sanitize_path(plan.source)}",
                    f"output: {sanitize_path(plan.output)}",
                    f"precision: {plan.precision}",
                    f"container: {plan.container}",
                    f"segments: {len(plan.segments)}",
                    f"selected duration: {float(plan.exported_duration.seconds):.3f}s",
                ]
            )
        elif plan is not None:
            lines.append(f"source: {sanitize_path(plan.source)}")
            lines.append(f"output: {sanitize_path(plan.output)}")
            lines.append(f"target size: {plan.target_size} bytes ({_fmt_mb(plan.target_size)})")
            lines.append(f"video bitrate: {plan.video_bitrate} bps")
            lines.append(f"audio bitrate: {plan.audio_bitrate} bps")
            lines.append(f"two-pass: {plan.two_pass}")
            lines.append(f"preset: {plan.preset}")
            lines.append(f"scaler: {plan.scaler}")
            lines.append(f"rate control: {plan.rate_control} / {plan.rate_control_method}")
            if plan.tone_map_hdr:
                lines.append("hdr: tone-mapped to SDR")
            lines.extend(f"plan warning: {warning}" for warning in plan.warnings)
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
