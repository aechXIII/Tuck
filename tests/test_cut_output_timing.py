from fractions import Fraction
from itertools import product

from tuck.cutting.output_timing import round_div, ticks_from, to_ticks
from tuck.models.cutting import MediaTime, PacketTiming, TrackPackets

TIMES = [Fraction(n, d) for n, d in product(range(-25, 26), (1, 2, 3, 7, 1001, 48000))]
BASES = [Fraction(1, 90000), Fraction(1, 1000), Fraction(1001, 30000), Fraction(1, 2), Fraction(3)]


def test_ticks_round_half_away_from_zero_like_ffmpeg():
    for time, base in product(TIMES, BASES):
        value = time / base
        rounded = int(value + (Fraction(1, 2) if value >= 0 else Fraction(-1, 2)))
        assert to_ticks(time, base) == rounded


def test_exact_halves_round_away_from_zero():
    assert [round_div(n, 2) for n in (-3, -1, 1, 3)] == [-2, -1, 1, 2]


def test_ticks_from_is_the_first_tick_at_or_after_a_time():
    for time, base in product(TIMES, BASES):
        tick = ticks_from(time, base)
        assert tick * base >= time
        assert (tick - 1) * base < time


def test_whole_times_match_the_packet_times():
    packets = (
        PacketTiming(MediaTime.from_seconds(Fraction(-1024, 48000)), MediaTime(1024, 1, 48000)),
        PacketTiming(MediaTime(0, 1, 1), MediaTime.from_seconds(Fraction(1, 30))),
        PacketTiming(MediaTime(3, 1001, 30000), MediaTime(1, 1, 90000)),
    )
    times = TrackPackets(1, "audio", "aac", packets).whole_times
    for packet, start, end, duration in zip(
        packets, times.starts, times.ends, times.durations, strict=True
    ):
        assert Fraction(start, times.denominator) == packet.start.seconds
        assert Fraction(duration, times.denominator) == packet.duration.seconds
        assert Fraction(end, times.denominator) == packet.start.seconds + packet.duration.seconds
