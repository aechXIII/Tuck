"""Shared display transforms for decoded video pictures."""

# libav reports counter-clockwise display rotation; transpose uses the same direction
UPRIGHT_FILTERS: dict[int, tuple[tuple[str, str], ...]] = {
    90: (("transpose", "cclock"),),
    180: (("hflip", ""), ("vflip", "")),
    270: (("transpose", "clock"),),
}
