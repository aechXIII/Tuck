from __future__ import annotations

import numpy as np
import pytest

from tuck.encoding import frame_blending, native_blending
from tuck.models.frame_blending import FrameBlending, interval_weight, vegas_weights


def test_encoded_blending_uses_the_original_quantized_weights(monkeypatch):
    pictures = [np.full((3, 5, 3), n, dtype=np.uint8) for n in (9, 87, 231)]
    weights = [0.1, 0.7, 0.2]
    expected = np.full((3, 5, 3), 117, dtype=np.uint8)
    calls = []

    def native(inputs, quantized):
        assert all(a is b for a, b in zip(inputs, pictures, strict=True))
        assert quantized == frame_blending._integer_weights(weights)
        calls.append(True)
        return expected

    monkeypatch.setattr(native_blending, "blend_encoded", native)
    actual = frame_blending._blend(list(zip(pictures, weights, strict=True)), None, "bt709")
    assert actual is expected
    assert calls == [True]


def test_linear_blending_keeps_existing_normalization_and_inverse_transfer(monkeypatch):
    pictures = [np.full((3, 5, 3), n, dtype=np.uint8) for n in (4, 89, 248)]
    weights = [0.1, 0.7, 0.2]
    lookup = frame_blending.to_linear(np.arange(256, dtype=np.float32) / np.float32(255), "bt709")
    sums = np.zeros(pictures[0].shape, dtype=np.float32)
    normalized = [np.float32(weight / sum(weights)) for weight in weights]
    for picture, weight in zip(pictures, normalized, strict=True):
        sums += lookup[picture] * weight
    expected = np.rint(frame_blending.from_linear(sums, "bt709") * 255).astype(np.uint8)
    calls = []

    def native(inputs, actual_weights, actual_lookup):
        assert all(a is b for a, b in zip(inputs, pictures, strict=True))
        np.testing.assert_array_equal(actual_weights, normalized)
        assert actual_lookup is lookup
        calls.append(True)
        return sums.copy()

    monkeypatch.setattr(native_blending, "accumulate_linear", native)
    actual = frame_blending._blend(list(zip(pictures, weights, strict=True)), lookup, "bt709")
    np.testing.assert_array_equal(actual, expected)
    assert calls == [True]


@pytest.mark.parametrize(
    "curve", ["gaussian", "triangular", "ascending", "descending", "vegas", "custom"]
)
@pytest.mark.parametrize(
    "transfer", [None, "bt709", "smpte170m", "iec61966-2-1", "linear", "gamma22", "gamma28"]
)
def test_all_weighted_modes_match_numpy_exactly(curve, transfer, monkeypatch):
    if native_blending._load_library() is None:
        pytest.skip("native helper has not been built")
    rng = np.random.default_rng(95)
    pictures = [rng.integers(0, 256, (17, 31, 3), dtype=np.uint8) for _ in range(7)]
    settings = FrameBlending(
        curve="equal" if curve == "custom" else curve,
        sigma=0.19,
        peak=0.27,
        power=2.3,
        custom_weights=(0, 7, 0.1, 0, 3) if curve == "custom" else (),
    )
    vegas = vegas_weights(240, 60, 1) if curve == "vegas" else ()
    weights = [interval_weight(settings, i / 7, (i + 1) / 7, vegas=vegas) for i in range(7)]
    weighted = list(zip(pictures, weights, strict=True))
    lookup = (
        None
        if transfer is None
        else frame_blending.to_linear(np.arange(256, dtype=np.float32) / np.float32(255), transfer)
    )
    actual = frame_blending._blend(weighted, lookup, transfer or "bt709")
    monkeypatch.setattr(native_blending, "blend_encoded", lambda *_: None)
    monkeypatch.setattr(native_blending, "accumulate_linear", lambda *_: None)
    expected = frame_blending._blend(weighted, lookup, transfer or "bt709")
    np.testing.assert_array_equal(actual, expected)
