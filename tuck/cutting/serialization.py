"""Serialize cut previews without losing integer media timestamps at the bridge."""

from ..bridge_contract import JsonValue
from ..models.cutting import CutIssue, CutPlan, CutRange
from .service import AnalysisSnapshot


def issue_dict(issue: CutIssue) -> dict[str, JsonValue]:
    return {"code": issue.code, "message": issue.message, "field": issue.field}


def range_dict(value: CutRange | None) -> JsonValue:
    if value is None:
        return None
    return {"start": value.start.to_dict(), "end": value.end.to_dict()}


def cut_plan_preview_dict(plan: CutPlan) -> dict[str, JsonValue]:
    return {
        "operation": "cut",
        "precision": plan.precision,
        "container": plan.container,
        "include_audio": plan.include_audio,
        "output_path": plan.output_path,
        "exported_duration": plan.exported_duration.to_dict(),
        "estimated_bytes": plan.estimated_bytes,
        "fingerprint": plan.fingerprint,
        "issues": [issue_dict(i) for i in plan.issues],
        "exact_available": plan.exact_available,
        "exact_reason": plan.exact_reason,
        "source_identity": {
            "path": plan.identity.path,
            "size": plan.identity.size,
            "mtime_ns": str(plan.identity.mtime_ns),
            "signature": plan.identity.signature,
        },
        "segments": [
            {
                "requested": range_dict(s.requested),
                "resolved": range_dict(s.resolved),
                "start_kind": s.start_kind,
                "end_frames_moved": s.end_frames_moved,
                "audio_source": range_dict(s.audio_source),
                "audio_output": range_dict(s.audio_output),
                "audio_packet_count": s.audio_packet_count,
            }
            for s in plan.segments
        ],
    }


def analysis_snapshot_dict(snapshot: AnalysisSnapshot) -> dict[str, JsonValue]:
    analysis = snapshot.analysis
    result: dict[str, JsonValue] = {
        "work_id": snapshot.work_id,
        "status": snapshot.status,
        "progress": snapshot.progress.progress,
        "coverage_end": snapshot.progress.coverage_end.to_dict(),
        "keyframes": [t.to_dict() for t in snapshot.progress.keyframes],
        "issue": issue_dict(snapshot.issue) if snapshot.issue else None,
        "analysis": None,
    }
    if analysis:
        result["analysis"] = {
            "duration": analysis.duration.to_dict(),
            "frame_duration": analysis.frame_duration.to_dict(),
            "exact_available": analysis.exact_available,
            "exact_reason": analysis.exact_reason,
            "issues": [issue_dict(i) for i in analysis.issues],
            "version": analysis.version,
            "streams": [
                {
                    "index": s.index,
                    "kind": s.kind,
                    "codec": s.codec,
                    "properties": dict(s.properties),
                    "metadata": dict(s.metadata),
                    "dispositions": list(s.dispositions),
                }
                for s in analysis.streams
            ],
        }
    return result
