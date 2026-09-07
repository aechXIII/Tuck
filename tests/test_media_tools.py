from pathlib import Path

from tuck.media_tools import find_ffmpeg, find_ffprobe


class _Settings:
    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get_setting(self, key: str, default: str = "") -> str:
        return self._values.get(key, default)


def test_configured_media_tools_take_precedence_over_path(tmp_path: Path, monkeypatch) -> None:
    import tuck.media_tools as media_tools

    ffmpeg = tmp_path / "custom-ffmpeg.exe"
    ffprobe = tmp_path / "custom-ffprobe.exe"
    ffmpeg.touch()
    ffprobe.touch()
    settings = _Settings({"ffmpeg_path": str(ffmpeg), "ffprobe_path": str(ffprobe)})
    monkeypatch.setattr(media_tools, "get_settings_manager", lambda: settings)
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: (_ for _ in ()).throw(AssertionError(f"PATH checked for {name}")),
    )

    assert find_ffmpeg() == str(ffmpeg)
    assert find_ffprobe() == str(ffprobe)


def test_invalid_custom_paths_fall_back_to_path(tmp_path: Path, monkeypatch) -> None:
    import tuck.media_tools as media_tools

    settings = _Settings(
        {
            "ffmpeg_path": str(tmp_path / "missing-ffmpeg.exe"),
            "ffprobe_path": str(tmp_path / "missing-ffprobe.exe"),
        }
    )
    monkeypatch.setattr(media_tools, "get_settings_manager", lambda: settings)
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: str(tmp_path / f"path-{name}.exe"),
    )

    assert find_ffmpeg() == str(tmp_path / "path-ffmpeg.exe")
    assert find_ffprobe() == str(tmp_path / "path-ffprobe.exe")


def test_linux_uses_plain_named_bundled_tools_without_path_lookup(
    tmp_path: Path, monkeypatch
) -> None:
    import tuck.media_tools as media_tools
    import tuck.packaged as packaged

    tools = tmp_path / "bundle"
    tools.mkdir()
    ffmpeg = tools / "ffmpeg"
    ffmpeg.touch()
    ffprobe = tools / "ffprobe"
    ffprobe.touch()
    monkeypatch.setenv("TUCK_DESKTOP_PLATFORM", "linux")
    monkeypatch.setenv(packaged.TOOLS_DIR_ENV, str(tools))
    monkeypatch.setattr(media_tools, "get_settings_manager", lambda: _Settings({}))
    monkeypatch.setattr(
        media_tools.shutil,
        "which",
        lambda name: (_ for _ in ()).throw(AssertionError(f"PATH checked for {name}")),
    )

    assert find_ffmpeg() == str(ffmpeg)
    assert find_ffprobe() == str(ffprobe)
