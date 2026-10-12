from __future__ import annotations

import math
import re
from fractions import Fraction

import pytest

from tuck.encoding.command import _tmix_graph
from tuck.encoding.frame_blending import TmixBlend, TmixPiece

Contributions = dict[int, Fraction]


def evaluate_graph(graph: list[str], source_count: int, source_rate: int) -> list[Contributions]:
    # track source identities and weights only; no media, pixels or FFmpeg processes
    streams = {"0:v": [{index: Fraction(1)} for index in range(source_count)]}
    for part in graph:
        parsed = re.fullmatch(r"((?:\[[^]]+\])+)([^[]+)((?:\[[^]]+\])+)", part)
        assert parsed is not None, part
        inputs, chain, outputs = parsed.groups()
        incoming = [streams[label] for label in re.findall(r"\[([^]]+)\]", inputs)]
        frames = incoming[0]
        for operation in re.split(r",(?=(?:[^']*'[^']*')*[^']*$)", chain):
            name, _, options = operation.partition("=")
            if name == "trim":
                values = dict(value.split("=", 1) for value in options.split(":"))
                frames = [
                    frame
                    for frame in frames
                    if Fraction(values["start"])
                    <= Fraction(next(iter(frame)), source_rate)
                    < Fraction(values["end"])
                ]
            elif name == "tpad":
                values = dict(value.split("=", 1) for value in options.split(":"))
                assert values.get("start_mode", "clone") == "clone"
                assert values.get("stop_mode", "clone") == "clone"
                frames = (
                    [frames[0]] * int(values.get("start", "0"))
                    + frames
                    + [frames[-1]] * int(values.get("stop", "0"))
                )
            elif name == "select":
                expression = options.strip("'").replace("\\", "")
                selection = re.fullmatch(
                    r"between\(n,(\d+),(\d+)\)\*not\(mod\(n-(\d+),(\d+)\)\)", expression
                )
                assert selection is not None, expression
                first, last, offset, step = map(int, selection.groups())
                frames = [
                    frame
                    for index, frame in enumerate(frames)
                    if first <= index <= last and (index - offset) % step == 0
                ]
            elif name == "mix":
                values = dict(value.split("=", 1) for value in options.split(":"))
                weights = [Fraction(value) for value in values["weights"].strip("'").split()]
                assert int(values["inputs"]) == len(incoming) == len(weights)
                assert values["duration"] == "shortest"
                frames = []
                for samples in zip(*incoming, strict=True):
                    combined: Contributions = {}
                    for sample, weight in zip(samples, weights, strict=True):
                        for source, contribution in sample.items():
                            combined[source] = combined.get(
                                source, Fraction(0)
                            ) + contribution * weight / sum(weights)
                    frames.append(combined)
            elif name == "tmix":
                values = dict(value.split("=", 1) for value in options.split(":"))
                weights = [Fraction(value) for value in values["weights"].strip("'").split()]
                assert int(values["frames"]) == len(weights)
                mixed = []
                for index in range(len(frames)):
                    combined = {}
                    for offset, weight in enumerate(weights):
                        sample = frames[max(0, index - len(weights) + 1 + offset)]
                        for source, contribution in sample.items():
                            combined[source] = combined.get(
                                source, Fraction(0)
                            ) + contribution * weight / sum(weights)
                    mixed.append(combined)
                frames = mixed
            elif name == "concat":
                frames = [frame for stream in incoming for frame in stream]
            else:
                assert name in {"setpts", "settb", "fps", "split", "null"}, operation
        for label in re.findall(r"\[([^]]+)\]", outputs):
            streams[label] = frames
    return streams["vout"]


def previous_contributions(
    piece: TmixPiece, source_rate: int, source_count: int = 60
) -> list[Contributions]:
    source = [
        index
        for index in range(source_count)
        if max(Fraction(0), piece.start) <= Fraction(index, source_rate) < piece.end
    ]
    weights = [Fraction(format(float(weight), ".9g")) for weight in piece.weights]
    frames = []
    for index in range(piece.first, piece.last + 1, piece.step):
        combined: Contributions = {}
        for offset, weight in enumerate(weights):
            sample = source[max(0, index - len(weights) + 1 + offset)]
            combined[sample] = combined.get(sample, Fraction(0)) + weight / sum(weights)
        frames.append(combined)
    return [frames[0]] * piece.lead + frames + [frames[-1]] * piece.trail


@pytest.mark.parametrize("first,last,lead,trail", [(2, 17, 0, 0), (0, 18, 2, 1), (1, 1, 1, 3)])
@pytest.mark.parametrize(
    "weights", [(Fraction(1),) * 3, (Fraction(1, 4), Fraction(1), Fraction(3, 4))]
)
def test_select_then_mix_preserves_source_contributions_and_cut_padding(
    first, last, lead, trail, weights
):
    piece = TmixPiece(Fraction(5, 60), Fraction(45, 60), weights, first, last, 3, lead, trail)
    graph = _tmix_graph(TmixBlend(Fraction(10), (piece,)), [])
    assert not any("tmix=" in part for part in graph)
    assert evaluate_graph(graph, 60, 30) == previous_contributions(piece, 30)


def test_select_then_mix_keeps_reordered_segments_separate():
    pieces = (
        TmixPiece(Fraction(49, 60), Fraction(89, 60), (Fraction(1),) * 3, 0, 18, 3, 1, 2),
        TmixPiece(Fraction(1, 60), Fraction(21, 60), (Fraction(1),) * 3, 2, 8, 3, 0, 1),
    )
    graph = _tmix_graph(TmixBlend(Fraction(10), pieces), [])
    expected = [frame for piece in pieces for frame in previous_contributions(piece, 30)]
    assert evaluate_graph(graph, 60, 30) == expected


def test_optimized_and_legacy_segments_join_with_the_same_contributions():
    pieces = (
        TmixPiece(Fraction(49, 60), Fraction(89, 60), (Fraction(1),) * 3, 0, 18, 3, 1, 2),
        TmixPiece(Fraction(1, 60), Fraction(21, 60), (Fraction(1),) * 2, 2, 8, 3, 0, 1),
    )
    graph = _tmix_graph(TmixBlend(Fraction(10), pieces), [])
    assert any("mix=inputs=" in part for part in graph)
    assert any("tmix=" in part for part in graph)
    expected = [frame for piece in pieces for frame in previous_contributions(piece, 30)]
    assert evaluate_graph(graph, 60, 30) == expected


@pytest.mark.parametrize(
    "weights,step",
    [
        ((Fraction(1),) * 2, 2),
        ((Fraction(1),) * 4, 3),
        ((Fraction(1, 3),) * 3, 3),
        ((Fraction(1), Fraction(999_999_999, 1_000_000_000)), 3),
        ((Fraction(1),), 3),
        ((Fraction(1),) * 3, 1),
    ],
)
def test_keep_tmix_where_rounding_differs_or_selection_cannot_reduce_work(weights, step):
    piece = TmixPiece(Fraction(0), Fraction(1), weights, 2, 8, step, 0, 0)
    graph = _tmix_graph(TmixBlend(Fraction(10), (piece,)), [])
    assert any("tmix=" in part for part in graph)
    assert not any("mix=inputs=" in part for part in graph)


def test_select_then_mix_keeps_the_fractional_output_clock_and_final_filters():
    piece = TmixPiece(Fraction(0), Fraction(1), (Fraction(1),) * 5, 4, 24, 5, 0, 0)
    graph = _tmix_graph(TmixBlend(Fraction(60_000, 1001), (piece,)), ["hflip"])
    selected = [part for part in graph if "select=" in part]
    assert len(selected) == 5
    assert all("settb=1001/60000,setpts=N" in part for part in selected)
    assert graph[-1] == "[blend0]hflip[vout]"
    assert "fps=60000/1001[blend0]" in graph[-2]


def test_odd_unit_weight_mix_rounding_matches_tmix_for_every_possible_sum():
    import numpy as np

    for count in range(3, 256, 2):
        totals = np.arange(255 * count + 1, dtype=np.int32)
        mixed = np.rint(totals.astype(np.float32) * np.float32(1 / count))
        assert np.array_equal(mixed, (totals + count // 2) // count)


@pytest.mark.parametrize("source_rate", [90, 180])
@pytest.mark.parametrize("amount", [0.5, 1, 2, 4])
@pytest.mark.parametrize(
    "segments", [[(0, 1)], [(1.013, 2.4), (3.3, 4.05)], [(4.2, 5.1), (0.5, 1.7)]]
)
def test_planned_blends_keep_the_previous_frame_schedule(
    monkeypatch, source_rate, amount, segments
):
    from tuck.encoding import frame_blending
    from tuck.models import EncodePlan, Segment, VideoInfo
    from tuck.models.frame_blending import FrameBlending

    monkeypatch.setattr(
        frame_blending, "_frame_grid", lambda *_: (Fraction(0), Fraction(1, source_rate))
    )
    info = VideoInfo("in.mp4", 6, 16, 16, source_rate, "h264", pixel_format="yuv420p")
    plan = EncodePlan(
        source="in.mp4",
        output="out.mp4",
        source_info=info,
        target_fps=30,
        segments=[Segment(start, end) for start, end in segments],
        frame_blending=FrameBlending(enabled=True, amount=amount),
    )
    blend = frame_blending.tmix_blend(plan)
    assert blend is not None
    source_count = 6 * source_rate
    expected = [
        frame
        for piece in blend.pieces
        for frame in previous_contributions(piece, source_rate, source_count)
    ]
    assert len(expected) == math.ceil(plan.effective_duration * plan.target_fps - 1e-8)
    assert evaluate_graph(_tmix_graph(blend, []), source_count, source_rate) == expected
