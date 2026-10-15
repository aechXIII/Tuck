from __future__ import annotations

import re

from .export_preferences import NAME_TAKEN_CHOICES

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


DEFAULT_CUT_SUFFIX = "_cut"
CUT_SUFFIX_MAX_LENGTH = 64
_INVALID_FILE_NAME_CHARS = frozenset('<>:"/\\|?*')


def _check_file_name_text(value: str, label: str) -> None:
    # the suffix lands inside the export's file name, so a separator would move the export
    # into another folder and a colon would write an NTFS alternate data stream
    if any(ord(char) < 32 or char in _INVALID_FILE_NAME_CHARS for char in value):
        raise ValueError(
            f'The {label} suffix cannot contain \\ / : * ? " < > | or control characters.'
        )


def normalize_cut_suffix(value: object) -> str:
    """Check the text added to a cut's file name before its extension.

    Cuts keep the source name, so unlike the encode suffixes no {tokens} are
    filled in. Raises ValueError with a message that can be shown to the user.
    """
    if not isinstance(value, str):
        raise ValueError("cut_suffix must be a string")
    if not value.strip():
        raise ValueError("Enter a suffix for lossless cut file names.")
    if len(value) > CUT_SUFFIX_MAX_LENGTH:
        raise ValueError(
            f"The lossless cut suffix must be {CUT_SUFFIX_MAX_LENGTH} characters or fewer."
        )
    _check_file_name_text(value, "lossless cut")
    if "{" in value or "}" in value:
        raise ValueError("The lossless cut suffix cannot use tokens like {size}.")
    return value


# the encode suffixes; {size}, {width} and {height} are filled in with numbers
_ENCODE_SUFFIX_LABELS = {"compression_suffix": "compress", "upscale_suffix": "upscale"}
ENCODE_SUFFIXES: tuple[str, ...] = tuple(_ENCODE_SUFFIX_LABELS)


def normalize_encode_suffix(key: str, value: object) -> str:
    """Check the compress or upscale suffix added to an export's file name.

    Raises ValueError with a message that can be shown to the user.
    """
    label = _ENCODE_SUFFIX_LABELS[key]
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    if not value.strip():
        raise ValueError(f"Enter a suffix for {label} file names.")
    _check_file_name_text(value, label)
    return value


def normalize_timeline_toggle(key: str, value: object) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be boolean")
    return value


# on/off preferences; a stored value that isn't a boolean falls back to the default
FLAG_PREFERENCES: tuple[str, ...] = (
    "timeline_snap",
    "timeline_keyframes",
    "timeline_frames",
    "animations",
    "reopen_last_videos",
    "keep_file_dates",
    "notify_when_done",
    "keep_awake",
    "background_exports",
    "loop_playback",
    "remove_after_export",
)

ACCENT_COLORS: tuple[str, ...] = ("violet", "blue", "teal", "green", "amber", "rose")
INTERFACE_SIZES: tuple[str, ...] = ("compact", "default", "large")
TEXT_SIZES: tuple[str, ...] = ("default", "large", "extra_large")
TIMELINE_STYLES: tuple[str, ...] = ("graphite", "violet")
TIME_FORMATS: tuple[str, ...] = ("seconds", "timecode", "frames")
TIMELINE_FRAME_MODES: tuple[str, ...] = ("center", "whole")
# how far Shift with the arrow keys skips, in seconds
SKIP_LENGTHS: tuple[str, ...] = ("1", "3", "5", "10")

# the frontend owns what each choice looks like; Python only keeps the stored value known
CHOICE_PREFERENCES: dict[str, tuple[str, ...]] = {
    "accent_color": ACCENT_COLORS,
    "interface_size": INTERFACE_SIZES,
    "text_size": TEXT_SIZES,
    "timeline_style": TIMELINE_STYLES,
    "time_format": TIME_FORMATS,
    "timeline_frame_mode": TIMELINE_FRAME_MODES,
    "skip_seconds": SKIP_LENGTHS,
    "name_taken": NAME_TAKEN_CHOICES,
}


def migrate_appearance_preferences(data: dict[str, object]) -> dict[str, object]:
    # older Large settings enlarged text too; Compact now keeps the default text size
    if "interface_size" in data and "text_size" not in data:
        return {**data, "text_size": "large" if data["interface_size"] == "large" else "default"}
    return data


def normalize_choice(key: str, value: object) -> str:
    choices = CHOICE_PREFERENCES[key]
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{key} must be one of: {', '.join(choices)}")
    return value


# pinned and hidden profiles in the picker; ids only, so profiles.json keeps its format
PROFILE_LIST_PREFERENCES: tuple[str, ...] = ("pinned_profile_ids", "hidden_profile_ids")
PROFILE_LIST_MAX = 200
_PROFILE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def normalize_profile_ids(key: str, value: object) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{key} must be a list of profile ids")
    if len(value) > PROFILE_LIST_MAX:
        raise ValueError(f"{key} can list at most {PROFILE_LIST_MAX} profiles")
    clean: list[str] = []
    for item in value:
        if not isinstance(item, str) or not _PROFILE_ID.match(item):
            raise ValueError(f"{key} must only list profile ids")
        if item not in clean:
            clean.append(item)
    return clean


def clean_profile_ids(value: object) -> list[str]:
    """Keep the usable ids from a stored value instead of dropping the whole list."""
    if not isinstance(value, list):
        return []
    clean: list[str] = []
    for item in value:
        if isinstance(item, str) and _PROFILE_ID.match(item) and item not in clean:
            clean.append(item)
    return clean[:PROFILE_LIST_MAX]


SESSION_FILES_MAX = 500
SESSION_PATH_MAX_LENGTH = 4096


def _session_path(value: object) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > SESSION_PATH_MAX_LENGTH
        or "\x00" in value
    ):
        return None
    return value


def normalize_session_files(value: object) -> list[str]:
    """Check the Library list kept for the next launch.

    Paths are only checked for shape here; files that are gone by the next
    launch are skipped when the list is read back.
    """
    if not isinstance(value, list):
        raise ValueError("last_session_files must be a list of file paths")
    if len(value) > SESSION_FILES_MAX:
        raise ValueError(f"Only {SESSION_FILES_MAX} videos can be reopened.")
    clean: list[str] = []
    for item in value:
        path = _session_path(item)
        if path is None:
            raise ValueError("last_session_files must only list file paths")
        if path not in clean:
            clean.append(path)
    return clean


def clean_session_files(value: object) -> list[str]:
    """Keep the usable paths from a stored value instead of dropping the whole list."""
    if not isinstance(value, list):
        return []
    clean: list[str] = []
    for item in value:
        path = _session_path(item)
        if path is not None and path not in clean:
            clean.append(path)
        if len(clean) == SESSION_FILES_MAX:
            break
    return clean


SHORTCUT_OVERRIDES_MAX_COMMANDS = 64
SHORTCUT_COMMAND_MAX_LENGTH = 64
SHORTCUT_KEYS_PER_COMMAND = 3
SHORTCUT_COMBO_MAX_LENGTH = 40
SHORTCUT_MODIFIERS: tuple[str, ...] = ("Ctrl", "Alt", "Shift", "Meta")
_SHORTCUT_COMMAND = re.compile(r"[a-z0-9]+(?:[.-][a-z0-9]+)*")
_SHORTCUT_NAMED_KEYS = frozenset(
    {
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Space",
        "Escape",
        "Delete",
        "Backspace",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Enter",
        "Tab",
        *(f"F{number}" for number in range(1, 25)),
    }
)


def _shortcut_combo_key(combo: str) -> tuple[frozenset[str], str] | None:
    """Split a combo like "Ctrl+Shift+Z" into its modifiers and key, or None if invalid."""
    if not combo or len(combo) > SHORTCUT_COMBO_MAX_LENGTH:
        return None
    # "+" is a key too, so "Ctrl++" means Ctrl and the plus key
    if combo == "+":
        modifiers: list[str] = []
        key = "+"
    elif combo.endswith("++"):
        modifiers = combo[:-2].split("+")
        key = "+"
    else:
        *modifiers, key = combo.split("+")
    if any(modifier not in SHORTCUT_MODIFIERS for modifier in modifiers):
        return None
    if len(set(modifiers)) != len(modifiers):
        return None
    single = len(key) == 1 and key.isprintable() and not key.isspace()
    if not single and key not in _SHORTCUT_NAMED_KEYS:
        return None
    return frozenset(modifiers), key


def _describe_combo(combo: object) -> str:
    if isinstance(combo, str) and 0 < len(combo) <= SHORTCUT_COMBO_MAX_LENGTH:
        return f'"{combo}"'
    return "One of the keys"


def _normalize_shortcut_entry(command: object, combos: object) -> list[str]:
    if (
        not isinstance(command, str)
        or len(command) > SHORTCUT_COMMAND_MAX_LENGTH
        or not _SHORTCUT_COMMAND.fullmatch(command)
    ):
        raise ValueError("A keyboard shortcut belongs to a command Tuck does not know.")
    if not isinstance(combos, list):
        raise ValueError("Keyboard shortcuts must be listed for each command.")
    if len(combos) > SHORTCUT_KEYS_PER_COMMAND:
        raise ValueError(
            f"A command can have at most {SHORTCUT_KEYS_PER_COMMAND} keyboard shortcuts."
        )
    seen: set[tuple[frozenset[str], str]] = set()
    clean: list[str] = []
    for combo in combos:
        parsed = _shortcut_combo_key(combo) if isinstance(combo, str) else None
        if parsed is None:
            raise ValueError(f"{_describe_combo(combo)} is not a key combination Tuck supports.")
        if parsed in seen:
            raise ValueError(f'"{combo}" is listed twice for the same command.')
        seen.add(parsed)
        clean.append(combo)
    return clean


def normalize_shortcut_overrides(value: object) -> dict[str, list[str]]:
    """Return a clean copy of the user's keyboard shortcut changes.

    Maps a command id to its chosen key combos; an empty list means every key
    was removed from that command. The frontend owns the command list, so ids
    are only checked for shape. Raises ValueError with a message that can be
    shown to the user.
    """
    if not isinstance(value, dict):
        raise ValueError("shortcut_overrides must map commands to lists of keys")
    if len(value) > SHORTCUT_OVERRIDES_MAX_COMMANDS:
        raise ValueError(
            f"Only {SHORTCUT_OVERRIDES_MAX_COMMANDS} commands can have changed keyboard shortcuts."
        )
    return {
        command: _normalize_shortcut_entry(command, combos) for command, combos in value.items()
    }


def clean_shortcut_overrides(value: object) -> dict[str, list[str]]:
    """Keep the valid entries from a stored value, so one bad entry keeps its default keys."""
    if not isinstance(value, dict):
        return {}
    clean: dict[str, list[str]] = {}
    for command, combos in value.items():
        if len(clean) == SHORTCUT_OVERRIDES_MAX_COMMANDS:
            break
        try:
            clean[command] = _normalize_shortcut_entry(command, combos)
        except ValueError:
            continue
    return clean
