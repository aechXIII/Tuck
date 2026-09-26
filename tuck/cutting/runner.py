from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Event

import av

from ..encoding.output import OutputTransaction
from ..media_tools import find_ffmpeg
from ..models.cutting import CutPlan
from ..models.progress import EncodeProgress, EncodeStage
from .analysis import CutAnalysisError
from .exact import encode_edges, exact_packets
from .packets import check_cut_cancel, prepare_cut, selected_packets
from .verification import verify_cut_output


class CutRunner:
    def __init__(self, *, ffprobe: str | None = None, ffmpeg: str | None = None) -> None:
        self._cancel = Event()
        self._ffprobe = ffprobe
        self._ffmpeg = ffmpeg

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
                result = transaction.workspace / "result.mp4"
                edges = None
                if plan.precision == "exact":
                    report(EncodeStage.ENCODING_EDGES, "Encoding cut edges")
                    ffmpeg = self._ffmpeg or find_ffmpeg()
                    if not ffmpeg:
                        raise CutAnalysisError("cut_failed", "FFmpeg is not available.")
                    edges = encode_edges(
                        plan,
                        analysis,
                        transaction.workspace,
                        self._cancel,
                        ffmpeg=ffmpeg,
                        on_frame=lambda: check_cut_cancel(self._cancel),
                    )
                report(EncodeStage.COPYING, "Copying")
                with (
                    av.open(plan.identity.path) as incoming,
                    av.open(
                        str(result),
                        "w",
                        format="mp4",
                        options={"movflags": "+use_metadata_tags"},
                    ) as outgoing,
                ):
                    outgoing.metadata.update(incoming.metadata)
                    streams = {}
                    for stream in incoming.streams:
                        if stream.type == "video" or (
                            stream.type == "audio" and plan.include_audio
                        ):
                            # copying decoder parameters avoids requiring an installed encoder
                            target = outgoing.add_stream_from_template(
                                stream,
                                opaque=True,
                                time_base=stream.time_base,
                                disposition=stream.disposition.value,
                            )
                            target.metadata.update(stream.metadata)
                            if edges is not None and stream.type == "video":
                                # lists the encoded edges' parameter sets beside the source's
                                target.codec_context.extradata = edges.extradata
                            streams[stream.index] = target
                    copied = 0
                    last_progress = -1
                    packets = selected_packets(incoming, plan, analysis, self._cancel)
                    if edges is not None:
                        packets = exact_packets(
                            packets,
                            plan,
                            analysis,
                            edges,
                            incoming.streams.video[0],
                            self._cancel,
                        )
                    for packet in packets:
                        if packet.stream.type == "video":
                            copied += 1
                        packet.stream = streams[packet.stream.index]
                        outgoing.mux(packet)
                        current = float(copied * analysis.frame_duration.seconds)
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
