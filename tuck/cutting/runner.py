from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import Event

import av

from ..encoding.output import OutputTransaction
from ..models.cutting import CutPlan
from ..models.progress import EncodeProgress, EncodeStage
from .analysis import CutAnalysisError
from .packets import check_cut_cancel, prepare_cut, selected_packets
from .verification import verify_cut_output


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
                        in {EncodeStage.PREPARING, EncodeStage.JOINING, EncodeStage.VERIFYING},
                    )
                )
            if stage != EncodeStage.COMPLETED:
                check_cut_cancel(self._cancel)

        try:
            report(EncodeStage.PREPARING, "Preparing")
            analysis = prepare_cut(plan, self._cancel, self._ffprobe)
            with OutputTransaction(Path(plan.output_path)) as transaction:
                result = transaction.workspace / "result.mp4"
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
                            streams[stream.index] = target
                    copied = 0
                    last_progress = -1
                    for packet in selected_packets(incoming, plan, analysis, self._cancel):
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
                    plan, result, self._cancel, analysis=analysis, ffprobe=self._ffprobe
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
