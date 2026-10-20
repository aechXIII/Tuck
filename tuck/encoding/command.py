from __future__ import annotations

import math
import os
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from struct import pack
from typing import TYPE_CHECKING

from ..audio_mix import ClipPiece, audible_clips, clip_pieces, clip_placements
from ..models import (
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    AudioClip,
    AudioTrack,
    EncodePlan,
    Segment,
    SourceAudioTrack,
    TimelineAudioPiece,
    audio_independent_from_pieces,
    positioned_frame_ranges,
    segment_timeline_duration,
    source_audio_output_pieces,
)
from ..models.encoding_policy import (
    AMF_ENCODERS,
    CPU_ENCODERS,
    NVENC_ENCODERS,
    VAAPI_ENCODERS,
    native_preset_for_encoder,
)
from . import filters as _filters
from .filters import build_plan_video_filters, join_video_filters

if TYPE_CHECKING:
    from .frame_blending import TmixBlend
    from .hardware_decoding import HardwareDecode
    from .vaapi import VaapiEncodeDevice

scaler_to_ffmpeg_flag = _filters.scaler_to_ffmpeg_flag


def _source_audio(track: int) -> str:
    # tracks are always mapped by number; left to itself FFmpeg would pick the one with the
    # most channels and drop the rest
    return f"0:a:{track}"


def fmt_ffmpeg_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    return f"{seconds:.3f}"


def _segment_atrim(
    graph_parts: list[str],
    segment: Segment,
    label: str,
    *,
    stream: str,
    preserve_offset: bool = False,
) -> None:
    start = fmt_ffmpeg_time(segment.start)
    end = fmt_ffmpeg_time(segment.end)
    if preserve_offset:
        duration = fmt_ffmpeg_time(segment.duration)
        graph_parts.append(
            f"[{stream}]atrim=start={start}:end={end},asetpts=PTS-{start}/TB,"
            f"aresample=async=1:first_pts=0,apad=whole_dur={duration},"
            f"atrim=duration={duration}[{label}]"
        )
    else:
        graph_parts.append(f"[{stream}]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[{label}]")


def _source_audio_chain(
    graph_parts: list[str],
    plan: EncodePlan,
    segments: list[Segment],
    source_pieces: list[TimelineAudioPiece],
    *,
    track: SourceAudioTrack,
    position: int,
    audio_independent: bool,
    blending: bool,
    output_duration: str,
) -> list[str]:
    """One source audio track with the timeline's source audio edits, as labels to mix"""
    stream = _source_audio(track.index)
    # the first output track keeps the plain labels; the others are told apart by a prefix
    prefix = f"t{position}" if position else ""
    mix_inputs: list[str] = []
    if audio_independent:
        for piece in source_pieces:
            filters = [
                f"atrim=start={fmt_ffmpeg_time(piece.source_start)}:"
                f"end={fmt_ffmpeg_time(piece.source_end)}",
                "asetpts=PTS-STARTPTS",
            ]
            if blending:
                # retain silence before delayed source audio on the shared video clock
                filters[-1] = f"asetpts=PTS-{fmt_ffmpeg_time(piece.source_start)}/TB"
                filters.append("aresample=async=1:first_pts=0")
            if abs(track.gain_db) > 1e-9:
                filters.append(f"volume={track.gain_db:.2f}dB")
            filters.extend(
                [
                    f"adelay={max(0, round(piece.output_start * 1000))}:all=1",
                    "asetpts=N/SR/TB",
                    f"apad=whole_dur={output_duration}",
                    f"atrim=duration={output_duration}",
                ]
            )
            mix_label = f"{prefix}mix{len(mix_inputs)}"
            graph_parts.append(f"[{stream}]{','.join(filters)}[{mix_label}]")
            mix_inputs.append(f"[{mix_label}]")
        return mix_inputs

    source_audio_inputs: list[str] = []
    for index, segment in enumerate(segments):
        _segment_atrim(
            graph_parts,
            segment,
            f"{prefix}sa{index}",
            stream=stream,
            preserve_offset=blending,
        )
        source_audio_inputs.append(f"[{prefix}sa{index}]")
    if not source_audio_inputs:
        graph_parts.append(f"[{stream}]asetpts=PTS-STARTPTS[{prefix}sa0]")
        source_audio_inputs.append(f"[{prefix}sa0]")
    source_audio_label = f"{prefix}sa0"
    if len(source_audio_inputs) > 1:
        graph_parts.append(
            "".join(source_audio_inputs)
            + f"concat=n={len(source_audio_inputs)}:v=0:a=1[{prefix}sacat]"
        )
        source_audio_label = f"{prefix}sacat"
    source_filters: list[str] = []
    if abs(track.gain_db) > 1e-9:
        source_filters.append(f"volume={track.gain_db:.2f}dB")
    source_filters.extend(
        [
            f"apad=whole_dur={output_duration}",
            f"atrim=duration={output_duration}",
        ]
    )
    graph_parts.append(f"[{source_audio_label}]{','.join(source_filters)}[{prefix}mix0]")
    return [f"[{prefix}mix0]"]


def _mix_to(graph_parts: list[str], mix_inputs: list[str], label: str) -> None:
    if len(mix_inputs) == 1:
        graph_parts.append(f"{mix_inputs[0]}anull[{label}]")
    else:
        graph_parts.append(
            "".join(mix_inputs) + f"amix=inputs={len(mix_inputs)}:duration=longest:"
            f"dropout_transition=0:normalize=0[{label}]"
        )


def _place_video(graph_parts: list[str], segments: list[Segment], fps: float) -> list[str]:
    # tmix produces only occupied frames; restore their shared project slots
    result = [part.replace("[vout]", "[vjoined]") for part in graph_parts]
    ranges = [(first, count) for first, count in positioned_frame_ranges(segments, fps) if count]
    frames = sum(count for _, count in ranges)
    # concat can end before its last numbered frame when a short piece loses its duration
    result.append(
        f"[vjoined]settb=1/{fps:.9f},setpts=N,tpad=stop_mode=clone:stop=1,"
        f"fps={fps:.9f}:eof_action=pass,trim=end_frame={frames}[placed_grid]"
    )
    count = len(ranges)
    if count > 1:
        result.append(f"[placed_grid]split={count}" + "".join(f"[place{i}]" for i in range(count)))
    source_cursor = 0
    project_cursor = 0
    total_frames = math.ceil(segment_timeline_duration(segments) * fps - 1e-8)
    for index, (first, frames) in enumerate(ranges):
        label = f"place{index}" if count > 1 else "placed_grid"
        filters = (
            f"trim=start_frame={source_cursor}:end_frame={source_cursor + frames},"
            f"settb=1/{fps:.9f},setpts=N"
        )
        gap = max(0, first - project_cursor)
        if gap:
            filters += f",tpad=start={gap}:start_mode=add:color=black"
        if index == count - 1 and first + frames < total_frames:
            filters += f",tpad=stop={total_frames - first - frames}:stop_mode=add:color=black"
        result.append(f"[{label}]{filters}[placed{index}]")
        source_cursor += frames
        project_cursor = first + frames
    labels = "".join(f"[placed{i}]" for i in range(count))
    result.append(labels + (f"concat=n={count}:v=1:a=0" if count > 1 else "null") + "[placed_cat]")
    result.append(f"[placed_cat]settb=1/{fps:.9f},setpts=N[vout]")
    return result


def _placed_source_video_graph(plan: EncodePlan, filters: list[str], fps: float) -> list[str]:
    parts = []
    labels = []
    cursor = 0
    rate = Fraction(fps).limit_denominator(100_000)
    clock = f"settb={rate.denominator}/{rate.numerator},setpts=N"
    ranges = positioned_frame_ranges(plan.effective_segments, fps)
    last = max((index for index, (_, count) in enumerate(ranges) if count), default=-1)
    total_frames = math.ceil(plan.effective_duration * fps - 1e-8)
    for index, (segment, (first, count)) in enumerate(
        zip(plan.effective_segments, ranges, strict=True)
    ):
        if not count:
            continue
        at = segment.timeline_start
        if at is None:
            raise ValueError("Placed video requires timeline_start on every segment")
        # sample on the project grid before joining, so every source edge keeps its phase
        chain = (
            f"trim=start={segment.start:.9f}:end={segment.end:.9f},"
            f"setpts=PTS-({segment.start:.9f}-{at:.9f})/TB,"
            f"fps={rate.numerator}/{rate.denominator}:start_time={first / fps:.9f}:eof_action=pass,"
            f"{clock},tpad=stop_mode=clone:stop={count},trim=end_frame={count}"
        )
        if first > cursor:
            chain += f",tpad=start={first - cursor}:start_mode=add:color=black"
        if index == last and first + count < total_frames:
            chain += f",tpad=stop={total_frames - first - count}:stop_mode=add:color=black"
        parts.append(f"[0:v]{chain}[placed_source{index}]")
        labels.append(f"[placed_source{index}]")
        cursor = first + count
    if not labels:
        count = max(1, math.ceil(plan.effective_duration * fps - 1e-8))
        parts.append(
            f"[0:v]trim=end_frame=1,{clock},drawbox=color=black:t=fill,"
            f"tpad=stop_mode=clone:stop={count},trim=end_frame={count}[placed_black]"
        )
        labels.append("[placed_black]")
    if len(labels) > 1:
        parts.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[placed_joined]")
        joined = "[placed_joined]"
    else:
        joined = labels[0]
    parts.append(
        joined + clock + "," + (join_video_filters(filters) if filters else "null") + "[vout]"
    )
    return parts


def _imported_clip_filters(
    plan: EncodePlan,
    clip: AudioClip,
    piece: ClipPiece,
    output_duration: str,
) -> list[str]:
    local_offset = piece.local_offset
    piece_duration = piece.duration
    if clip.loop:
        loop_samples = max(
            1,
            round(clip.source_duration * max(1, plan.audio_sample_rate)),
        )
        filters = [
            f"atrim=start={fmt_ffmpeg_time(clip.source_in)}:end={fmt_ffmpeg_time(clip.source_out)}",
            "asetpts=PTS-STARTPTS",
            f"aresample={max(1, plan.audio_sample_rate)}",
            f"aloop=loop=-1:size={loop_samples}",
            f"atrim=start={fmt_ffmpeg_time(local_offset)}:duration={fmt_ffmpeg_time(piece_duration)}",
            "asetpts=PTS-STARTPTS",
        ]
    else:
        filters = [
            f"atrim=start={fmt_ffmpeg_time(clip.source_in + local_offset)}:"
            f"duration={fmt_ffmpeg_time(piece_duration)}",
            "asetpts=PTS-STARTPTS",
        ]
    if abs(piece.gain_db) > 1e-9:
        filters.append(f"volume={piece.gain_db:.2f}dB")
    fade_in = piece.fade_in
    fade_out = piece.fade_out
    if fade_in > 0:
        filters.append(f"afade=t=in:st=0:d={fmt_ffmpeg_time(min(fade_in, piece_duration))}")
    if fade_out > 0:
        fade_start = max(0.0, piece_duration - fade_out)
        filters.append(
            f"afade=t=out:st={fmt_ffmpeg_time(fade_start)}:d="
            f"{fmt_ffmpeg_time(min(fade_out, piece_duration))}"
        )
    filters.extend(
        [
            f"adelay={max(0, round(piece.output_start * 1000))}:all=1",
            f"apad=whole_dur={output_duration}",
            f"atrim=duration={output_duration}",
        ]
    )
    return filters


_NVENC_PRESET_MAP: dict[str, str] = {
    "ultrafast": "p1",
    "superfast": "p2",
    "veryfast": "p3",
    "faster": "p3",
    "fast": "p4",
    # matches the Balanced speed the app offers for NVENC
    "medium": "p5",
    "slow": "p6",
    "slower": "p7",
    "veryslow": "p7",
}


def nvenc_preset(preset: str) -> str:
    return (
        preset
        if preset in {"p1", "p2", "p3", "p4", "p5", "p6", "p7"}
        else _NVENC_PRESET_MAP.get(preset, "p5")
    )


def _tmix_time(seconds: Fraction) -> str:
    # halfway between source frames, so millisecond rounding cannot move a frame
    return f"{max(0.0, float(seconds)):.6f}"


def can_hardware_decode_blend(plan: EncodePlan, blend: TmixBlend | None) -> bool:
    """Support for an NV12 download; GPU availability is checked separately."""
    info = plan.source_info
    return bool(
        blend is not None
        and (blend.weighted or len(blend.pieces) == 1)
        and len(plan.effective_segments) == 1
        and info is not None
        and info.video_codec == "av1"
        and info.pixel_format == "yuv420p"
        and not info.is_hdr
        and info.display_rotation == 0
        and not build_plan_video_filters(replace(plan, apply_fps_filter=False))
    )


def _tmix_graph(
    blend: TmixBlend, video_filters: list[str], *, download: bool = False, positioned: bool = False
) -> list[str]:
    """Blend the selected source pictures, then join segments on the output clock."""
    if blend.weighted:
        return _weighted_mix_graph(blend, video_filters, download=download)
    rate = blend.rate
    parts: list[str] = []
    labels: list[str] = []
    for index, piece in enumerate(blend.pieces):
        count = len(piece.weights)
        weights = " ".join(format(float(weight), ".9g") for weight in piece.weights)
        # FFmpeg parses weights as float32; nearly equal text can select its uniform fast mode
        parsed_weights = {pack("f", float(weight)) for weight in weights.split()}
        # uniform tmix rounds halves up, while mix rounds to even; odd unit sums have no ties
        same_rounding = len(parsed_weights) > 1 or (
            count % 2 == 1 and parsed_weights == {pack("f", 1.0)}
        )
        clock = [f"settb={rate.denominator}/{rate.numerator}", "setpts=N"]
        chain = (["hwdownload", "format=nv12"] if download else []) + [
            f"trim=start={_tmix_time(piece.start)}:end={_tmix_time(piece.end)}",
            "setpts=PTS-STARTPTS",
        ]
        source = "[0:v]"
        if count > 1 and piece.step > 1 and same_rounding:
            samples = [f"blend{index}_sample{offset}" for offset in range(count)]
            selected = [f"blend{index}_selected{offset}" for offset in range(count)]
            # tmix fills its initial window with the first picture, including partial windows
            chain += [f"tpad=start={count - 1}:start_mode=clone", f"split={count}"]
            parts.append(source + ",".join(chain) + "".join(f"[{label}]" for label in samples))
            for offset, (sample, output) in enumerate(zip(samples, selected, strict=True)):
                first, last = piece.first + offset, piece.last + offset
                selection = (
                    f"select='between(n\\,{first}\\,{last})*not(mod(n-{first}\\,{piece.step}))'"
                )
                parts.append(f"[{sample}]{','.join([selection, *clock])}[{output}]")
            source = "".join(f"[{label}]" for label in selected)
            chain = [f"mix=inputs={count}:weights='{weights}':duration=shortest"]
        else:
            chain += [
                f"tmix=frames={count}:weights='{weights}'",
                f"select='between(n\\,{piece.first}\\,{piece.last})"
                f"*not(mod(n-{piece.first}\\,{piece.step}))'",
            ]
        if piece.lead or piece.trail:
            chain.append(
                f"tpad=start_mode=clone:start={piece.lead}:stop_mode=clone:stop={piece.trail}"
            )
        # number the kept pictures on the output grid; fps then gives each its length
        if positioned:
            frames = (piece.last - piece.first) // piece.step + 1 + piece.lead + piece.trail
            chain += [
                *clock,
                "tpad=stop_mode=clone:stop=1",
                f"fps={rate.numerator}/{rate.denominator}:eof_action=pass",
                f"trim=end_frame={frames}",
            ]
        else:
            chain += [*clock, f"fps={rate.numerator}/{rate.denominator}"]
        parts.append(f"{source}{','.join(chain)}[blend{index}]")
        labels.append(f"[blend{index}]")
    joined = labels[0]
    if len(labels) > 1:
        parts.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[blended]")
        joined = "[blended]"
    filters = join_video_filters(video_filters) if video_filters else "null"
    parts.append(f"{joined}{filters}[vout]")
    return parts


def _weighted_mix_graph(blend: TmixBlend, video_filters: list[str], *, download: bool) -> list[str]:
    clock = [f"settb={blend.rate.denominator}/{blend.rate.numerator}", "setpts=N"]
    branches = sum(sum(weight > 0 for weight in piece.weights) for piece in blend.pieces)
    chain = [f"trim=end_frame={max(piece.last for piece in blend.pieces) + 1}"]
    if download:
        chain += ["hwdownload", "format=nv12"]
    chain += ["format=yuv420p", f"split={branches}"]
    parts = ["[0:v]" + ",".join(chain) + "".join(f"[weighted{n}]" for n in range(branches))]
    branch = 0
    outputs = []
    for index, piece in enumerate(blend.pieces):
        inputs = []
        weights = []
        for offset, weight in enumerate(piece.weights):
            if not weight:
                continue
            first = piece.first - len(piece.weights) + 1 + offset
            last = piece.last - len(piece.weights) + 1 + offset
            label = f"weighted{index}_{offset}"
            select = f"select='between(n\\,{first}\\,{last})*not(mod(n-{first}\\,{piece.step}))'"
            parts.append(f"[weighted{branch}]{','.join([select, *clock])}[{label}]")
            inputs.append(f"[{label}]")
            weights.append(str(int(weight)))
            branch += 1
        chain = []
        if len(inputs) > 1:
            chain.append(
                f"mix=inputs={len(inputs)}:weights='{' '.join(weights)}':duration=shortest"
            )
        chain += [*clock, f"fps={blend.rate.numerator}/{blend.rate.denominator}:eof_action=pass"]
        label = f"weighted_result{index}"
        parts.append("".join(inputs) + ",".join(chain) + f"[{label}]")
        outputs.append(f"[{label}]")
    chain = []
    if len(outputs) > 1:
        chain.append(f"concat=n={len(outputs)}:v=1:a=0")
    # setpts clears frame duration; restore it after joining so MP4 keeps the last picture
    chain += [
        *clock,
        f"fps={blend.rate.numerator}/{blend.rate.denominator}:eof_action=pass",
        "setsar=1/1",
        *video_filters,
        "format=yuv420p",
        "setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:"
        + ("range=full" if blend.color_range == "pc" else "range=limited"),
    ]
    parts.append("".join(outputs) + ",".join(chain) + "[vout]")
    return parts


# VBR aims at the average bitrate the size budget allows and lets busy scenes borrow from quiet
# ones. The cap stops one scene spiking far past what players and upload sites buffer: 1.5x
# leaves room for motion without the size swings a 2x peak can cause, and a buffer twice the
# cap (three seconds at the average rate) lets the encoder spread those bits out smoothly
VBR_MAXRATE_FACTOR = 1.5
VBR_BUFSIZE_FACTOR = 2.0
_FALLBACK_BITRATE = 2_000_000


def vbr_limits(bitrate: int) -> tuple[int, int]:
    """The peak rate and buffer size for capped VBR at this average bitrate."""
    maxrate = int(bitrate * VBR_MAXRATE_FACTOR)
    return maxrate, int(maxrate * VBR_BUFSIZE_FACTOR)


def _rate_control_args(plan: EncodePlan) -> list[str]:
    encoder = plan.video_encoder
    rc_method = plan.rate_control_method
    bitrate = plan.video_bitrate if plan.video_bitrate > 0 else _FALLBACK_BITRATE
    maxrate, bufsize = vbr_limits(bitrate)
    if encoder in VAAPI_ENCODERS:
        preset = native_preset_for_encoder(plan.preset, encoder)
        # FFmpeg clamps this speed/quality choice to the driver's supported range
        args = ["-compression_level", str({"speed": 7, "balanced": 4, "quality": 1}[preset])]
        if rc_method in (RCM_CQ, RCM_CQP):
            return [
                *args,
                "-rc_mode",
                "CQP",
                "-qp",
                str(plan.cq if rc_method == RCM_CQ else plan.qp),
            ]
        if rc_method == RCM_CBR:
            return [
                *args,
                "-rc_mode",
                "CBR",
                "-b:v",
                str(bitrate),
                "-maxrate",
                str(bitrate),
                "-bufsize",
                str(bitrate),
            ]
        if rc_method == RCM_VBR:
            return [
                *args,
                "-rc_mode",
                "VBR",
                "-b:v",
                str(bitrate),
                "-maxrate",
                str(maxrate),
                "-bufsize",
                str(bufsize),
            ]
        raise ValueError("VAAPI encoding requires CQP, CQ, CBR, or VBR rate control")
    if encoder in CPU_ENCODERS:
        args = ["-preset", plan.preset]
        if plan.tune:
            args += ["-tune", plan.tune]
        if rc_method == RCM_CRF:
            return [*args, "-crf", str(plan.crf)]
        if rc_method == RCM_CBR:
            return [
                *args,
                *("-b:v", str(bitrate), "-minrate", str(bitrate)),
                *("-maxrate", str(bitrate), "-bufsize", str(bitrate)),
            ]
        if rc_method == RCM_VBR:
            # with two passes x264 and x265 spend the average well; without, the cap and
            # buffer keep a single pass from drifting far from it
            return [
                *args,
                *("-b:v", str(bitrate), "-maxrate", str(maxrate), "-bufsize", str(bufsize)),
            ]
        return args
    if encoder in NVENC_ENCODERS:
        args = ["-preset", nvenc_preset(plan.preset)]
        if rc_method == RCM_CQ:
            args += ["-rc", "vbr", "-cq", str(plan.cq)]
            if plan.video_bitrate > 0:
                args += ["-b:v", str(plan.video_bitrate), "-maxrate", str(plan.video_bitrate * 2)]
            return args
        if rc_method == RCM_CQP:
            return [*args, "-rc", "constqp", "-qp", str(plan.qp)]
        if rc_method == RCM_CBR:
            return [*args, "-rc", "cbr", "-b:v", str(bitrate)]
        if rc_method == RCM_VBR:
            return [
                *args,
                *("-rc", "vbr", "-b:v", str(bitrate)),
                *("-maxrate", str(maxrate), "-bufsize", str(bufsize)),
            ]
        return args
    if encoder in AMF_ENCODERS:
        args = ["-usage", "transcoding"]
        if rc_method in (RCM_CQ, RCM_CQP):
            return [
                *args,
                *("-rc", "cqp", "-qp_i", str(plan.cq)),
                *("-qp_p", str(plan.cq), "-qp_b", str(plan.cq)),
            ]
        if rc_method == RCM_CBR:
            return [*args, "-rc", "cbr", "-b:v", str(bitrate)]
        if rc_method == RCM_VBR:
            # AMF has no plain "vbr"; its peak-constrained mode is the capped VBR used above
            return [
                *args,
                *("-rc", "vbr_peak", "-b:v", str(bitrate)),
                *("-maxrate", str(maxrate), "-bufsize", str(bufsize)),
            ]
        return args
    return []


def build_base_cmd(
    ffmpeg: str,
    plan: EncodePlan,
    source: Path,
    *,
    include_audio: bool = True,
    prepared_video: Path | None = None,
    blend: TmixBlend | None = None,
    hardware_decode: HardwareDecode | None = None,
    streamed_video: bool = False,
    vaapi_device: VaapiEncodeDevice | None = None,
) -> list[str]:
    vaapi = plan.video_encoder in VAAPI_ENCODERS
    if vaapi and vaapi_device is None:
        raise ValueError("VAAPI encoding requires a probed render device")
    if streamed_video and (prepared_video is not None or blend is not None):
        raise ValueError("An export can use only one blended video input")
    if streamed_video and (plan.source_info is None or plan.target_fps <= 0):
        raise ValueError("Streamed blending needs source dimensions and a positive output rate")
    # explicit progress records are flushed independently of console status output
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:2"]
    if vaapi_device is not None and vaapi:
        cmd += vaapi_device.init_args

    segments = plan.effective_segments
    single_segment = len(segments) == 1
    positioned = bool(segments and segments[0].timeline_start is not None)
    # both blending paths put video on the output frame grid from the source clock
    blending = prepared_video is not None or blend is not None or streamed_video
    placement_fps = (
        plan.target_fps
        if blending or plan.apply_fps_filter or plan.source_info is None
        else plan.source_info.fps
    )
    if prepared_video is not None or not can_hardware_decode_blend(plan, blend):
        hardware_decode = None
    trim_start = float(segments[0].start) if single_segment else 0.0
    trim_end = float(segments[0].end) if single_segment else 0.0
    trim_duration = float(segments[0].duration) if single_segment else 0.0

    project_imported_clips = audible_clips(plan)
    imported_clips = project_imported_clips if include_audio and plan.audio_enabled else []
    source_has_audio = plan.source_info is None or plan.source_info.has_audio
    source_pieces = source_audio_output_pieces(segments, plan.source_audio_segments)
    audio_independent = positioned or (
        plan.source_audio_segments is not None
        and audio_independent_from_pieces(source_pieces, segments)
    )
    kept_tracks = plan.kept_source_tracks
    source_audio_active = bool(
        include_audio
        and plan.audio_enabled
        and source_has_audio
        and kept_tracks
        and (plan.audio_bitrate > 0 or plan.copy_audio)
        and (plan.source_audio_segments is None or bool(source_pieces))
    )
    source_gain_edits = any(abs(track.gain_db) > 1e-9 for track in kept_tracks)
    audio_filters_required = bool(imported_clips) or bool(
        source_audio_active
        and (len(segments) > 1 or source_gain_edits or audio_independent or blending)
    )
    timeline_audio_edits = bool(
        plan.audio_enabled
        and (
            project_imported_clips
            or (source_has_audio and source_gain_edits)
            or (source_audio_active and audio_independent)
        )
    )
    filtered_timeline = len(segments) > 1 or timeline_audio_edits or blending or positioned
    # only a single piece of the source keeps its subtitles in time with the picture, and the
    # analysis pass (include_audio off) writes nothing to carry them into
    subtitle_track = (
        plan.source_info.text_subtitle_track
        if include_audio and single_segment and not positioned and plan.source_info is not None
        else None
    )

    if not filtered_timeline and single_segment and trim_start > 0.001:
        cmd += ["-ss", fmt_ffmpeg_time(trim_start)]
    if hardware_decode is not None:
        # retry a decoder failure instead of publishing an export with dropped pictures
        cmd += hardware_decode.input_args
    if blend is not None and blend.weighted:
        cmd += ["-filter_complex_threads", str(min(16, os.cpu_count() or 1))]
    cmd += ["-i", str(source)]
    imported_inputs: list[tuple[int, AudioTrack, AudioClip]] = []
    for track, clip in imported_clips:
        cmd += ["-i", clip.source]
        imported_inputs.append((len(imported_inputs) + 1, track, clip))

    input_count = 1 + len(imported_inputs)
    if prepared_video is not None:
        cmd += ["-i", str(prepared_video)]
        input_count += 1
    elif streamed_video:
        cmd += ["-f", "nut", "-i", "pipe:0"]
        input_count += 1

    subtitle_map = ""
    if subtitle_track is not None:
        if filtered_timeline and trim_start > 0.001:
            # the filter graph trims the picture itself, so the subtitles come from a second
            # reading of the source that is seeked and cut to the same piece
            cmd += ["-ss", fmt_ffmpeg_time(trim_start), "-t", fmt_ffmpeg_time(trim_duration)]
            cmd += ["-i", str(source)]
            subtitle_map = f"{input_count}:s:{subtitle_track}?"
        else:
            subtitle_map = f"0:s:{subtitle_track}?"

    if not filtered_timeline and (
        single_segment
        and trim_duration > 0.001
        and (
            trim_start > 0.001
            or (
                plan.source_info is not None
                and trim_end > 0
                and trim_end < float(plan.source_info.duration) - 0.001
            )
        )
    ):
        cmd += ["-t", fmt_ffmpeg_time(trim_duration)]

    filtered_audio = False
    video_filters = build_plan_video_filters(
        replace(plan, apply_fps_filter=False) if blending else plan
    )
    if filtered_timeline:
        graph_parts: list[str] = []
        combined_source_concat = False
        if positioned and not blending:
            graph_parts.extend(_placed_source_video_graph(plan, video_filters, placement_fps))
        elif prepared_video is not None or streamed_video:
            info = plan.source_info
            ratio = info.sample_aspect_ratio if info else "1:1"
            sar = (
                Fraction(ratio.replace(":", "/"))
                if ratio not in {"N/A", "0:1", "", "unknown"}
                else Fraction(1)
            )
            if not Fraction(1, 1_000_000) <= sar <= 1_000_000:
                raise ValueError("Frame blending requires a supported positive sample aspect ratio")
            if info and info.display_rotation in {90, 270}:
                sar = 1 / sar
            video_filters.insert(0, f"setsar={sar.numerator}/{sar.denominator}:max=1000000")
            # the tone-map chain already ends in BT.709 SDR; converting that to another matrix
            # or tagging it with the source's HDR colours would misdescribe the picture
            tone_mapped = plan.tone_map_hdr and info is not None
            matrix = (
                "bt709"
                if tone_mapped or (info is not None and info.color_space == "bt709")
                else "bt601"
            )
            video_filters.append(f"scale=out_color_matrix={matrix}:out_range=tv")
            if info is not None:
                tags = [
                    f"colorspace={'bt709' if matrix == 'bt709' else 'smpte170m'}",
                    "range=limited",
                ]
                if tone_mapped:
                    tags += ["color_trc=bt709", "color_primaries=bt709"]
                else:
                    if info.color_transfer not in {"unknown", "unspecified", ""}:
                        tags.append(f"color_trc={info.color_transfer}")
                    if info.color_primaries not in {"unknown", "unspecified", ""}:
                        tags.append(f"color_primaries={info.color_primaries}")
                video_filters.append("setparams=" + ":".join(tags))
            video_chain = join_video_filters(video_filters)
            graph_parts.append(f"[{len(imported_inputs) + 1}:v]{video_chain}[vout]")
            cmd += ["-t", fmt_ffmpeg_time(plan.effective_duration)]
        elif blend is not None:
            graph_parts.extend(
                _tmix_graph(
                    blend,
                    video_filters,
                    download=hardware_decode is not None,
                    positioned=positioned,
                )
            )
            if blend.weighted and not positioned:
                # allow the last held picture its full tick instead of clipping it at audio EOF
                frames = sum(
                    (piece.last - piece.first) // piece.step + 1 + piece.lead + piece.trail
                    for piece in blend.pieces
                )
                cmd += ["-t", fmt_ffmpeg_time(float(frames / blend.rate))]
                cmd += ["-fps_mode", "passthrough"]
            else:
                cmd += ["-t", fmt_ffmpeg_time(plan.effective_duration)]
        else:
            video_inputs: list[str] = []
            combined_source_concat = bool(
                source_audio_active
                and len(segments) > 1
                and not imported_inputs
                and not source_gain_edits
                and not audio_independent
            )
            source_audio_inputs: list[str] = []
            for index, segment in enumerate(segments):
                start = fmt_ffmpeg_time(segment.start)
                end = fmt_ffmpeg_time(segment.end)
                graph_parts.append(
                    f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{index}]"
                )
                video_inputs.append(f"[v{index}]")
                if combined_source_concat:
                    _segment_atrim(
                        graph_parts,
                        segment,
                        f"a{index}",
                        stream=_source_audio(kept_tracks[0].index),
                    )
                    source_audio_inputs.append(f"[a{index}]")

            if not video_inputs:
                graph_parts.append("[0:v]setpts=PTS-STARTPTS[v0]")
                video_inputs.append("[v0]")

            if len(segments) > 1:
                video_concat_output = "vcat" if video_filters else "vout"
                if combined_source_concat:
                    concat_inputs = "".join(
                        video_inputs[index] + source_audio_inputs[index]
                        for index in range(len(video_inputs))
                    )
                    graph_parts.append(
                        concat_inputs
                        + f"concat=n={len(segments)}:v=1:a=1[{video_concat_output}][aout]"
                    )
                    filtered_audio = True
                else:
                    graph_parts.append(
                        "".join(video_inputs)
                        + f"concat=n={len(segments)}:v=1:a=0[{video_concat_output}]"
                    )
                if video_filters:
                    graph_parts.append(
                        f"[{video_concat_output}]{join_video_filters(video_filters)}[vout]"
                    )
            else:
                source_label = "v0"
                if video_filters:
                    graph_parts.append(f"[{source_label}]{join_video_filters(video_filters)}[vout]")
                else:
                    graph_parts.append(f"[{source_label}]null[vout]")

        mix_inputs: list[str] = []
        # the other source tracks, each its own output track after the first
        extra_audio_labels: list[str] = []
        output_duration = fmt_ffmpeg_time(plan.effective_duration)
        if combined_source_concat:
            # the first track rides along with the video concat; the others get the same cuts
            for position, track in enumerate(kept_tracks[1:], start=1):
                cut_inputs: list[str] = []
                for index, segment in enumerate(segments):
                    label = f"t{position}a{index}"
                    _segment_atrim(graph_parts, segment, label, stream=_source_audio(track.index))
                    cut_inputs.append(f"[{label}]")
                graph_parts.append(
                    "".join(cut_inputs) + f"concat=n={len(cut_inputs)}:v=0:a=1[aout{position}]"
                )
                extra_audio_labels.append(f"[aout{position}]")
        elif source_audio_active and audio_filters_required:
            for position, track in enumerate(kept_tracks):
                track_inputs = _source_audio_chain(
                    graph_parts,
                    plan,
                    segments,
                    source_pieces,
                    track=track,
                    position=position,
                    audio_independent=audio_independent,
                    blending=blending,
                    output_duration=output_duration,
                )
                if position == 0:
                    mix_inputs.extend(track_inputs)
                else:
                    _mix_to(graph_parts, track_inputs, f"aout{position}")
                    extra_audio_labels.append(f"[aout{position}]")

        # added audio is mixed into the first track only
        for input_index, track, clip in imported_inputs:
            for piece in clip_pieces(track, clip, clip_placements(clip, segments, positioned)):
                mix_label = f"mix{len(mix_inputs)}"
                clip_filters = _imported_clip_filters(plan, clip, piece, output_duration)
                graph_parts.append(f"[{input_index}:a:0]{','.join(clip_filters)}[{mix_label}]")
                mix_inputs.append(f"[{mix_label}]")

        if mix_inputs:
            _mix_to(graph_parts, mix_inputs, "aout")
            filtered_audio = True

        if positioned:
            if blend is not None:
                graph_parts = _place_video(graph_parts, segments, placement_fps)
            frames = math.ceil(plan.effective_duration * placement_fps - 1e-8)
            # keep every owned picture when FFmpeg rounds the output time limit to a frame
            cmd += ["-t", f"{frames / placement_fps:.9f}", "-r", f"{placement_fps:.9f}"]
        if vaapi:
            # upload only after all software filters, including the blend's final colour tags
            graph_parts = [part.replace("[vout]", "[vsoftware]") for part in graph_parts]
            graph_parts.append("[vsoftware]format=nv12,hwupload[vout]")
        cmd += ["-filter_complex", ";".join(graph_parts), "-map", "[vout]"]
        if filtered_audio:
            cmd += ["-map", "[aout]"]
            for label in extra_audio_labels:
                cmd += ["-map", label]
        if subtitle_map and prepared_video is None and blend is None:
            # subtitles read from the start of the source would run on past the trimmed
            # picture; the blending paths already end the output at the piece's length
            cmd += ["-t", fmt_ffmpeg_time(trim_duration)]
    else:
        # explicit maps, so FFmpeg's own stream choice can't swap tracks or pick subtitles
        cmd += ["-map", "0:v:0"]
        if source_audio_active:
            for track in kept_tracks:
                cmd += ["-map", f"{_source_audio(track.index)}?"]
        if vaapi:
            video_filters += ["format=nv12", "hwupload"]
        if video_filters:
            cmd += ["-vf", join_video_filters(video_filters)]
    if subtitle_map:
        # every encode is written as MP4 (the runner's result.mp4), and mov_text is the
        # only subtitle format MP4 holds as text
        cmd += ["-map", subtitle_map, "-c:s", "mov_text"]

    cmd += ["-c:v", plan.video_encoder, *_rate_control_args(plan)]

    if not vaapi:
        cmd += ["-pix_fmt", "yuv420p"]
    if plan.tone_map_hdr:
        # the tone-mapped picture is BT.709 SDR, so say so instead of keeping the HDR tags
        cmd += ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
        cmd += ["-color_range", "tv"]

    if not include_audio or not plan.audio_enabled:
        cmd += ["-an"]
    elif filtered_audio:
        audio_bitrate = plan.audio_bitrate if plan.audio_bitrate > 0 else 128_000
        cmd += ["-c:a", "aac", "-b:a", str(audio_bitrate)]
        cmd += ["-ac", str(plan.audio_channels)]
        cmd += ["-ar", str(plan.audio_sample_rate)]
    elif not source_audio_active:
        cmd += ["-an"]
    elif plan.copy_audio:
        cmd += ["-c:a", "copy"]
    elif plan.audio_bitrate > 0:
        cmd += ["-c:a", "aac", "-b:a", str(plan.audio_bitrate)]
        cmd += ["-ac", str(plan.audio_channels)]
        cmd += ["-ar", str(plan.audio_sample_rate)]
    else:
        cmd += ["-an"]

    cmd += ["-movflags", "+faststart"]
    return cmd
