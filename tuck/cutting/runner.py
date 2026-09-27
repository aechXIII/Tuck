from __future__ import annotations

from collections.abc import Callable
from fractions import Fraction
from math import gcd
from pathlib import Path
from threading import Event

import av
from av.container import InputContainer
from av.video.stream import VideoStream

from ..encoding.output import OutputTransaction
from ..models.cutting import Chapter, CutPlan, MediaTime
from ..models.progress import EncodeProgress, EncodeStage
from .analysis import CutAnalysisError
from .exact import encode_edges, exact_packets
from .packets import check_cut_cancel, output_frame_times, prepare_cut, selected_packets
from .planner import OUTPUT_FORMATS
from .verification import is_generated_tag, verify_cut_output


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
                on_progress(
                    EncodeProgress(
                        percent=100
                        if stage == EncodeStage.COMPLETED
                        else min(99, current / duration * 100)
                        if duration > 0
                        else 0,
                        stage=stage,
                        current_time=current,
                        duration=duration,
                        message=message,
                        indeterminate=stage
                        in {
                            EncodeStage.PREPARING,
                            EncodeStage.ENCODING_EDGES,
                            EncodeStage.JOINING,
                            EncodeStage.VERIFYING,
                        },
                    )
                )
            if stage != EncodeStage.COMPLETED:
                check_cut_cancel(self._cancel)

        try:
            report(EncodeStage.PREPARING, "Preparing")
            analysis = prepare_cut(plan, self._cancel, self._ffprobe)
            with OutputTransaction(Path(plan.output_path)) as transaction:
                extension = "." + plan.container
                muxer = OUTPUT_FORMATS[extension]
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
                with (
                    av.open(plan.identity.path) as incoming,
                    av.open(
                        str(result),
                        "w",
                        format=muxer,
                        options={
                            "movflags": "+use_metadata_tags",
                            # the default 1/1000 movie timescale rounds the joined duration
                            "movie_timescale": str(_video_timescale(incoming)),
                            # keep the source's own video timescale instead of a scaled one
                            "video_track_timescale": str(_video_timescale(incoming)),
                        }
                        if muxer in {"mp4", "mov", "3gp"}
                        else {},
                    ) as outgoing,
                ):
                    outgoing.metadata.update(
                        {
                            k: v
                            for k, v in incoming.metadata.items()
                            if not is_generated_tag(k, plan.container)
                        }
                    )
                    streams = {}
                    kept = {analysis.video_index} | {t.index for t in plan.tracks if t.keep}
                    for stream in incoming.streams:
                        if stream.index in kept:
                            # copying decoder parameters avoids requiring an installed encoder
                            target = outgoing.add_stream_from_template(
                                stream,
                                opaque=True,
                                time_base=stream.time_base,
                                disposition=stream.disposition.value,
                            )
                            target.metadata.update(
                                {
                                    k: v
                                    for k, v in stream.metadata.items()
                                    if not is_generated_tag(k)
                                }
                            )
                            if isinstance(stream, VideoStream) and isinstance(target, VideoStream):
                                _keep_container_video_facts(stream, target)
                            if muxer in {"mp4", "mov", "3gp"} and stream.codec_tag:
                                # e.g. HEVC stays hvc1, which Apple players need, not hev1
                                target.codec_tag = stream.codec_tag
                            if edges is not None and stream.type == "video":
                                # lists the encoded edges' parameter sets beside the source's
                                target.codec_context.extradata = edges.extradata
                            streams[stream.index] = target
                    if plan.chapters:
                        outgoing.set_chapters(
                            [
                                {
                                    "id": number + 1,
                                    "start": chapter.start.ticks,
                                    "end": chapter.end.ticks,
                                    "time_base": Fraction(
                                        chapter.start.time_base_num, chapter.start.time_base_den
                                    )
                                    if chapter.start.time_base_den == chapter.end.time_base_den
                                    else None,
                                    "metadata": {"title": chapter.title} if chapter.title else {},
                                }
                                for number, chapter in enumerate(_common_base(plan.chapters))
                            ]
                        )
                    total_frames = max(1, len(output_frame_times(plan, analysis)))
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
                        percent = int(current / duration * 100)
                        if percent != last_progress:
                            report(EncodeStage.COPYING, "Copying", current)
                            last_progress = percent
                    # finalizing the container writes the joined index and duration
                    report(EncodeStage.JOINING, "Joining")
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
            if on_progress is not None:
                on_progress(EncodeProgress(stage=EncodeStage.FAILED, message=str(exc)))
            raise CutAnalysisError("cut_failed", f"The cut could not be saved: {exc}") from exc
