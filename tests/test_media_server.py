import hashlib
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from tuck.media_server import MediaServer, _waveform_gain_db, get_media_server


class TestMediaServer:
    @pytest.mark.parametrize(
        ("returncode", "stderr", "expected"),
        [
            (0, b"[Parsed_volumedetect] max_volume: -21.0 dB", 20.0),
            (0, b"[Parsed_volumedetect] max_volume: -120.0 dB", 60.0),
            (0, b"[Parsed_volumedetect] max_volume: 0.0 dB", 0.0),
            (0, b"volumedetect produced no peak", 0.0),
            (1, b"max_volume: -21.0 dB", 0.0),
        ],
    )
    def test_waveform_gain_handles_detection_results(
        self, tmp_path, monkeypatch, returncode, stderr, expected
    ):
        source = tmp_path / "source.wav"
        source.write_bytes(b"audio")
        calls = []

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=returncode, stderr=stderr)

        monkeypatch.setattr("tuck.media_server.subprocess.run", fake_run)

        assert _waveform_gain_db("ffmpeg", source, 3.5) == expected
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

    def test_register_file_replaces_old_token(self, tmp_path):

        f = tmp_path / "test.mp4"
        f.write_text("dummy")

        server = MediaServer()
        token1 = server.register_file(str(f))
        token2 = server.register_file(str(f))

        assert token1 != token2
        with server._lock:
            assert token1 not in server._tokens
            assert token2 in server._tokens

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
        assert "showwavespic=s=8192x96" in waveform_filter
        assert "scale=sqrt" in waveform_filter
        assert "filter=peak" in waveform_filter

    def test_generate_waveform_ignores_legacy_linear_cache(self, tmp_path, monkeypatch):
        source = tmp_path / "quiet-video.mp4"
        source.write_bytes(b"video")
        cache = tmp_path / "thumbs"
        server = MediaServer()
        server.set_thumbnail_cache_dir(cache)

        stat = source.stat()
        legacy_key = hashlib.sha256(
            f"waveform:{source.resolve()}:{stat.st_size}:{stat.st_mtime_ns}".encode()
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
