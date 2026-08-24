from tuck.models import (
    FPS_MODE_CUSTOM,
    RC_TARGET_SIZE,
    RCM_CBR,
    RES_MODE_CUSTOM,
    PlanRequest,
    Profile,
)
from tuck.planner_options import resolve_plan_options


def test_profile_values_are_the_default_plan_options() -> None:
    profile = Profile(
        name="Profile",
        profile_id="profile",
        resolution_mode=RES_MODE_CUSTOM,
        fps_mode=FPS_MODE_CUSTOM,
        rate_control=RC_TARGET_SIZE,
        audio_bitrate=96_000,
        keep_audio=True,
        scaler="lanczos",
        video_encoder="libx264",
        rate_control_method=RCM_CBR,
        preset="slow",
        two_pass=True,
    )

    options = resolve_plan_options(profile, None)

    assert options.resolution_mode == RES_MODE_CUSTOM
    assert options.fps_mode == FPS_MODE_CUSTOM
    assert options.audio_bitrate == 96_000
    assert options.keep_audio is True
    assert options.scaler == "lanczos"
    assert options.preset == "slow"
    assert options.two_pass is True


def test_request_values_override_profile_options_without_mutating_inputs() -> None:
    profile = Profile(name="Profile", profile_id="profile", keep_audio=True)
    request = PlanRequest(
        source="input.mp4",
        audio_bitrate=192_000,
        keep_audio=False,
        audio_enabled=False,
        source_audio_muted=True,
        source_audio_gain_db=-3.0,
        scaler="bicubic",
        preset="fast",
        two_pass=False,
    )

    options = resolve_plan_options(profile, request)

    assert options.audio_bitrate == 192_000
    assert options.keep_audio is False
    assert options.audio_enabled is False
    assert options.source_audio_muted is True
    assert options.source_audio_gain_db == -3.0
    assert options.scaler == "bicubic"
    assert options.preset == "fast"
    assert options.two_pass is False
    assert profile.keep_audio is True
    assert request.scaler == "bicubic"
