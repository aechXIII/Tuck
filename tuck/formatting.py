from __future__ import annotations


def format_size(bytes_val: int | float) -> str:
    size = float(bytes_val)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def format_clock(seconds: float) -> str:
    """A length the way a player shows it: 0:45, 12:05 or 1:00:00."""
    total = max(1, round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"
