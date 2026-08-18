from __future__ import annotations

import hashlib
import http.server
import logging
import mimetypes
import os
import re
import secrets
import subprocess
import threading
from functools import lru_cache
from pathlib import Path
from socketserver import ThreadingTCPServer

logger = logging.getLogger(__name__)


# SO_REUSEADDR lets the server restart quickly; daemon threads don't block process exit
class _MediaTCPServer(ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


for ext, mime in [
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".mkv", "video/x-matroska"),
    (".mov", "video/quicktime"),
    (".avi", "video/x-msvideo"),
    (".flv", "video/x-flv"),
    (".m4v", "video/x-m4v"),
    (".wmv", "video/x-ms-wmv"),
    (".mp3", "audio/mpeg"),
    (".wav", "audio/wav"),
    (".flac", "audio/flac"),
    (".m4a", "audio/mp4"),
    (".aac", "audio/aac"),
    (".ogg", "audio/ogg"),
    (".opus", "audio/opus"),
    (".wma", "audio/x-ms-wma"),
    (".aif", "audio/aiff"),
    (".aiff", "audio/aiff"),
    (".jpg", "image/jpeg"),
    (".png", "image/png"),
]:
    mimetypes.add_type(mime, ext)

_MAX_THUMBNAIL_DIM = 480  # Maximum width/height for thumbnails
_THUMBNAIL_TIMEOUT = 15  # seconds
_THUMBNAIL_SEEK = 0.5  # seek to this fraction of duration (50%)
_WAVEFORM_WIDTH = 1600
_WAVEFORM_HEIGHT = 96
_WAVEFORM_TIMEOUT = 60
_TOKEN_BYTES = 32  # bytes for each token


def _compute_byte_range(range_header: str, file_size: int, multiple: bool) -> tuple[int, int] | str:
    if multiple:
        return "Multiple Range headers not supported"

    m = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not m:
        return "Invalid Range header"

    start_str, end_str = m.group(1), m.group(2)
    if start_str == "" and end_str == "":
        return "Invalid Range header"

    if file_size == 0:
        return "Empty file"

    if start_str == "":
        suffix = int(end_str)
        if suffix <= 0:
            return "Invalid suffix range"
        start = max(0, file_size - suffix)
        end = file_size - 1
    else:
        start = int(start_str)
        end = int(end_str) if end_str else file_size - 1

    if end < start:
        return "Range end must be >= start"
    if start >= file_size:
        return "Range not satisfiable"

    return start, min(end, file_size - 1)


class _TokenRequestHandler(http.server.BaseHTTPRequestHandler):
    server_instance: MediaServer | None = None

    def do_GET(self) -> None:
        server = self.server_instance
        if server is None:
            self._send_error(500, "Server not initialized")
            return

        path = self.path.lstrip("/")
        if "/" not in path:
            self._send_error(400, "Invalid request path")
            return

        token, _rest = path.split("/", 1)

        with server._lock:
            served_path = server._tokens.get(token)

        if served_path is None:
            self._send_error(403, "Invalid or expired token")
            return

        file_path = Path(served_path)
        if not file_path.is_file():
            self._send_error(404, "File not found")
            return

        mime_type, _ = mimetypes.guess_type(str(file_path))
        if mime_type is None:
            mime_type = "application/octet-stream"

        file_size = file_path.stat().st_size

        range_header = self.headers.get("Range")
        if range_header:
            self._handle_range(file_path, mime_type, file_size, range_header)
        else:
            self._handle_full(file_path, mime_type, file_size)

    _CLIENT_GONE = (
        ConnectionResetError,
        ConnectionAbortedError,
        BrokenPipeError,
        TimeoutError,
    )

    @staticmethod
    def _client_disconnected(exc: OSError) -> bool:
        return getattr(exc, "winerror", None) in (10053, 10054) or getattr(exc, "errno", None) in (
            32,
            54,
            104,
        )

    def _write_chunk(self, data: bytes) -> bool:
        try:
            self.wfile.write(data)
            return True
        except self._CLIENT_GONE:
            return False
        except OSError as exc:
            if self._client_disconnected(exc):
                return False
            raise

    def _handle_full(self, file_path: Path, mime_type: str, file_size: int) -> None:
        try:
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    if not self._write_chunk(chunk):
                        return
        except self._CLIENT_GONE:
            return
        except OSError as exc:
            if self._client_disconnected(exc):
                return
            raise

    def _handle_range(
        self, file_path: Path, mime_type: str, file_size: int, range_header: str
    ) -> None:

        all_range_values = self.headers.get_all("Range")
        multiple = all_range_values is not None and len(all_range_values) > 1
        parsed = _compute_byte_range(range_header, file_size, multiple)
        if isinstance(parsed, str):
            self._send_error(416, parsed, file_size)
            return
        start, end = parsed

        content_length = end - start + 1
        try:
            self.send_response(206)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(content_length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(remaining, 65536))
                    if not chunk:
                        break
                    if not self._write_chunk(chunk):
                        return
                    remaining -= len(chunk)
        except self._CLIENT_GONE:
            return
        except OSError as exc:
            if self._client_disconnected(exc):
                return
            raise

    def _send_error(self, code: int, message: str, file_size: int = -1) -> None:
        try:
            self.send_response(code)
            self.send_header("Content-Type", "text/plain")
            if code == 416 and file_size >= 0:
                self.send_header("Content-Range", f"bytes */{file_size}")
            self.end_headers()
            self._write_chunk(message.encode("utf-8"))
        except self._CLIENT_GONE:
            return
        except OSError:
            return

    def log_message(self, fmt: str, *args: object) -> None:
        logger.debug("MediaServer: %s", fmt % args)

    def log_error(self, fmt: str, *args: object) -> None:
        msg = fmt % args if args else str(fmt)
        lower = msg.lower()
        if "10054" in msg or "10053" in msg or "forcibly closed" in lower or "aborted" in lower:
            logger.debug("MediaServer client disconnected: %s", msg)
            return
        logger.warning("MediaServer: %s", msg)


def _cached_file_or_none(path: Path) -> str | None:
    if path.exists() and path.stat().st_size > 0:
        return str(path)
    return None


def _thumbnail_seek_time(file_path: Path) -> str:
    candidate = _find_ffprobe()
    if not candidate:
        return "1"
    try:
        cmd_probe = [
            candidate,
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            str(file_path),
        ]
        result = subprocess.run(
            cmd_probe,
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode != 0:
            return "1"
        import json

        data = json.loads(result.stdout)
        dur = float(data.get("format", {}).get("duration", 0))
        if dur > 0:
            return str(dur * _THUMBNAIL_SEEK)
    except Exception:
        logger.debug(
            "Could not determine thumbnail seek time for %s", file_path.name, exc_info=True
        )
    return "1"


def _run_thumbnail_ffmpeg(
    ffmpeg: str, file_path: Path, duration_str: str, thumb_path: Path, timeout: float
) -> None:
    vf_filter = (
        f"scale='min({_MAX_THUMBNAIL_DIM},iw)':"
        f"'min({_MAX_THUMBNAIL_DIM},ih)':"
        f"force_original_aspect_ratio=decrease"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        duration_str,
        "-i",
        str(file_path),
        "-vframes",
        "1",
        "-vf",
        vf_filter,
        "-f",
        "image2",
        str(thumb_path),
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode != 0:
        stderr_tail = result.stderr.strip()[-500:] if result.stderr else ""
        logger.warning(
            "Thumbnail ffmpeg failed for %s (rc=%d): %s",
            file_path.name,
            result.returncode,
            stderr_tail,
        )


class MediaServer:
    def __init__(self) -> None:
        self._host = "127.0.0.1"
        self._port = 0
        self._tokens: dict[str, str] = {}
        self._lock = threading.Lock()
        self._server: _MediaTCPServer | None = None
        self._thread: threading.Thread | None = None
        self._running = False

        self._thumb_dir: Path | None = None

    @property
    def port(self) -> int:
        if self._server:
            return self._server.server_address[1]
        return 0

    def register_file(self, file_path: str | Path) -> str:
        file_path = Path(file_path).resolve()
        if not file_path.is_file():
            raise ValueError(f"File not found: {file_path}")

        token = secrets.token_hex(_TOKEN_BYTES)
        with self._lock:
            to_remove = [t for t, p in self._tokens.items() if p == str(file_path)]
            for t in to_remove:
                del self._tokens[t]
            self._tokens[token] = str(file_path)
        return token

    def get_url(self, token: str) -> str:

        with self._lock:
            file_path = self._tokens.get(token)
        if file_path is None:
            raise ValueError("Unknown or expired token")
        fname = Path(file_path).name
        return f"http://{self._host}:{self.port}/{token}/{fname}"

    def unregister_token(self, token: str) -> None:
        with self._lock:
            self._tokens.pop(token, None)

    def start(self) -> None:

        if self._running:
            return

        class Handler(_TokenRequestHandler):
            pass

        Handler.server_instance = self  # type: ignore[assignment]

        self._server = _MediaTCPServer((self._host, self._port), Handler)
        self._port = self._server.server_address[1]
        self._running = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        logger.info("Media server started on %s:%d", self._host, self._port)

    # joins the server thread for at most 2 seconds; daemon threads die with the process
    def stop(self) -> None:
        self._running = False
        if self._server:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                logger.debug("Error shutting down media server", exc_info=True)
            self._server = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        with self._lock:
            self._tokens.clear()
        logger.info("Media server stopped")

    def set_thumbnail_cache_dir(self, cache_dir: Path) -> None:
        self._thumb_dir = cache_dir
        cache_dir.mkdir(parents=True, exist_ok=True)

    def generate_thumbnail(
        self, file_path: str | Path, timeout: float = _THUMBNAIL_TIMEOUT
    ) -> str | None:

        file_path = Path(file_path).resolve()
        if not file_path.is_file():
            return None

        if self._thumb_dir is None:
            return None

        stat = file_path.stat()
        cache_key = hashlib.sha256(
            f"{file_path}:{stat.st_size}:{stat.st_mtime}".encode()
        ).hexdigest()[:32]
        thumb_path = self._thumb_dir / f"thumb_{cache_key}.jpg"

        cached = _cached_file_or_none(thumb_path)
        if cached:
            return cached

        from .engine import _find_ffmpeg

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.warning("Cannot generate thumbnail: ffmpeg not found")
            return None

        try:
            duration_str = _thumbnail_seek_time(file_path)
            _run_thumbnail_ffmpeg(ffmpeg, file_path, duration_str, thumb_path, timeout)
            return _cached_file_or_none(thumb_path)
        except Exception as e:
            logger.warning("Thumbnail generation failed for %s: %s", file_path.name, e)
            return None

    def generate_waveform(
        self, file_path: str | Path, timeout: float = _WAVEFORM_TIMEOUT
    ) -> str | None:
        file_path = Path(file_path).resolve()
        if not file_path.is_file() or self._thumb_dir is None:
            return None

        stat = file_path.stat()
        cache_key = hashlib.sha256(
            f"waveform:{file_path}:{stat.st_size}:{stat.st_mtime_ns}".encode()
        ).hexdigest()[:32]
        waveform_path = self._thumb_dir / f"waveform_{cache_key}.png"
        cached = _cached_file_or_none(waveform_path)
        if cached:
            return cached

        from .engine import _find_ffmpeg

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.warning("Cannot generate waveform: ffmpeg not found")
            return None

        try:
            if not _run_waveform_ffmpeg(ffmpeg, file_path, waveform_path, timeout):
                return None
            return _cached_file_or_none(waveform_path)
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.warning("Waveform generation failed for %s: %s", file_path.name, exc)
        return None


def _run_waveform_ffmpeg(ffmpeg: str, file_path: Path, waveform_path: Path, timeout: float) -> bool:
    command = [
        ffmpeg,
        "-y",
        "-v",
        "error",
        "-i",
        str(file_path),
        "-filter_complex",
        (
            "aformat=channel_layouts=mono,"
            f"showwavespic=s={_WAVEFORM_WIDTH}x{_WAVEFORM_HEIGHT}:colors=0xa78bfa"
        ),
        "-frames:v",
        "1",
        str(waveform_path),
    ]
    result = subprocess.run(
        command,
        capture_output=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode != 0:
        stderr_tail = result.stderr.decode(errors="replace")[-500:]
        logger.warning(
            "Waveform ffmpeg failed for %s (rc=%d): %s",
            file_path.name,
            result.returncode,
            stderr_tail,
        )
        return False
    return True


@lru_cache(maxsize=1)
def get_media_server() -> MediaServer:
    return MediaServer()


def _find_ffprobe() -> str | None:

    import shutil as _shutil

    found = _shutil.which("ffprobe")
    if found:
        return found
    for c in [
        r"C:\ffmpeg\bin\ffprobe.exe",
        r"C:\Program Files\ffmpeg\bin\ffprobe.exe",
    ]:
        if Path(c).is_file():
            return c
    return None
