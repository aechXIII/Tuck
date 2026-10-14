import hashlib
import socket
import subprocess
import threading
from array import array
from dataclasses import replace
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import av
import pytest

from tuck.media_server import (
    _TOKENS_PER_PATH,
    MediaServer,
    _waveform_levels,
    get_media_server,
)
from tuck.media_tools import find_ffmpeg


class TestMediaServer:
    @pytest.mark.parametrize(
        ("returncode", "stderr", "expected"),
        [
            (0, b"[Parsed_volumedetect] max_volume: -21.0 dB", (20.0, "sqrt", "peak", 8192)),
            (0, b"[Parsed_volumedetect] max_volume: -120.0 dB", (60.0, "sqrt", "peak", 8192)),
            (0, b"[Parsed_volumedetect] max_volume: 0.0 dB", (0.0, "sqrt", "peak", 8192)),
            (0, b"volumedetect produced no peak", (0.0, "sqrt", "peak", 8192)),
            (1, b"max_volume: -21.0 dB", (0.0, "sqrt", "peak", 8192)),
            # mastered music: loud and dense, so it is drawn from its average level, and a long
            # song gets the widest image
            (
                0,
                b"Duration: 00:04:17.25, start: 0.0\nmean_volume: -13.7 dB\nmax_volume: 0.0 dB",
                (5.7, "lin", "average", 16384),
            ),
            # game sound: quiet with loud moments keeps the square-root scale
            (
                0,
                b"Duration: 00:00:11.25, start: 0.0\nmean_volume: -31.9 dB\nmax_volume: -10.1 dB",
                (9.1, "sqrt", "peak", 8192),
            ),
            # a two-minute file gets more columns than the smallest width
            (
                0,
                b"Duration: 00:02:00.00, start: 0.0\nmean_volume: -30.0 dB\nmax_volume: -3.0 dB",
                (2.0, "sqrt", "peak", 11520),
            ),
        ],
    )
    def test_waveform_levels_follow_the_measured_audio(
        self, tmp_path, monkeypatch, returncode, stderr, expected
    ):
        source = tmp_path / "source.wav"
        source.write_bytes(b"audio")
        calls = []

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=returncode, stderr=stderr)

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        levels = _waveform_levels("ffmpeg", source, 3.5)
        assert (round(levels.gain_db, 3), levels.scale, levels.filter, levels.width) == expected
        assert len(calls) == 1
        command, kwargs = calls[0]
        assert "volumedetect" in command[command.index("-af") + 1]
        assert command[command.index("-map") + 1] == "0:a:0"
        assert kwargs["timeout"] == 3.5

    def test_register_file_returns_token(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy video content")

        server = MediaServer()
        token = server.register_file(str(f))
        assert token
        assert len(token) == 64  # 32 bytes hex

    def test_register_file_rejects_nonexistent(self, tmp_path):
        server = MediaServer()
        with pytest.raises(ValueError, match="File not found"):
            server.register_file(str(tmp_path / "no_such_file.mp4"))

    def test_two_players_of_the_same_file_keep_reading_until_each_releases(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_bytes(b"0123456789")

        server = MediaServer()
        server.start()
        try:
            preview = server.get_url(server.register_file(str(f)))
            audio_token = server.register_file(str(f))
            audio = server.get_url(audio_token)

            # the preview's next range request must not fail because the audio track loaded
            for url in (preview, audio):
                with urlopen(Request(url, headers={"Range": "bytes=2-4"}), timeout=5) as resp:
                    assert resp.status == 206
                    assert resp.read() == b"234"

            server.unregister_token(audio_token)
            with pytest.raises(HTTPError) as error:
                urlopen(audio, timeout=5)
            assert error.value.code == 403
            with urlopen(preview, timeout=5) as resp:
                assert resp.read() == b"0123456789"
        finally:
            server.stop()

    def test_register_file_keeps_a_bounded_number_of_tokens_per_file(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy")
        other = tmp_path / "other.mp4"
        other.write_text("dummy")

        server = MediaServer()
        kept = server.register_file(str(other))
        tokens = [server.register_file(str(f)) for _ in range(_TOKENS_PER_PATH + 3)]

        with server._lock:
            live = set(server._tokens)
        assert live == {kept, *tokens[3:]}

    @pytest.mark.parametrize(
        ("origin", "allowed"),
        [
            ("tauri://localhost", "tauri://localhost"),
            ("http://tauri.localhost", "http://tauri.localhost"),
            ("http://127.0.0.1:5173", "http://127.0.0.1:5173"),
            ("https://example.com", None),
            ("http://127.0.0.1:8080", None),
            (None, None),
        ],
    )
    def test_only_tucks_own_pages_may_read_media_from_script(self, tmp_path, origin, allowed):
        f = tmp_path / "table.bin"
        f.write_bytes(b"0123456789")

        server = MediaServer()
        server.start()
        try:
            url = server.get_url(server.register_file(str(f)))
            for headers in ({}, {"Range": "bytes=0-3"}):
                if origin:
                    headers["Origin"] = origin
                with urlopen(Request(url, headers=headers), timeout=5) as resp:
                    assert resp.headers["Access-Control-Allow-Origin"] == allowed
                    assert resp.headers["Vary"] == "Origin"
        finally:
            server.stop()

    def test_another_socket_cannot_take_over_the_media_port(self):
        server = MediaServer()
        server.start()
        try:
            intruder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                intruder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                with pytest.raises(OSError):
                    intruder.bind(("127.0.0.1", server.port))
            finally:
                intruder.close()
        finally:
            server.stop()

    def test_media_processes_never_read_the_sidecar_protocol_input(self, tmp_path, monkeypatch):
        source = tmp_path / "clip.mp4"
        source.write_bytes(b"not a video")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "thumbs")
        calls = []

        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr("tuck.media_server.find_ffprobe", lambda: "ffprobe")

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            if command[0] == "ffprobe":
                return SimpleNamespace(returncode=0, stdout='{"format": {"duration": "2"}}')
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(returncode=0, stderr=b"max_volume: -6.0 dB")
            Path(command[-1]).write_bytes(b"picture")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        assert server.generate_thumbnail(source) is not None
        assert server.generate_waveform(source) is not None

        # ffprobe for the seek time, the ffmpeg thumbnail, and both waveform passes
        assert [command[0] for command, _ in calls] == ["ffprobe", "ffmpeg", "ffmpeg", "ffmpeg"]
        for command, kwargs in calls:
            # every request frame holds a "q", which ffmpeg would take as its quit key
            assert kwargs["stdin"] is subprocess.DEVNULL
            assert command[0] == "ffprobe" or "-nostdin" in command
        probe_kwargs = calls[0][1]
        assert (probe_kwargs["encoding"], probe_kwargs["errors"]) == ("utf-8", "replace")

    def test_get_url_returns_valid_url(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy")

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            assert url.startswith("http://127.0.0.1")
            assert f"/{token}/" in url
            assert url.endswith("/test.mp4")
        finally:
            server.stop()

    def test_get_url_rejects_unknown_token(self):
        server = MediaServer()
        with pytest.raises(ValueError, match="Unknown or expired token"):
            server.get_url("nonexistent_token")

    def test_unregister_token(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy")

        server = MediaServer()
        token = server.register_file(str(f))
        server.unregister_token(token)
        with server._lock:
            assert token not in server._tokens

    def test_server_start_stop(self):
        server = MediaServer()
        server.start()
        assert server._running
        port = server.port
        assert port > 0
        server.stop()
        assert not server._running

    def test_server_quick_stop_start(self):

        server = MediaServer()
        for _ in range(3):
            server.start()
            port = server.port
            assert port > 0
            assert server._running
            server.stop()
            assert not server._running
            assert server._server is None

    def test_server_serves_file(self, tmp_path):
        f = tmp_path / "serve_test.mp4"
        f.write_bytes(b"hello video world")

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)

            resp = urlopen(url, timeout=5)
            assert resp.status == 200
            assert resp.read() == b"hello video world"
        finally:
            server.stop()

    def test_server_returns_403_for_invalid_token(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy")

        server = MediaServer()
        server.start()
        try:
            url = f"http://127.0.0.1:{server.port}/badtoken/file.mp4"
            with pytest.raises(HTTPError) as exc_info:
                urlopen(url, timeout=5)
            assert exc_info.value.code == 403
        finally:
            server.stop()

    def test_server_returns_404_for_missing_file(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy")

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))

            f.unlink()
            url = server.get_url(token)
            with pytest.raises(HTTPError) as exc_info:
                urlopen(url, timeout=5)
            assert exc_info.value.code == 404
        finally:
            server.stop()

    def test_server_range_request(self, tmp_path):
        f = tmp_path / "range_test.mp4"
        content = b"A" * 10000
        f.write_bytes(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=0-99"})
            resp = urlopen(req, timeout=5)
            assert resp.status == 206
            assert resp.getheader("Content-Range") == f"bytes 0-99/{len(content)}"
            assert resp.read() == content[:100]
        finally:
            server.stop()

    def test_server_range_open_end(self, tmp_path):

        f = tmp_path / "open_end.mp4"
        content = b"0123456789ABCDEFGHIJ"
        f.write_bytes(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=10-"})
            resp = urlopen(req, timeout=5)
            assert resp.status == 206
            assert resp.getheader("Content-Range") == f"bytes 10-{len(content) - 1}/{len(content)}"
            assert resp.read() == content[10:]
        finally:
            server.stop()

    def test_server_range_full_file_206(self, tmp_path):

        f = tmp_path / "full_range.mp4"
        content = b"HELLO"
        f.write_bytes(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": f"bytes=0-{len(content) - 1}"})
            resp = urlopen(req, timeout=5)
            assert resp.status == 206
            assert resp.getheader("Content-Range") == f"bytes 0-{len(content) - 1}/{len(content)}"
            assert resp.read() == content
        finally:
            server.stop()

    def test_server_suffix_range(self, tmp_path):

        f = tmp_path / "suffix_test.mp4"
        content = b"HELLO_WORLD"  # 11 bytes
        f.write_bytes(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=-5"})
            resp = urlopen(req, timeout=5)
            assert resp.status == 206
            assert resp.getheader("Content-Range") == "bytes 6-10/11"
            assert resp.read() == content[-5:]  # "WORLD"
        finally:
            server.stop()

    def test_server_suffix_range_larger_than_file(self, tmp_path):

        f = tmp_path / "big_suffix.mp4"
        content = b"SHORT"
        f.write_bytes(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=-999"})
            resp = urlopen(req, timeout=5)
            assert resp.status == 206
            assert resp.getheader("Content-Range") == f"bytes 0-{len(content) - 1}/{len(content)}"
            assert resp.read() == content
        finally:
            server.stop()

    def test_server_reversed_range_returns_416(self, tmp_path):

        f = tmp_path / "reversed_test.mp4"
        content = b"A" * 1000
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=500-100"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_server_unsatisfiable_range_returns_416(self, tmp_path):

        f = tmp_path / "unsat_test.mp4"
        content = b"A" * 100
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=100-"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_server_empty_file_range_returns_416(self, tmp_path):

        f = tmp_path / "empty_test.mp4"
        f.write_bytes(b"")

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=0-"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == "bytes */0"
        finally:
            server.stop()

    def test_server_malformed_range_multirange_returns_416(self, tmp_path):

        f = tmp_path / "multi_test.mp4"
        content = b"A" * 500
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=0-100, 200-300"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_server_malformed_range_with_params_returns_416(self, tmp_path):

        f = tmp_path / "param_test.mp4"
        content = b"A" * 200
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=0-100;q=0.5"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_server_malformed_range_garbage_returns_416(self, tmp_path):

        f = tmp_path / "garbage_test.mp4"
        content = b"A" * 100
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=abc-def"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_server_malformed_range_empty_suffix_returns_416(self, tmp_path):

        f = tmp_path / "empty_suffix.mp4"
        content = b"A" * 50
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)
            req = Request(url, headers={"Range": "bytes=-"})
            with pytest.raises(HTTPError) as exc_info:
                urlopen(req, timeout=5)
            e = exc_info.value
            assert e.code == 416
            assert e.headers.get("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_server_multiple_range_headers_returns_416(self, tmp_path):

        import http.client

        f = tmp_path / "multi_header.mp4"
        content = b"A" * 200
        f.write_bytes(content)
        file_size = len(content)

        server = MediaServer()
        server.start()
        try:
            token = server.register_file(str(f))
            url = server.get_url(token)

            path = "/" + url.split("/", 3)[-1]
            conn = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
            conn.putrequest("GET", path)
            conn.putheader("Range", "bytes=0-99")
            conn.putheader("Range", "bytes=100-199")
            conn.endheaders()
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            assert resp.status == 416
            assert b"Multiple Range headers" in body
            assert resp.getheader("Content-Range") == f"bytes */{file_size}"
        finally:
            server.stop()

    def test_thumbnail_cache_dir_set(self, tmp_path):
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)
        assert cache.exists()
        assert server._thumb_dir == cache

    def test_generate_thumbnail_no_thumb_dir(self, tmp_path):
        f = tmp_path / "test.mp4"
        f.write_text("dummy")

        server = MediaServer()

        result = server.generate_thumbnail(str(f))
        assert result is None

    def test_generate_thumbnail_nonexistent_file(self, tmp_path):
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)
        result = server.generate_thumbnail(str(tmp_path / "no_file.mp4"))
        assert result is None

    @pytest.mark.parametrize(
        ("rotation", "upright_size"),
        [(None, (480, 270)), ("90", (270, 480)), ("-90", (270, 480)), ("180", (480, 270))],
    )
    def test_generate_thumbnail_reads_the_picture_without_starting_ffmpeg(
        self, tmp_path, monkeypatch, rotation, upright_size
    ):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            pytest.skip("ffmpeg not available for generating test video")
        source = tmp_path / "clip.mp4"
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
             "testsrc2=size=640x360:rate=30:duration=4", "-c:v", "libx264", "-preset",
             "ultrafast", "-pix_fmt", "yuv420p", str(tmp_path / "plain.mp4")],
            check=True,
        )  # fmt: skip
        rotate = ["-display_rotation", rotation] if rotation else []
        subprocess.run(
            [ffmpeg, "-y", "-v", "error", *rotate, "-i", str(tmp_path / "plain.mp4"),
             "-c", "copy", str(source)],
            check=True,
        )  # fmt: skip
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "thumbs")

        def no_process(*_args, **_kwargs):
            raise AssertionError("the thumbnail started a process")

        monkeypatch.setattr("tuck.media_server.subprocess.run", no_process)

        result = server.generate_thumbnail(source)

        assert result is not None
        with av.open(result) as picture:
            frame = next(picture.decode(video=0))
            assert (frame.width, frame.height) == upright_size
        assert not list((tmp_path / "thumbs").glob("*.partial"))

    def test_generate_thumbnail_reads_av1_without_starting_ffmpeg(self, tmp_path, monkeypatch):
        # OBS records AV1; its decoder returns no picture when told to skip non-keyframes
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            pytest.skip("ffmpeg not available for generating test video")
        source = tmp_path / "clip.mp4"
        for encoder in ("libsvtav1", "libaom-av1"):
            made = subprocess.run(
                [ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
                 "testsrc2=size=640x360:rate=30:duration=4", "-c:v", encoder, "-g", "60",
                 "-pix_fmt", "yuv420p", str(source)],
                capture_output=True,
            )  # fmt: skip
            if made.returncode == 0:
                break
        else:
            pytest.skip("ffmpeg has no AV1 encoder for generating test video")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "thumbs")

        def no_process(*_args, **_kwargs):
            raise AssertionError("the thumbnail started a process")

        monkeypatch.setattr("tuck.media_server.subprocess.run", no_process)
        # the picture must come straight after the keyframe the seek lands on; skipping
        # non-keyframes here only delays it, but in OBS recordings it never comes at all
        monkeypatch.setattr("tuck.media_server._THUMBNAIL_MAX_PACKETS", 20)

        result = server.generate_thumbnail(source)

        assert result is not None
        with av.open(result) as picture:
            frame = next(picture.decode(video=0))
            assert (frame.width, frame.height) == (480, 270)

    def test_generate_thumbnail_falls_back_to_ffmpeg_when_pyav_cannot_read(
        self, tmp_path, monkeypatch
    ):
        source = tmp_path / "clip.mp4"
        source.write_bytes(b"not a video")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "thumbs")
        calls = []

        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr("tuck.media_server.find_ffprobe", lambda: None)

        def fake_run(command, **_kwargs):
            calls.append(command)
            Path(command[-1]).write_bytes(b"jpg")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        result = server.generate_thumbnail(source)

        assert result is not None and Path(result).read_bytes() == b"jpg"
        assert [command[0] for command in calls] == ["ffmpeg"]

    def test_generate_thumbnail_runs_ffmpeg_once_for_requests_at_the_same_time(
        self, tmp_path, monkeypatch
    ):
        source = tmp_path / "clip.mp4"
        source.write_bytes(b"video")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "thumbs")
        calls = []
        entered = threading.Event()
        release = threading.Event()

        # PyAV cannot read the dummy file, so both requests reach the ffmpeg fallback
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        monkeypatch.setattr("tuck.media_server.find_ffprobe", lambda: None)

        def fake_run(command, **_kwargs):
            calls.append(command)
            entered.set()
            release.wait(timeout=5)
            Path(command[-1]).write_bytes(b"jpg")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        results: list[str | None] = []
        first = threading.Thread(target=lambda: results.append(server.generate_thumbnail(source)))
        second = threading.Thread(target=lambda: results.append(server.generate_thumbnail(source)))
        first.start()
        assert entered.wait(timeout=5)
        second.start()
        release.set()
        first.join(timeout=5)
        second.join(timeout=5)

        assert len(calls) == 1
        assert len(results) == 2 and results[0] == results[1] is not None

    def test_generate_waveform_uses_cache(self, tmp_path, monkeypatch):
        source = tmp_path / "music.mp3"
        source.write_bytes(b"audio")
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)
        calls = []

        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")

        def fake_run(command, **_kwargs):
            calls.append(command)
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(
                    returncode=0, stderr=b"[Parsed_volumedetect] max_volume: -21.0 dB"
                )
            Path(command[-1]).write_bytes(b"png")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        first = server.generate_waveform(source)
        second = server.generate_waveform(source)

        assert first == second
        assert first is not None and Path(first).read_bytes() == b"png"
        assert len(calls) == 2
        waveform_filter = calls[1][calls[1].index("-filter_complex") + 1]
        assert "volume=20dB" in waveform_filter
        assert "showwavespic=s=8192x192" in waveform_filter
        assert "scale=sqrt" in waveform_filter
        assert "filter=peak" in waveform_filter
        # a solid white shape, which the timeline colours through a mask
        assert "colors=0xffffff" in waveform_filter
        assert "draw=full" in waveform_filter

    @pytest.mark.parametrize("kind", ["waveform", "audio_preview"])
    def test_generated_media_is_published_whole_and_shared(self, tmp_path, monkeypatch, kind):
        source = tmp_path / "music.mp3"
        source.write_bytes(b"audio")
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        entered = threading.Event()
        release = threading.Event()
        started = threading.Event()
        outputs = []
        results = []
        errors = []

        def fake_run(command, **_kwargs):
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(returncode=0, stderr=b"max_volume: -12 dB")
            output = Path(command[-1])
            outputs.append(output)
            output.write_bytes(b"partial")
            entered.set()
            assert release.wait(timeout=5)
            output.write_bytes(b"complete")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)
        generate = getattr(server, "generate_" + kind)

        def request():
            started.set()
            try:
                results.append(generate(source, track=0))
            except Exception as error:
                errors.append(error)

        first = threading.Thread(target=request)
        second = threading.Thread(target=request)
        first.start()
        try:
            assert entered.wait(timeout=5)
            # public cache files must never expose the writer's unfinished bytes
            assert not list(cache.glob("*.png"))
            assert not list(cache.glob("*.m4a"))
            started.clear()
            second.start()
            assert started.wait(timeout=5)
        finally:
            release.set()
            first.join(timeout=5)
            if second.ident is not None:
                second.join(timeout=5)

        assert not errors
        assert not first.is_alive() and not second.is_alive()
        assert len(outputs) == 1
        assert len(results) == 2 and results[0] == results[1] is not None
        assert Path(results[0]).read_bytes() == b"complete"
        assert outputs[0].suffix == (".png" if kind == "waveform" else ".m4a")
        assert not outputs[0].exists()
        assert list(cache.iterdir()) == [Path(results[0])]

    @pytest.mark.parametrize("kind", ["waveform", "audio_preview"])
    @pytest.mark.parametrize("failure", ["exit", "timeout", "io"])
    def test_failed_generated_media_cleans_only_its_partial_file(
        self, tmp_path, monkeypatch, kind, failure
    ):
        source = tmp_path / "music.mp3"
        source.write_bytes(b"audio")
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)
        existing = cache / "other.png"
        existing.write_bytes(b"valid cache")
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")

        def fake_run(command, **_kwargs):
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(returncode=0, stderr=b"max_volume: -12 dB")
            Path(command[-1]).write_bytes(b"partial")
            if failure == "timeout":
                raise subprocess.TimeoutExpired(command, 1)
            if failure == "io":
                raise OSError("write failed")
            return SimpleNamespace(returncode=1, stderr=b"encoding failed")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)
        generate = getattr(server, "generate_" + kind)

        assert generate(source, track=0) is None
        assert list(cache.iterdir()) == [existing]
        assert existing.read_bytes() == b"valid cache"

    @pytest.mark.parametrize("kind", ["waveform", "audio_preview"])
    def test_failed_writer_preserves_another_servers_completed_media(
        self, tmp_path, monkeypatch, kind
    ):
        source = tmp_path / "music.mp3"
        source.write_bytes(b"audio")
        cache = tmp_path / "thumbs"
        first_server = MediaServer()
        second_server = MediaServer()
        first_server.set_thumbnail_cache_dir(cache)
        second_server.set_thumbnail_cache_dir(cache)
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        entered = threading.Event()
        release = threading.Event()
        outputs = []
        first_results = []

        def fake_run(command, **_kwargs):
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(returncode=0, stderr=b"max_volume: -12 dB")
            output = Path(command[-1])
            outputs.append(output)
            if len(outputs) == 1:
                output.write_bytes(b"partial")
                entered.set()
                assert release.wait(timeout=5)
                return SimpleNamespace(returncode=1, stderr=b"first writer failed")
            output.write_bytes(b"complete")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)
        first_generate = getattr(first_server, "generate_" + kind)
        second_generate = getattr(second_server, "generate_" + kind)
        first = threading.Thread(
            target=lambda: first_results.append(first_generate(source, track=0))
        )
        first.start()
        try:
            assert entered.wait(timeout=5)
            completed = second_generate(source, track=0)
            assert completed is not None
            assert Path(completed).read_bytes() == b"complete"
        finally:
            release.set()
            first.join(timeout=5)

        assert first_results == [None]
        assert len(outputs) == 2 and outputs[0] != outputs[1]
        assert Path(completed).read_bytes() == b"complete"
        assert list(cache.iterdir()) == [Path(completed)]

    @pytest.mark.parametrize("origin", [0, 5])
    def test_audio_previews_select_exact_tracks_and_keep_delayed_audio(self, tmp_path, origin):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            pytest.skip("ffmpeg is needed to check audio preview extraction")
        source = tmp_path / "two-tracks.mkv"
        created = subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=size=64x64:rate=10:duration=1.5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1.5",
                "-itsoffset",
                "0.4",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=48000:duration=1.1",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:a",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-disposition:a:0",
                "0",
                "-disposition:a:1",
                "default",
                "-output_ts_offset",
                str(origin),
                str(source),
            ],
            capture_output=True,
            timeout=30,
        )
        assert created.returncode == 0, created.stderr.decode(errors="replace")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "cache")
        first = server.generate_audio_preview(source, track=0)
        second = server.generate_audio_preview(source, track=1)
        assert first and second and first != second
        assert server.generate_audio_preview(source, track=1) == second
        assert server.generate_audio_preview(source, track=2) is None
        assert sorted((tmp_path / "cache").iterdir()) == sorted([Path(first), Path(second)])

        def samples(path):
            data = array("f")
            with av.open(path) as media:
                assert len(media.streams.audio) == 1
                assert media.streams.audio[0].codec_context.name == "aac"
                assert media.duration / 1_000_000 == pytest.approx(origin + 1.5, abs=0.08)
                resampler = av.AudioResampler(format="flt", layout="mono", rate=48000)
                for frame in media.decode(audio=0):
                    for converted in resampler.resample(frame):
                        data.extend(array("f", bytes(converted.planes[0])[: converted.samples * 4]))
            return data

        for path, frequency in [(first, 440), (second, 880)]:
            audio = samples(path)
            start = origin * 48000
            region = audio[start + 38400 : start + 52800]
            crossings = sum(left <= 0 < right for left, right in pairwise(region))
            assert crossings / 0.3 == pytest.approx(frequency, abs=10)
            if origin:
                assert max(abs(value) for value in audio[: start - 4800]) < 0.001
            if path == second:
                assert max(abs(value) for value in audio[start : start + 14400]) < 0.001
            else:
                assert max(abs(value) for value in audio[start : start + 14400]) > 0.01

    def test_audio_preview_cache_changes_with_the_source_and_survives_missing_ffmpeg(
        self, tmp_path, monkeypatch
    ):
        source = tmp_path / "music.mp3"
        source.write_bytes(b"original")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "cache")
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")

        def fake_run(command, **_kwargs):
            Path(command[-1]).write_bytes(source.read_bytes())
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)
        original = server.generate_audio_preview(source, track=0)
        source.write_bytes(b"replacement source")
        replacement = server.generate_audio_preview(source, track=0)

        assert original and replacement and original != replacement
        assert Path(original).read_bytes() == b"original"
        assert Path(replacement).read_bytes() == b"replacement source"
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: None)
        assert server.generate_audio_preview(source, track=0) == replacement

    def test_each_audio_track_has_its_own_waveform(self, tmp_path, monkeypatch):
        source = tmp_path / "recording.mkv"
        source.write_bytes(b"video")
        server = MediaServer()
        server.set_thumbnail_cache_dir(tmp_path / "thumbs")
        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        calls = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(returncode=0, stderr=b"max_volume: -12.0 dB")
            Path(command[-1]).write_bytes(b"png")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        first = server.generate_waveform(source)
        second = server.generate_waveform(source, track=1)

        assert first is not None and second is not None and first != second
        assert len(calls) == 4
        assert calls[0][calls[0].index("-map") + 1] == "0:a:0"
        assert calls[1][calls[1].index("-filter_complex") + 1].startswith("[0:a:0]")
        assert calls[2][calls[2].index("-map") + 1] == "0:a:1"
        assert calls[3][calls[3].index("-filter_complex") + 1].startswith("[0:a:1]")

    @pytest.mark.parametrize("legacy_prefix", ["waveform", "waveform:v10"])
    def test_generate_waveform_ignores_legacy_linear_cache(
        self, tmp_path, monkeypatch, legacy_prefix
    ):
        source = tmp_path / "quiet-video.mp4"
        source.write_bytes(b"video")
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)

        stat = source.stat()
        legacy_key = hashlib.sha256(
            f"{legacy_prefix}:{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()
        ).hexdigest()[:32]
        (cache / f"waveform_{legacy_key}.png").write_bytes(b"legacy")

        monkeypatch.setattr("tuck.media_server.find_ffmpeg", lambda: "ffmpeg")
        calls = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            if "volumedetect" in " ".join(command):
                return SimpleNamespace(returncode=0, stderr=b"max_volume: -12.0 dB")
            Path(command[-1]).write_bytes(b"readable")
            return SimpleNamespace(returncode=0, stderr=b"")

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        result = server.generate_waveform(source)

        assert result is not None and Path(result).read_bytes() == b"readable"
        assert len(calls) == 2

    def test_media_server_singleton(self):
        s1 = get_media_server()
        s2 = get_media_server()
        assert s1 is s2


class TestBridgeMediaIntegration:
    def test_get_media_url_rejects_invalid_path(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        resp = api.get_media_url(str(tmp_path / "no_file.mp4"))
        assert not resp["ok"]
        assert "error" in resp

    def test_get_thumbnail_rejects_invalid_path(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        resp = api.get_thumbnail(str(tmp_path / "no_file.mp4"))
        assert not resp["ok"]
        assert "error" in resp

    @pytest.mark.parametrize("name", ["notes.txt", "settings.json", "tool.exe", "picture.png"])
    def test_get_media_url_only_serves_video_and_audio(self, tmp_path, monkeypatch, name):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.bridge.get_media_server", MediaServer)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        unsupported = tmp_path / name
        unsupported.write_bytes(b"private")
        video = tmp_path / "Clip.MP4"
        video.write_bytes(b"video")
        audio = tmp_path / "voice.flac"
        audio.write_bytes(b"audio")

        refused = api.get_media_url(str(unsupported))
        assert refused == {"ok": False, "error": f"Unsupported media file type: {name}"}
        with api._media_server._lock:
            assert not api._media_server._tokens
        assert api.get_media_url(str(video))["ok"]
        assert api.get_media_url(str(audio))["ok"]

    @pytest.mark.parametrize(
        "name", ["film.mpg", "film.MPEG", "dvd.vob", "camera.mxf", "flash.f4v", "phone.3g2"]
    )
    def test_preview_serves_containers_that_import_and_export(self, tmp_path, monkeypatch, name):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.bridge.get_media_server", MediaServer)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        video = tmp_path / name
        video.write_bytes(b"video")
        assert api.get_media_url(str(video))["ok"]

    def test_media_server_runs_only_while_background_services_do(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod
        from tuck.queue import ProcessingQueue

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.bridge.get_media_server", MediaServer)
        monkeypatch.setattr("tuck.bridge.get_queue", ProcessingQueue)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        # building the API is side-effect free; the application boundary starts services
        assert not api._media_server._running
        api.start_background_services()
        try:
            assert api._media_server._running
            assert api._media_server.port > 0
        finally:
            api.stop_background_services()
        assert not api._media_server._running

    def test_release_media_token_always_ok(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        resp = api.release_media_token("some_token")
        assert resp["ok"]

    def test_release_media_token_handles_none(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        resp = api.release_media_token(None)  # type: ignore[arg-type]
        assert resp["ok"]


class TestWaveformTracks:
    def test_bridge_refuses_an_audio_track_the_video_does_not_have(self, tmp_path, monkeypatch):
        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)
        monkeypatch.setattr("tuck.bridge.get_media_server", MediaServer)

        from tuck.bridge import BridgeAPI
        from tuck.models import VideoInfo

        api = BridgeAPI()
        video = tmp_path / "recording.mkv"
        video.write_bytes(b"video")
        info = VideoInfo(str(video), 1.0, 320, 240, 25.0, "h264", has_audio=True)
        monkeypatch.setattr(api, "_probe_once", lambda _path: replace(info, audio_stream_count=2))
        asked = []
        monkeypatch.setattr(
            api._media_server,
            "generate_waveform",
            lambda path, *, track: asked.append(track) or None,
        )

        missing = api.get_waveform(str(video), 2)
        assert missing == {"ok": False, "error": "This video has no audio track 3"}
        assert api.get_waveform(str(video), -1)["ok"] is False
        assert api.get_waveform(str(video), 1)["ok"] is False
        assert asked == [1]
