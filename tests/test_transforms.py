import pytest

from tuck.models import (
    CROP_ASPECT_1_1,
    CROP_ASPECT_4_3,
    CROP_ASPECT_9_16,
    CROP_ASPECT_16_9,
    CROP_ASPECT_FREE,
    SIZING_MODE_FILL,
    SIZING_MODE_FIT,
    SIZING_MODE_STRETCH,
    CropRect,
    OutputGeometry,
    VideoTransform,
    calculate_transform_geometry,
    crop_for_aspect,
    fill_crop_dimensions,
    fit_output_dimensions,
)


@pytest.mark.parametrize(
    ("source", "aspect", "ratio"),
    [
        ((1920, 1080), CROP_ASPECT_16_9, (16, 9)),
        ((1920, 1080), CROP_ASPECT_9_16, (9, 16)),
        ((1920, 1080), CROP_ASPECT_1_1, (1, 1)),
        ((1920, 1080), CROP_ASPECT_4_3, (4, 3)),
        ((1080, 1920), CROP_ASPECT_16_9, (16, 9)),
        ((1080, 1920), CROP_ASPECT_9_16, (9, 16)),
        ((1080, 1920), CROP_ASPECT_1_1, (1, 1)),
        ((1080, 1920), CROP_ASPECT_4_3, (4, 3)),
    ],
)
def test_aspect_presets_stay_inside_landscape_and_portrait_sources(source, aspect, ratio):
    crop = crop_for_aspect(*source, aspect)
    assert crop.width * ratio[1] == crop.height * ratio[0]
    assert crop.x >= 0 and crop.y >= 0
    assert crop.x + crop.width <= source[0]
    assert crop.y + crop.height <= source[1]


@pytest.mark.parametrize(
    ("source", "current"),
    [
        ((1920, 1080), CropRect(120, 80, 800, 600)),
        ((1080, 1920), CropRect(80, 120, 600, 800)),
    ],
)
def test_free_aspect_preserves_the_current_crop(source, current):
    assert crop_for_aspect(*source, CROP_ASPECT_FREE, current) == current


@pytest.mark.parametrize(
    ("source", "aspect"),
    [
        ((1920, 1080), CROP_ASPECT_16_9),
        ((1080, 1920), CROP_ASPECT_9_16),
        ((1000, 1000), CROP_ASPECT_1_1),
        ((1600, 1200), CROP_ASPECT_4_3),
    ],
)
def test_matching_source_aspect_keeps_the_full_frame(source, aspect):
    assert crop_for_aspect(*source, aspect) == CropRect(0, 0, *source)


def test_ratio_change_preserves_crop_center_where_bounds_allow():
    current = CropRect(300, 200, 800, 600)
    crop = crop_for_aspect(1920, 1080, CROP_ASPECT_16_9, current)
    assert crop.x + crop.width / 2 == current.x + current.width / 2
    assert crop.y + crop.height / 2 == current.y + current.height / 2


def test_switching_aspects_does_not_progressively_shrink_crop():
    square = crop_for_aspect(1920, 1080, CROP_ASPECT_1_1)
    four_three = crop_for_aspect(1920, 1080, CROP_ASPECT_4_3, square)
    square_again = crop_for_aspect(1920, 1080, CROP_ASPECT_1_1, four_three)
    four_three_again = crop_for_aspect(1920, 1080, CROP_ASPECT_4_3, square_again)

    assert square_again == square
    assert four_three_again == four_three


@pytest.mark.parametrize("rotation", [90, 270])
def test_crop_aspect_describes_visible_ratio_after_quarter_turn(rotation):
    crop = crop_for_aspect(1920, 1080, CROP_ASPECT_16_9, rotation=rotation)
    transform = VideoTransform(crop=crop, crop_aspect=CROP_ASPECT_16_9, rotation=rotation)
    geometry = calculate_transform_geometry(transform, 1920, 1080)

    assert crop.width * 16 == crop.height * 9
    assert geometry.oriented_width * 9 == geometry.oriented_height * 16


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_rotation_values_are_deterministic(rotation):
    assert VideoTransform(rotation=rotation).rotation == rotation


@pytest.mark.parametrize("rotation", [-90, 45, 360, True])
def test_invalid_rotation_is_rejected(rotation):
    with pytest.raises(ValueError, match="rotation"):
        VideoTransform(rotation=rotation)


@pytest.mark.parametrize(
    ("rotation", "expected"),
    [(0, (640, 360)), (90, (360, 640)), (180, (640, 360)), (270, (360, 640))],
)
def test_rotated_output_dimensions(rotation, expected):
    geometry = calculate_transform_geometry(VideoTransform(rotation=rotation), 640, 360)
    assert (geometry.output_width, geometry.output_height) == expected


@pytest.mark.parametrize(
    ("horizontal", "vertical"),
    [(False, False), (True, False), (False, True), (True, True)],
)
def test_flip_states_round_trip(horizontal, vertical):
    transform = VideoTransform(flip_horizontal=horizontal, flip_vertical=vertical)
    assert VideoTransform.from_dict(transform.to_dict()) == transform


@pytest.mark.parametrize(
    ("source", "requested", "expected"),
    [
        ((1920, 1080), (1280, 720), (1280, 720)),
        ((1920, 1080), (1000, 1000), (1000, 562)),
        ((1920, 1080), (1080, 1920), (1080, 608)),
        ((1080, 1920), (1920, 1080), (608, 1080)),
        ((640, 360), (1920, 1080), (1920, 1080)),
        ((3840, 2160), (1280, 720), (1280, 720)),
        ((1920, 1080), (1919, 1079), (1918, 1078)),
    ],
)
def test_fit_output_geometry(source, requested, expected):
    assert fit_output_dimensions(*source, *requested) == expected


def test_fit_transform_reports_expected_final_dimensions():
    transform = VideoTransform(
        sizing_mode=SIZING_MODE_FIT,
        output=OutputGeometry(1080, 1920),
    )
    geometry = calculate_transform_geometry(transform, 1920, 1080)
    assert (geometry.output_width, geometry.output_height) == (1080, 608)
    assert geometry.fill_crop is None


def test_fill_matching_aspect_does_not_add_a_crop():
    assert fill_crop_dimensions(1920, 1080, 1280, 720) is None


@pytest.mark.parametrize(
    ("source", "requested"),
    [((1920, 1080), (1280, 720)), ((640, 360), (1920, 1080))],
)
def test_fill_matching_aspect_reports_requested_dimensions(source, requested):
    transform = VideoTransform(
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(*requested),
    )
    geometry = calculate_transform_geometry(transform, *source)
    assert (geometry.output_width, geometry.output_height) == requested
    assert geometry.fill_crop is None


@pytest.mark.parametrize(
    ("source", "requested"),
    [
        ((1920, 1080), (1080, 1920)),
        ((1080, 1920), (1920, 1080)),
        ((640, 360), (1918, 1078)),
        ((3840, 2160), (1000, 1000)),
    ],
)
def test_fill_mismatched_aspect_uses_a_centered_crop(source, requested):
    crop = fill_crop_dimensions(*source, *requested)
    assert crop is not None
    assert crop.x >= 0 and crop.y >= 0
    assert crop.x + crop.width <= source[0]
    assert crop.y + crop.height <= source[1]
    assert abs((crop.x + crop.width / 2) - source[0] / 2) <= 0.5
    assert abs((crop.y + crop.height / 2) - source[1] / 2) <= 0.5


def test_fill_transform_uses_even_requested_dimensions():
    transform = VideoTransform(
        sizing_mode=SIZING_MODE_FILL,
        output=OutputGeometry(1001, 1001),
    )
    geometry = calculate_transform_geometry(transform, 1920, 1080)
    assert (geometry.output_width, geometry.output_height) == (1000, 1000)
    assert geometry.fill_crop is not None


def test_stretch_reports_the_requested_source_dimensions():
    transform = VideoTransform(
        crop=CropRect(100, 50, 800, 600),
        sizing_mode=SIZING_MODE_STRETCH,
        output=OutputGeometry(1920, 1080),
    )
    geometry = calculate_transform_geometry(transform, 1920, 1080)
    assert (geometry.output_width, geometry.output_height) == (1920, 1080)
    assert geometry.fill_crop is None
    assert geometry.requires_scale
