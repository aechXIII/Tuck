from pathlib import Path
from types import SimpleNamespace

import pytest
from test_cuda_blending import blend_for, blending_plan

from tuck.encoding import hardware_decoding
from tuck.encoding.command import build_base_cmd
from tuck.encoding.failures import is_hardware_decode_failure


@pytest.mark.parametrize(
    "backend,format", [("cuda", "cuda"), ("d3d11va", "d3d11"), ("vaapi", "vaapi")]
)
@pytest.mark.parametrize("weighted", [False, True])
def test_hardware_decode_downloads_before_the_same_blend(tmp_path, backend, format, weighted):
    from dataclasses import replace

    plan = blending_plan(tmp_path)
    blend = replace(blend_for(plan), weighted=weighted, color_range="pc")
    decoder = hardware_decoding.HardwareDecode(
        backend, "/dev/dri/renderD128" if backend == "vaapi" else ""
    )
    cpu = build_base_cmd("ffmpeg", plan, Path(plan.source), blend=blend)
    gpu = build_base_cmd("ffmpeg", plan, Path(plan.source), blend=blend, hardware_decode=decoder)
    before = gpu[: gpu.index("-i")]
    assert before[before.index("-hwaccel") + 1] == backend
    assert before[before.index("-hwaccel_output_format") + 1] == format
    assert before[before.index("-c:v") + 1] == "av1"
    assert "-xerror" in before
    if backend == "vaapi":
        assert "vaapi=tuck_decode:/dev/dri/renderD128" in before
    graph = gpu[gpu.index("-filter_complex") + 1]
    assert graph.count("hwdownload,format=nv12,") == 1
    assert graph.replace("hwdownload,format=nv12,", "") == cpu[cpu.index("-filter_complex") + 1]


def test_windows_prefers_cuda_and_uses_amd_adapter_without_requiring_amf(monkeypatch):
    monkeypatch.setattr(hardware_decoding, "is_linux_desktop", lambda: False)
    attempts = []

    def available(_ffmpeg, decoder):
        attempts.append(decoder)
        return decoder.backend == "d3d11va"

    monkeypatch.setattr(hardware_decoding, "device_available", available)
    assert (
        hardware_decoding.choose_hardware_decode("ffmpeg", frozenset({"h264_nvenc"})).backend
        == "cuda"
    )
    assert not attempts
    decoder = hardware_decoding.choose_hardware_decode("ffmpeg", frozenset({"libx264"}))
    assert decoder.backend == "d3d11va" and decoder.device == ",vendor_id=0x1002"


def test_linux_tries_available_render_devices_without_a_hardware_encoder(monkeypatch):
    monkeypatch.setattr(hardware_decoding, "is_linux_desktop", lambda: True)
    monkeypatch.setattr(
        hardware_decoding, "render_devices", lambda: ["/dev/dri/renderD128", "/dev/dri/renderD129"]
    )
    attempts = []

    def available(_ffmpeg, decoder):
        attempts.append(decoder)
        return decoder.device.endswith("129")

    monkeypatch.setattr(hardware_decoding, "device_available", available)
    decoder = hardware_decoding.choose_hardware_decode("ffmpeg", frozenset({"libx264"}))
    assert decoder == hardware_decoding.HardwareDecode("vaapi", "/dev/dri/renderD129")
    assert [d.backend for d in attempts] == ["cuda", "vaapi", "vaapi"]


@pytest.mark.parametrize("linux", [False, True])
def test_missing_devices_use_cpu_decoding(monkeypatch, linux):
    monkeypatch.setattr(hardware_decoding, "is_linux_desktop", lambda: linux)
    monkeypatch.setattr(hardware_decoding, "render_devices", lambda: ["/dev/dri/renderD128"])
    monkeypatch.setattr(hardware_decoding, "device_available", lambda *_: False)
    assert hardware_decoding.choose_hardware_decode("ffmpeg", frozenset({"libx264"})) is None


def test_windows_without_amd_does_not_choose_an_unrelated_adapter(monkeypatch):
    monkeypatch.setattr(hardware_decoding, "is_linux_desktop", lambda: False)
    attempts = []

    def available(_ffmpeg, decoder):
        attempts.append(decoder)
        return not decoder.device

    monkeypatch.setattr(hardware_decoding, "device_available", available)
    assert hardware_decoding.choose_hardware_decode("ffmpeg", frozenset({"libx264"})) is None
    assert [decoder.device for decoder in attempts] == [",vendor_id=0x1002"]


@pytest.mark.parametrize("vendor", ["0x1002", "0x8086", "0x10de", None])
def test_linux_automatic_render_devices_are_amd_only(tmp_path, monkeypatch, vendor):
    device = tmp_path / "dev/dri/renderD128"
    device.parent.mkdir(parents=True)
    device.touch()
    if vendor is not None:
        vendor_file = tmp_path / "sys/class/drm/renderD128/device/vendor"
        vendor_file.parent.mkdir(parents=True)
        vendor_file.write_text(vendor + "\n")
    monkeypatch.setattr(hardware_decoding, "Path", lambda value: tmp_path / value.lstrip("/"))
    monkeypatch.setattr(Path, "is_char_device", lambda path: path == device)
    assert hardware_decoding.render_devices() == ([str(device)] if vendor == "0x1002" else [])


@pytest.mark.parametrize("backend", ["d3d11va", "vaapi"])
@pytest.mark.parametrize("returncode", [0, 1])
def test_device_probe_uses_real_initialization_and_is_bounded(monkeypatch, backend, returncode):
    commands = []

    def run(command, **kwargs):
        assert kwargs["stdin"] is not None and kwargs["timeout"] == 15
        commands.append(command)
        return SimpleNamespace(returncode=returncode, stderr=b"device failure")

    monkeypatch.setattr(hardware_decoding.subprocess, "run", run)
    assert hardware_decoding.device_available(
        "ffmpeg", hardware_decoding.HardwareDecode(backend)
    ) == (returncode == 0)
    assert "-init_hw_device" in commands[0] and not any("nvenc" in arg for arg in commands[0])
    # the synthetic fixture uses a software decoder, so only device initialization is probed
    assert "-hwaccel_device" not in commands[0]


@pytest.mark.parametrize(
    "backend,stderr",
    [
        (
            "vaapi",
            "[AVHWDeviceContext @ 01] No VA display found for device /dev/dri/renderD128.\n"
            "Device creation failed: -22.\n"
            "Failed to set value 'vaapi=tuck_decode:/dev/dri/renderD128' "
            "for option 'init_hw_device': Invalid argument",
        ),
        (
            "vaapi",
            "[AVHWDeviceContext @ 01] Failed to initialise VAAPI connection: 1 (operation failed).",
        ),
        ("vaapi", "[av1 @ 01] No support for codec av1 profile 0."),
        ("d3d11va", "[AVHWDeviceContext @ 01] Failed to create Direct3D device (887a0004)"),
        ("d3d11va", "[AVHWDeviceContext @ 01] Failed to find d3d11va adapter by vendor id 0x1002"),
        ("d3d11va", "[av1 @ 01] No decoder device for codec av1"),
        (
            "d3d11va",
            "[av1 @ 01] Failed setup for format d3d11: hwaccel initialisation returned error.",
        ),
        (
            "vaapi",
            "[av1 @ 01] Failed setup for format vaapi: hwaccel initialisation returned error.",
        ),
        (
            "vaapi",
            "[AVHWDeviceContext @ 01] Failed to open /dev/dri/renderD128 as DRM device node.\n"
            "Device creation failed: -13.\n"
            "Failed to set value 'vaapi=tuck_decode:/dev/dri/renderD128' "
            "for option 'init_hw_device': Permission denied\n"
            "Error parsing global options: Permission denied",
        ),
    ],
)
def test_hardware_device_and_codec_failures_retry(backend, stderr):
    assert is_hardware_decode_failure(stderr, backend)


@pytest.mark.parametrize("backend", ["cuda", "d3d11va", "vaapi"])
@pytest.mark.parametrize(
    "failure",
    [
        "No space left on device",
        "Permission denied",
        "Corrupt frame",
        "Error while opening encoder",
        "Unknown encoder 'libx264'",
    ],
)
def test_file_and_encoder_failures_do_not_retry(backend, failure):
    assert not is_hardware_decode_failure(failure, backend)


@pytest.mark.parametrize("backend", ["cuda", "d3d11va", "vaapi"])
@pytest.mark.parametrize("stage", ["start frame", "decode slice", "end frame"])
def test_native_av1_hardware_callback_failure_retries(backend, stage):
    stderr = f"[av1 @ 01] Failed to execute: 0x887a0005\n[av1 @ 01] HW accel {stage} fail."
    assert is_hardware_decode_failure(stderr, backend)


@pytest.mark.parametrize("backend", ["cuda", "d3d11va", "vaapi"])
@pytest.mark.parametrize(
    "failure", ["No space left on device", "Corrupt frame", "Permission denied"]
)
def test_hardware_callback_failure_does_not_mask_file_errors(backend, failure):
    assert not is_hardware_decode_failure(
        f"[av1 @ 01] HW accel end frame fail.\n{failure}", backend
    )


@pytest.mark.parametrize(
    "error", [FileNotFoundError(), hardware_decoding.subprocess.TimeoutExpired("ffmpeg", 15)]
)
def test_unavailable_probe_never_blocks_export(monkeypatch, error):
    def run(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(hardware_decoding.subprocess, "run", run)
    assert not hardware_decoding.device_available(
        "ffmpeg", hardware_decoding.HardwareDecode("vaapi")
    )
