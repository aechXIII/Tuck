from __future__ import annotations

import json
import os
import subprocess
import sys
from threading import Event

import pytest

from tuck import media_tools


@pytest.mark.parametrize(
    "platform,frozen,original,expected",
    [
        ("linux", True, "/app/usr/lib:/user/lib", "/app/usr/lib:/user/lib"),
        ("linux", True, None, None),
        ("linux", True, "", ""),
        ("linux", False, "/user/lib", "/sidecar/_internal:/app/usr/lib"),
        ("win32", True, "/user/lib", "/sidecar/_internal:/app/usr/lib"),
        ("win32", False, None, "/sidecar/_internal:/app/usr/lib"),
    ],
)
def test_media_tool_environment_restores_only_frozen_linux_library_path(
    monkeypatch, platform, frozen, original, expected
):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/sidecar/_internal:/app/usr/lib")
    monkeypatch.setenv("TUCK_ENV_TEST", "preserved")
    if original is None:
        monkeypatch.delenv("LD_LIBRARY_PATH_ORIG", raising=False)
    else:
        monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", original)
    before = dict(os.environ)

    environment = media_tools.media_tool_environment()

    assert environment.get("LD_LIBRARY_PATH") == expected
    assert ("LD_LIBRARY_PATH" in environment) == (expected is not None)
    assert environment["TUCK_ENV_TEST"] == "preserved"
    assert environment.get("LD_LIBRARY_PATH_ORIG") == original
    environment["TUCK_ENV_TEST"] = "child only"
    assert not [
        key for key in before.keys() | os.environ.keys() if before.get(key) != os.environ.get(key)
    ]


def test_media_tool_environment_reaches_a_real_child_without_changing_parent(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/sidecar/_internal:/app/usr/lib")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/app/usr/lib:/user/lib")
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import os,json; print(json.dumps(os.environ.get('LD_LIBRARY_PATH')))",
        ],
        env=media_tools.media_tool_environment(),
        capture_output=True,
        text=True,
        check=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert json.loads(result.stdout) == "/app/usr/lib:/user/lib"
    assert os.environ["LD_LIBRARY_PATH"] == "/sidecar/_internal:/app/usr/lib"


def test_encoder_cache_tracks_restored_library_path(monkeypatch):
    from types import SimpleNamespace

    from tuck.encoding import capabilities

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/sidecar/_internal")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/original/old")
    monkeypatch.setattr(capabilities, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(capabilities, "environment_fingerprint", lambda _: "unchanged")
    monkeypatch.setattr(capabilities, "_encoder_cache", None)
    monkeypatch.setattr(capabilities, "_encoder_cache_fingerprint", None)
    monkeypatch.setattr(
        "tuck.settings.get_settings_manager", lambda: SimpleNamespace(get_setting=lambda *_: 0)
    )
    probes = []

    def detect(_ffmpeg):
        probes.append(media_tools.media_tool_environment()["LD_LIBRARY_PATH"])
        return frozenset({"libx264"}) if len(probes) == 1 else frozenset({"libx264", "h264_nvenc"})

    monkeypatch.setattr(capabilities, "_detect_usable_encoders", detect)
    assert capabilities.get_available_encoders() == frozenset({"libx264"})
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/original/new")
    assert capabilities.get_available_encoders() == frozenset({"libx264", "h264_nvenc"})
    assert probes == ["/original/old", "/original/new"]


def test_vaapi_cache_tracks_restored_library_path(monkeypatch):
    from tuck.encoding import vaapi

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/sidecar/_internal")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/original/old")
    device = vaapi.VaapiEncodeDevice("/dev/dri/renderD128")
    monkeypatch.setattr(vaapi, "render_devices", lambda: (device,))
    monkeypatch.setattr(vaapi, "_probe_cache", {})
    probes = []

    def run(command, **kwargs):
        library_path = kwargs["env"]["LD_LIBRARY_PATH"]
        probes.append(library_path)
        return subprocess.CompletedProcess(
            command, 0 if library_path == "/original/new" else 1, "", "old runtime"
        )

    monkeypatch.setattr(subprocess, "run", run)
    assert vaapi.choose_encode_device("ffmpeg", "h264_vaapi") is None
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/original/new")
    assert vaapi.choose_encode_device("ffmpeg", "h264_vaapi") == device
    assert probes == ["/original/old", "/original/new"]


@pytest.mark.parametrize(
    "operation",
    [
        "encoders",
        "nvenc",
        "filters",
        "vaapi",
        "decode",
        "version",
        "probe",
        "thumbnail_seek",
        "thumbnail",
        "audio_preview",
        "waveform",
        "cut_inventory",
        "frame_save",
        "encode",
    ],
)
def test_media_launches_pass_restored_environment(monkeypatch, tmp_path, operation):
    from tuck import diagnostics, frame_export, media_server, probe
    from tuck.cutting import analysis
    from tuck.encoding import capabilities, hardware_decoding, runner, vaapi
    from tuck.request_work import RequestWork

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/sidecar/_internal:/app/usr/lib")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/app/usr/lib:/user/lib")
    captured = []

    def run(command, **kwargs):
        captured.append(kwargs.get("env"))
        output = '{"streams": []}'
        text = kwargs.get("encoding") is not None or kwargs.get("text")
        return subprocess.CompletedProcess(
            command, 0, output if text else output.encode(), "" if text else b""
        )

    class Process:
        pid = 1
        returncode = 0

        def poll(self):
            return 0

        def wait(self, timeout=None):
            return 0

    def popen(_command, **kwargs):
        captured.append(kwargs.get("env"))
        output = kwargs.get("stdout")
        if hasattr(output, "write"):
            output.write(b'{"streams": []}')
        return Process()

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(subprocess, "Popen", popen)
    source, destination = tmp_path / "source.mp4", tmp_path / "output.png"
    if operation == "encoders":
        capabilities._detect_available_encoders("ffmpeg")
    elif operation == "nvenc":
        assert capabilities._hardware_encoder_works("ffmpeg", "h264_nvenc")
    elif operation == "filters":
        monkeypatch.setattr(capabilities, "find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr(capabilities, "_filter_cache", {})
        capabilities.get_available_filters()
    elif operation == "vaapi":
        assert vaapi._device_encodes(
            "ffmpeg", "h264_vaapi", vaapi.VaapiEncodeDevice("/dev/dri/renderD128")
        )
    elif operation == "decode":
        assert hardware_decoding.device_available(
            "ffmpeg", hardware_decoding.HardwareDecode("vaapi", "/dev/dri/renderD128")
        )
    elif operation == "version":
        diagnostics._run_version(["ffmpeg", "-version"])
    elif operation == "probe":
        assert probe._run_ffprobe_json("ffprobe", source, "for testing") == {"streams": []}
    elif operation == "thumbnail_seek":
        monkeypatch.setattr(media_server, "find_ffprobe", lambda: "ffprobe")
        media_server._thumbnail_seek_time(source)
    elif operation == "thumbnail":
        media_server._run_thumbnail_ffmpeg("ffmpeg", source, "1", destination, 10)
    elif operation == "audio_preview":
        assert media_server._run_audio_preview_ffmpeg("ffmpeg", source, destination, 10, 0)
    elif operation == "waveform":
        assert media_server._run_waveform_ffmpeg("ffmpeg", source, destination, 10)
    elif operation == "cut_inventory":
        assert analysis.read_inventory(source, Event(), "ffprobe") == ((), ())
    elif operation == "frame_save":
        frame_export._run_ffmpeg(["ffmpeg"], RequestWork())
    else:
        runner.FFmpegEngine()._spawn_ffmpeg(["ffmpeg"], 0)

    assert captured
    for environment in captured:
        assert environment is not None
        assert environment["LD_LIBRARY_PATH"] == "/app/usr/lib:/user/lib"
    assert os.environ["LD_LIBRARY_PATH"] == "/sidecar/_internal:/app/usr/lib"
