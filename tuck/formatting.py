from __future__ import annotations


def format_size(bytes_val: int | float) -> str:
    size = float(bytes_val)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"
