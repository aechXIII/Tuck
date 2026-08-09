from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class EncodeStage(Enum):
    PREPARING = "preparing"
    PROBING = "probing"
    ENCODING = "encoding"
    PASS_1 = "pass_1"
    PASS_2 = "pass_2"
    RETRYING = "retrying"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class EncodeProgress:
    percent: float = 0.0
    stage: EncodeStage = EncodeStage.PREPARING
    current_time: float = 0.0
    duration: float = 0.0
    speed: float | None = None
    eta_seconds: float | None = None
    pass_number: int | None = None
    total_passes: int | None = None
    retry_number: int | None = None
    max_retries: int | None = None
    message: str = ""

    def to_dict(self) -> dict:
        return {
            "percent": round(float(self.percent), 1),
            "stage": self.stage.value,
            "current_time": round(float(self.current_time), 3),
            "duration": round(float(self.duration), 3),
            "speed": round(float(self.speed), 2) if self.speed is not None else None,
            "eta_seconds": round(float(self.eta_seconds), 1)
            if self.eta_seconds is not None
            else None,
            "pass_number": self.pass_number,
            "total_passes": self.total_passes,
            "retry_number": self.retry_number,
            "max_retries": self.max_retries,
            "message": self.message,
            "status_text": self.status_text(),
        }

    def status_text(self) -> str:
        stage = self.stage
        if stage == EncodeStage.PREPARING:
            return "Preparing"
        if stage == EncodeStage.PROBING:
            return "Probing"
        if stage == EncodeStage.PASS_1:
            total = self.total_passes or 2
            return f"Pass 1 of {total}"
        if stage == EncodeStage.PASS_2:
            total = self.total_passes or 2
            return f"Pass 2 of {total}"
        if stage == EncodeStage.RETRYING:
            parts = ["Retrying"]
            if self.retry_number is not None and self.max_retries is not None:
                parts.append(f"Attempt {self.retry_number} of {self.max_retries}")
            if self.message:
                parts.append(self.message)
            return " · ".join(parts)
        if stage == EncodeStage.VERIFYING:
            return self.message or "Verifying output"
        if stage == EncodeStage.COMPLETED:
            return "Completed"
        if stage == EncodeStage.FAILED:
            return "Failed"
        if stage == EncodeStage.CANCELLED:
            return "Cancelled"
        if stage == EncodeStage.ENCODING:
            if self.pass_number and self.total_passes and self.total_passes > 1:
                return f"Pass {self.pass_number} of {self.total_passes}"
            return "Encoding"
        return stage.value.replace("_", " ").title()
