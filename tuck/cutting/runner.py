from __future__ import annotations

from collections.abc import Callable
from fractions import Fraction
from math import gcd
from pathlib import Path
from threading import Event

import av
from av.container import InputContainer, OutputContainer
from av.stream import Stream
from av.video.stream import VideoStream

from ..models.cutting import Chapter, CutAnalysis, CutPlan, MediaTime
from ..models.progress import EncodeProgress, EncodeStage
from ..output_paths import copy_file_dates
from ..output_transaction import OutputTransaction
from .analysis import CutAnalysisError
from .exact import ExactEdges, encode_edges, exact_packets
from .output_timing import output_frame_count
from .packets import check_cut_cancel, prepare_cut, selected_packets
from .planner import OUTPUT_FORMATS
from .verification import is_generated_tag, verify_cut_output, without_bitrate_box

_MP4_FAMILY = {"mp4", "mov", "3gp"}
_UNMEASURED_STAGES = {
    EncodeStage.PREPARING,
    EncodeStage.ENCODING_EDGES,
    EncodeStage.JOINING,
    EncodeStage.VERIFYING,
}


def _common_base(chapters: tuple[Chapter, ...]) -> list[Chapter]:
    """Chapters on one shared time base, which the muxer needs for start and end."""
    base = 1
    for chapter in chapters:
        for time in (chapter.start, chapter.end):
            base = base * time.seconds.denominator // gcd(base, time.seconds.denominator)
    return [
        Chapter(
            MediaTime(int(c.start.seconds * base), 1, base),
            MediaTime(int(c.end.seconds * base), 1, base),
            c.title,
        )
        for c in chapters
    ]


def _keep_container_video_facts(source: VideoStream, target: VideoStream) -> None:
    """Carry facts some files store only in the container, not in the video bitstream."""
    source_codec, target_codec = source.codec_context, target.codec_context
    if target_codec.sample_aspect_ratio is None and source.sample_aspect_ratio:
        target_codec.sample_aspect_ratio = source.sample_aspect_ratio
    target_codec.color_primaries = source_codec.color_primaries
    target_codec.color_trc = source_codec.color_trc
    target_codec.colorspace = source_codec.colorspace
    target_codec.color_range = source_codec.color_range


def _video_stream(container: InputContainer, index: int) -> VideoStream:
    stream = container.streams[index]
    if not isinstance(stream, VideoStream):
        raise CutAnalysisError("cut_failed", "The video track could not be read.")
    return stream


def _video_timescale(container: InputContainer) -> int:
    base = container.streams.video[0].time_base
    return base.denominator if base is not None else 1000


def _muxer_options(muxer: str, incoming: InputContainer) -> dict[str, str]:
    if muxer not in _MP4_FAMILY:
        return {}
    timescale = str(_video_timescale(incoming))
    return {
        "movflags": "+use_metadata_tags",
        # the default 1/1000 movie timescale rounds the joined duration
        "movie_timescale": timescale,
        # keep the source's own video timescale instead of a scaled one
        "video_track_timescale": timescale,
    }


def _add_streams(
    incoming: InputContainer,
    outgoing: OutputContainer,
    plan: CutPlan,
    analysis: CutAnalysis,
    muxer: str,
    edges: ExactEdges | None,
) -> dict[int, Stream]:
    """Output streams for the video and every kept track, keyed by source index."""
    streams: dict[int, Stream] = {}
    kept = {analysis.video_index} | {t.index for t in plan.tracks if t.keep}
    for stream in incoming.streams:
        if stream.index not in kept:
            continue
        # copying decoder parameters avoids requiring an installed encoder
        target = outgoing.add_stream_from_template(
            stream,
            opaque=True,
            time_base=stream.time_base,
            disposition=stream.disposition.value,
        )
        target.metadata.update(
            {k: v for k, v in stream.metadata.items() if not is_generated_tag(k)}
        )
        if isinstance(stream, VideoStream) and isinstance(target, VideoStream):
            _keep_container_video_facts(stream, target)
        if muxer in _MP4_FAMILY and stream.codec_tag:
            # e.g. HEVC stays hvc1, which Apple players need, not hev1
            target.codec_tag = stream.codec_tag
        codec = stream.codec_context
        if muxer in _MP4_FAMILY and codec and codec.name == "mov_text" and codec.extradata:
            # the muxer adds a bitrate box that describes the new file
            target.codec_context.extradata = without_bitrate_box(codec.name, codec.extradata)
        if edges is not None and stream.type == "video":
            # lists the encoded edges' parameter sets beside the source's
            target.codec_context.extradata = edges.extradata
        streams[stream.index] = target
    return streams


def _write_chapters(outgoing: OutputContainer, chapters: tuple[Chapter, ...]) -> None:
    if not chapters:
        return
    outgoing.set_chapters(
        [
            {
                "id": number + 1,
                "start": chapter.start.ticks,
                "end": chapter.end.ticks,
                "time_base": Fraction(chapter.start.time_base_num, chapter.start.time_base_den)
                if chapter.start.time_base_den == chapter.end.time_base_den
                else None,
                "metadata": {"title": chapter.title} if chapter.title else {},
            }
            for number, chapter in enumerate(_common_base(chapters))
        ]
    )


def _progress(stage: EncodeStage, message: str, current: float, duration: float) -> EncodeProgress:
    if stage == EncodeStage.COMPLETED:
        percent = 100.0
    else:
        percent = min(99, current / duration * 100) if duration > 0 else 0
    return EncodeProgress(
        percent=percent,
        stage=stage,
        current_time=current,
        duration=duration,
        message=message,
        # only copying can be measured; the other stages have no honest percentage
        indeterminate=stage in _UNMEASURED_STAGES,
    )


class CutRunner:
    def __init__(self, *, ffprobe: str | None = None) -> None:
        self._cancel = Event()
        self._ffprobe = ffprobe

    def cancel(self) -> None:
        self._cancel.set()

    def reset_cancel(self) -> None:
        self._cancel.clear()

    def run(
        self,
        plan: CutPlan,
        on_progress: Callable[[EncodeProgress], None] | None = None,
    ) -> Path:
        duration = float(plan.exported_duration.seconds)

        def report(stage: EncodeStage, message: str, current: float = 0) -> None:
            if on_progress is not None:
                on_progress(_progress(stage, message, current, duration))
            if stage != EncodeStage.COMPLETED:
                check_cut_cancel(self._cancel)

        try:
            report(EncodeStage.PREPARING, "Preparing")
            analysis = prepare_cut(plan, self._cancel, self._ffprobe)
            with OutputTransaction(Path(plan.output_path)) as transaction:
                extension = "." + plan.container
                result = transaction.workspace / ("result" + extension)
                edges = None
                if plan.precision == "exact":
                    report(EncodeStage.ENCODING_EDGES, "Encoding cut edges")
                    edges = encode_edges(
                        plan,
                        analysis,
                        transaction.workspace,
                        self._cancel,
                        on_frame=lambda: check_cut_cancel(self._cancel),
                    )
                report(EncodeStage.COPYING, "Copying")
                self._join(plan, analysis, result, OUTPUT_FORMATS[extension], edges, report)
                report(EncodeStage.VERIFYING, "Checking output")
                verify_cut_output(
                    plan,
                    result,
                    self._cancel,
                    analysis=analysis,
                    ffprobe=self._ffprobe,
                    edges=edges,
                )
                check_cut_cancel(self._cancel)
                output = transaction.publish(result)
                if plan.keep_file_dates:
                    copy_file_dates(Path(plan.source), output)
            report(EncodeStage.COMPLETED, "Completed", duration)
            return output
        except CutAnalysisError as exc:
            if self._cancel.is_set():
                if on_progress is not None:
                    on_progress(EncodeProgress(stage=EncodeStage.CANCELLED, message="Cancelled"))
                raise CutAnalysisError("cut_cancelled", "Cutting was cancelled.") from exc
            if on_progress is not None:
                on_progress(EncodeProgress(stage=EncodeStage.FAILED, message=str(exc)))
            raise
        except (OSError, ValueError) as exc:
            error = CutAnalysisError(
                "cut_failed",
                "The cut could not be saved. Check that the folder is writable and has free space.",
                str(exc),
            )
            if on_progress is not None:
                on_progress(EncodeProgress(stage=EncodeStage.FAILED, message=str(error)))
            raise error from exc

    def _join(
        self,
        plan: CutPlan,
        analysis: CutAnalysis,
        result: Path,
        muxer: str,
        edges: ExactEdges | None,
        report: Callable[[EncodeStage, str, float], None],
    ) -> None:
        """Write the kept packets, and any encoded edges, into one file."""
        duration = float(plan.exported_duration.seconds)
        with (
            av.open(plan.identity.path) as incoming,
            av.open(
                str(result), "w", format=muxer, options=_muxer_options(muxer, incoming)
            ) as outgoing,
        ):
            outgoing.metadata.update(
                {
                    k: v
                    for k, v in incoming.metadata.items()
                    if not is_generated_tag(k, plan.container)
                }
            )
            streams = _add_streams(incoming, outgoing, plan, analysis, muxer, edges)
            _write_chapters(outgoing, plan.chapters)
            total_frames = max(1, output_frame_count(plan, analysis))
            copied = 0
            last_progress = -1
            packets = selected_packets(incoming, plan, analysis, self._cancel)
            if edges is not None:
                packets = exact_packets(
                    packets,
                    plan,
                    analysis,
                    edges,
                    _video_stream(incoming, analysis.video_index),
                    self._cancel,
                )
            for packet in packets:
                if packet.stream.type == "video":
                    copied += 1
                packet.stream = streams[packet.stream.index]
                outgoing.mux(packet)
                current = duration * min(1.0, copied / total_frames)
                percent = int(current / duration * 100) if duration > 0 else 0
                if percent != last_progress:
                    report(EncodeStage.COPYING, "Copying", current)
                    last_progress = percent
            # finalizing the container writes the joined index and duration
            report(EncodeStage.JOINING, "Joining", 0)
