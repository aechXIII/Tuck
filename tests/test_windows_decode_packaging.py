"""Windows tool verification must check AV1 hardware support, not just D3D11 presence."""

import subprocess
from pathlib import Path

import pytest

from scripts import windows_ffmpeg


@pytest.mark.parametrize(
    "devices",
    ["cuda dxva2", "cuda", ""],
)
def test_windows_tools_reject_av1_without_d3d11va(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, devices: str
) -> None:
    lock = windows_ffmpeg.load_lock()

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if "-buildconf" in command:
            text = " ".join(lock["output"]["configure_flags_required"])
        elif command[-1] in {"-encoders", "-decoders", "-filters"}:
            text = "\n".join(f" V..... {name}" for name in lock["output"][command[-1][1:]])
        elif command[-2:] == ["-h", "decoder=av1"]:
            text = (
                "Decoder av1 [Alliance for Open Media AV1]:\n"
                f"    Supported hardware devices: {devices}\n"
            )
        else:
            text = ""
        return subprocess.CompletedProcess(command, 0, text, "")

    monkeypatch.setattr(windows_ffmpeg.subprocess, "run", run)
    with pytest.raises(windows_ffmpeg.BuildError, match=r"AV1.*d3d11va"):
        windows_ffmpeg.validate_runtime(tmp_path, lock)


def test_windows_tools_accept_av1_d3d11va(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lock = windows_ffmpeg.load_lock()

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if "-buildconf" in command:
            text = " ".join(lock["output"]["configure_flags_required"])
        elif command[-1] in {"-encoders", "-decoders", "-filters"}:
            text = "\n".join(f" V..... {name}" for name in lock["output"][command[-1][1:]])
        elif command[-2:] == ["-h", "decoder=av1"]:
            text = (
                "Decoder av1 [Alliance for Open Media AV1]:\n"
                "    Supported hardware devices: cuda d3d11va dxva2\n"
            )
        else:
            text = ""
        return subprocess.CompletedProcess(command, 0, text, "")

    monkeypatch.setattr(windows_ffmpeg.subprocess, "run", run)
    windows_ffmpeg.validate_runtime(tmp_path, lock)
