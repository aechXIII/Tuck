import pytest

from tuck.cutting.bitstream import (
    BitstreamError,
    HevcConfig,
    HevcIds,
    av1_obus,
    escape,
    hevc_parameter_id,
    renumber_hevc_parameter_set,
    renumber_hevc_slice,
    unescape,
    without_temporal_delimiters,
)


def bits(data):
    return "".join(f"{byte:08b}" for byte in data)


def test_escaping_round_trips_and_protects_start_codes():
    raw = bytes([0, 0, 0, 1, 0, 0, 3, 0, 0, 2, 5, 0, 0])
    escaped = escape(raw)
    assert b"\x00\x00\x00" not in escaped and b"\x00\x00\x01" not in escaped
    assert unescape(escaped) == raw


@pytest.mark.parametrize("idr", [True, False])
def test_slice_renumbering_moves_the_slice_data_by_exactly_one_byte(idr):
    # header byte 0x28 is an IDR (type 20), 0x02 a trailing picture (type 1)
    header = bytes([0x28 if idr else 0x02, 0x01])
    flags = "11" if idr else "1"  # first slice, and no_output_of_prior_pics for IRAP
    head = flags + "1" + "0" * (8 - len(flags) - 1)  # PPS ID 0 is the single bit 1
    # slice data full of zeros, so escaping matters on both sides of the rewrite
    data = bytes([int(head, 2)]) + bytes([0, 0, 1, 0, 0, 0, 7, 9, 0x80])
    unit = header + escape(data)
    renumbered = renumber_hevc_slice(unit, 20)
    payload = bits(unescape(renumbered)[2:])
    start = len(flags)
    assert payload[start : start + 9] == "000010101"  # 20 as Exp-Golomb
    # everything after the ID is unchanged, so the byte-aligned slice data is kept as it is
    assert payload[start + 9 :] == bits(data)[start + 1 :]
    assert unescape(renumbered)[4:] == data[1:]
    with pytest.raises(BitstreamError):
        renumber_hevc_slice(unit, 3)


def pps(pps_id, sps_id):
    code = lambda v: "0" * (len(f"{v + 1:b}") - 1) + f"{v + 1:b}"  # noqa: E731
    body = code(pps_id) + code(sps_id) + "1011"
    body += "1" + "0" * (-(len(body) + 1) % 8)
    return bytes([0x44, 0x01]) + escape(int(body, 2).to_bytes(len(body) // 8, "big"))


def test_parameter_sets_are_renumbered_and_listed_beside_the_source_sets():
    vps = bytes([0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF])
    source_pps = pps(0, 0)
    header = bytes([1]) + bytes(20) + bytes([0xF3])
    config = HevcConfig.parse(
        header
        + bytes([2])
        + bytes([0xA0, 0, 1, 0, len(vps)])
        + vps
        + bytes([0xA2, 0, 1, 0, len(source_pps)])
        + source_pps
    )
    assert config.length_size == 4
    ids = HevcIds(1, 15, 16)
    edge_vps = renumber_hevc_parameter_set(vps, ids)
    edge_pps = renumber_hevc_parameter_set(source_pps, ids)
    assert hevc_parameter_id(edge_vps) == 1
    assert hevc_parameter_id(edge_pps) == 16
    merged = HevcConfig.parse(config.with_units([edge_vps, edge_pps]))
    assert merged.units(32) == (vps, edge_vps)
    assert merged.units(34) == (source_pps, edge_pps)
    # arrays keep the source's completeness flags
    assert [byte for byte, _ in merged.arrays] == [0xA0, 0xA2]
    with pytest.raises(BitstreamError):
        renumber_hevc_parameter_set(edge_pps, ids)


def test_av1_temporal_delimiters_are_removed():
    delimiter = bytes([0x12, 0x00])
    sequence = bytes([0x0A, 0x02, 0xAA, 0xBB])
    frame = bytes([0x32, 0x01, 0xCC])
    packet = delimiter + sequence + frame
    assert [kind for kind, _ in av1_obus(packet)] == [2, 1, 6]
    assert without_temporal_delimiters(packet) == sequence + frame
    with pytest.raises(BitstreamError):
        list(av1_obus(bytes([0x0A, 0x05, 0x01])))
