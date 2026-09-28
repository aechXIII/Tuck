from __future__ import annotations

EXPORT_TASKS: tuple[str, ...] = ("compression", "upscale", "cut")

# order here is the stored order, so saved lists stay stable across edits
HIDDEN_UI_PARTS: tuple[str, ...] = (
    *EXPORT_TASKS,
    "panel_video",
    "panel_audio",
    "audio_editing",
    "frame_blending",
    "lut",
)

START_TASK_LAST = "last"
START_TASKS: tuple[str, ...] = (START_TASK_LAST, *EXPORT_TASKS)

ALL_TASKS_HIDDEN_ERROR = "Keep at least one of Compress, Upscale, or Lossless cut visible."


def normalize_hidden_ui(value: object) -> list[str]:
    """Return the hidden parts deduplicated in canonical order.

    Raises ValueError with a message that can be shown to the user.
    """
    if not isinstance(value, list):
        raise ValueError("hidden_ui must be a list of interface parts")
    for item in value:
        if not isinstance(item, str):
            raise ValueError("hidden_ui must only list interface part names")
        if item not in HIDDEN_UI_PARTS:
            raise ValueError(f"hidden_ui has an unknown interface part: {item}")
    hidden = [part for part in HIDDEN_UI_PARTS if part in value]
    if all(task in hidden for task in EXPORT_TASKS):
        raise ValueError(ALL_TASKS_HIDDEN_ERROR)
    return hidden


def normalize_start_task(value: object) -> str:
    if not isinstance(value, str) or value not in START_TASKS:
        raise ValueError("start_task must be last, compression, upscale, or cut")
    return value
