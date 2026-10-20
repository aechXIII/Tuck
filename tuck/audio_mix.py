"""Where each sound in an edit plays and how loud it is.

The export's FFmpeg graph and the native player's preview mix both take their placement, gain,
fade and loop rules from here, so the preview sounds the way the export will.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import (
    AudioClip,
    AudioTrack,
    EncodePlan,
    Segment,
    TimelineAudioPiece,
    map_source_range_to_output,
    source_audio_output_pieces,
)

# a piece that starts or ends this close to its clip's edge carries that edge's fade
_EDGE = 1e-6


@dataclass(frozen=True)
class ClipPiece:
    """One stretch of an added clip: where it starts on the output, how long it plays and how
    far into the clip it begins. Only the pieces that hold the clip's own edges fade."""

    output_start: float
    duration: float
    local_offset: float
    gain_db: float
    fade_in: float
    fade_out: float


def clip_placements(
    clip: AudioClip, segments: list[Segment], positioned: bool
) -> list[TimelineAudioPiece]:
    """The stretches of `clip` that play: all of it on a timeline of moved clips, otherwise the
    parts over kept footage, moved up as the cuts between them close"""
    if positioned:
        return [TimelineAudioPiece(clip.timeline_start, clip.timeline_end, clip.timeline_start)]
    return map_source_range_to_output(segments, clip.timeline_start, clip.timeline_end)


def clip_pieces(
    track: AudioTrack, clip: AudioClip, placements: list[TimelineAudioPiece]
) -> list[ClipPiece]:
    pieces: list[ClipPiece] = []
    for placement in placements:
        local_offset = placement.source_start - clip.timeline_start
        duration = placement.duration
        remaining_after = clip.timeline_duration - local_offset - duration
        pieces.append(
            ClipPiece(
                output_start=placement.output_start,
                duration=duration,
                local_offset=local_offset,
                gain_db=float(track.gain_db + clip.gain_db),
                fade_in=clip.fade_in if local_offset <= _EDGE else 0.0,
                fade_out=clip.fade_out if remaining_after <= _EDGE else 0.0,
            )
        )
    return pieces


def audible_clips(plan: EncodePlan) -> list[tuple[AudioTrack, AudioClip]]:
    """The added clips that play: muted tracks and muted clips are left out"""
    return [
        (track, clip)
        for track in plan.audio_tracks
        if not track.muted
        for clip in track.clips
        if not clip.muted
    ]


@dataclass(frozen=True)
class MixPiece:
    """A stretch of one sound on the player's timeline. `source_in` is where it starts in the
    file; with `loop_span` the file's next `loop_span` seconds repeat from `loop_start`."""

    start: float
    end: float
    source_in: float
    gain: float
    fade_in: float = 0.0
    fade_out: float = 0.0
    loop_start: float = 0.0
    loop_span: float = 0.0


@dataclass(frozen=True)
class MixVoice:
    """One sound stream to decode: the video's own stream `stream`, or an added file's first"""

    path: str
    stream: int
    pieces: tuple[MixPiece, ...]


@dataclass(frozen=True)
class PreviewMix:
    duration: float
    voices: tuple[MixVoice, ...]


def db_to_gain(db: float) -> float:
    return float(10 ** (db / 20))


def _timeline_length(plan: EncodePlan, positioned: bool) -> float:
    if positioned:
        return float(plan.effective_duration)
    if plan.source_info is not None and plan.source_info.duration > 0:
        return float(plan.source_info.duration)
    return float(max((segment.end for segment in plan.effective_segments), default=0.0))


def _source_pieces(plan: EncodePlan, positioned: bool) -> list[TimelineAudioPiece]:
    """The source's sound on the player's timeline. With moved clips that is the export's own
    output time; without them it is the source's time, which the player skips cuts in"""
    segments = plan.effective_segments
    if positioned:
        return source_audio_output_pieces(segments, plan.source_audio_segments)
    audible = plan.source_audio_segments if plan.source_audio_segments is not None else segments
    return [TimelineAudioPiece(segment.start, segment.end, segment.start) for segment in audible]


def compile_preview_mix(plan: EncodePlan) -> PreviewMix:
    """The mix the native player plays for `plan`, from the same rules as the export.

    The preview sums every source stream the export keeps, where the export writes each as its
    own track, and applies gains above 0 dB as the export does, without a limiter."""
    segments = plan.effective_segments
    positioned = bool(segments and segments[0].timeline_start is not None)
    duration = _timeline_length(plan, positioned)
    if not plan.audio_enabled:
        return PreviewMix(duration, ())
    voices: list[MixVoice] = []
    if plan.source_info is None or plan.source_info.has_audio:
        pieces = _source_pieces(plan, positioned)
        for track in plan.kept_source_tracks:
            gain = db_to_gain(track.gain_db)
            voices.append(
                MixVoice(
                    plan.source,
                    track.index,
                    tuple(
                        MixPiece(
                            piece.output_start,
                            piece.output_start + piece.duration,
                            piece.source_start,
                            gain,
                        )
                        for piece in pieces
                        if piece.duration > 0
                    ),
                )
            )
    added: dict[str, list[MixPiece]] = {}
    for track, clip in audible_clips(plan):
        # the player plays an added clip whole on its timeline and skips cuts in the picture
        # itself, so the clip is one piece there
        whole = [TimelineAudioPiece(clip.timeline_start, clip.timeline_end, clip.timeline_start)]
        for piece in clip_pieces(track, clip, whole):
            added.setdefault(clip.source, []).append(
                MixPiece(
                    start=piece.output_start,
                    end=piece.output_start + piece.duration,
                    source_in=clip.source_in,
                    gain=db_to_gain(piece.gain_db),
                    fade_in=piece.fade_in,
                    fade_out=piece.fade_out,
                    loop_start=clip.source_in if clip.loop else 0.0,
                    loop_span=clip.source_duration if clip.loop else 0.0,
                )
            )
    for path, pieces in added.items():
        voices.append(MixVoice(path, 0, tuple(sorted(pieces, key=lambda piece: piece.start))))
    return PreviewMix(duration, tuple(voices))


def compile_cut_preview_mix(
    source: str, segments: list[Segment], stream_count: int, include_audio: bool
) -> PreviewMix:
    """A lossless cut keeps the source's own tracks untouched, so its preview is every stream at
    full level over the kept segments, as the cut will be"""
    duration = float(max((segment.end for segment in segments), default=0.0))
    if not include_audio or stream_count <= 0:
        return PreviewMix(duration, ())
    pieces = tuple(
        MixPiece(segment.start, segment.end, segment.start, 1.0)
        for segment in segments
        if segment.end > segment.start
    )
    return PreviewMix(
        duration, tuple(MixVoice(source, index, pieces) for index in range(stream_count))
    )


def preview_mix_dict(mix: PreviewMix) -> dict[str, object]:
    """The mix as the page hands it to the desktop shell"""
    return {
        "duration": mix.duration,
        "voices": [
            {
                "path": voice.path,
                "stream": voice.stream,
                "pieces": [
                    {
                        "start": piece.start,
                        "end": piece.end,
                        "sourceIn": piece.source_in,
                        "gain": piece.gain,
                        "fadeIn": piece.fade_in,
                        "fadeOut": piece.fade_out,
                        "loopStart": piece.loop_start,
                        "loopSpan": piece.loop_span,
                    }
                    for piece in voice.pieces
                ],
            }
            for voice in mix.voices
        ],
    }
