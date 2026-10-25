import json
from pathlib import Path

import pytest

from tuck.bridge import BridgeAPI
from tuck.bridge_validation import parse_plan_request
from tuck.models import (
    DEFAULT_PROFILES,
    PROFILE_ID_4K_UPSCALE,
    PROFILE_ID_1440P_UPSCALE,
    PROFILE_ID_DISCORD_NITRO,
    PROFILE_SCHEMA_VERSION,
    RES_MODE_CUSTOM,
    RES_MODE_SHORT_SIDE,
    RES_MODE_SOURCE,
    SIZING_MODE_FIT,
    WORKFLOW_COMPRESSION,
    WORKFLOW_UPSCALE,
    CropRect,
    PlanRequest,
    Profile,
    VideoInfo,
    VideoTransform,
    find_profile_by_id,
    normalize_scaler,
    short_side_dimensions,
)
from tuck.planner import plan
from tuck.settings import SettingsManager, profiles_path, settings_path

UPSCALE_SUFFIX = "_upscaled_{width}x{height}"


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    import tuck.settings as settings

    monkeypatch.setattr(settings, "_settings_manager", None)
    monkeypatch.setattr(settings, "_storage_root", tmp_path / "storage")


def _source(tmp_path: Path, width: int, height: int) -> tuple[Path, VideoInfo]:
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    info = VideoInfo(
        path=str(source), duration=10.0, width=width, height=height, fps=30.0, video_codec="h264"
    )
    return source, info


def _builtin(profile_id: str) -> Profile:
    profile = find_profile_by_id(DEFAULT_PROFILES, profile_id)
    assert profile is not None
    return profile


def _upscale(tmp_path, width, height, profile_id=PROFILE_ID_1440P_UPSCALE, request=None):
    source, info = _source(tmp_path, width, height)
    return plan(
        source,
        _builtin(profile_id),
        request=request,
        source_info=info,
        upscale_suffix=UPSCALE_SUFFIX,
    )


class TestShortSideSizing:
    @pytest.mark.parametrize(
        ("width", "height", "expected"),
        [
            (1920, 1080, (2560, 1440)),
            (1080, 1920, (1440, 2560)),
            (1080, 1080, (1440, 1440)),
            (1440, 1080, (1920, 1440)),
            (2560, 1080, (3414, 1440)),
            (854, 480, (2562, 1440)),
        ],
    )
    def test_1440p_sizes_the_short_side(self, tmp_path, width, height, expected):
        result = _upscale(tmp_path, width, height)

        assert (result.target_width, result.target_height) == expected
        assert result.apply_scale
        assert result.warnings == []

    def test_portrait_4k(self, tmp_path):
        result = _upscale(tmp_path, 720, 1280, PROFILE_ID_4K_UPSCALE)

        assert (result.target_width, result.target_height) == (2160, 3840)

    def test_dimensions_round_halves_up_like_the_resolution_menu(self):
        # 853 * 1440 / 480 / 2 = 1279.5, which the menu's Math.round takes up
        assert short_side_dimensions(853, 480, 1440) == (2560, 1440)
        assert short_side_dimensions(480, 853, 1440) == (1440, 2560)
        with pytest.raises(ValueError):
            short_side_dimensions(1920, 1080, 0)

    def test_output_is_named_from_the_real_size(self, tmp_path):
        result = _upscale(tmp_path, 1080, 1920)

        assert Path(result.output).name == "clip_upscaled_1440x2560.mp4"

    def test_crop_is_sized_by_its_own_short_side(self, tmp_path):
        transform = VideoTransform(crop=CropRect(656, 0, 608, 1080), sizing_mode=SIZING_MODE_FIT)
        result = _upscale(tmp_path, 1920, 1080, request=PlanRequest(transform=transform))

        assert (result.target_width, result.target_height) == (1440, 2558)
        assert Path(result.output).name == "clip_upscaled_1440x2558.mp4"

    def test_request_short_side_overrides_the_profile(self, tmp_path):
        request = PlanRequest(resolution_mode=RES_MODE_SHORT_SIDE, short_side=2160)
        result = _upscale(tmp_path, 1080, 1920, request=request)

        assert (result.target_width, result.target_height) == (2160, 3840)

    def test_compress_can_use_a_short_side(self, tmp_path):
        source, info = _source(tmp_path, 1080, 1920)
        request = PlanRequest(resolution_mode=RES_MODE_SHORT_SIDE, short_side=720)
        result = plan(
            source,
            _builtin(PROFILE_ID_DISCORD_NITRO),
            request=request,
            source_info=info,
            compression_suffix="_{width}x{height}",
        )

        assert (result.target_width, result.target_height) == (720, 1280)
        assert Path(result.output).name == "clip_720x1280.mp4"
        assert result.warnings == []


class TestUpscaleNeverShrinks:
    def test_a_4k_video_keeps_its_size_on_1440p(self, tmp_path):
        result = _upscale(tmp_path, 3840, 2160)

        assert (result.target_width, result.target_height) == (3840, 2160)
        assert not result.apply_scale
        assert Path(result.output).name == "clip_upscaled_3840x2160.mp4"
        assert result.warnings == [
            "This video is already larger than 1440p, so it keeps its size of 3840x2160."
        ]

    def test_a_portrait_4k_video_keeps_its_size_on_4k(self, tmp_path):
        result = _upscale(tmp_path, 2160, 3840, PROFILE_ID_4K_UPSCALE)

        assert (result.target_width, result.target_height) == (2160, 3840)
        assert result.warnings == ["This video is already 4K, so it keeps its size of 2160x3840."]

    def test_a_square_video_at_the_target_keeps_its_size(self, tmp_path):
        result = _upscale(tmp_path, 1440, 1440)

        assert (result.target_width, result.target_height) == (1440, 1440)
        assert result.warnings == [
            "This video is already 1440p, so it keeps its size of 1440x1440."
        ]

    def test_a_smaller_custom_size_is_kept_and_noted(self, tmp_path):
        request = PlanRequest(resolution_mode=RES_MODE_CUSTOM, custom_width=1280, custom_height=720)
        result = _upscale(tmp_path, 1920, 1080, request=request)

        assert (result.target_width, result.target_height) == (1280, 720)
        assert result.warnings == [
            "The output, 1280x720, is smaller than the video (1920x1080), so it isn't upscaled."
        ]

    def test_source_size_in_upscale_is_noted(self, tmp_path):
        request = PlanRequest(resolution_mode=RES_MODE_SOURCE)
        result = _upscale(tmp_path, 1920, 1080, request=request)

        assert result.warnings == [
            "The output is the same size as the video (1920x1080), so it isn't upscaled."
        ]

    def test_compress_has_no_upscale_note(self, tmp_path):
        source, info = _source(tmp_path, 1920, 1080)
        request = PlanRequest(resolution_mode=RES_MODE_CUSTOM, custom_width=1280, custom_height=720)
        result = plan(source, _builtin(PROFILE_ID_DISCORD_NITRO), request=request, source_info=info)

        assert result.workflow == WORKFLOW_COMPRESSION
        assert result.warnings == []


class TestScalingChoice:
    @pytest.mark.parametrize(
        ("saved", "expected"),
        [
            ("bilinear", "lanczos"),
            ("bicubic", "lanczos"),
            ("lanczos", "lanczos"),
            ("neighbor", "neighbor"),
            ("point", "neighbor"),
            ("nearest", "neighbor"),
        ],
    )
    def test_old_names_read_as_smooth_or_sharp_pixels(self, saved, expected):
        assert normalize_scaler(saved) == expected

    @pytest.mark.parametrize("value", ["bogus", "", None, 3, ["lanczos"]])
    def test_unknown_values_are_refused(self, value):
        with pytest.raises(ValueError, match="scaler must be one of"):
            normalize_scaler(value)

    def test_new_profiles_and_settings_default_to_smooth(self):
        assert Profile(name="New").scaler == "lanczos"
        assert SettingsManager().load().default_scaler == "lanczos"

    def test_request_keeps_its_value_and_the_plan_uses_smooth(self, tmp_path):
        source, info = _source(tmp_path, 1280, 720)
        request = parse_plan_request(
            {
                "source": str(source),
                "resolution_mode": "custom",
                "custom_width": 1920,
                "custom_height": 1080,
                "scaler": "bicubic",
            },
            lambda path: path,
        )
        result = plan(source, Profile(name="P", two_pass=False), request=request, source_info=info)

        assert result.scaler == "lanczos"

    def test_bad_short_side_is_refused(self):
        with pytest.raises(ValueError, match="short_side"):
            PlanRequest(resolution_mode=RES_MODE_SHORT_SIDE, short_side=1).validate()
        data = Profile(name="P", profile_id="p").to_dict()
        for value in (0, True, "1440", 1440.5):
            with pytest.raises(ValueError, match="short_side"):
                Profile.from_dict({**data, "short_side": value})
        assert Profile.from_dict({**data, "short_side": 1440.0}).short_side == 1440


def _v6_profile(profile_id: str, **values) -> dict:
    data = Profile(name="Profile", profile_id=profile_id).to_dict()
    data.pop("short_side")
    data.update({"scaler": "neighbor", "schema_version": 6, **values})
    return data


def _load_profiles(profiles: list[dict]) -> dict[str, Profile]:
    path = profiles_path()
    path.write_text(json.dumps({"version": 6, "profiles": profiles}), encoding="utf-8")
    return {p.profile_id: p for p in SettingsManager().get_profiles() if p.profile_id}


class TestMigration:
    def test_untouched_builtin_upscale_profiles_size_the_short_side(self):
        old_1440 = _v6_profile(
            PROFILE_ID_1440P_UPSCALE,
            name="1440p Upscale (2560x1440)",
            workflow=WORKFLOW_UPSCALE,
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=2560,
            custom_height=1440,
            rate_control_method="crf",
            crf=18,
            two_pass=False,
        )
        old_4k = {
            **old_1440,
            "profile_id": PROFILE_ID_4K_UPSCALE,
            "name": "4K Upscale (3840x2160)",
            "custom_width": 3840,
            "custom_height": 2160,
        }

        profiles = _load_profiles([old_1440, old_4k])

        upscale_1440 = profiles[PROFILE_ID_1440P_UPSCALE]
        assert upscale_1440.name == "1440p Upscale"
        assert upscale_1440.resolution_mode == RES_MODE_SHORT_SIDE
        assert upscale_1440.short_side == 1440
        assert upscale_1440.scaler == "lanczos"
        assert upscale_1440.schema_version == PROFILE_SCHEMA_VERSION
        upscale_4k = profiles[PROFILE_ID_4K_UPSCALE]
        assert upscale_4k.name == "4K Upscale"
        assert upscale_4k.resolution_mode == RES_MODE_SHORT_SIDE
        assert upscale_4k.short_side == 2160

    def test_changed_builtin_upscale_profile_keeps_its_box_and_name(self):
        edited = _v6_profile(
            PROFILE_ID_1440P_UPSCALE,
            name="My upscale",
            workflow=WORKFLOW_UPSCALE,
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=1920,
            custom_height=1080,
            rate_control_method="crf",
            two_pass=False,
        )

        profile = _load_profiles([edited])[PROFILE_ID_1440P_UPSCALE]

        assert profile.name == "My upscale"
        assert profile.resolution_mode == RES_MODE_CUSTOM
        assert (profile.custom_width, profile.custom_height) == (1920, 1080)
        assert profile.scaler == "lanczos"

    def test_builtin_point_choice_stays_sharp_pixels(self):
        chosen = _v6_profile(PROFILE_ID_DISCORD_NITRO, scaler="point")

        assert _load_profiles([chosen])[PROFILE_ID_DISCORD_NITRO].scaler == "neighbor"

    def test_user_profiles_keep_their_scaling_and_box(self):
        own = _v6_profile(
            "my-upscale",
            name="Mine",
            workflow=WORKFLOW_UPSCALE,
            resolution_mode=RES_MODE_CUSTOM,
            custom_width=2560,
            custom_height=1440,
            rate_control_method="crf",
            two_pass=False,
        )
        smooth = {**own, "profile_id": "my-bicubic", "scaler": "bicubic"}

        profiles = _load_profiles([own, smooth])

        assert profiles["my-upscale"].scaler == "neighbor"
        assert profiles["my-upscale"].resolution_mode == RES_MODE_CUSTOM
        assert profiles["my-bicubic"].scaler == "lanczos"

    def test_current_profiles_are_not_migrated_again(self):
        current = Profile(
            name="P", profile_id=PROFILE_ID_DISCORD_NITRO, scaler="neighbor"
        ).to_dict()
        path = profiles_path()
        path.write_text(
            json.dumps({"version": PROFILE_SCHEMA_VERSION, "profiles": [current]}),
            encoding="utf-8",
        )

        profiles = {p.profile_id: p for p in SettingsManager().get_profiles()}

        assert profiles[PROFILE_ID_DISCORD_NITRO].scaler == "neighbor"

    @pytest.mark.parametrize(
        ("version", "saved", "expected"),
        [
            (1, "neighbor", "lanczos"),
            (1, "point", "neighbor"),
            (1, "bicubic", "lanczos"),
            (1, "bogus", "lanczos"),
            (2, "neighbor", "neighbor"),
        ],
    )
    def test_default_scaler_setting(self, version, saved, expected):
        settings_path().write_text(
            json.dumps({"version": version, "default_scaler": saved}), encoding="utf-8"
        )

        settings = SettingsManager().load()

        assert settings.default_scaler == expected
        assert settings.version == 2

    def test_bridge_saves_default_scaler_as_one_of_two_choices(self):
        api = BridgeAPI()

        assert api.save_settings({"default_scaler": "bicubic"}) == {"ok": True}
        assert api.get_settings()["default_scaler"] == "lanczos"
        assert api.save_settings({"default_scaler": "point"}) == {"ok": True}
        assert api.get_settings()["default_scaler"] == "neighbor"
        assert api.save_settings({"default_scaler": "bogus"})["ok"] is False
