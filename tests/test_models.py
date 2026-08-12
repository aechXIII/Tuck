import json

import pytest

from tuck.models import (
    BUILTIN_PROFILE_IDS,
    DEFAULT_PROFILES,
    FPS_MODE_SOURCE,
    PROFILE_ID_4K_UPSCALE,
    PROFILE_ID_1440P_UPSCALE,
    PROFILE_ID_DISCORD_FREE,
    PROFILE_ID_DISCORD_NITRO,
    PROFILE_ID_DISCORD_NITRO_BASIC,
    RC_EXPLICIT_BITRATE,
    RC_TARGET_SIZE,
    RES_MODE_CUSTOM,
    RES_MODE_SOURCE,
    SCALER_BICUBIC,
    SCALER_BILINEAR,
    SCALER_LANCZOS,
    SCALER_NEIGHBOR,
    CropRect,
    EncodePlan,
    PlanRequest,
    Profile,
    QueueItem,
    QueueState,
    VideoInfo,
    VideoTransform,
    dicts_to_profiles,
    estimate_size_from_bitrate,
    export_profiles_json,
    find_profile_by_id,
    import_profiles_json,
    profiles_to_dicts,
)


class TestVideoTransform:
    def test_default_state(self):
        assert VideoTransform() == VideoTransform(crop=None)

    def test_valid_crop(self):
        transform = VideoTransform(crop=CropRect(x=100, y=50, width=800, height=600))
        transform.validate_for_source(1920, 1080)

    @pytest.mark.parametrize(
        ("crop", "message"),
        [
            (CropRect(x=0, y=0, width=1, height=1), "crop width and height"),
        ],
    )
    def test_crop_requires_encoder_alignment(self, crop, message):
        with pytest.raises(ValueError, match=message):
            VideoTransform(crop=crop).validate_for_source(1920, 1080)

    def test_negative_crop_coordinates(self):
        with pytest.raises(ValueError, match="crop x"):
            CropRect(x=-1, y=0, width=100, height=100)
        with pytest.raises(ValueError, match="crop y"):
            CropRect(x=0, y=-1, width=100, height=100)

    @pytest.mark.parametrize("width,height", [(0, 100), (100, 0)])
    def test_zero_crop_dimensions(self, width, height):
        with pytest.raises(ValueError, match=r"crop (width|height)"):
            CropRect(x=0, y=0, width=width, height=height)

    def test_crop_beyond_source_bounds(self):
        with pytest.raises(ValueError, match="inside source"):
            VideoTransform(crop=CropRect(x=1600, y=0, width=400, height=600)).validate_for_source(
                1920, 1080
            )

    def test_full_frame_crop(self):
        transform = VideoTransform(crop=CropRect(x=0, y=0, width=1920, height=1080))
        transform.validate_for_source(1920, 1080)

    def test_odd_origin_is_allowed_for_exact_source_coordinates(self):
        transform = VideoTransform(crop=CropRect(x=101, y=51, width=800, height=600))
        transform.validate_for_source(1920, 1080)

    @pytest.mark.parametrize("width,height", [(801, 600), (800, 601)])
    def test_odd_output_dimensions_are_rejected_for_yuv420p(self, width, height):
        with pytest.raises(ValueError, match="crop width and height"):
            VideoTransform(crop=CropRect(x=0, y=0, width=width, height=height)).validate_for_source(
                1920, 1080
            )

    def test_later_transform_fields_are_not_accepted(self):
        with pytest.raises(ValueError, match="unsupported fields"):
            VideoTransform.from_dict({"crop": None, "rotation": 90})

    def test_serialization_round_trip(self):
        transform = VideoTransform(crop=CropRect(x=0, y=0, width=1280, height=720))
        assert VideoTransform.from_dict(transform.to_dict()) == transform

    def test_encode_plan_round_trip_preserves_transform(self):
        transform = VideoTransform(crop=CropRect(x=0, y=0, width=1280, height=720))
        plan = EncodePlan(source="source.mp4", output="output.mp4", transform=transform)
        assert EncodePlan.from_dict(plan.to_dict()).transform == transform

    def test_old_encode_plan_without_transform_defaults_to_full_frame(self):
        restored = EncodePlan.from_dict({"source": "source.mp4", "output": "output.mp4"})

        assert restored.transform == VideoTransform()


def test_two_pass_accepts_auto_best_compression() -> None:
    from tuck.models import validate_rate_control_matrix

    validate_rate_control_matrix(
        workflow="compression",
        rate_control="target_size",
        rate_control_method="cbr",
        video_encoder="auto_compression",
        two_pass=True,
    )


class TestProfile:
    def test_default_profile_has_stable_id(self):
        p = Profile(name="Test", profile_id=PROFILE_ID_DISCORD_FREE)
        assert p.profile_id == PROFILE_ID_DISCORD_FREE
        assert p.profile_id in BUILTIN_PROFILE_IDS

    def test_user_profile_gets_uuid_id(self):
        p = Profile(name="Custom User")
        assert p.profile_id
        assert p.profile_id not in BUILTIN_PROFILE_IDS
        assert len(p.profile_id) == 12

    def test_profile_id_validation_rejects_invalid(self):
        with pytest.raises(ValueError, match="Invalid profile_id"):
            Profile(name="Bad", profile_id="INVALID UPPERCASE")
        with pytest.raises(ValueError, match="non-empty"):
            Profile(name="Bad", profile_id="")

    def test_profile_to_dict_and_back(self):
        p = DEFAULT_PROFILES[0]
        d = p.to_dict()
        p2 = Profile.from_dict(d)
        assert p2.profile_id == p.profile_id
        assert p2.name == p.name
        assert p2.target_size_bytes == p.target_size_bytes
        assert p2.schema_version == p.schema_version

    def test_profile_roundtrip(self):
        for p in DEFAULT_PROFILES:
            d = p.to_dict()
            restored = Profile.from_dict(d)
            assert restored.profile_id == p.profile_id
            assert restored.name == p.name
            assert restored.target_size_bytes == p.target_size_bytes

    def test_legacy_cqp_roundtrip_preserves_quality_value(self):
        profile = Profile(
            name="Legacy CQP",
            profile_id="legacy-cqp",
            workflow="upscale",
            video_encoder="h264_nvenc",
            preset="p5",
            rate_control_method="cqp",
            rate_control="target_size",
            cq=31,
            qp=18,
            two_pass=False,
        )

        serialized = profile.to_dict()
        restored = Profile.from_dict(serialized)

        assert serialized["qp"] == 18
        assert restored.rate_control_method == "cqp"
        assert restored.qp == 18
        assert restored.cq == 31

    def test_validate_profile_dict_rejects_unknown_fields(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["unknown_field"] = "bad"
        with pytest.raises(ValueError, match="unknown fields"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_missing_required(self):
        d = {"profile_id": "test-123"}
        with pytest.raises(ValueError, match="missing required"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_size(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["target_size_bytes"] = 0
        with pytest.raises(ValueError, match="target_size_bytes"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_preset(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["preset"] = "nonexistent"
        with pytest.raises(ValueError, match="preset must be one of"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_schema_version(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["schema_version"] = 999
        with pytest.raises(ValueError, match="schema_version"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bool_for_numeric(self):

        d = DEFAULT_PROFILES[0].to_dict()
        d["target_size_bytes"] = True
        with pytest.raises(ValueError, match="target_size_bytes must be a number, not boolean"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_nan(self):

        d = DEFAULT_PROFILES[0].to_dict()
        d["max_fps"] = float("nan")
        with pytest.raises(ValueError, match="must be finite"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_infinity(self):

        d = DEFAULT_PROFILES[0].to_dict()
        d["max_width"] = float("inf")
        with pytest.raises(ValueError, match="must be finite"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_resolution_mode(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["resolution_mode"] = "bogus"
        with pytest.raises(ValueError, match="resolution_mode must be one of"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_fps_mode(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["fps_mode"] = "bogus"
        with pytest.raises(ValueError, match="fps_mode must be one of"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_rate_control(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["rate_control"] = "bogus"
        with pytest.raises(ValueError, match="rate_control must be one of"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_bad_scaler(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["scaler"] = "bogus"
        with pytest.raises(ValueError, match="scaler must be one of"):
            Profile.from_dict(d)

    def test_profile_default_scaler(self):
        p = DEFAULT_PROFILES[0]
        d = p.to_dict()
        assert d.get("scaler") == SCALER_NEIGHBOR

    def test_profile_scaler_roundtrip(self):
        for scaler in [SCALER_BILINEAR, SCALER_BICUBIC, SCALER_LANCZOS, SCALER_NEIGHBOR]:
            p = Profile(name="Test", profile_id="test-scaler", scaler=scaler)
            d = p.to_dict()
            restored = Profile.from_dict(d)
            assert restored.scaler == scaler

    def test_profile_scaler_backward_compat(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d.pop("scaler", None)
        p = Profile.from_dict(d)
        assert p.scaler == SCALER_NEIGHBOR

    def test_validate_profile_dict_rejects_non_bool_two_pass(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["two_pass"] = "not-a-bool"
        with pytest.raises(ValueError, match="two_pass must be a boolean"):
            Profile.from_dict(d)

    def test_validate_profile_dict_rejects_invalid_qp(self):
        d = DEFAULT_PROFILES[0].to_dict()
        d["qp"] = 52
        with pytest.raises(ValueError, match="qp must be between 0 and 51"):
            Profile.from_dict(d)

    def test_default_profiles_have_correct_ids(self):
        ids = {p.profile_id for p in DEFAULT_PROFILES}
        assert PROFILE_ID_DISCORD_FREE in ids
        assert PROFILE_ID_DISCORD_NITRO_BASIC in ids
        assert PROFILE_ID_DISCORD_NITRO in ids
        assert PROFILE_ID_1440P_UPSCALE in ids
        assert PROFILE_ID_4K_UPSCALE in ids

        assert "custom" not in ids
        assert "tuck-default" not in ids

    def test_builtin_1440p_profile_dimensions_and_scaler(self):
        p = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_1440P_UPSCALE)
        assert p is not None
        assert p.resolution_mode == RES_MODE_CUSTOM
        assert p.custom_width == 2560
        assert p.custom_height == 1440
        assert p.scaler == SCALER_NEIGHBOR
        assert p.target_size_bytes == 500 * 1024 * 1024

    def test_builtin_4k_profile_dimensions_and_scaler(self):
        p = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_4K_UPSCALE)
        assert p is not None
        assert p.resolution_mode == RES_MODE_CUSTOM
        assert p.custom_width == 3840
        assert p.custom_height == 2160
        assert p.scaler == SCALER_NEIGHBOR
        assert p.target_size_bytes == 500 * 1024 * 1024

    def test_default_profiles_have_correct_modes(self):
        free = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        assert free.resolution_mode == RES_MODE_SOURCE
        assert free.fps_mode == FPS_MODE_SOURCE
        assert free.rate_control == RC_TARGET_SIZE

        basic = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_NITRO_BASIC)
        assert basic.max_width == 3840
        assert basic.max_height == 2160

    def test_default_profiles_have_correct_sizes(self):
        free = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        assert free.target_size_bytes == 10 * 1024 * 1024
        basic = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_NITRO_BASIC)
        assert basic.target_size_bytes == 50 * 1024 * 1024
        nitro = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_NITRO)
        assert nitro.target_size_bytes == 500 * 1024 * 1024

    def test_find_profile_by_id(self):
        found = find_profile_by_id(DEFAULT_PROFILES, PROFILE_ID_DISCORD_FREE)
        assert found is not None
        not_found = find_profile_by_id(DEFAULT_PROFILES, "nonexistent")
        assert not_found is None


class TestBridgeUpdateProfileValidation:
    def test_rejects_non_bool_two_pass(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Test Custom", profile_id="test-custom")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = '{"two_pass": "not-a-bool"}'
        resp = json.loads(api.update_profile("test-custom", payload))
        assert not resp["ok"]
        assert "two_pass must be a boolean" in resp["error"]

    def test_rejects_invalid_preset(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Test Custom", profile_id="test-custom2")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = '{"preset": "bogus"}'
        resp = json.loads(api.update_profile("test-custom2", payload))
        assert not resp["ok"]
        assert "preset must be one of" in resp["error"]

    def test_rejects_unknown_field(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Test Custom", profile_id="test-custom3")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = '{"made_up_field": "should_fail"}'
        resp = json.loads(api.update_profile("test-custom3", payload))
        assert not resp["ok"]
        assert "unknown fields" in resp["error"]

    def test_rejects_target_size_below_two_mb(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        profiles.append(Profile(name="Minimum size", profile_id="minimum-size"))
        api._settings.set_profiles(profiles)

        resp = json.loads(api.update_profile("minimum-size", '{"target_size_mb": 1}'))
        assert not resp["ok"]
        assert "at least 2" in resp["error"]

    def test_rejects_negative_target_size(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI
        from tuck.models import Profile

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Test Custom", profile_id="test-custom4")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = '{"target_size_mb": -5}'
        resp = json.loads(api.update_profile("test-custom4", payload))
        assert not resp["ok"]
        assert "at least 2" in resp["error"]


class TestProfileSerialization:
    def test_profiles_to_dicts_and_back(self):
        dicts = profiles_to_dicts(DEFAULT_PROFILES)
        assert len(dicts) == len(DEFAULT_PROFILES)
        restored = dicts_to_profiles(dicts)
        assert len(restored) == len(DEFAULT_PROFILES)
        for i, p in enumerate(restored):
            assert p.profile_id == DEFAULT_PROFILES[i].profile_id

    def test_export_import_profiles_json(self, tmp_path):
        path = tmp_path / "profiles.json"
        export_profiles_json(DEFAULT_PROFILES, path)
        assert path.exists()
        imported = import_profiles_json(path)
        assert len(imported) == len(DEFAULT_PROFILES)

    def test_import_empty_file(self, tmp_path):
        path = tmp_path / "empty.json"
        path.write_text("", encoding="utf-8")
        with pytest.raises(ValueError, match="empty"):
            import_profiles_json(path)

    def test_import_invalid_json(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("not json", encoding="utf-8")
        with pytest.raises(ValueError, match="Invalid JSON"):
            import_profiles_json(path)

    def test_import_missing_profiles_key(self, tmp_path):
        path = tmp_path / "noprofiles.json"
        path.write_text('{"version": 1}', encoding="utf-8")
        with pytest.raises(ValueError, match="missing 'profiles'"):
            import_profiles_json(path)

    def test_import_newer_schema_version(self, tmp_path):
        path = tmp_path / "future.json"
        path.write_text('{"version": 999, "profiles": []}', encoding="utf-8")
        with pytest.raises(ValueError, match="newer"):
            import_profiles_json(path)

    def test_atomic_export_no_temp_files_left(self, tmp_path):

        path = tmp_path / "profiles.json"
        export_profiles_json(DEFAULT_PROFILES, path)
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert len(tmp_files) == 0

    def test_atomic_export_parent_missing_raises(self, tmp_path):

        path = tmp_path / "nope" / "profiles.json"
        with pytest.raises(FileNotFoundError):
            export_profiles_json(DEFAULT_PROFILES, path)

        assert len(list(tmp_path.glob("**/*.tmp"))) == 0

    def test_atomic_export_overwrites_cleanly(self, tmp_path):

        path = tmp_path / "profiles.json"
        export_profiles_json([DEFAULT_PROFILES[0]], path)
        first = json.loads(path.read_text(encoding="utf-8"))
        assert len(first["profiles"]) == 1

        export_profiles_json(DEFAULT_PROFILES, path)
        second = json.loads(path.read_text(encoding="utf-8"))
        assert len(second["profiles"]) == 5


class TestVideoInfo:
    def test_resolution_str(self):
        vi = VideoInfo(
            path="test.mp4",
            duration=10.0,
            width=1920,
            height=1080,
            fps=30.0,
            video_codec="h264",
            file_size=1000000,
        )
        assert vi.resolution_str == "1920x1080"

    def test_duration_str(self):
        vi = VideoInfo(
            path="test.mp4",
            duration=65.0,
            width=640,
            height=480,
            fps=30.0,
            video_codec="h264",
            file_size=1000000,
        )
        assert vi.duration_str == "1:05"

    def test_duration_str_hours(self):
        vi = VideoInfo(
            path="test.mp4",
            duration=3661.0,
            width=640,
            height=480,
            fps=30.0,
            video_codec="h264",
            file_size=1000000,
        )
        assert vi.duration_str == "1:01:01"


class TestEncodePlan:
    def test_to_dict_and_from_dict(self):
        vi = VideoInfo(
            path="test.mp4",
            duration=10.0,
            width=1920,
            height=1080,
            fps=30.0,
            video_codec="h264",
            file_size=1000000,
        )
        plan = EncodePlan(
            source="test.mp4",
            output="test_tucked.mp4",
            target_width=1920,
            target_height=1080,
            target_fps=30.0,
            video_bitrate=1_000_000,
            audio_bitrate=128_000,
            estimated_size=5_000_000,
            target_size=8_000_000,
            source_info=vi,
            profile_id=PROFILE_ID_DISCORD_FREE,
            resolution_mode=RES_MODE_SOURCE,
            fps_mode=FPS_MODE_SOURCE,
        )
        d = plan.to_dict()
        restored = EncodePlan.from_dict(d)
        assert restored.source == plan.source
        assert restored.resolution_mode == RES_MODE_SOURCE
        assert restored.source_info is not None
        assert restored.source_info.width == 1920

    def test_from_dict_defaults_missing_v2_fields(self):

        d = {
            "source": "test.mp4",
            "output": "out.mp4",
            "target_width": 1920,
            "target_height": 1080,
            "target_fps": 30.0,
            "video_bitrate": 1_000_000,
            "audio_bitrate": 128_000,
            "estimated_size": 5_000_000,
            "target_size": 8_000_000,
            "profile_id": "test",
            "source_info": None,
        }
        plan = EncodePlan.from_dict(d)
        assert plan.resolution_mode == RES_MODE_SOURCE
        assert plan.fps_mode == FPS_MODE_SOURCE
        assert plan.rate_control == RC_TARGET_SIZE
        assert plan.apply_scale is False
        assert plan.apply_fps_filter is False
        assert plan.transform == VideoTransform()


class TestQueueItem:
    def test_default_state(self):
        item = QueueItem()
        assert item.state == QueueState.PENDING
        assert item.progress == 0.0
        assert item.id

    def test_state_values(self):
        for state in QueueState:
            assert isinstance(state.value, str)


class TestPlanRequest:
    def test_defaults(self):
        req = PlanRequest()
        assert req.resolution_mode is None
        assert req.fps_mode is None
        assert req.rate_control is None
        assert req.explicit_bitrate is None
        assert req.audio_bitrate is None

    def test_validate_rejects_bad_mode(self):
        req = PlanRequest(resolution_mode="bogus")
        with pytest.raises(ValueError, match="Invalid resolution_mode"):
            req.validate()

    def test_validate_custom_width_required(self):
        req = PlanRequest(resolution_mode="custom", custom_width=0)
        with pytest.raises(ValueError, match="custom_width must be >= 2"):
            req.validate()

    def test_validate_custom_fps_required(self):
        req = PlanRequest(fps_mode="custom", custom_fps=0)
        with pytest.raises(ValueError, match="custom_fps must be > 0"):
            req.validate()

    def test_validate_explicit_bitrate_min(self):
        req = PlanRequest(rate_control=RC_EXPLICIT_BITRATE, explicit_bitrate=0)
        with pytest.raises(ValueError, match="explicit_bitrate must be >= 1000"):
            req.validate()

    def test_validate_rejects_bad_scaler(self):
        req = PlanRequest(scaler="bogus")
        with pytest.raises(ValueError, match="Invalid scaler"):
            req.validate()

    def test_validate_accepts_valid_scaler(self):
        req = PlanRequest(scaler=SCALER_LANCZOS)
        req.validate()  # should not raise

    def test_validate_accepts_none_scaler(self):
        req = PlanRequest(scaler=None)
        req.validate()  # should not raise

    def test_validate_rejects_bad_video_encoder(self):
        req = PlanRequest(video_encoder="bogus")
        with pytest.raises(ValueError, match="video_encoder must be"):
            req.validate()

    def test_validate_accepts_valid_video_encoder(self):
        for enc in ("libx264", "libx265"):
            req = PlanRequest(video_encoder=enc)
            req.validate()  # should not raise

    def test_validate_rejects_crf_out_of_range(self):
        req = PlanRequest(crf=52)
        with pytest.raises(ValueError, match="crf must be between 0 and 51"):
            req.validate()

    def test_validate_accepts_valid_crf(self):
        for crf in (0, 23, 51):
            req = PlanRequest(crf=crf)
            req.validate()  # should not raise

    def test_validate_rejects_bad_tune(self):
        req = PlanRequest(tune="bogus")
        with pytest.raises(ValueError, match="tune must be one of"):
            req.validate()

    def test_validate_accepts_valid_tune(self):
        for tune in (
            "",
            "film",
            "animation",
            "grain",
            "stillimage",
            "fastdecode",
            "zerolatency",
            "psnr",
            "ssim",
        ):
            req = PlanRequest(tune=tune)
            req.validate()  # should not raise

    def test_validate_rejects_incompatible_tune_with_libx265(self):
        req = PlanRequest(video_encoder="libx265", tune="film")
        with pytest.raises(ValueError, match="not compatible with libx265"):
            req.validate()

    def test_validate_accepts_compatible_tune_with_libx265(self):
        for tune in ("", "grain", "fastdecode", "zerolatency"):
            req = PlanRequest(video_encoder="libx265", tune=tune)
            req.validate()  # should not raise

    def test_validate_none_fields_no_validation(self):
        req = PlanRequest(video_encoder=None, crf=None, tune=None)
        req.validate()  # should not raise


class TestSizeEstimate:
    def test_estimate_from_bitrate(self):
        est = estimate_size_from_bitrate(
            duration_s=60.0, video_bitrate_bps=1_000_000, audio_bitrate_bps=128_000
        )

        expected = int((1_000_000 / 8 * 60) + (128_000 / 8 * 60))
        expected = int(expected * 1.08)
        assert est == expected

    def test_estimate_from_bitrate_no_audio(self):
        est = estimate_size_from_bitrate(
            duration_s=30.0, video_bitrate_bps=2_000_000, audio_bitrate_bps=0
        )
        assert est > 0


class TestMergeImportedProfiles:
    def test_no_duplicates_appends_all(self):
        from tuck.models import merge_imported_profiles

        existing = [
            Profile(name="A", profile_id="aaa"),
            Profile(name="B", profile_id="bbb"),
        ]
        imported = [
            Profile(name="C", profile_id="ccc"),
            Profile(name="D", profile_id="ddd"),
        ]
        merged = merge_imported_profiles(existing, imported)
        assert len(merged) == 4
        ids = {p.profile_id for p in merged}
        assert ids == {"aaa", "bbb", "ccc", "ddd"}

    def test_duplicate_with_existing_gets_new_uuid(self):
        from tuck.models import merge_imported_profiles

        existing = [
            Profile(name="A", profile_id="aaa"),
        ]
        imported = [
            Profile(name="B (dup of aaa)", profile_id="aaa"),
        ]
        merged = merge_imported_profiles(existing, imported)
        assert len(merged) == 2

        assert merged[0].profile_id == "aaa"
        assert merged[0].name == "A"

        assert merged[1].profile_id != "aaa"
        assert merged[1].name == "B (dup of aaa)"

    def test_duplicate_within_import_gets_new_uuid(self):

        from tuck.models import merge_imported_profiles

        existing: list[Profile] = []
        imported = [
            Profile(name="First", profile_id="same-id"),
            Profile(name="Second (same id)", profile_id="same-id"),
        ]
        merged = merge_imported_profiles(existing, imported)
        assert len(merged) == 2

        assert merged[0].profile_id == "same-id"
        assert merged[0].name == "First"

        assert merged[1].profile_id != "same-id"
        assert len(merged[1].profile_id) == 12  # UUID hex[:12]

    def test_existing_profiles_unchanged(self):

        from tuck.models import merge_imported_profiles

        existing = [
            Profile(name="Keep Me", profile_id="keep-me"),
        ]
        imported = [
            Profile(name="Dup", profile_id="keep-me"),
        ]
        merged = merge_imported_profiles(existing, imported)

        assert merged[0].profile_id == "keep-me"
        assert merged[0].name == "Keep Me"

    def test_mixed_existing_and_self_duplicates(self):

        from tuck.models import merge_imported_profiles

        existing = [
            Profile(name="A", profile_id="aaa"),
        ]
        imported = [
            Profile(name="B", profile_id="bbb"),  # no collision
            Profile(name="C (dup of aaa)", profile_id="aaa"),  # collides with existing
            Profile(name="D", profile_id="ddd"),  # no collision
            Profile(name="E (dup of ddd)", profile_id="ddd"),  # collides with D in same batch
        ]
        merged = merge_imported_profiles(existing, imported)
        assert len(merged) == 5

        ids = [p.profile_id for p in merged]
        assert len(ids) == len(set(ids))

        assert merged[0].profile_id == "aaa"
        assert merged[0].name == "A"

        bbb = [p for p in merged if p.name == "B"]
        assert len(bbb) == 1
        assert bbb[0].profile_id == "bbb"


class TestNormalizeLegacyRCMatrix:
    def test_compression_crf_normalized_to_cbr(self):
        """Legacy compression+CRF is normalized to compression+CBR."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="compression",
            rate_control="target_size",
            rate_control_method="crf",
            video_encoder="libx264",
            two_pass=True,
        )
        assert new_rcm == "cbr"
        assert new_two_pass is True

    def test_compression_cqp_normalized_to_cbr(self):
        """Legacy compression+CQP is normalized to compression+CBR."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="compression",
            rate_control="target_size",
            rate_control_method="cqp",
            video_encoder="h264_nvenc",
            two_pass=False,
        )
        assert new_rcm == "cbr"
        assert new_two_pass is False  # GPU + two_pass disabled

    def test_upscale_crf_preserved(self):
        """Upscale+CRF is preserved as-is."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="upscale",
            rate_control="target_size",
            rate_control_method="crf",
            video_encoder="libx264",
            two_pass=False,
        )
        assert new_rcm == "crf"
        assert new_two_pass is False

    def test_compression_cbr_preserved(self):
        """Compression+CBR is preserved as-is."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="compression",
            rate_control="target_size",
            rate_control_method="cbr",
            video_encoder="libx264",
            two_pass=True,
        )
        assert new_rcm == "cbr"
        assert new_two_pass is True

    def test_two_pass_disabled_for_gpu(self):
        """Two-pass is disabled for GPU encoders during normalization."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="compression",
            rate_control="target_size",
            rate_control_method="crf",
            video_encoder="h264_nvenc",
            two_pass=True,
        )
        assert new_rcm == "cbr"
        assert new_two_pass is False

    def test_two_pass_disabled_for_upscale(self):
        """Upscale with bitrate + target_size normalizes to crf + no two-pass."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="upscale",
            rate_control="target_size",
            rate_control_method="cbr",
            video_encoder="libx264",
            two_pass=True,
        )
        assert new_rcm == "crf"
        assert new_two_pass is False

    def test_two_pass_disabled_for_quality_method(self):
        """Two-pass is disabled when rate-control method is quality-based."""
        from tuck.models import _normalize_legacy_rc_matrix

        new_rcm, new_two_pass = _normalize_legacy_rc_matrix(
            workflow="compression",
            rate_control="target_size",
            rate_control_method="crf",
            video_encoder="libx264",
            two_pass=True,
        )
        assert new_rcm == "cbr"
        assert new_two_pass is True  # CPU + CBR keeps two_pass


class TestLegacyProfileNormalization:
    """Legacy compression+CRF profiles are normalized rather than rejected."""

    def test_compression_crf_profile_normalized_on_load(self):
        """Profile.from_dict normalizes compression+CRF to compression+CBR."""
        from tuck.models import Profile

        data = {
            "profile_id": "legacy-crf-test",
            "name": "Legacy CRF Profile",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "max_width": 1920,
            "max_height": 1080,
            "fps_mode": "source",
            "max_fps": 30.0,
            "rate_control": "target_size",
            "audio_bitrate": 128000,
            "audio_channels": 2,
            "audio_sample_rate": 44100,
            "preset": "medium",
            "two_pass": True,
            "schema_version": 2,
            "workflow": "compression",
            "rate_control_method": "crf",
        }
        p = Profile.from_dict(data)
        assert p.rate_control_method == "cbr"
        assert p.workflow == "compression"

    def test_compression_cqp_gpu_profile_normalized_on_load(self):
        """Profile.from_dict normalizes compression+CQP+GPU to CBR with two_pass=False."""
        from tuck.models import Profile

        data = {
            "profile_id": "legacy-cqp-gpu",
            "name": "Legacy CQP GPU Profile",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "max_width": 1920,
            "max_height": 1080,
            "fps_mode": "source",
            "max_fps": 30.0,
            "rate_control": "target_size",
            "audio_bitrate": 128000,
            "audio_channels": 2,
            "audio_sample_rate": 44100,
            "preset": "medium",
            "two_pass": True,
            "schema_version": 2,
            "workflow": "compression",
            "rate_control_method": "cqp",
            "video_encoder": "h264_nvenc",
        }
        p = Profile.from_dict(data)
        assert p.rate_control_method == "cbr"
        assert p.two_pass is False

    def test_upscale_crf_profile_preserved_on_load(self):
        """Profile.from_dict preserves upscale+CRF as-is."""
        from tuck.models import Profile

        data = {
            "profile_id": "legacy-upscale-crf",
            "name": "Legacy Upscale CRF",
            "target_size_bytes": 500 * 1024 * 1024,
            "resolution_mode": "custom",
            "custom_width": 2560,
            "custom_height": 1440,
            "fps_mode": "source",
            "rate_control": "target_size",
            "audio_bitrate": 128000,
            "audio_channels": 2,
            "audio_sample_rate": 44100,
            "preset": "medium",
            "two_pass": False,
            "schema_version": 2,
            "workflow": "upscale",
            "rate_control_method": "crf",
            "crf": 18,
        }
        p = Profile.from_dict(data)
        assert p.rate_control_method == "crf"
        assert p.workflow == "upscale"
        assert p.crf == 18
