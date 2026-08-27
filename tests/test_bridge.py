import pytest

from tuck.bridge import BridgeAPI
from tuck.bridge_serialization import queue_item_dict
from tuck.models import (
    PROFILE_ID_DISCORD_FREE,
    CropRect,
    EncodePlan,
    OutputGeometry,
    Profile,
    QueueItem,
    QueueState,
    Segment,
    VideoInfo,
    VideoTransform,
    find_profile_by_id,
)
from tuck.profile_service import pick_surviving_default


def test_parse_plan_request_accepts_segments_and_rejects_legacy_mix(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    api = BridgeAPI()

    request = api._parse_plan_request(
        {
            "source": str(source),
            "segments": [{"start": 0.25, "end": 1.5}, {"start": 3, "end": 4}],
        }
    )
    assert request.segments == [Segment(0.25, 1.5), Segment(3, 4)]

    with pytest.raises(ValueError, match="cannot be combined"):
        api._parse_plan_request(
            {
                "source": str(source),
                "segments": [{"start": 0.25, "end": 1.5}],
                "trim_start": 0.25,
            }
        )


@pytest.mark.parametrize(
    ("segments", "message"),
    [
        ([], "at least one"),
        ([{"start": 0, "end": 0.01}], "too short"),
        ([{"start": 0, "end": float("inf")}], "finite"),
        ([{"start": 0, "end": 2}, {"start": 1, "end": 3}], "overlap"),
    ],
)
def test_parse_plan_request_rejects_invalid_segments(tmp_path, segments, message):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    with pytest.raises(ValueError, match=message):
        BridgeAPI()._parse_plan_request({"source": str(source), "segments": segments})


class TestBridgeQueueState:
    def test_reads_queue_state_from_one_snapshot(self, monkeypatch):
        api = BridgeAPI()
        item = QueueItem(plan=EncodePlan(source="clip.mp4", output="out.mp4"))
        monkeypatch.setattr(api._queue, "snapshot", lambda: ([item], item, [item.id]))
        state = api.get_queue_state()
        assert state["current_id"] == item.id
        assert state["pending_ids"] == [item.id]
        assert state["items"][0]["id"] == item.id

    def test_queue_snapshot_exposes_crop(self):
        crop = CropRect(11, 13, 200, 100)
        item = QueueItem(
            plan=EncodePlan(
                source="clip.mp4",
                output="out.mp4",
                transform=VideoTransform(crop=crop),
            )
        )

        assert queue_item_dict(item)["crop"] == crop.to_dict()

    def test_queue_snapshot_exposes_complete_transform(self):
        transform = VideoTransform(
            crop=CropRect(10, 20, 800, 600),
            crop_aspect="4:3",
            rotation=90,
            flip_horizontal=True,
            sizing_mode="fill",
            output=OutputGeometry(1080, 1920),
        )
        item = QueueItem(plan=EncodePlan(source="clip.mp4", output="out.mp4", transform=transform))
        assert queue_item_dict(item)["transform"] == transform.to_dict()

    def test_clear_completed_returns_removed_count(self):
        api = BridgeAPI()
        item = QueueItem(plan=EncodePlan(source="clip.mp4", output="out.mp4"))
        item.state = QueueState.COMPLETED
        api._queue._items[item.id] = item

        assert api.clear_completed() == {"ok": True, "count": 1}


def test_bridge_reuses_probe_metadata_for_unchanged_video(tmp_path, monkeypatch):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    info = VideoInfo(
        path=str(source),
        duration=1.0,
        width=320,
        height=240,
        fps=30.0,
        video_codec="h264",
    )
    calls = []
    monkeypatch.setattr("tuck.bridge.probe_video", lambda path: calls.append(path) or info)
    api = BridgeAPI()

    assert api._probe_once(str(source)) is info
    assert api._probe_once(str(source)) is info

    assert calls == [str(source)]


def test_bridge_reprobes_when_source_changes(tmp_path, monkeypatch):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    calls = []

    def fake_probe(path):
        calls.append(path)
        return VideoInfo(
            path=path,
            duration=1.0,
            width=320,
            height=240,
            fps=30.0,
            video_codec="h264",
        )

    monkeypatch.setattr("tuck.bridge.probe_video", fake_probe)
    api = BridgeAPI()
    api._probe_once(str(source))
    source.write_bytes(b"changed video")
    api._probe_once(str(source))

    assert calls == [str(source), str(source)]


class TestBridgeProfileLifecycle:
    def test_create_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = {
            "name": "My Test Profile",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "audio_bitrate": 128000,
            "preset": "medium",
            "two_pass": True,
            "max_width": 1920,
            "max_height": 1080,
            "max_fps": 30.0,
        }

        resp = api.create_profile(payload)
        assert resp["ok"]
        assert "profile_id" in resp

        profiles = api._settings.get_profiles()
        found = [p for p in profiles if p.profile_id == resp["profile_id"]]
        assert len(found) == 1
        assert found[0].name == "My Test Profile"

    def test_create_profile_persists_reusable_transform_intent(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        result = api.create_profile(
            {
                "name": "Vertical upload",
                "target_size_mb": 10,
                "resolution_mode": "custom",
                "custom_width": 1080,
                "custom_height": 1920,
                "transform_intent": {
                    "crop_aspect": "9:16",
                    "sizing_mode": "fill",
                    "rotation": 0,
                },
            }
        )

        assert result["ok"]
        profile = find_profile_by_id(api._settings.get_profiles(), result["profile_id"])
        assert profile is not None
        assert profile.transform_intent is not None
        assert profile.transform_intent.crop_aspect == "9:16"
        exposed = next(
            item for item in api.get_profiles_json() if item["profile_id"] == result["profile_id"]
        )
        assert exposed["transform_intent"] == profile.transform_intent.to_dict()

    def test_create_compression_profile_without_explicit_bitrate(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        payload = {
            "name": "Compression Profile",
            "target_size_mb": 50,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "audio_bitrate_kbps": 128,
            "keep_audio": True,
            "two_pass": True,
            "preset": "medium",
            "scaler": "neighbor",
            "video_encoder": "libx264",
            "crf": 23,
            "cq": 23,
            "tune": "",
            "workflow": "compression",
            "rate_control_method": "cbr",
        }

        result = api.create_profile(payload)
        assert result["ok"]
        profile = find_profile_by_id(api._settings.get_profiles(), result["profile_id"])
        assert profile is not None
        assert profile.explicit_bitrate == 0

    def test_noop_update_preserves_legacy_cqp_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profile = Profile(
            name="Legacy CQP",
            profile_id="legacy-cqp",
            workflow="upscale",
            video_encoder="h264_nvenc",
            preset="p5",
            rate_control="target_size",
            rate_control_method="cqp",
            cq=31,
            qp=18,
            two_pass=False,
        )
        profiles = api._settings.get_profiles()
        profiles.append(profile)
        api._settings.set_profiles(profiles)

        result = api.update_profile("legacy-cqp", {})
        assert result["ok"]
        restored = find_profile_by_id(api._settings.get_profiles(), "legacy-cqp")
        assert restored is not None
        assert restored.rate_control_method == "cqp"
        assert restored.qp == 18
        assert restored.cq == 31
        serialized = next(
            item for item in api.get_profiles_json() if item["profile_id"] == "legacy-cqp"
        )
        assert serialized["qp"] == 18

    def test_create_profile_rejects_invalid(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = '{"name": ""}'
        resp = api.create_profile(payload)
        assert not resp["ok"]

    def test_create_profile_uses_default_scaler_when_absent(self, tmp_path, monkeypatch):
        """create_profile uses persisted AppSettings.default_scaler when scaler absent."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        api._settings.set_setting("default_scaler", "lanczos")
        api._settings.save()

        payload = {
            "name": "Scaler Default Test",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "audio_bitrate": 128000,
            "preset": "medium",
            "two_pass": True,
        }

        resp = api.create_profile(payload)
        assert resp["ok"]
        assert "profile_id" in resp

        profiles = api._settings.get_profiles()
        found = [p for p in profiles if p.profile_id == resp["profile_id"]]
        assert len(found) == 1
        assert found[0].scaler == "lanczos"

    def test_create_profile_default_scaler_is_neighbor(self, tmp_path, monkeypatch):
        """create_profile falls back to 'neighbor' when default_scaler not explicitly set."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        api._settings.set_setting("default_scaler", "neighbor")
        api._settings.save()

        payload = {
            "name": "Scaler Fallback Test",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "audio_bitrate": 128000,
            "preset": "medium",
            "two_pass": True,
        }

        resp = api.create_profile(payload)
        assert resp["ok"]

        profiles = api._settings.get_profiles()
        found = [p for p in profiles if p.profile_id == resp["profile_id"]]
        assert len(found) == 1
        assert found[0].scaler == "neighbor"

    def test_duplicate_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        resp = api.duplicate_profile(PROFILE_ID_DISCORD_FREE)
        assert resp["ok"]
        assert "profile_id" in resp
        assert resp["profile_id"] != PROFILE_ID_DISCORD_FREE

        profiles = api._settings.get_profiles()
        found = [p for p in profiles if p.profile_id == resp["profile_id"]]
        assert len(found) == 1
        assert "copy" in found[0].name.lower()

    def test_delete_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Deletable", profile_id="delete-me")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        resp = api.delete_profile("delete-me")
        assert resp["ok"]

        remaining = api._settings.get_profiles()
        assert not any(p.profile_id == "delete-me" for p in remaining)

    def test_delete_profile_updates_default(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="My Default", profile_id="my-default")
        profiles.append(custom)
        api._settings.set_profiles(profiles)
        api._settings.set_setting("default_profile_id", "my-default")

        api.delete_profile("my-default")

        new_default = api._settings.get_setting("default_profile_id", "")
        assert new_default == PROFILE_ID_DISCORD_FREE

    def test_update_profile(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="Updatable", profile_id="updatable-1")
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = {"name": "Updated Name", "target_size_mb": 25}
        resp = api.update_profile("updatable-1", payload)
        assert resp["ok"]

        updated = api._settings.get_profiles()
        found = [p for p in updated if p.profile_id == "updatable-1"]
        assert len(found) == 1
        assert found[0].name == "Updated Name"
        assert found[0].target_size_bytes == 25 * 1024 * 1024

    def test_partial_update_preserves_other_fields(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(
            name="Partial Test",
            profile_id="partial-1",
            target_size_bytes=50 * 1024 * 1024,
            resolution_mode="source",
            fps_mode="source",
            rate_control="target_size",
            audio_bitrate=128000,
            preset="medium",
            two_pass=True,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = {"name": "Renamed Only"}
        resp = api.update_profile("partial-1", payload)
        assert resp["ok"]

        updated = api._settings.get_profiles()
        found = [p for p in updated if p.profile_id == "partial-1"]
        assert len(found) == 1
        assert found[0].name == "Renamed Only"
        assert found[0].target_size_bytes == 50 * 1024 * 1024
        assert found[0].resolution_mode == "source"
        assert found[0].fps_mode == "source"
        assert found[0].rate_control == "target_size"
        assert found[0].audio_bitrate == 128000
        assert found[0].preset == "medium"
        assert found[0].two_pass is True

    def test_partial_update_explicit_bitrate_kbps_is_rejected_for_compression(
        self, tmp_path, monkeypatch
    ):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        profiles.append(Profile(name="Bitrate Test", profile_id="br-test"))
        api._settings.set_profiles(profiles)

        resp = api.update_profile("br-test", {"explicit_bitrate_kbps": 2000})

        assert not resp["ok"]

    def test_partial_update_audio_bitrate_kbps(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(
            name="Audio Test",
            profile_id="audio-test",
            audio_bitrate=128000,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = {"audio_bitrate_kbps": 192}
        resp = api.update_profile("audio-test", payload)
        assert resp["ok"]

        updated = api._settings.get_profiles()
        found = [p for p in updated if p.profile_id == "audio-test"]
        assert len(found) == 1
        assert found[0].audio_bitrate == 192000


class TestBridgePlanRequest:
    def test_parse_plan_request_valid(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "resolution_mode": "custom",
            "custom_width": 1280,
            "custom_height": 720,
            "fps_mode": "custom",
            "custom_fps": 30.0,
            "rate_control": "explicit_bitrate",
            "explicit_bitrate": 2_000_000,
            "audio_bitrate": 192_000,
        }
        req = api._parse_plan_request(raw)
        assert req.source == str(test_file)
        assert req.resolution_mode == "custom"
        assert req.custom_width == 1280
        assert req.fps_mode == "custom"
        assert req.custom_fps == 30.0
        assert req.rate_control == "explicit_bitrate"
        assert req.explicit_bitrate == 2_000_000

    def test_queue_reorder_and_diagnostics(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        api = BridgeAPI()
        api._settings.load()
        plan = EncodePlan(source="a.mp4", output="a_out.mp4", target_size=1024 * 1024)
        a = api._queue.enqueue(plan)
        b = api._queue.enqueue(
            EncodePlan(source="b.mp4", output="b_out.mp4", target_size=1024 * 1024)
        )
        r = api.move_item(b.id, 0)
        assert r["ok"]
        state = api.get_queue_state()
        assert state["pending_ids"] == [b.id, a.id]
        for invalid_index in (True, 1.9):
            response = api.move_item(a.id, invalid_index)
            assert not response["ok"]
            assert response["error"] == "new_index must be an integer"
        diag = api.get_diagnostics({})
        assert diag["ok"]
        assert "Tuck version" in diag["text"]

    def test_parse_plan_request_accepts_trim(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        req = api._parse_plan_request(
            {
                "source": str(test_file),
                "profile_id": "test-p",
                "trim_start": 1.25,
                "trim_end": 4.5,
            }
        )
        assert req.trim_start == pytest.approx(1.25)
        assert req.trim_end == pytest.approx(4.5)

    def test_parse_plan_request_accepts_source_space_crop(self, tmp_path, monkeypatch):
        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")
        api = BridgeAPI()

        req = api._parse_plan_request(
            {
                "source": str(test_file),
                "transform": {"crop": {"x": 11, "y": 13, "width": 200, "height": 100}},
            }
        )

        assert req.transform == VideoTransform(crop=CropRect(11, 13, 200, 100))

    def test_parse_plan_request_accepts_complete_transform(self, tmp_path, monkeypatch):
        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")
        api = BridgeAPI()
        transform = {
            "crop": {"x": 10, "y": 20, "width": 800, "height": 600},
            "crop_aspect": "4:3",
            "rotation": 270,
            "flip_horizontal": True,
            "flip_vertical": True,
            "sizing_mode": "fill",
            "output": {"width": 1080, "height": 1920},
        }
        req = api._parse_plan_request({"source": str(test_file), "transform": transform})
        assert req.transform == VideoTransform.from_dict(transform)

    def test_old_request_without_crop_remains_full_frame(self, tmp_path, monkeypatch):
        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")
        api = BridgeAPI()

        req = api._parse_plan_request({"source": str(test_file)})

        assert req.transform is None

    def test_parse_plan_request_rejects_invalid_crop_shape(self, tmp_path, monkeypatch):
        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")
        api = BridgeAPI()

        with pytest.raises(ValueError, match="crop width"):
            api._parse_plan_request(
                {
                    "source": str(test_file),
                    "transform": {"crop": {"x": 0, "y": 0, "width": 0, "height": 100}},
                }
            )

    def test_parse_plan_request_rejects_inverted_trim(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        with pytest.raises(ValueError, match="trim_end"):
            api._parse_plan_request(
                {
                    "source": str(test_file),
                    "trim_start": 5.0,
                    "trim_end": 1.0,
                }
            )

    def test_parse_plan_request_rejects_empty_source(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        with pytest.raises(ValueError, match="non-empty"):
            api._parse_plan_request({"source": ""})

    def test_parse_plan_request_rejects_string_for_bool(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "keep_audio": "true",
        }
        with pytest.raises(ValueError, match="must be a boolean"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_rejects_bool_for_numeric(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "audio_bitrate": True,
        }
        with pytest.raises(ValueError, match="must be a number"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_rejects_numeric_string(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "custom_width": "1920",
        }
        with pytest.raises(ValueError, match="must be a number"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_rejects_nan(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "custom_fps": float("nan"),
        }
        with pytest.raises(ValueError, match="must be a finite number"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_rejects_infinity(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "explicit_bitrate": float("inf"),
        }
        with pytest.raises(ValueError, match="must be a finite number"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_accepts_valid_typed_input(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "custom_width": 1920,
            "custom_height": 1080,
            "custom_fps": 60.0,
            "audio_bitrate": 320000,
            "explicit_bitrate": 10000000,
            "keep_audio": True,
        }
        req = api._parse_plan_request(raw)
        assert req.custom_width == 1920
        assert req.custom_height == 1080
        assert req.custom_fps == 60.0
        assert req.audio_bitrate == 320000
        assert req.explicit_bitrate == 10000000
        assert req.keep_audio is True

    def test_parse_plan_request_rejects_fractional_float_for_integer(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "custom_width": 1920.5,
        }
        with pytest.raises(ValueError, match="must be an integer, not a fractional float"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_rejects_non_string_profile_id(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": 123,
        }
        with pytest.raises(ValueError, match="must be a string"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_rejects_non_string_resolution_mode(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "resolution_mode": 456,
        }
        with pytest.raises(ValueError, match="must be a string"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_scaler_valid(self, tmp_path, monkeypatch):
        """Scaler field is parsed from request."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "scaler": "lanczos",
        }
        req = api._parse_plan_request(raw)
        assert req.scaler == "lanczos"

    def test_parse_plan_request_scaler_invalid(self, tmp_path, monkeypatch):
        """Invalid scaler value is rejected."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "scaler": "bogus",
        }
        with pytest.raises(ValueError, match="Invalid scaler"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_scaler_none_ok(self, tmp_path, monkeypatch):
        """None scaler is accepted (falls back to profile)."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
        }
        req = api._parse_plan_request(raw)
        assert req.scaler is None

    def test_parse_plan_request_video_encoder_valid(self, tmp_path, monkeypatch):
        """video_encoder field is parsed from request."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "video_encoder": "libx265",
        }
        req = api._parse_plan_request(raw)
        assert req.video_encoder == "libx265"

    def test_parse_plan_request_video_encoder_invalid(self, tmp_path, monkeypatch):
        """Invalid video_encoder is rejected."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "video_encoder": "bogus",
        }
        with pytest.raises(ValueError, match="video_encoder must be"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_crf_valid(self, tmp_path, monkeypatch):
        """crf field is parsed from request."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "crf": 18,
        }
        req = api._parse_plan_request(raw)
        assert req.crf == 18

    def test_parse_plan_request_crf_out_of_range(self, tmp_path, monkeypatch):
        """crf out of range is rejected."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "crf": 52,
        }
        with pytest.raises(ValueError, match="crf must be between 0 and 51"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_crf_rejects_bool(self, tmp_path, monkeypatch):
        """crf as boolean is rejected."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "crf": True,
        }
        with pytest.raises(ValueError, match="must be a number"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_tune_valid(self, tmp_path, monkeypatch):
        """tune field is parsed from request."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "tune": "animation",
        }
        req = api._parse_plan_request(raw)
        assert req.tune == "animation"

    def test_parse_plan_request_tune_invalid(self, tmp_path, monkeypatch):
        """Invalid tune is rejected."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "tune": "bogus",
        }
        with pytest.raises(ValueError, match="tune must be one of"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_tune_incompatible_with_libx265(self, tmp_path, monkeypatch):
        """tune incompatible with libx265 is rejected."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
            "video_encoder": "libx265",
            "tune": "film",
        }
        with pytest.raises(ValueError, match="not compatible with libx265"):
            api._parse_plan_request(raw)

    def test_parse_plan_request_encoder_fields_none_ok(self, tmp_path, monkeypatch):
        """None for encoder fields is accepted (falls back to profile)."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        raw = {
            "source": str(test_file),
            "profile_id": "test-p",
        }
        req = api._parse_plan_request(raw)
        assert req.video_encoder is None
        assert req.crf is None
        assert req.tune is None

    def testnormalize_profile_ui_payload_rejects_fractional_float(self, tmp_path):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="must be an integer, not a fractional float"):
            normalize_profile_ui_payload({"target_size_mb": 25.5})

    def testnormalize_profile_ui_payload_rejects_bool_for_numeric(self):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="must be a number"):
            normalize_profile_ui_payload({"target_size_mb": True})

    def testnormalize_profile_ui_payload_rejects_string_for_numeric(self):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="must be a number"):
            normalize_profile_ui_payload({"target_size_mb": "not-a-number"})

    def testnormalize_profile_ui_payload_rejects_nan(self):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="must be a finite number"):
            normalize_profile_ui_payload({"target_size_mb": float("nan")})

    def testnormalize_profile_ui_payload_rejects_infinity(self):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="must be a finite number"):
            normalize_profile_ui_payload({"explicit_bitrate_kbps": float("inf")})

    def testnormalize_profile_ui_payload_rejects_string_for_two_pass(self):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="two_pass must be a boolean"):
            normalize_profile_ui_payload({"two_pass": "true"})

    def testnormalize_profile_ui_payload_rejects_string_for_keep_audio(self):

        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="keep_audio must be a boolean"):
            normalize_profile_ui_payload({"keep_audio": "false"})

    def testnormalize_profile_ui_payload_accepts_valid_video_encoder(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        for enc in ("libx264", "libx265"):
            result = normalize_profile_ui_payload({"video_encoder": enc})
            assert result["video_encoder"] == enc

    def testnormalize_profile_ui_payload_rejects_invalid_video_encoder(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="video_encoder must be"):
            normalize_profile_ui_payload({"video_encoder": "bogus"})

    def testnormalize_profile_ui_payload_rejects_non_string_video_encoder(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="video_encoder must be"):
            normalize_profile_ui_payload({"video_encoder": 123})

    def testnormalize_profile_ui_payload_accepts_valid_crf(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        for crf in (0, 23, 51):
            result = normalize_profile_ui_payload({"crf": crf})
            assert result["crf"] == crf

    def testnormalize_profile_ui_payload_rejects_crf_bool(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="crf must be a number"):
            normalize_profile_ui_payload({"crf": True})

    def testnormalize_profile_ui_payload_rejects_crf_string(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="crf must be a number"):
            normalize_profile_ui_payload({"crf": "23"})

    def testnormalize_profile_ui_payload_rejects_crf_out_of_range_high(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="crf must be between 0 and 51"):
            normalize_profile_ui_payload({"crf": 52})

    def testnormalize_profile_ui_payload_rejects_crf_out_of_range_low(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="crf must be between 0 and 51"):
            normalize_profile_ui_payload({"crf": -1})

    def testnormalize_profile_ui_payload_rejects_crf_nan(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="crf must be finite"):
            normalize_profile_ui_payload({"crf": float("nan")})

    def testnormalize_profile_ui_payload_rejects_crf_inf(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="crf must be finite"):
            normalize_profile_ui_payload({"crf": float("inf")})

    def testnormalize_profile_ui_payload_accepts_valid_tune(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        for tune in ("", "film", "animation", "grain", "stillimage", "fastdecode", "zerolatency"):
            result = normalize_profile_ui_payload({"tune": tune})
            assert result["tune"] == tune

    def testnormalize_profile_ui_payload_rejects_invalid_tune(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="tune must be one of"):
            normalize_profile_ui_payload({"tune": "bogus"})

    def testnormalize_profile_ui_payload_rejects_non_string_tune(self):
        from tuck.bridge_validation import normalize_profile_ui_payload

        with pytest.raises(ValueError, match="tune must be a string"):
            normalize_profile_ui_payload({"tune": 123})

    def test_create_plan_returns_request_id(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test.mp4"
        test_file.write_text("dummy")

        api = BridgeAPI()
        api._settings.load()
        resp = api.create_plan({"source": str(test_file), "_request_id": 42})
        assert resp.get("_request_id") == 42

    def test_create_plan_response_includes_scaler(
        self, tmp_path, monkeypatch, skip_if_no_ffprobe, sample_video_path
    ):
        """create_plan response exposes the effective scaler."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        profiles = api._settings.get_profiles()
        custom = Profile(
            name="Scaler Test",
            profile_id="scaler-test",
            target_size_bytes=100 * 1024 * 1024,
            resolution_mode="custom",
            custom_width=640,
            custom_height=360,
            fps_mode="source",
            scaler="lanczos",
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        resp = api.create_plan(
            {
                "source": str(sample_video_path),
                "profile_id": "scaler-test",
            }
        )
        assert resp["ok"]
        assert resp["data"]["scaler"] == "lanczos"

    def test_create_plan_scaler_override_in_response(
        self, tmp_path, monkeypatch, skip_if_no_ffprobe, sample_video_path
    ):
        """create_plan response scaler reflects request override."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        profiles = api._settings.get_profiles()
        custom = Profile(
            name="Scaler Override Test",
            profile_id="scaler-override",
            target_size_bytes=100 * 1024 * 1024,
            resolution_mode="custom",
            custom_width=640,
            custom_height=360,
            fps_mode="source",
            scaler="bicubic",
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        resp = api.create_plan(
            {
                "source": str(sample_video_path),
                "profile_id": "scaler-override",
                "scaler": "nearest",
            }
        )
        assert resp["ok"]
        assert resp["data"]["scaler"] == "neighbor"


class TestBridgeWorkflowPropagation:
    def test_create_plan_response_includes_workflow(
        self, tmp_path, monkeypatch, skip_if_no_ffprobe, sample_video_path
    ):
        """create_plan response exposes workflow field."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        profiles = api._settings.get_profiles()
        custom = Profile(
            name="Workflow Test",
            profile_id="wf-test",
            target_size_bytes=500 * 1024 * 1024,
            resolution_mode="custom",
            custom_width=2560,
            custom_height=1440,
            fps_mode="source",
            workflow="upscale",
            rate_control_method="crf",
            crf=18,
            two_pass=False,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        resp = api.create_plan(
            {
                "source": str(sample_video_path),
                "profile_id": "wf-test",
            }
        )
        assert resp["ok"]
        assert resp["data"]["workflow"] == "upscale"
        assert resp["data"]["rate_control_method"] == "crf"

    def test_create_plan_response_includes_qp(
        self, tmp_path, monkeypatch, skip_if_no_ffprobe, sample_video_path
    ):
        """create_plan response exposes qp field."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        profiles = api._settings.get_profiles()
        custom = Profile(
            name="QP Test",
            profile_id="qp-test",
            target_size_bytes=500 * 1024 * 1024,
            resolution_mode="custom",
            custom_width=1920,
            custom_height=1080,
            fps_mode="source",
            workflow="upscale",
            rate_control_method="cqp",
            video_encoder="h264_nvenc",
            qp=20,
            two_pass=False,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        resp = api.create_plan(
            {
                "source": str(sample_video_path),
                "profile_id": "qp-test",
            }
        )
        assert resp["ok"]
        assert resp["data"]["qp"] == 20

    def test_get_settings_includes_workflow_fields(self, tmp_path, monkeypatch):
        """get_settings response includes workflow, rate_control_method, qp."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        resp = api.get_settings()
        profiles = resp.get("profiles", [])
        assert len(profiles) > 0
        p = profiles[0]
        assert "workflow" in p
        assert "rate_control_method" in p
        assert "qp" in p
        assert resp["encoder_cache_days"] == 7
        assert resp["last_update_check"] == ""
        assert resp["open_output_folder_after_queue"] is False
        assert resp["timeline_height"] == 0
        assert resp["inspector_start_panel"] == "export"
        assert resp["last_inspector_panel"] == "export"

    def test_save_settings_validates_open_output_folder_after_queue(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        saved = api.save_settings({"open_output_folder_after_queue": True})
        invalid = api.save_settings({"open_output_folder_after_queue": "yes"})

        assert saved["ok"]
        assert api._settings.load().open_output_folder_after_queue is True
        assert not invalid["ok"]
        assert invalid["error"] == "open_output_folder_after_queue must be boolean"

    def test_save_settings_validates_timeline_height(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        saved = api.save_settings({"timeline_height": 260})
        reset = api.save_settings({"timeline_height": 0})
        invalid = api.save_settings({"timeline_height": 120})

        assert saved["ok"]
        assert reset["ok"]
        assert api._settings.load().timeline_height == 0
        assert not invalid["ok"]
        assert invalid["error"] == "timeline_height must be 0 or 170 to 2400"

    def test_save_settings_validates_inspector_panel_preferences(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        assert api.save_settings({"inspector_start_panel": "last"})["ok"]
        assert api.save_settings({"last_inspector_panel": "audio"})["ok"]

        settings = api._settings.load()
        assert settings.inspector_start_panel == "last"
        assert settings.last_inspector_panel == "audio"

        invalid_start = api.save_settings({"inspector_start_panel": "edit"})
        invalid_last = api.save_settings({"last_inspector_panel": "last"})
        assert invalid_start == {
            "ok": False,
            "error": "inspector_start_panel must be last, video, audio, or export",
        }
        assert invalid_last == {
            "ok": False,
            "error": "last_inspector_panel must be video, audio, or export",
        }

    def test_save_settings_validates_encoder_cache_days(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        assert api.save_settings({"encoder_cache_days": 30})["ok"]
        assert api._settings.load().encoder_cache_days == 30
        assert not api.save_settings({"encoder_cache_days": 366})["ok"]

    def test_saving_cache_duration_keeps_encoder_cache(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        cleared: list[bool] = []
        monkeypatch.setattr(
            "tuck.bridge.clear_encoder_cache", lambda *, delete_disk: cleared.append(delete_disk)
        )

        api = BridgeAPI()
        assert api.save_settings({"encoder_cache_days": 30})["ok"]
        assert cleared == []

    def test_get_profiles_json_includes_workflow_fields(self, tmp_path, monkeypatch):
        """get_profiles_json response includes workflow, rate_control_method, qp."""
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        resp = api.get_profiles_json()
        assert len(resp) > 0
        p = resp[0]
        assert "workflow" in p
        assert "rate_control_method" in p
        assert "qp" in p


class TestBridgeImportExport:
    def test_import_handles_duplicate_ids(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.models import export_profiles_json

        api = BridgeAPI()
        api._settings.load()

        dup = Profile(name="Duplicate", profile_id=PROFILE_ID_DISCORD_FREE)
        export_path = tmp_path / "dup.json"
        export_profiles_json([dup], export_path)

        profiles_before = len(api._settings.get_profiles())
        from tuck.models import import_profiles_json, merge_imported_profiles

        imported = import_profiles_json(export_path)
        merged = merge_imported_profiles(api._settings.get_profiles(), imported)
        api._settings.set_profiles(merged)

        assert len(api._settings.get_profiles()) > profiles_before


class TestBridgeQueueManagement:
    def test_retry_item_requeues_failed_item(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        item = api._queue.enqueue(EncodePlan(source="source.mp4", output="output.mp4"))
        item.state = QueueState.FAILED

        response = api.retry_item(item.id)

        assert response["ok"]
        assert api._queue.items[-1].state == QueueState.PENDING
        assert api._queue.items[-1].plan == item.plan

    def test_stop_after_current_cancels_pending_items(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        item = api._queue.enqueue(EncodePlan(source="source.mp4", output="output.mp4"))

        response = api.stop_after_current()

        assert response["ok"]
        assert item.state == QueueState.CANCELLED


class TestBridgePreviewEnqueueParity:
    def test_preview_and_enqueue_produce_same_plan(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        test_file = tmp_path / "test_video.mp4"
        test_file.write_text("dummy probe placeholder")

        api = BridgeAPI()
        api._settings.load()

        profiles = api._settings.get_profiles()
        custom = Profile(
            name="Parity Test",
            profile_id="parity-p",
            target_size_bytes=100 * 1024 * 1024,
            resolution_mode="limit",
            max_width=1920,
            max_height=1080,
            fps_mode="limit",
            max_fps=30.0,
            rate_control="explicit_bitrate",
            explicit_bitrate=2_000_000,
            audio_bitrate=128000,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        request_payload = {
            "source": str(test_file),
            "profile_id": "parity-p",
            "resolution_mode": "custom",
            "custom_width": 1280,
            "custom_height": 720,
            "fps_mode": "custom",
            "custom_fps": 24.0,
            "rate_control": "explicit_bitrate",
            "explicit_bitrate": 1_500_000,
            "audio_bitrate": 192000,
        }

        preview_json = api.create_plan(request_payload)
        enqueue_json = api.enqueue_with_options(request_payload)

        assert preview_json["ok"] == enqueue_json["ok"], (
            f"Parity mismatch: preview={preview_json['ok']}, enqueue={enqueue_json['ok']}"
        )

        if preview_json["ok"]:
            preview_data = preview_json["data"]

            item_id = enqueue_json["item_id"]
            queue_items = api._queue.items
            enqueued = [i for i in queue_items if i.id == item_id]
            assert len(enqueued) == 1
            enqueued_plan = enqueued[0].plan
            assert enqueued_plan is not None

            assert enqueued_plan.source == preview_data["source"]
            assert enqueued_plan.profile_id == preview_data["profile_id"]
            assert enqueued_plan.target_width == preview_data["target_width"]
            assert enqueued_plan.target_height == preview_data["target_height"]
            assert enqueued_plan.rate_control == preview_data["rate_control"]

            api._queue.cancel(item_id)

    def test_preview_and_enqueue_reject_same_error(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        payload = {"source": ""}
        preview = api.create_plan(payload)
        enqueue = api.enqueue_with_options(payload)
        assert not preview["ok"]
        assert not enqueue["ok"]

        assert "error" in preview
        assert "error" in enqueue


class TestDeleteDefaultPolicy:
    def test_delete_default_picks_survivor(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        profiles = api._settings.get_profiles()
        custom = Profile(name="DefaultCustom", profile_id="default-custom")
        profiles.append(custom)
        api._settings.set_profiles(profiles)
        api._settings.set_setting("default_profile_id", "default-custom")

        api.delete_profile("default-custom")
        new_default = api._settings.get_setting("default_profile_id", "")

        assert new_default != "default-custom"
        assert new_default in {p.profile_id for p in api._settings.get_profiles()}

    def test_delete_default_when_only_user_profiles_left(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()

        api._settings.set_profiles([])

        p1 = Profile(name="First", profile_id="user-one")
        p2 = Profile(name="Second", profile_id="user-two")
        api._settings.set_profiles([p1, p2])
        api._settings.set_setting("default_profile_id", "user-one")

        api.delete_profile("user-one")
        new_default = api._settings.get_setting("default_profile_id", "")
        assert new_default == "user-two"

    def testpick_surviving_default_prefers_builtins(self):

        p1 = Profile(name="Builtin 500MB", profile_id="discord-500mb")
        p2 = Profile(name="User", profile_id="user-abc")
        result = pick_surviving_default([p1, p2])
        assert result == "discord-500mb"

    def testpick_surviving_default_returns_first_if_no_builtins(self):

        p1 = Profile(name="A", profile_id="aaa")
        p2 = Profile(name="B", profile_id="bbb")
        result = pick_surviving_default([p1, p2])
        assert result == "aaa"


class TestBridgeImportExportFromFile:
    def test_import_from_file_success(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.models import export_profiles_json

        api = BridgeAPI()
        api._settings.load()

        dup = Profile(name="ImportTest", profile_id="import-test-1")
        export_path = tmp_path / "to_import.json"
        export_profiles_json([dup], export_path)

        profiles_before = len(api._settings.get_profiles())
        resp = api.import_profiles_from_file(str(export_path))
        assert resp["ok"]
        assert resp["count"] == 1
        assert len(api._settings.get_profiles()) > profiles_before

    def test_import_from_file_handles_duplicate_ids(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.models import export_profiles_json

        api = BridgeAPI()
        api._settings.load()

        dup = Profile(name="Duplicate", profile_id=PROFILE_ID_DISCORD_FREE)
        export_path = tmp_path / "dup.json"
        export_profiles_json([dup], export_path)

        profiles_before = len(api._settings.get_profiles())
        resp = api.import_profiles_from_file(str(export_path))
        assert resp["ok"]
        assert len(api._settings.get_profiles()) > profiles_before

    def test_import_from_file_missing_file(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        resp = api.import_profiles_from_file(str(tmp_path / "nonexistent.json"))
        assert not resp["ok"]

    def test_export_single_profile_to_file(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        from tuck.models import import_profiles_json

        api = BridgeAPI()
        api._settings.load()
        first = Profile(name="First", profile_id="first")
        second = Profile(name="Second", profile_id="second")
        api._settings.set_profiles([first, second])

        export_path = tmp_path / "second.json"
        resp = api.export_profile_to_file(str(export_path), "second")

        assert resp["ok"]
        assert import_profiles_json(export_path) == [second]

    def test_export_single_profile_rejects_missing_id(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_settings_manager", None)

        api = BridgeAPI()
        api._settings.load()
        export_path = tmp_path / "missing.json"

        resp = api.export_profile_to_file(str(export_path), "missing")

        assert resp == {"ok": False, "error": "Profile not found: missing"}
        assert not export_path.exists()


class TestBridgeGetProfilesJson:
    def test_returns_list(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        resp = api.get_profiles_json()
        assert isinstance(resp, list)
        assert len(resp) >= 3  # builtins

    def test_profile_dict_has_expected_keys(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        resp = api.get_profiles_json()
        p = resp[0]
        for key in (
            "profile_id",
            "name",
            "target_size_bytes",
            "target_size_mb",
            "resolution_mode",
            "max_width",
            "max_height",
            "fps_mode",
            "max_fps",
            "custom_fps",
            "rate_control",
            "audio_bitrate",
            "audio_bitrate_kbps",
            "two_pass",
            "preset",
        ):
            assert key in p, f"Missing key: {key}"


class TestBridgeRemoveGenericSendTo:
    def test_remove_generic_sendto_ok(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.sendto._sendto_dir", lambda: tmp_path)

        api = BridgeAPI()
        api._settings.load()
        resp = api.remove_generic_sendto()
        assert resp["ok"]


class TestBridgeRateControlMatrixValidation:
    """Bridge create/update rejects invalid rate-control combinations."""

    def _setup_api(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        api = BridgeAPI()
        api._settings.load()
        return api

    def test_create_profile_rejects_compression_with_crf(self, tmp_path, monkeypatch):
        """Compression workflow + CRF rate-control method is rejected."""
        api = self._setup_api(tmp_path, monkeypatch)
        payload = {
            "name": "Bad Compression CRF",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "workflow": "compression",
            "rate_control_method": "crf",
            "two_pass": False,
        }

        resp = api.create_profile(payload)
        assert not resp["ok"]
        assert "bitrate-driven" in resp["error"] or "quality method" in resp["error"]

    def test_create_profile_rejects_compression_with_cqp(self, tmp_path, monkeypatch):
        """Compression workflow + CQP rate-control method is rejected."""
        api = self._setup_api(tmp_path, monkeypatch)
        payload = {
            "name": "Bad Compression CQP",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "workflow": "compression",
            "rate_control_method": "cqp",
            "video_encoder": "h264_nvenc",
            "two_pass": False,
        }

        resp = api.create_profile(payload)
        assert not resp["ok"]
        assert "bitrate-driven" in resp["error"] or "quality method" in resp["error"]

    def test_create_profile_rejects_two_pass_with_gpu(self, tmp_path, monkeypatch):
        """Two-pass encoding with GPU encoder is rejected."""
        api = self._setup_api(tmp_path, monkeypatch)
        payload = {
            "name": "Bad Two-Pass GPU",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "workflow": "compression",
            "rate_control_method": "cbr",
            "video_encoder": "h264_nvenc",
            "two_pass": True,
        }

        resp = api.create_profile(payload)
        assert not resp["ok"]
        assert "Two-pass" in resp["error"]

    def test_create_profile_rejects_two_pass_with_upscale(self, tmp_path, monkeypatch):
        """Two-pass encoding with upscale workflow is rejected."""
        api = self._setup_api(tmp_path, monkeypatch)
        payload = {
            "name": "Bad Two-Pass Upscale",
            "target_size_bytes": 500 * 1024 * 1024,
            "resolution_mode": "custom",
            "custom_width": 2560,
            "custom_height": 1440,
            "fps_mode": "source",
            "rate_control": "target_size",
            "workflow": "upscale",
            "rate_control_method": "crf",
            "crf": 18,
            "two_pass": True,
        }

        resp = api.create_profile(payload)
        assert not resp["ok"]
        assert "Two-pass" in resp["error"]

    def test_create_profile_accepts_compression_with_cbr(self, tmp_path, monkeypatch):
        """Compression workflow + CBR rate-control method is accepted."""
        api = self._setup_api(tmp_path, monkeypatch)
        payload = {
            "name": "Good Compression CBR",
            "target_size_bytes": 50 * 1024 * 1024,
            "resolution_mode": "source",
            "fps_mode": "source",
            "rate_control": "target_size",
            "workflow": "compression",
            "rate_control_method": "cbr",
            "two_pass": True,
        }

        resp = api.create_profile(payload)
        assert resp["ok"]

    def test_create_profile_accepts_upscale_with_crf(self, tmp_path, monkeypatch):
        """Upscale workflow + CRF rate-control method is accepted."""
        api = self._setup_api(tmp_path, monkeypatch)
        payload = {
            "name": "Good Upscale CRF",
            "target_size_bytes": 500 * 1024 * 1024,
            "resolution_mode": "custom",
            "custom_width": 2560,
            "custom_height": 1440,
            "fps_mode": "source",
            "rate_control": "target_size",
            "workflow": "upscale",
            "rate_control_method": "crf",
            "crf": 18,
            "two_pass": False,
        }

        resp = api.create_profile(payload)
        assert resp["ok"]

    def test_update_profile_rejects_invalid_rc_matrix(self, tmp_path, monkeypatch):
        """Updating a profile to an invalid rate-control matrix is rejected."""
        api = self._setup_api(tmp_path, monkeypatch)
        profiles = api._settings.get_profiles()
        custom = Profile(
            name="RC Matrix Test",
            profile_id="rc-matrix-test",
            target_size_bytes=50 * 1024 * 1024,
            resolution_mode="source",
            fps_mode="source",
            rate_control="target_size",
            workflow="compression",
            rate_control_method="cbr",
            two_pass=True,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = {"rate_control_method": "crf", "two_pass": False}
        resp = api.update_profile("rc-matrix-test", payload)
        assert not resp["ok"]
        assert "bitrate-driven" in resp["error"] or "quality method" in resp["error"]

    def test_update_profile_accepts_valid_rc_matrix_change(self, tmp_path, monkeypatch):
        """Updating a profile to a valid rate-control matrix is accepted."""
        api = self._setup_api(tmp_path, monkeypatch)
        profiles = api._settings.get_profiles()
        custom = Profile(
            name="RC Matrix Valid",
            profile_id="rc-matrix-valid",
            target_size_bytes=50 * 1024 * 1024,
            resolution_mode="source",
            fps_mode="source",
            rate_control="target_size",
            workflow="compression",
            rate_control_method="cbr",
            two_pass=True,
        )
        profiles.append(custom)
        api._settings.set_profiles(profiles)

        payload = {"rate_control_method": "cbr", "two_pass": False}
        resp = api.update_profile("rc-matrix-valid", payload)
        assert resp["ok"]
