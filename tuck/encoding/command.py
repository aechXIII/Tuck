from __future__ import annotations

from pathlib import Path

from ..models import (
    _AMF_ENCODERS,
    _CPU_ENCODERS,
    _NVENC_ENCODERS,
    RCM_CBR,
    RCM_CQ,
    RCM_CQP,
    RCM_CRF,
    RCM_VBR,
    AudioClip,
    AudioTrack,
    EncodePlan,
    Segment,
    audio_independent_from_pieces,
    map_source_range_to_output,
    source_audio_output_pieces,
)
from . import filters as _filters
from .filters import build_plan_video_filters, join_video_filters

scaler_to_ffmpeg_flag = _filters.scaler_to_ffmpeg_flag


def fmt_ffmpeg_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    return f"{seconds:.3f}"


def _segment_atrim(graph_parts: list[str], segment: Segment, label: str) -> None:
    start = fmt_ffmpeg_time(segment.start)
    end = fmt_ffmpeg_time(segment.end)
    graph_parts.append(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[{label}]")


def _imported_clip_filters(
    plan: EncodePlan,
    track: AudioTrack,
    clip: AudioClip,
    output_start: float,
    piece_duration: float,
    local_offset: float,
    output_duration: str,
) -> list[str]:
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
    total_gain = float(track.gain_db + clip.gain_db)
    if abs(total_gain) > 1e-9:
        filters.append(f"volume={total_gain:.2f}dB")
    fade_in = clip.fade_in if local_offset <= 1e-6 else 0.0
    remaining_after = clip.timeline_duration - local_offset - piece_duration
    fade_out = clip.fade_out if remaining_after <= 1e-6 else 0.0
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
            f"adelay={max(0, round(output_start * 1000))}:all=1",
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
    "medium": "p6",
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


def build_base_cmd(
    ffmpeg: str,
    plan: EncodePlan,
    source: Path,
    *,
    include_audio: bool = True,
) -> list[str]:
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-stats"]

    segments = plan.effective_segments
    single_segment = len(segments) == 1
    trim_start = float(segments[0].start) if single_segment else 0.0
    trim_end = float(segments[0].end) if single_segment else 0.0
    trim_duration = float(segments[0].duration) if single_segment else 0.0

    project_imported_clips = [
        (track, clip)
        for track in plan.audio_tracks
        if not track.muted
        for clip in track.clips
        if not clip.muted
    ]
    imported_clips = project_imported_clips if include_audio and plan.audio_enabled else []
    source_has_audio = plan.source_info is None or plan.source_info.has_audio
    source_pieces = source_audio_output_pieces(segments, plan.source_audio_segments)
    audio_independent = plan.source_audio_segments is not None and audio_independent_from_pieces(
        source_pieces, segments
    )
    source_audio_active = bool(
        include_audio
        and plan.audio_enabled
        and source_has_audio
        and not plan.source_audio_muted
        and (plan.audio_bitrate > 0 or plan.copy_audio)
        and (plan.source_audio_segments is None or bool(source_pieces))
    )
    audio_filters_required = bool(imported_clips) or bool(
        source_audio_active
        and (len(segments) > 1 or abs(plan.source_audio_gain_db) > 1e-9 or audio_independent)
    )
    timeline_audio_edits = bool(
        plan.audio_enabled
        and (
            project_imported_clips
            or (source_has_audio and abs(plan.source_audio_gain_db) > 1e-9)
            or (source_audio_active and audio_independent)
        )
    )
    filtered_timeline = len(segments) > 1 or timeline_audio_edits

    if not filtered_timeline and single_segment and trim_start > 0.001:
        cmd += ["-ss", fmt_ffmpeg_time(trim_start)]
    cmd += ["-i", str(source)]
    imported_inputs: list[tuple[int, AudioTrack, AudioClip]] = []
    for track, clip in imported_clips:
        cmd += ["-i", clip.source]
        imported_inputs.append((len(imported_inputs) + 1, track, clip))

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
    video_filters = build_plan_video_filters(plan)
    if filtered_timeline:
        graph_parts: list[str] = []
        video_inputs: list[str] = []
        combined_source_concat = bool(
            source_audio_active
            and len(segments) > 1
            and not imported_inputs
            and abs(plan.source_audio_gain_db) <= 1e-9
            and not audio_independent
        )
        source_audio_inputs: list[str] = []
        for index, segment in enumerate(segments):
            start = fmt_ffmpeg_time(segment.start)
            end = fmt_ffmpeg_time(segment.end)
            graph_parts.append(f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{index}]")
            video_inputs.append(f"[v{index}]")
            if combined_source_concat:
                _segment_atrim(graph_parts, segment, f"a{index}")
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
                    concat_inputs + f"concat=n={len(segments)}:v=1:a=1[{video_concat_output}][aout]"
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
        output_duration = fmt_ffmpeg_time(plan.effective_duration)
        if source_audio_active and audio_filters_required and not combined_source_concat:
            if audio_independent:
                for piece in source_pieces:
                    filters = [
                        f"atrim=start={fmt_ffmpeg_time(piece.source_start)}:"
                        f"end={fmt_ffmpeg_time(piece.source_end)}",
                        "asetpts=PTS-STARTPTS",
                    ]
                    if abs(plan.source_audio_gain_db) > 1e-9:
                        filters.append(f"volume={plan.source_audio_gain_db:.2f}dB")
                    filters.extend(
                        [
                            f"adelay={max(0, round(piece.output_start * 1000))}:all=1",
                            "asetpts=PTS-STARTPTS",
                            f"apad=whole_dur={output_duration}",
                            f"atrim=duration={output_duration}",
                        ]
                    )
                    mix_label = f"mix{len(mix_inputs)}"
                    graph_parts.append(f"[0:a]{','.join(filters)}[{mix_label}]")
                    mix_inputs.append(f"[{mix_label}]")
            else:
                source_audio_inputs: list[str] = []
                for index, segment in enumerate(segments):
                    _segment_atrim(graph_parts, segment, f"sa{index}")
                    source_audio_inputs.append(f"[sa{index}]")
                if not source_audio_inputs:
                    graph_parts.append("[0:a]asetpts=PTS-STARTPTS[sa0]")
                    source_audio_inputs.append("[sa0]")
                source_audio_label = "sa0"
                if len(source_audio_inputs) > 1:
                    graph_parts.append(
                        "".join(source_audio_inputs)
                        + f"concat=n={len(source_audio_inputs)}:v=0:a=1[sacat]"
                    )
                    source_audio_label = "sacat"
                source_filters: list[str] = []
                if abs(plan.source_audio_gain_db) > 1e-9:
                    source_filters.append(f"volume={plan.source_audio_gain_db:.2f}dB")
                source_filters.extend(
                    [
                        f"apad=whole_dur={output_duration}",
                        f"atrim=duration={output_duration}",
                    ]
                )
                graph_parts.append(f"[{source_audio_label}]{','.join(source_filters)}[mix0]")
                mix_inputs.append("[mix0]")

        for input_index, track, clip in imported_inputs:
            mapped = map_source_range_to_output(segments, clip.timeline_start, clip.timeline_end)
            if not mapped:
                continue
            for piece in mapped:
                local_offset = piece.source_start - clip.timeline_start
                mix_label = f"mix{len(mix_inputs)}"
                clip_filters = _imported_clip_filters(
                    plan,
                    track,
                    clip,
                    piece.output_start,
                    piece.duration,
                    local_offset,
                    output_duration,
                )
                graph_parts.append(f"[{input_index}:a]{','.join(clip_filters)}[{mix_label}]")
                mix_inputs.append(f"[{mix_label}]")

        if mix_inputs:
            if len(mix_inputs) == 1:
                graph_parts.append(f"{mix_inputs[0]}anull[aout]")
            else:
                graph_parts.append(
                    "".join(mix_inputs) + f"amix=inputs={len(mix_inputs)}:duration=longest:"
                    "dropout_transition=0:normalize=0[aout]"
                )
            filtered_audio = True

        cmd += ["-filter_complex", ";".join(graph_parts), "-map", "[vout]"]
        if filtered_audio:
            cmd += ["-map", "[aout]"]
    else:
        if video_filters:
            cmd += ["-vf", join_video_filters(video_filters)]

    encoder = getattr(plan, "video_encoder", "libx264")
    rc_method = getattr(plan, "rate_control_method", RCM_CRF)
    qp_val = getattr(plan, "qp", 23)
    cq_val = getattr(plan, "cq", qp_val)
    crf_val = getattr(plan, "crf", 23)

    cmd += ["-c:v", encoder]

    if encoder in _CPU_ENCODERS:
        cmd += ["-preset", plan.preset]
        tune = getattr(plan, "tune", "")
        if tune:
            cmd += ["-tune", tune]
        if rc_method == RCM_CRF:
            cmd += ["-crf", str(crf_val)]
        elif rc_method == RCM_CBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-b:v", str(bitrate)]
            cmd += ["-minrate", str(bitrate)]
            cmd += ["-maxrate", str(bitrate)]
            cmd += ["-bufsize", str(bitrate)]
    elif encoder in _NVENC_ENCODERS:
        cmd += ["-preset", nvenc_preset(plan.preset)]
        if rc_method == RCM_CQ:
            bitrate = plan.video_bitrate
            cmd += ["-rc", "vbr", "-cq", str(cq_val)]
            if bitrate > 0:
                cmd += ["-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]
        elif rc_method == RCM_CQP:
            cmd += ["-rc", "constqp", "-qp", str(qp_val)]
        elif rc_method == RCM_CBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "cbr", "-b:v", str(bitrate)]
        elif rc_method == RCM_VBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "vbr", "-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]
    elif encoder in _AMF_ENCODERS:
        cmd += ["-usage", "transcoding"]
        if rc_method in (RCM_CQ, RCM_CQP):
            cmd += [
                "-rc",
                "cqp",
                "-qp_i",
                str(cq_val),
                "-qp_p",
                str(cq_val),
                "-qp_b",
                str(cq_val),
            ]
        elif rc_method == RCM_CBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "cbr", "-b:v", str(bitrate)]
        elif rc_method == RCM_VBR:
            bitrate = plan.video_bitrate
            if bitrate <= 0:
                bitrate = 2_000_000
            cmd += ["-rc", "vbr", "-b:v", str(bitrate), "-maxrate", str(bitrate * 2)]

    cmd += ["-pix_fmt", "yuv420p"]

    if not include_audio or not plan.audio_enabled:
        cmd += ["-an"]
    elif filtered_audio:
        audio_bitrate = plan.audio_bitrate if plan.audio_bitrate > 0 else 128_000
        cmd += ["-c:a", "aac", "-b:a", str(audio_bitrate)]
        cmd += ["-ac", str(plan.audio_channels)]
        cmd += ["-ar", str(plan.audio_sample_rate)]
    elif not source_audio_active:
        cmd += ["-an"]
    elif getattr(plan, "copy_audio", False):
        cmd += ["-c:a", "copy"]
    elif plan.audio_bitrate > 0:
        cmd += ["-c:a", "aac", "-b:a", str(plan.audio_bitrate)]
        cmd += ["-ac", str(plan.audio_channels)]
        cmd += ["-ar", str(plan.audio_sample_rate)]
    else:
        cmd += ["-an"]

    cmd += ["-movflags", "+faststart"]
    return cmd
