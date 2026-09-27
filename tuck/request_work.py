"""How long one desktop request may keep working, and whether its caller gave up on it."""

from __future__ import annotations

from threading import Event
from time import monotonic

# leave time to return a refusal before the native 120-second request timeout
REQUEST_SECONDS = 90.0


class RequestWork(Event):
    """Set when the request is cancelled; `expired` once its time budget is spent."""

    def __init__(self, seconds: float = REQUEST_SECONDS) -> None:
        super().__init__()
        self.deadline = monotonic() + seconds

    @property
    def expired(self) -> bool:
        return monotonic() >= self.deadline
