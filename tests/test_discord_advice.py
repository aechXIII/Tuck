"""The note on Discord profiles when the chosen encoder makes a file the chat may not play."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from tuck.models import (
    DEFAULT_PROFILES,
    PROFILE_ID_DISCORD_FREE,
    PlanRequest,
    Profile,
    VideoInfo,
    find_profile_by_id,
)
from tuck.planner import DISCORD_HEVC_WARNING, plan


def _profile(profile_id: str) -> Profile:
    found = find_profile_by_id(DEFAULT_PROFILES, profile_id)
    assert found is not None
    return Profile.from_dict(found.to_dict())


def _info(path: Path, **overrides: Any) -> VideoInfo:
    info = VideoInfo(
        path=str(path),
        duration=20.0,
        width=1920,
        height=1080,
        fps=60.0,
        video_codec="h264",
        audio_codec="aac",
        audio_channels=2,
        audio_sample_rate=48000,
        audio_bitrate=160_000,
        has_audio=True,
        audio_stream_count=1,
        audio_codecs=["aac"],
    )
    return replace(info, **overrides)


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"not read by the planner")
    return path


@pytest.mark.parametrize("encoder", ["libx265", "hevc_nvenc", "hevc_vaapi"])
def test_h265_on_a_discord_profile_says_h264_plays_everywhere(
    source: Path, monkeypatch: pytest.MonkeyPatch, encoder: str
) -> None:
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    request = PlanRequest(source=str(source), video_encoder=encoder, two_pass=False)
    result = plan(
        source, _profile(PROFILE_ID_DISCORD_FREE), request=request, source_info=_info(source)
    )
    assert DISCORD_HEVC_WARNING in result.warnings
    assert "H.264 plays everywhere" in DISCORD_HEVC_WARNING


@pytest.mark.parametrize("encoder", ["libx264", "auto", "auto_fast", "h264_nvenc"])
def test_h264_and_auto_need_no_advice(source: Path, encoder: str) -> None:
    request = PlanRequest(source=str(source), video_encoder=encoder, two_pass=False)
    result = plan(
        source, _profile(PROFILE_ID_DISCORD_FREE), request=request, source_info=_info(source)
    )
    assert DISCORD_HEVC_WARNING not in result.warnings


def test_only_profiles_meant_for_discord_get_it(source: Path) -> None:
    request = PlanRequest(source=str(source), video_encoder="libx265", two_pass=False)
    other = Profile(name="Family clips", profile_id="0123456789ab")
    assert (
        DISCORD_HEVC_WARNING
        not in plan(source, other, request=request, source_info=_info(source)).warnings
    )
    mine = Profile(name="My Discord clips", profile_id="0123456789ac")
    assert (
        DISCORD_HEVC_WARNING
        in plan(source, mine, request=request, source_info=_info(source)).warnings
    )
