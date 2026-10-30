"""Waveform pictures for the audio timeline.

A picture is a solid white shape on transparency, which the timeline colours through a mask. Its
level and drawing come from one measurement of the whole track, so it takes two passes over the
audio: FFmpeg's volumedetect, then its showwavespic. media_server runs those two FFmpeg passes;
draw_waveform() draws the same picture, pixel for pixel, with PyAV and NumPy, which saves starting
FFmpeg twice. A short track is decoded only once.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Iterator
from fractions import Fraction
from itertools import chain
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, NamedTuple

from .media_libraries import load_media_libraries

# imported inside functions after load_media_libraries(), so the backend starts without them
if TYPE_CHECKING:
    import numpy as np
    from av.audio.codeccontext import AudioCodecContext
    from av.audio.frame import AudioFrame
    from av.audio.resampler import AudioResampler
    from av.packet import Packet
    from numpy.typing import NDArray

# tall enough to stay sharp in the tallest timeline rows
WAVEFORM_HEIGHT = 192
# long files get more columns so they don't turn into stair steps when zoomed in. The cap stays
# within the GPU texture limit, past which browsers quietly shrink the mask image
_MIN_WIDTH = 8192
_MAX_WIDTH = 16384
_COLUMNS_PER_SECOND = 96
_TARGET_PEAK_DB = -1.0
_MAX_GAIN_DB = 60.0
# audio this dense (peak close to its average, like mastered music) fills the whole row when its
# peaks are drawn, so it is drawn from its average level instead, raised to a set loudness, which
# shows the beat and leaves room above it. Sparser audio such as game sound or speech keeps the
# square-root peak drawing, which keeps its quiet parts visible
_DENSE_CREST_DB = 16.0
_DENSE_TARGET_MEAN_DB = -8.0
# PyAV reads a whole file to get at one track, where FFmpeg skips the video, so long recordings
# are left to FFmpeg's passes
_MAX_FILE_BYTES = 1024 * 1024 * 1024
# the two mixes a drawing may need are made while measuring and kept up to this size (about two
# minutes at 48 kHz), so the audio isn't decoded again
_KEPT_MIX_BYTES = 32 * 1024 * 1024
# past that, compressed audio up to this size is kept for decoding again instead of reading the
# file again
_KEPT_AUDIO_BYTES = 32 * 1024 * 1024
# NumPy works through the samples in blocks this long instead of one decoded frame at a time
_BLOCK_SAMPLES = 65536
# what volumedetect reports for silence
_SILENT_DB = -91.0
_LOG2_10 = 3.32192809488736234787


class WaveformLevels(NamedTuple):
    gain_db: float
    scale: str
    filter: str
    width: int


def waveform_levels(
    peak_db: float | None, mean_db: float | None, duration: float | None
) -> WaveformLevels:
    """Picks how a track is drawn from its measured levels and length in seconds.

    Without a measured peak it falls back to the square-root peak drawing without a gain.
    """
    width = _MIN_WIDTH
    if duration is not None:
        width = max(_MIN_WIDTH, min(_MAX_WIDTH, round(duration * _COLUMNS_PER_SECOND)))
    if peak_db is None:
        return WaveformLevels(0.0, "sqrt", "peak", width)
    if mean_db is not None and peak_db - mean_db <= _DENSE_CREST_DB:
        return WaveformLevels(_gain(_DENSE_TARGET_MEAN_DB - mean_db), "lin", "average", width)
    return WaveformLevels(_gain(_TARGET_PEAK_DB - peak_db), "sqrt", "peak", width)


def _gain(gain_db: float) -> float:
    return max(0.0, min(_MAX_GAIN_DB, gain_db))


def draw_waveform(source: Path, output: Path, track: int, timeout: float) -> bool:
    """Writes the waveform PNG of one audio track the way FFmpeg's two passes draw it.

    False leaves the track to those passes: a file too big to read whole, one without that track or
    with too little audio to draw, and audio PyAV can't decode. Raises TimeoutError once the
    timeout has passed.
    """
    if source.stat().st_size > _MAX_FILE_BYTES:
        return False
    load_media_libraries()
    import av
    import numpy as np
    from av.error import FFmpegError

    deadline = monotonic() + timeout

    def check() -> None:
        if monotonic() >= deadline:
            raise TimeoutError("Waveform took too long to draw")

    try:
        with av.open(str(source), timeout=timeout) as container:
            if track >= len(container.streams.audio):
                return False
            stream = container.streams.audio[track]
            kept = _KeptAudio()
            count, peak_db, mean_db = _measure(
                kept.measured(container.demux(stream), stream.codec_context, check)
            )
            # the length FFmpeg prints, rounded to hundredths, sets the width
            duration = (
                None if container.duration is None else (container.duration + 5000) // 10000 / 100
            )
        levels = waveform_levels(peak_db, mean_db, duration)
        if count < levels.width:
            # showwavespic refuses a picture whose columns would get no samples
            return False
        samples = kept.drawn(levels.gain_db)
        if samples is None:
            samples = _decoded_again(source, track, kept.packets, levels.gain_db, check, timeout)
        columns = _columns(samples, count, levels.width, levels.filter == "peak")
    except FFmpegError:
        return False
    # showwavespic's own arithmetic, so every column ends on the same pixel
    if levels.scale == "sqrt":
        scaled = np.sqrt(columns.astype(np.float64)) * WAVEFORM_HEIGHT / math.sqrt(32767)
        heights = scaled.astype(np.int64)
    else:
        heights = (columns * WAVEFORM_HEIGHT + 32767 // 2) // 32767
    tops = (WAVEFORM_HEIGHT - heights) // 2
    rows = np.arange(WAVEFORM_HEIGHT)[:, None]
    image = np.zeros((WAVEFORM_HEIGHT, levels.width, 4), dtype=np.uint8)
    image[(rows >= tops) & (rows < tops + heights)] = 255
    data = _png(image)
    if not data:
        return False
    output.write_bytes(data)
    return True


class _KeptAudio:
    """What the measuring pass keeps of a track, so drawing it reads and decodes less again."""

    def __init__(self) -> None:
        self.packets: list[Packet] | None = []
        self._packet_bytes = 0
        # the 16-bit mix for an ungained drawing and the float one for a gained drawing
        self._sixteen_bit: list[NDArray[np.number]] = []
        self._floating: list[NDArray[np.number]] = []
        self._mix_bytes: int | None = 0

    def measured(
        self, packets: Iterable[Packet], codec: AudioCodecContext, check: Callable[[], None]
    ) -> Iterator[NDArray[np.number]]:
        """The 16-bit mix volumedetect measures, decoded together with the float mix."""
        sixteen_bit = _sixteen_bit_resampler()
        floating = _float_resampler()
        for frame in chain(_decoded(self._keeping(packets), codec, check), [None]):
            for block in sixteen_bit.resample(frame):
                samples = block.to_ndarray().reshape(-1)
                self._keep(self._sixteen_bit, samples)
                yield samples
            if self._mix_bytes is not None:
                for block in floating.resample(frame):
                    self._keep(self._floating, block.to_ndarray().reshape(-1))

    def drawn(self, gain_db: float) -> Iterator[NDArray[np.int64]] | None:
        """The drawing's samples from the kept mix, or None when the mixes were too long to keep."""
        if self._mix_bytes is None:
            return None
        return _drawn(self._sixteen_bit if gain_db <= 0 else self._floating, gain_db)

    def _keeping(self, packets: Iterable[Packet]) -> Iterator[Packet]:
        for packet in packets:
            if self.packets is not None and packet.size:
                self._packet_bytes += packet.size
                if self._packet_bytes > _KEPT_AUDIO_BYTES:
                    self.packets = None
                else:
                    self.packets.append(packet)
            yield packet

    def _keep(self, mix: list[NDArray[np.number]], samples: NDArray[np.number]) -> None:
        if self._mix_bytes is None:
            return
        self._mix_bytes += samples.nbytes
        if self._mix_bytes > _KEPT_MIX_BYTES:
            self._mix_bytes = None
            self._sixteen_bit.clear()
            self._floating.clear()
        else:
            mix.append(samples)


def _decoded_again(
    source: Path,
    track: int,
    packets: list[Packet] | None,
    gain_db: float,
    check: Callable[[], None],
    timeout: float,
) -> Iterator[NDArray[np.int64]]:
    """The drawing's samples from a second decode, of the kept packets or of the file again."""
    load_media_libraries()
    import av

    # a flushed decoder doesn't always start again from a clean state (AAC keeps some), so the
    # second decode gets a new one
    with av.open(str(source), timeout=timeout) as fresh:
        stream = fresh.streams.audio[track]
        codec = stream.codec_context
        reading = packets if packets is not None else fresh.demux(stream)
        resampler = _sixteen_bit_resampler() if gain_db <= 0 else _float_resampler()
        yield from _drawn(_resampled(reading, codec, resampler, check), gain_db)


def _decoded(
    packets: Iterable[Packet], codec: AudioCodecContext, check: Callable[[], None]
) -> Iterator[AudioFrame]:
    load_media_libraries()
    from av.audio.frame import AudioFrame

    for packet in packets:
        check()
        # demux ends with an empty packet, which would already drain the decoder
        if packet.size:
            yield from (frame for frame in codec.decode(packet) if isinstance(frame, AudioFrame))
    yield from (frame for frame in codec.decode(None) if isinstance(frame, AudioFrame))


def _resampled(
    packets: Iterable[Packet],
    codec: AudioCodecContext,
    resampler: AudioResampler,
    check: Callable[[], None],
) -> Iterator[NDArray[np.number]]:
    for frame in _decoded(packets, codec, check):
        for block in resampler.resample(frame):
            yield block.to_ndarray().reshape(-1)
    for block in resampler.resample(None):
        yield block.to_ndarray().reshape(-1)


def _sixteen_bit_resampler() -> AudioResampler:
    """Mono 16-bit samples as FFmpeg makes them for volumedetect, and for an ungained drawing.

    Converting to 16 bits makes swresample scale a stereo mix to (L+R)/2 so it can't clip.
    """
    load_media_libraries()
    import av

    return av.AudioResampler(format="s16", layout="mono", frame_size=_BLOCK_SAMPLES)


def _float_resampler() -> AudioResampler:
    """Mono float samples as FFmpeg's volume filter gets them for a gained drawing.

    A float mix isn't scaled down, so swresample makes a stereo mix 0.71 x (L+R).
    """
    load_media_libraries()
    import av

    return av.AudioResampler(format="flt", layout="mono", frame_size=_BLOCK_SAMPLES)


def _measure(samples: Iterator[NDArray[np.number]]) -> tuple[int, float | None, float | None]:
    """Sample count, peak and mean level the way volumedetect measures and prints them."""
    load_media_libraries()
    import numpy as np

    count = peak = power = 0
    for block in samples:
        if not len(block):
            continue
        values = np.abs(block.astype(np.int64))
        count += len(values)
        peak = max(peak, int(values.max()))
        power += int(np.dot(values, values))
    if not count:
        return 0, None, None
    mean_power = (power + count // 2) // count
    return count, _printed_db(peak * peak), _printed_db(mean_power)


def _printed_db(power: int) -> float:
    # volumedetect prints one decimal, and the drawing follows what it printed
    db = 10 * math.log10(power / 2**30) if power else _SILENT_DB
    return float(f"{db:.1f}")


def _drawn(blocks: Iterable[NDArray[np.number]], gain_db: float) -> Iterator[NDArray[np.int64]]:
    """Absolute mono 16-bit samples as showwavespic gets them, after the gain.

    Without a gain the blocks are the 16-bit mix, and with one the float mix.
    """
    load_media_libraries()
    import numpy as np

    if gain_db <= 0:
        for block in blocks:
            yield np.abs(block.astype(np.int64))
        return
    # FFmpeg's volume filter converts to 16 bits after the gain. The level follows the filter's
    # text: dB to a factor through exp2, then single precision
    gain = np.float32(2.0 ** (_LOG2_10 * (float(f"{gain_db:g}") / 20)))
    for block in blocks:
        scaled = np.rint(block.astype(np.float32, copy=False) * gain * np.float32(32768))
        yield np.abs(np.clip(scaled, -32768, 32767).astype(np.int64))


def _columns(
    samples: Iterator[NDArray[np.int64]], count: int, width: int, peak: bool
) -> NDArray[np.int64]:
    """Each column's peak or average sample, split as showwavespic splits them.

    Every column takes count // width samples, and the last one also takes the rest.
    """
    load_media_libraries()
    import numpy as np

    per_column = count // width
    columns = np.zeros(width, dtype=np.int64)
    offset = 0
    for values in samples:
        if len(values):
            first = min(offset // per_column, width - 1)
            last = min((offset + len(values) - 1) // per_column, width - 1)
            starts = np.arange(first, last + 1, dtype=np.int64) * per_column - offset
            starts[0] = 0
            span = columns[first : last + 1]
            if peak:
                np.maximum(span, np.maximum.reduceat(values, starts), out=span)
            else:
                span += np.add.reduceat(values, starts)
        offset += len(values)
    if not peak:
        sizes = np.full(width, per_column, dtype=np.int64)
        sizes[-1] = count - (width - 1) * per_column
        columns //= sizes
    return columns


def _png(image: NDArray[np.uint8]) -> bytes:
    load_media_libraries()
    from av.codec.context import CodecContext
    from av.video.codeccontext import VideoCodecContext
    from av.video.frame import VideoFrame

    encoder = CodecContext.create("png", "w")
    if not isinstance(encoder, VideoCodecContext):
        return b""
    picture = VideoFrame.from_ndarray(image, format="rgba")
    encoder.width = picture.width
    encoder.height = picture.height
    encoder.pix_fmt = "rgba"
    encoder.time_base = Fraction(1, 1)
    return b"".join(bytes(p) for p in [*encoder.encode(picture), *encoder.encode(None)])
