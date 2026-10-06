from __future__ import annotations

OUTPUT_LOCATION_SOURCE = "source"
OUTPUT_LOCATION_SUBFOLDER = "subfolder"
OUTPUT_LOCATION_FOLDER = "folder"
OUTPUT_LOCATIONS: tuple[str, ...] = (
    OUTPUT_LOCATION_SOURCE,
    OUTPUT_LOCATION_SUBFOLDER,
    OUTPUT_LOCATION_FOLDER,
)

DEFAULT_OUTPUT_SUBFOLDER = "Tucked"
OUTPUT_SUBFOLDER_MAX_LENGTH = 64
_INVALID_NAME_CHARS = frozenset('<>:"/\\|?*')
_RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "CONIN$",
        "CONOUT$",
        # Windows also reserves the superscript digits ¹ ² ³
        *(f"{port}{digit}" for port in ("COM", "LPT") for digit in "¹²³"),
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)


def normalize_output_location(value: object) -> str:
    if not isinstance(value, str) or value not in OUTPUT_LOCATIONS:
        raise ValueError("output_location must be source, subfolder, or folder")
    return value


def normalize_output_subfolder(value: object) -> str:
    """Check the folder name used when exports go into a folder beside each source.

    It is a single name, never a path, so an export can't land outside the
    source's own folder. Raises ValueError with a message that can be shown.
    """
    if not isinstance(value, str):
        raise ValueError("output_subfolder must be a string")
    name = value.strip()
    if not name:
        raise ValueError("Enter a name for the export folder.")
    if len(name) > OUTPUT_SUBFOLDER_MAX_LENGTH:
        raise ValueError(
            f"The export folder name must be {OUTPUT_SUBFOLDER_MAX_LENGTH} characters or fewer."
        )
    if (
        name in (".", "..")
        or name.endswith(".")
        or any(ord(char) < 32 or char in _INVALID_NAME_CHARS for char in name)
    ):
        raise ValueError(
            'The export folder name cannot contain \\ / : * ? " < > | or end with a period.'
        )
    if name.split(".", 1)[0].rstrip().upper() in _RESERVED_NAMES:
        raise ValueError("Windows reserves that name. Choose another folder name.")
    return name


NAME_TAKEN_NUMBER = "number"
NAME_TAKEN_REPLACE = "replace"
NAME_TAKEN_CHOICES: tuple[str, ...] = (NAME_TAKEN_NUMBER, NAME_TAKEN_REPLACE)


def output_targets(location: str, output_dir: str, subfolder: str) -> tuple[str, str]:
    """Return the (folder, subfolder) pair the planners use for a stored location.

    Only one of the two is ever set. A chosen folder that was never picked falls
    back to saving beside the source.
    """
    if location == OUTPUT_LOCATION_FOLDER and output_dir:
        return output_dir, ""
    if location == OUTPUT_LOCATION_SUBFOLDER:
        try:
            return "", normalize_output_subfolder(subfolder)
        except ValueError:
            return "", DEFAULT_OUTPUT_SUBFOLDER
    return "", ""
