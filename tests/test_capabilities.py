import json
import os

import pytest

from tuck.encoding.capabilities import (
    HW_FAILURE_DEVICE,
    HW_FAILURE_SETTINGS,
    _detect_usable_encoders,
    auto_encoder_candidates,
    get_encoder_capabilities,
    hardware_failure_kind,
    parse_filter_names,
    resolve_encoder,
    select_auto_encoder,
)
from tuck.models import ENCODER_AUTO, ENCODER_AUTO_COMPRESSION, ENCODER_AUTO_FAST


class TestAutoEncoder:
    def test_prefers_nvidia(self):
        available = frozenset({"libx264", "h264_nvenc", "h264_amf"})
        assert select_auto_encoder(available=available) == "h264_nvenc"

    def test_prefers_amd_when_no_nvidia(self):
        available = frozenset({"libx264", "h264_amf"})
        assert select_auto_encoder(available=available) == "h264_amf"

    def test_cpu_fallback(self):
        available = frozenset({"libx264", "libx265"})
        assert select_auto_encoder(available=available) == "libx264"

    def test_candidates_keep_amd_after_unavailable_nvenc(self):
        available = frozenset({"libx264", "h264_nvenc", "h264_amf"})
        assert auto_encoder_candidates(available=available) == (
            "h264_nvenc",
            "h264_amf",
            "libx264",
        )

    def test_compression_prefers_cpu(self):
        available = frozenset({"libx264", "h264_nvenc", "h264_amf"})
        assert auto_encoder_candidates(available=available, fastest=False) == (
            "libx264",
            "h264_nvenc",
            "h264_amf",
        )

    def test_resolve_auto(self):
        enc, was_auto = resolve_encoder(ENCODER_AUTO, frozenset({"libx264", "h264_nvenc"}))
        assert was_auto
        assert enc == "h264_nvenc"

    def test_resolve_both_auto_modes(self):
        for encoder in (ENCODER_AUTO, ENCODER_AUTO_COMPRESSION, ENCODER_AUTO_FAST):
            _, was_auto = resolve_encoder(encoder, frozenset({"libx264"}))
            assert was_auto

    def test_resolve_auto_compression_prefers_cpu(self):
        encoder, was_auto = resolve_encoder(
            ENCODER_AUTO_COMPRESSION, frozenset({"libx264", "h264_nvenc"})
        )
        assert was_auto
        assert encoder == "libx264"

    def test_resolve_explicit(self):
        enc, was_auto = resolve_encoder("h264_amf", frozenset({"h264_amf", "libx264"}))
        assert not was_auto
        assert enc == "h264_amf"


class TestUsableHardwareDetection:
    def test_linux_excludes_unusable_nvenc_and_amf(self, monkeypatch):
        monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
        monkeypatch.setattr(
            "tuck.encoding.capabilities._detect_available_encoders",
            lambda _ffmpeg: frozenset({"libx264", "libx265", "h264_nvenc", "h264_amf"}),
        )
        probes = []

        def unavailable(_ffmpeg, encoder):
            probes.append(encoder)
            return False

        monkeypatch.setattr("tuck.encoding.capabilities._hardware_encoder_works", unavailable)

        assert _detect_usable_encoders("ffmpeg") == frozenset({"libx264", "libx265"})
        assert probes == ["h264_nvenc"]
        assert auto_encoder_candidates(available=frozenset({"libx264", "h264_amf"})) == ("libx264",)
        caps = get_encoder_capabilities(available=frozenset({"libx264", "h264_amf"}))
        assert caps.to_dict() == {
            "available": ["libx264"],
            "has_nvidia": False,
            "has_amd": False,
            "has_cpu": True,
            "has_vaapi": False,
            "supports_auto": True,
        }
        with pytest.raises(ValueError, match="not supported on Linux"):
            resolve_encoder("h264_amf", frozenset({"libx264", "h264_amf"}))

    def test_excludes_nvenc_that_cannot_initialize(self, monkeypatch):
        monkeypatch.setattr(
            "tuck.encoding.capabilities._detect_available_encoders",
            lambda _ffmpeg: frozenset({"libx264", "h264_nvenc", "h264_amf"}),
        )
        monkeypatch.setattr(
            "tuck.encoding.capabilities._hardware_encoder_works",
            lambda _ffmpeg, encoder: encoder == "h264_amf",
        )
        assert _detect_usable_encoders("ffmpeg") == frozenset({"libx264", "h264_amf"})

    def test_hardware_probe_uses_supported_dimensions(self, monkeypatch):
        captured = {}

        class Result:
            returncode = 0
            stderr = ""

        def run(command, **_kwargs):
            captured["command"] = command
            return Result()

        monkeypatch.setattr("tuck.encoding.capabilities.subprocess.run", run)
        from tuck.encoding.capabilities import _hardware_encoder_works

        assert _hardware_encoder_works("ffmpeg", "h264_nvenc")
        assert "color=c=black:s=1280x720:d=0.1" in captured["command"]

    def test_excludes_all_unavailable_hardware(self, monkeypatch):
        monkeypatch.setattr(
            "tuck.encoding.capabilities._detect_available_encoders",
            lambda _ffmpeg: frozenset({"libx264", "h264_nvenc", "h264_amf"}),
        )
        monkeypatch.setattr(
            "tuck.encoding.capabilities._hardware_encoder_works", lambda *_args: False
        )
        assert _detect_usable_encoders("ffmpeg") == frozenset({"libx264"})


class TestPersistentEncoderCache:
    def test_uses_valid_cached_encoders(self, tmp_path, monkeypatch):
        import tuck.encoding.capabilities as capabilities

        cache_file = tmp_path / "encoders.json"
        ffmpeg_path = os.path.abspath("ffmpeg.exe")
        cache_file.write_text(
            json.dumps(
                {
                    "ffmpeg_path": ffmpeg_path,
                    "created_at": 1000,
                    "encoders": ["libx264", "h264_nvenc"],
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setattr(capabilities, "_encoder_cache_path", lambda: cache_file)
        monkeypatch.setattr(capabilities.time, "time", lambda: 1001)

        assert capabilities._load_cached_encoders(ffmpeg_path, 7) == frozenset(
            {"libx264", "h264_nvenc"}
        )

    def test_rejects_expired_or_different_ffmpeg_cache(self, tmp_path, monkeypatch):
        import tuck.encoding.capabilities as capabilities

        cache_file = tmp_path / "encoders.json"
        cache_file.write_text(
            json.dumps({"ffmpeg_path": "C:/old.exe", "created_at": 0, "encoders": ["libx264"]}),
            encoding="utf-8",
        )
        monkeypatch.setattr(capabilities, "_encoder_cache_path", lambda: cache_file)
        monkeypatch.setattr(capabilities.time, "time", lambda: 1_000_000)

        assert capabilities._load_cached_encoders("C:/ffmpeg.exe", 7) is None


class TestHardwareFailureClassification:
    def test_nvenc_missing_device(self):
        assert hardware_failure_kind("No NVENC capable devices found") is not None

    def test_amf_init(self):
        assert hardware_failure_kind("Failed to initialise AMF context") is not None

    def test_unrelated_input_error(self):
        assert hardware_failure_kind("No such file or directory") is None

    def test_permission_error_not_hw(self):
        assert hardware_failure_kind("Permission denied writing output") is None

    def test_missing_gpu_is_a_device_failure(self):
        stderr = (
            "[h264_nvenc @ 000001] Cannot load nvcuda.dll\n"
            "[vost#0:0/h264_nvenc @ 000002] Error while opening encoder - maybe incorrect "
            "parameters such as bit_rate, rate, width or height.\n"
        )
        assert hardware_failure_kind(stderr) == HW_FAILURE_DEVICE

    def test_missing_amd_runtime_is_a_device_failure(self):
        stderr = (
            "[h264_amf @ 000001] DLL amfrt64.dll failed to open\n"
            "[vost#0:0/h264_amf @ 000002] Error while opening encoder - maybe incorrect "
            "parameters such as bit_rate, rate, width or height.\n"
        )
        assert hardware_failure_kind(stderr) == HW_FAILURE_DEVICE

    def test_rejected_option_is_a_settings_failure_not_a_missing_gpu(self):
        stderr = (
            "[h264_amf @ 000001] [Eval @ 000002] Undefined constant or missing '(' in 'vbr'\n"
            '[h264_amf @ 000001] Unable to parse option value "vbr"\n'
            "[h264_amf @ 000001] Error setting option rc to value vbr.\n"
            "[vost#0:0/h264_amf @ 000003] Error applying encoder options: Invalid argument\n"
        )
        assert hardware_failure_kind(stderr) == HW_FAILURE_SETTINGS

    def test_generic_open_failure_is_a_settings_failure(self):
        stderr = (
            "[h264_nvenc @ 000001] Frame Dimension greater than maximum supported\n"
            "[vost#0:0/h264_nvenc @ 000002] Error while opening encoder - maybe incorrect "
            "parameters such as bit_rate, rate, width or height.\n"
        )
        assert hardware_failure_kind(stderr) == HW_FAILURE_SETTINGS

    def test_unrelated_failure_has_no_kind(self):
        assert hardware_failure_kind("pipe:2: No space left on device") is None


class TestFilterDiscovery:
    LISTING = (
        "Filters:\n"
        "  T.. = Timeline support\n"
        "  .S. = Slice threading\n"
        "  ..C = Command support\n"
        "  A = Audio input/output\n"
        "  | = Source or sink filter\n"
        " TSC aap               AA->A      Apply Affine Projection algorithm.\n"
        " .S. tonemap           V->V       Conversion to/from different dynamic ranges.\n"
        " .SC zscale            V->V       Apply resizing, colorspace and bit depth conversion.\n"
        " ... nullsrc           |->V       Null video source, return unprocessed video frames.\n"
    )

    def test_parses_filter_rows_without_the_legend(self):
        assert parse_filter_names(self.LISTING) == frozenset(
            {"aap", "tonemap", "zscale", "nullsrc"}
        )

    def test_tone_mapping_needs_both_filters(self, monkeypatch):
        from tuck.encoding import capabilities

        monkeypatch.setattr(capabilities, "get_available_filters", lambda: frozenset({"tonemap"}))
        assert not capabilities.can_tone_map_hdr()
        monkeypatch.setattr(
            capabilities, "get_available_filters", lambda: frozenset({"tonemap", "zscale"})
        )
        assert capabilities.can_tone_map_hdr()


class TestCapabilitiesDict:
    def test_to_dict_shape(self):
        caps = get_encoder_capabilities(available=frozenset({"libx264", "h264_nvenc"}))
        d = caps.to_dict()
        assert d["has_cpu"] is True
        assert d["has_nvidia"] is True
        assert d["has_amd"] is False
        assert "libx264" in d["available"]
