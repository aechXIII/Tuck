"""ProbeCache concurrency.

The cache probes with an ffprobe subprocess. Holding its lock across that call
lets one slow or stuck probe wedge every other caller, which is how create_plan
stopped responding after an encode left ffprobe busy.
"""

from __future__ import annotations

import threading

from tuck.probe_cache import ProbeCache


def _touch(tmp_path, name: str) -> str:
    path = tmp_path / name
    path.write_bytes(b"data")
    return str(path)


def test_a_stuck_probe_does_not_block_another_path(tmp_path) -> None:
    release = threading.Event()
    probing_a = threading.Event()

    def probe(path: str) -> str:
        if path.endswith("a"):
            probing_a.set()
            assert release.wait(timeout=5), "probe A was never released"
        return f"info:{path}"

    cache: ProbeCache[str] = ProbeCache(probe)
    path_a = _touch(tmp_path, "a")
    path_b = _touch(tmp_path, "b")

    result_a: list[str] = []
    thread_a = threading.Thread(target=lambda: result_a.append(cache.get(path_a)))
    thread_a.start()
    assert probing_a.wait(timeout=5), "probe A never started"

    # B must return while A is still parked inside its probe
    assert cache.get(path_b) == f"info:{path_b}"

    release.set()
    thread_a.join(timeout=5)
    assert result_a == [f"info:{path_a}"]


def test_second_call_for_the_same_path_uses_the_cache(tmp_path) -> None:
    calls: list[str] = []

    def probe(path: str) -> str:
        calls.append(path)
        return "info"

    cache: ProbeCache[str] = ProbeCache(probe)
    path = _touch(tmp_path, "clip.mp4")

    assert cache.get(path) == "info"
    assert cache.get(path) == "info"
    assert calls == [path], "the second get must not re-probe an unchanged file"


def test_a_changed_file_is_reprobed(tmp_path) -> None:
    values = iter(["first", "second"])

    cache: ProbeCache[str] = ProbeCache(lambda _path: next(values))
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"a")
    assert cache.get(str(path)) == "first"

    path.write_bytes(b"a much longer body")
    assert cache.get(str(path)) == "second"
