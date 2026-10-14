from __future__ import annotations

from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from struct import pack
from typing import TYPE_CHECKING

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
    map_source_range_to_output,
    source_audio_output_pieces,
)
from ..models.encoding_policy import AMF_ENCODERS, CPU_ENCODERS, NVENC_ENCODERS
from . import filters as _filters
from .filters import build_plan_video_filters, join_video_filters

if TYPE_CHECKING:
    from .frame_blending import TmixBlend

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
                    "asetpts=PTS-STARTPTS",
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


def can_cuda_decode_blend(plan: EncodePlan, blend: TmixBlend | None) -> bool:
    """Support for CUDA's NV12 download; GPU availability is checked separately."""
    info = plan.source_info
    return bool(
        blend is not None
        and len(blend.pieces) == 1
        and len(plan.effective_segments) == 1
        and info is not None
        and info.video_codec == "av1"
        and info.pixel_format == "yuv420p"
        and not info.is_hdr
        and info.display_rotation == 0
        and not build_plan_video_filters(replace(plan, apply_fps_filter=False))
    )


def _tmix_graph(
    blend: TmixBlend, video_filters: list[str], *, cuda_decode: bool = False
) -> list[str]:
    """Blend the selected source pictures, then join segments on the output clock."""
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
        chain = (["hwdownload", "format=nv12"] if cuda_decode else []) + [
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
    cuda_decode: bool = False,
) -> list[str]:
    # explicit progress records are flushed independently of console status output
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:2"]

    segments = plan.effective_segments
    single_segment = len(segments) == 1
    # both blending paths put video on the output frame grid from the source clock
    blending = prepared_video is not None or blend is not None
    cuda_decode = bool(
        cuda_decode and prepared_video is None and can_cuda_decode_blend(plan, blend)
    )
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
    filtered_timeline = len(segments) > 1 or timeline_audio_edits or blending
    # only a single piece of the source keeps its subtitles in time with the picture, and the
    # analysis pass (include_audio off) writes nothing to carry them into
    subtitle_track = (
        plan.source_info.text_subtitle_track
        if include_audio and single_segment and plan.source_info is not None
        else None
    )

    if not filtered_timeline and single_segment and trim_start > 0.001:
        cmd += ["-ss", fmt_ffmpeg_time(trim_start)]
    if cuda_decode:
        # retry a decoder failure instead of publishing an export with dropped pictures
        cmd += ["-xerror", "-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    cmd += ["-i", str(source)]
    imported_inputs: list[tuple[int, AudioTrack, AudioClip]] = []
    for track, clip in imported_clips:
        cmd += ["-i", clip.source]
        imported_inputs.append((len(imported_inputs) + 1, track, clip))

    input_count = 1 + len(imported_inputs)
    if prepared_video is not None:
        cmd += ["-i", str(prepared_video)]
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
        if prepared_video is not None:
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
            graph_parts.extend(_tmix_graph(blend, video_filters, cuda_decode=cuda_decode))
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
                graph_parts.append(f"[{input_index}:a:0]{','.join(clip_filters)}[{mix_label}]")
                mix_inputs.append(f"[{mix_label}]")

        if mix_inputs:
            _mix_to(graph_parts, mix_inputs, "aout")
            filtered_audio = True

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
        if video_filters:
            cmd += ["-vf", join_video_filters(video_filters)]
    if subtitle_map:
        # every encode is written as MP4 (the runner's result.mp4), and mov_text is the
        # only subtitle format MP4 holds as text
        cmd += ["-map", subtitle_map, "-c:s", "mov_text"]

    cmd += ["-c:v", plan.video_encoder, *_rate_control_args(plan)]

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
