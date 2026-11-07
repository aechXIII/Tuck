"""Save as GIF's preview: the real GIF, made again as the settings change.

The size the dialog shows is the file's size, so a size limit is met on the real file. A timeline
over half a minute is previewed from three pieces of a second, the way Quality's size estimate
samples an export: on game recordings their size came within 4% of the whole GIF.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .encoding.gif import gif_dimensions, gif_output_seconds, preview_plan
from .encoding.runner import EncodeCancelled, FFmpegEngine
from .models import EncodePlan
from .size_estimate import sample_pieces

PREVIEW_LONGEST = 30.0


@dataclass(frozen=True)
class GifPreview:
    path: Path
    size: int
    width: int
    height: int
    fps: float
    frames: int
    lowered: bool
    fits: bool
    # the size comes from pieces of a longer timeline
    estimated: bool
    # how long the whole GIF plays
    seconds: float
    # the width and frame rate a size limit starts lowering from
    start_width: int
    start_fps: float
    # the file name Save gives it
    name: str


class GifPreviews:
    """Makes one preview at a time: a new one, or cancel(), stops the one before it."""

    def __init__(
        self,
        cache_dir: Callable[[], Path],
        engine_factory: Callable[[], FFmpegEngine] = FFmpegEngine,
    ) -> None:
        self._cache_dir = cache_dir
        self._engine_factory = engine_factory
        self._lock = threading.Lock()
        self._engine: FFmpegEngine | None = None
        self._generation = 0
        self._swept = False

    def _folder(self) -> Path:
        root = self._cache_dir() / "gif-previews"
        root.mkdir(parents=True, exist_ok=True)
        if not self._swept:
            # previews left by an earlier run of Tuck are never shown again
            for stale in root.glob("preview-*.gif"):
                stale.unlink(missing_ok=True)
            self._swept = True
        return root

    def make(self, plan: EncodePlan) -> GifPreview:
        if plan.gif is None:
            raise ValueError("This export isn't a GIF")
        engine = self._engine_factory()
        with self._lock:
            older, self._engine = self._engine, engine
            self._generation += 1
            generation = self._generation
            output = self._folder() / f"preview-{uuid.uuid4().hex}.gif"
        if older is not None:
            older.cancel()
        sample, scale = preview_plan(
            plan, longest=PREVIEW_LONGEST, pieces=sample_pieces(plan.effective_segments)
        )
        try:
            result = engine.make_gif(sample, output, size_scale=scale)
            with self._lock:
                if self._generation != generation:
                    raise EncodeCancelled("A newer preview started")
        except BaseException:
            output.unlink(missing_ok=True)
            raise
        finally:
            with self._lock:
                if self._engine is engine:
                    self._engine = None
        return GifPreview(
            path=output,
            size=result.size,
            width=result.width,
            height=result.height,
            fps=result.fps,
            frames=round(result.frames * scale),
            lowered=result.lowered,
            fits=result.fits,
            estimated=scale != 1.0,
            seconds=gif_output_seconds(plan, plan.gif),
            start_width=gif_dimensions(plan, plan.gif.width)[0],
            start_fps=plan.gif.fps,
            name=Path(plan.output).name,
        )

    def cancel(self) -> bool:
        with self._lock:
            self._generation += 1
            engine, self._engine = self._engine, None
        if engine is not None:
            engine.cancel()
        return engine is not None
