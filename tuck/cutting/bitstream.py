"""Codec bitstream details: NAL units, AV1 OBUs, parameter sets and decoder configurations."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass

HEVC_VPS, HEVC_SPS, HEVC_PPS, HEVC_AUD = 32, 33, 34, 35
AV1_SEQUENCE_HEADER, AV1_TEMPORAL_DELIMITER = 1, 2


class BitstreamError(ValueError):
    pass


def nal_units(payload: bytes, length_size: int | None) -> Iterator[bytes]:
    """Split a packet into NAL units, length-prefixed or Annex B."""
    if length_size:
        cursor = 0
        while cursor + length_size <= len(payload):
            length = int.from_bytes(payload[cursor : cursor + length_size], "big")
            cursor += length_size
            if length <= 0 or cursor + length > len(payload):
                return
            yield payload[cursor : cursor + length]
            cursor += length
        return
    starts = []
    index = payload.find(b"\x00\x00\x01")
    while index != -1:
        starts.append(index + 3)
        index = payload.find(b"\x00\x00\x01", index + 3)
    for number, start in enumerate(starts):
        end = starts[number + 1] - 3 if number + 1 < len(starts) else len(payload)
        unit = payload[start:end].rstrip(b"\x00")
        if unit:
            yield unit


def nal_length_size(codec: str, extradata: bytes | None) -> int | None:
    """NAL length size from avcC/hvcC, or None for Annex B streams."""
    if not extradata or extradata[:3] in (b"\x00\x00\x01", b"\x00\x00\x00"):
        return None
    if codec == "h264" and len(extradata) >= 5 and extradata[0] == 1:
        return (extradata[4] & 3) + 1
    if codec == "hevc" and len(extradata) >= 23 and extradata[0] == 1:
        return (extradata[21] & 3) + 1
    return None


def length_prefixed(units: Iterable[bytes], length_size: int) -> bytes:
    return b"".join(len(unit).to_bytes(length_size, "big") + unit for unit in units)


def hevc_type(unit: bytes) -> int:
    return (unit[0] >> 1) & 0x3F


def unescape(unit: bytes) -> bytes:
    """Remove emulation-prevention bytes, giving the raw payload bits."""
    if b"\x00\x00\x03" not in unit:
        return unit
    out = bytearray()
    zeros = 0
    for byte in unit:
        if zeros >= 2 and byte == 3:
            zeros = 0
            continue
        out.append(byte)
        zeros = zeros + 1 if byte == 0 else 0
    return bytes(out)


def escape(payload: bytes) -> bytes:
    out = bytearray()
    zeros = 0
    for byte in payload:
        if zeros >= 2 and byte <= 3:
            out.append(3)
            zeros = 0
        out.append(byte)
        zeros = zeros + 1 if byte == 0 else 0
    return bytes(out)


def _bits(data: bytes) -> str:
    return "".join(f"{byte:08b}" for byte in data)


def _bytes(bits: str) -> bytes:
    if len(bits) % 8:
        raise BitstreamError("parameter set rewrite changed the byte alignment")
    return int(bits, 2).to_bytes(len(bits) // 8, "big") if bits else b""


def _ue_code(value: int) -> str:
    code = f"{value + 1:b}"
    return "0" * (len(code) - 1) + code


def _read_ue(bits: str, position: int) -> tuple[int, int]:
    zeros = 0
    while position + zeros < len(bits) and bits[position + zeros] == "0":
        zeros += 1
        if zeros > 31:
            raise BitstreamError("invalid Exp-Golomb value")
    end = position + 2 * zeros + 1
    if end > len(bits):
        raise BitstreamError("truncated Exp-Golomb value")
    return int(bits[position + zeros : end], 2) - 1, end


# --- H.264 decoder configuration (avcC) ---


@dataclass(frozen=True)
class AvcConfig:
    header: bytes  # profile, compatibility and level
    length_size: int
    sps: tuple[bytes, ...]
    pps: tuple[bytes, ...]
    extension: bytes

    @classmethod
    def parse(cls, data: bytes | None) -> AvcConfig:
        try:
            if not data or data[0] != 1:
                raise ValueError
            position = 6
            sps = []
            for _ in range(data[5] & 31):
                size = int.from_bytes(data[position : position + 2], "big")
                sps.append(data[position + 2 : position + 2 + size])
                position += 2 + size
            pps = []
            count = data[position]
            position += 1
            for _ in range(count):
                size = int.from_bytes(data[position : position + 2], "big")
                pps.append(data[position + 2 : position + 2 + size])
                position += 2 + size
            if position > len(data) or any(not nal for nal in (*sps, *pps)):
                raise ValueError
        except (IndexError, ValueError) as exc:
            raise BitstreamError("the H.264 decoder configuration could not be read") from exc
        return cls(
            bytes(data[1:4]), (data[4] & 3) + 1, tuple(sps), tuple(pps), bytes(data[position:])
        )

    @classmethod
    def from_annex_b(cls, data: bytes) -> AvcConfig:
        units = list(nal_units(data, None))
        return cls(
            b"",
            4,
            tuple(u for u in units if u[0] & 0x1F == 7),
            tuple(u for u in units if u[0] & 0x1F == 8),
            b"",
        )

    def sps_ids(self) -> set[int]:
        return {_read_ue(_bits(unescape(nal[:8])), 32)[0] for nal in self.sps}

    def pps_ids(self) -> set[int]:
        return {_read_ue(_bits(unescape(nal[:6])), 8)[0] for nal in self.pps}

    def merged(self, other: AvcConfig) -> bytes:
        """This configuration followed by `other`'s parameter sets, under this header."""
        sps, pps = (*self.sps, *other.sps), (*self.pps, *other.pps)
        if len(sps) > 31 or len(pps) > 255:
            raise BitstreamError("the video has too many parameter sets")
        out = bytearray([1, *self.header, 0xFC | (self.length_size - 1), 0xE0 | len(sps)])
        for nal in sps:
            out += len(nal).to_bytes(2, "big") + nal
        out.append(len(pps))
        for nal in pps:
            out += len(nal).to_bytes(2, "big") + nal
        return bytes(out + self.extension)


# --- HEVC decoder configuration (hvcC) and parameter-set numbering ---


@dataclass(frozen=True)
class HevcConfig:
    header: bytes  # everything before the NAL unit arrays
    arrays: tuple[tuple[int, tuple[bytes, ...]], ...]  # (completeness and type byte, units)

    @property
    def length_size(self) -> int:
        return (self.header[21] & 3) + 1

    @classmethod
    def parse(cls, data: bytes | None) -> HevcConfig:
        try:
            if not data or data[0] != 1 or len(data) < 23:
                raise ValueError
            position = 23
            arrays = []
            for _ in range(data[22]):
                kind = data[position]
                count = int.from_bytes(data[position + 1 : position + 3], "big")
                position += 3
                units = []
                for _ in range(count):
                    size = int.from_bytes(data[position : position + 2], "big")
                    units.append(bytes(data[position + 2 : position + 2 + size]))
                    position += 2 + size
                arrays.append((kind, tuple(units)))
            if position != len(data) or any(not u for _, units in arrays for u in units):
                raise ValueError
        except (IndexError, ValueError) as exc:
            raise BitstreamError("the HEVC decoder configuration could not be read") from exc
        return cls(bytes(data[:22]), tuple(arrays))

    def units(self, kind: int) -> tuple[bytes, ...]:
        return tuple(u for byte, units in self.arrays if byte & 0x3F == kind for u in units)

    def with_units(self, added: Iterable[bytes]) -> bytes:
        """This configuration with more parameter sets, each listed under its type."""
        arrays = {byte & 0x3F: (byte, list(units)) for byte, units in self.arrays}
        order = [byte & 0x3F for byte, _ in self.arrays]
        for unit in added:
            kind = hevc_type(unit)
            if kind not in arrays:
                # parameter-set arrays hold every set of their type, so mark them complete
                arrays[kind] = (0x80 | kind, [])
                order.append(kind)
            arrays[kind][1].append(unit)
        out = bytearray(self.header)
        out.append(len(order))
        for kind in order:
            byte, units = arrays[kind]
            if len(units) > 0xFFFF:
                raise BitstreamError("the video has too many parameter sets")
            out += bytes([byte]) + len(units).to_bytes(2, "big")
            for unit in units:
                out += len(unit).to_bytes(2, "big") + unit
        return bytes(out)


@dataclass(frozen=True)
class HevcIds:
    vps: int
    sps: int
    pps: int


def _skip_profile_tier_level(bits: str, position: int, sub_layers: int) -> int:
    position += 96  # general profile, tier, flags and level
    present = []
    for _ in range(sub_layers):
        present.append((bits[position] == "1", bits[position + 1] == "1"))
        position += 2
    if sub_layers:
        position += 2 * (8 - sub_layers)
    for profile, level in present:
        position += (88 if profile else 0) + (8 if level else 0)
    return position


def _sps_id_position(bits: str) -> int:
    """Where sps_seq_parameter_set_id starts in an SPS, counted from the NAL header."""
    sub_layers = int(bits[20:23], 2)
    return _skip_profile_tier_level(bits, 24, sub_layers)


def hevc_parameter_id(unit: bytes) -> int:
    """The ID a VPS, SPS or PPS declares."""
    bits = _bits(unescape(unit[:64] if hevc_type(unit) != HEVC_SPS else unit))
    kind = hevc_type(unit)
    if kind == HEVC_VPS:
        return int(bits[16:20], 2)
    if kind == HEVC_SPS:
        return _read_ue(bits, _sps_id_position(bits))[0]
    if kind == HEVC_PPS:
        return _read_ue(bits, 16)[0]
    raise BitstreamError("not an HEVC parameter set")


def _replace_ue(bits: str, position: int, expected: int, value: int) -> str:
    found, end = _read_ue(bits, position)
    if found != expected:
        raise BitstreamError("unexpected parameter-set ID")
    return bits[:position] + _ue_code(value) + bits[end:]


def renumber_hevc_parameter_set(unit: bytes, ids: HevcIds) -> bytes:
    """Give an encoder's VPS, SPS or PPS (all numbered 0) the IDs in `ids`."""
    kind = hevc_type(unit)
    bits = _bits(unescape(unit))
    if kind == HEVC_VPS:
        if int(bits[16:20], 2) != 0:
            raise BitstreamError("unexpected parameter-set ID")
        bits = bits[:16] + f"{ids.vps:04b}" + bits[20:]
    elif kind == HEVC_SPS:
        position = _sps_id_position(bits)
        bits = _replace_ue(bits, position, 0, ids.sps)
        bits = bits[:16] + f"{ids.vps:04b}" + bits[20:]
    elif kind == HEVC_PPS:
        bits = _replace_ue(bits, 16, 0, ids.pps)
        _, end = _read_ue(bits, 16)
        bits = _replace_ue(bits, end, 0, ids.sps)
    else:
        raise BitstreamError("not an HEVC parameter set")
    return escape(_bytes(bits))


def is_hevc_slice(unit: bytes) -> bool:
    kind = hevc_type(unit)
    return kind <= 9 or 16 <= kind <= 21


def renumber_hevc_slice(unit: bytes, pps: int) -> bytes:
    """Point a slice at PPS `pps` instead of 0 without touching its slice data.

    `pps` must take 9 bits as Exp-Golomb, 8 more than 0 does, so everything after the ID
    moves by exactly one byte and the byte-aligned slice data stays unchanged.
    """
    if len(_ue_code(pps)) != 9:
        raise BitstreamError("the PPS ID must be between 15 and 30")
    # only the head changes; cut the escaped unit after a byte that cannot end or be part of
    # an escape sequence, so the rest can be kept as it is
    cut = 8
    while cut < len(unit) and unit[cut - 1] in (0, 3):
        cut += 1
    head = unescape(unit[:cut])
    bits = _bits(head)
    position = 17 + (1 if 16 <= hevc_type(unit) <= 23 else 0)
    bits = _replace_ue(bits, position, 0, pps)
    return escape(_bytes(bits)) + unit[cut:]


# --- AV1 ---


def _leb128(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    for index in range(8):
        if position + index >= len(data):
            break
        byte = data[position + index]
        value |= (byte & 0x7F) << (7 * index)
        if not byte & 0x80:
            return value, position + index + 1
    raise BitstreamError("invalid AV1 OBU size")


def av1_obus(payload: bytes) -> Iterator[tuple[int, bytes]]:
    """(type, whole OBU) for each OBU in a temporal unit."""
    position = 0
    while position < len(payload):
        header = payload[position]
        kind = (header >> 3) & 0xF
        start = position
        position += 1 + ((header >> 2) & 1)
        if header & 2:
            size, position = _leb128(payload, position)
        else:
            size = len(payload) - position
        if position + size > len(payload):
            raise BitstreamError("truncated AV1 OBU")
        position += size
        yield kind, payload[start:position]


def without_temporal_delimiters(payload: bytes) -> bytes:
    # MP4 and Matroska samples leave temporal delimiters out
    return b"".join(obu for kind, obu in av1_obus(payload) if kind != AV1_TEMPORAL_DELIMITER)
