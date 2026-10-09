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
import time
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from socketserver import ThreadingTCPServer
from typing import NamedTuple

import av
from av.codec.context import CodecContext
from av.error import FFmpegError
from av.filter import Graph
from av.video.codeccontext import VideoCodecContext
from av.video.frame import VideoFrame

from .media_tools import find_ffmpeg, find_ffprobe
from .probe import first_video_frame

logger = logging.getLogger(__name__)


# daemon threads don't block process exit. The port is ephemeral, so SO_REUSEADDR buys
# nothing, and on Windows it would let another socket bind the same port and answer instead
class _MediaTCPServer(ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True


for ext, mime in [
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".mkv", "video/x-matroska"),
    (".mov", "video/quicktime"),
    (".avi", "video/x-msvideo"),
    (".flv", "video/x-flv"),
    (".f4v", "video/mp4"),
    (".m4v", "video/x-m4v"),
    (".wmv", "video/x-ms-wmv"),
    (".asf", "video/x-ms-asf"),
    (".ts", "video/mp2t"),
    (".m2ts", "video/mp2t"),
    (".mts", "video/mp2t"),
    (".3gp", "video/3gpp"),
    (".3g2", "video/3gpp2"),
    (".ogv", "video/ogg"),
    (".mpg", "video/mpeg"),
    (".mpeg", "video/mpeg"),
    (".m2v", "video/mpeg"),
    (".vob", "video/mpeg"),
    (".mxf", "application/mxf"),
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
_THUMBNAIL_SCALE = (
    f"'min({_MAX_THUMBNAIL_DIM},iw)':'min({_MAX_THUMBNAIL_DIM},ih)':"
    "force_original_aspect_ratio=decrease"
)
_THUMBNAIL_MAX_PACKETS = 1000
# filters that turn a picture upright, by its counter-clockwise display rotation in degrees
_UPRIGHT_FILTERS: dict[int, tuple[tuple[str, str], ...]] = {
    90: (("transpose", "cclock"),),
    180: (("hflip", ""), ("vflip", "")),
    270: (("transpose", "clock"),),
}
# long files get more columns so they don't turn into stair steps when zoomed in. The cap stays
# within the GPU texture limit, past which browsers quietly shrink the mask image
_WAVEFORM_MIN_WIDTH = 8192
_WAVEFORM_MAX_WIDTH = 16384
_WAVEFORM_COLUMNS_PER_SECOND = 96
# tall enough to stay sharp in the tallest timeline rows
_WAVEFORM_HEIGHT = 192
_WAVEFORM_TIMEOUT = 60
_WAVEFORM_CACHE_VERSION = 10
_WAVEFORM_TARGET_PEAK_DB = -1.0
_WAVEFORM_MAX_GAIN_DB = 60.0
# audio this dense (peak close to its average, like mastered music) fills the whole row when its
# peaks are drawn, so it is drawn from its average level instead, raised to a set loudness, which
# shows the beat and leaves room above it. Sparser audio such as game sound or speech keeps the
# square-root peak drawing, which keeps its quiet parts visible
_WAVEFORM_DENSE_CREST_DB = 16.0
_WAVEFORM_DENSE_TARGET_MEAN_DB = -8.0
_TOKEN_BYTES = 32  # bytes for each token
# the preview, the audio timeline and the Library can each hold a URL for the same file, so a
# path keeps several live tokens; the oldest goes once this many are live
_TOKENS_PER_PATH = 16
# Tuck's own pages: the Tauri scheme on Linux, its localhost host on Windows (http, or https if
# the webview is switched to it) and the Vite dev server. The preview <video> is loaded with
# crossorigin so the LUT preview can draw its frames, which makes it send an Origin just like
# the fetches for LUT tables and waveform masks; without a match here the preview doesn't play
_ALLOWED_ORIGINS = frozenset(
    {
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    }
)


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
            self._send_cors_headers()
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
            self._send_cors_headers()
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

    def _send_cors_headers(self) -> None:
        # the token authorizes the read; CORS decides which pages may read the bytes from
        # script, so a web page that learns a media URL still can't
        origin = self.headers.get("Origin")
        if origin in _ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")

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


def _write_thumbnail_in_process(file_path: Path, thumb_path: Path, timeout: float) -> bool:
    """Write the thumbnail with PyAV, so no ffmpeg process has to start.

    Starting ffmpeg takes far longer than decoding one picture. Returns False when no picture
    is found near the middle.
    """
    with av.open(str(file_path), timeout=timeout) as container:
        if not container.streams.video:
            return False
        stream = container.streams.video[0]
        # the seek lands on a keyframe, so the first picture out is that keyframe; asking the
        # decoder to skip other frames is not needed, and the AV1 decoder then returns nothing
        if container.duration and container.duration > 0:
            start = container.start_time or 0
            container.seek(start + int(container.duration * _THUMBNAIL_SEEK), backward=True)
        frame = first_video_frame(container, stream, _THUMBNAIL_MAX_PACKETS)
        if frame is None or stream.time_base is None:
            return False

        # the ffmpeg command turns phone videos upright by itself; PyAV leaves that to us
        graph = Graph()
        nodes = [
            graph.add_buffer(
                width=frame.width,
                height=frame.height,
                format=frame.format,
                time_base=stream.time_base,
            )
        ]
        for name, args in _UPRIGHT_FILTERS.get(round(frame.rotation) % 360, ()):
            nodes.append(graph.add(name, args))
        nodes.append(graph.add("scale", _THUMBNAIL_SCALE))
        nodes.append(graph.add("format", "yuvj420p"))
        nodes.append(graph.add("buffersink"))
        graph.link_nodes(*nodes).configure()
        graph.push(frame)
        picture = graph.pull()
    if not isinstance(picture, VideoFrame):
        return False

    encoder = CodecContext.create("mjpeg", "w")
    if not isinstance(encoder, VideoCodecContext):
        return False
    encoder.width = picture.width
    encoder.height = picture.height
    encoder.pix_fmt = "yuvj420p"
    encoder.time_base = Fraction(1, 1)
    picture.pts = 0
    picture.time_base = Fraction(1, 1)
    data = b"".join(bytes(packet) for packet in [*encoder.encode(picture), *encoder.encode(None)])
    if not data:
        return False
    # a half-written file would be served from the cache forever, so publish it whole
    partial = thumb_path.with_suffix(".partial")
    partial.write_bytes(data)
    os.replace(partial, thumb_path)
    return True


def _thumbnail_seek_time(file_path: Path) -> str:
    candidate = find_ffprobe()
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
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
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
    vf_filter = f"scale={_THUMBNAIL_SCALE}"
    cmd = [
        ffmpeg,
        "-nostdin",
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
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode != 0:
        stderr_tail = result.stderr.decode("utf-8", errors="replace").strip()[-500:]
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
        self._thumb_locks: dict[str, threading.Lock] = {}

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
            # tokens keep their registration order, so the first ones found are the oldest
            live = [t for t, p in self._tokens.items() if p == str(file_path)]
            for t in live[: max(0, len(live) - _TOKENS_PER_PATH + 1)]:
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

        # the Library and the player can ask for the same picture at once; the second waits
        # for the first and reuses its file instead of writing the same output again
        with self._lock:
            thumb_lock = self._thumb_locks.setdefault(cache_key, threading.Lock())
        with thumb_lock:
            cached = _cached_file_or_none(thumb_path)
            if cached:
                return cached

            try:
                if _write_thumbnail_in_process(file_path, thumb_path, timeout):
                    return _cached_file_or_none(thumb_path)
            except (FFmpegError, OSError, ValueError) as e:
                logger.debug("PyAV thumbnail failed for %s: %s", file_path.name, e)

            ffmpeg = find_ffmpeg()
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
            (
                f"waveform:v{_WAVEFORM_CACHE_VERSION}:{file_path}:{stat.st_size}:{stat.st_mtime_ns}"
            ).encode()
        ).hexdigest()[:32]
        waveform_path = self._thumb_dir / f"waveform_{cache_key}.png"
        cached = _cached_file_or_none(waveform_path)
        if cached:
            return cached

        ffmpeg = find_ffmpeg()
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


class _WaveformLevels(NamedTuple):
    gain_db: float
    scale: str
    filter: str
    width: int


def _run_waveform_ffmpeg(ffmpeg: str, file_path: Path, waveform_path: Path, timeout: float) -> bool:
    started = time.monotonic()
    levels = _waveform_levels(ffmpeg, file_path, timeout)
    remaining_timeout = max(0.1, timeout - (time.monotonic() - started))
    gain_filter = f"volume={levels.gain_db:g}dB," if levels.gain_db > 0 else ""
    command = [
        ffmpeg,
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        str(file_path),
        "-filter_complex",
        (
            "aformat=channel_layouts=mono,"
            f"{gain_filter}"
            # a solid white shape on transparency; the timeline uses it as a mask and colours it
            f"showwavespic=s={levels.width}x{_WAVEFORM_HEIGHT}:"
            f"colors=0xffffff:scale={levels.scale}:filter={levels.filter}:draw=full"
        ),
        "-frames:v",
        "1",
        str(waveform_path),
    ]
    result = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=remaining_timeout,
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


def _waveform_levels(ffmpeg: str, file_path: Path, timeout: float) -> _WaveformLevels:
    """Measures the audio once to pick how its waveform is drawn and how wide it is.

    A failed measurement falls back to the square-root peak drawing at the smallest width.
    """
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-v",
        "info",
        "-i",
        str(file_path),
        "-map",
        "0:a:0",
        "-af",
        "aformat=channel_layouts=mono,volumedetect",
        "-f",
        "null",
        os.devnull,
    ]
    result = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode != 0:
        return _WaveformLevels(0.0, "sqrt", "peak", _WAVEFORM_MIN_WIDTH)
    width = _waveform_width(_input_duration(result.stderr))
    peak_db = _detected_db(rb"max_volume", result.stderr)
    mean_db = _detected_db(rb"mean_volume", result.stderr)
    if peak_db is None:
        return _WaveformLevels(0.0, "sqrt", "peak", width)
    if mean_db is not None and peak_db - mean_db <= _WAVEFORM_DENSE_CREST_DB:
        return _WaveformLevels(
            _clamped_gain_db(_WAVEFORM_DENSE_TARGET_MEAN_DB - mean_db), "lin", "average", width
        )
    return _WaveformLevels(
        _clamped_gain_db(_WAVEFORM_TARGET_PEAK_DB - peak_db), "sqrt", "peak", width
    )


def _detected_db(name: bytes, stderr: bytes) -> float | None:
    match = re.search(name + rb":\s*([-+]?\d+(?:\.\d+)?)\s*dB", stderr)
    return float(match.group(1)) if match else None


def _input_duration(stderr: bytes) -> float | None:
    match = re.search(rb"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)", stderr)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def _clamped_gain_db(gain_db: float) -> float:
    return max(0.0, min(_WAVEFORM_MAX_GAIN_DB, gain_db))


def _waveform_width(duration: float | None) -> int:
    if duration is None:
        return _WAVEFORM_MIN_WIDTH
    columns = round(duration * _WAVEFORM_COLUMNS_PER_SECOND)
    return max(_WAVEFORM_MIN_WIDTH, min(_WAVEFORM_MAX_WIDTH, columns))


@lru_cache(maxsize=1)
def get_media_server() -> MediaServer:
    return MediaServer()
