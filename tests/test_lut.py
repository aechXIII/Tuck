from pathlib import Path

import numpy as np
import pytest

from tuck.lut import identity_table, import_lut, parse_cube, snapshot_lut, store_table
from tuck.models import EncodePlan, Profile, VideoInfo
from tuck.models.lut import LutSettings


@pytest.fixture
def storage(tmp_path, monkeypatch):
    from tuck.settings import configure_storage_root, get_settings_manager

    monkeypatch.setattr("tuck.settings._settings_manager", None)
    monkeypatch.setattr("tuck.settings._storage_root", None)
    configure_storage_root(tmp_path)
    yield get_settings_manager().data_dir / "luts"
    monkeypatch.setattr("tuck.settings._settings_manager", None)
    configure_storage_root(None)


@pytest.mark.parametrize(
    "raw",
    [
        {"enabled": 1},
        {"strength": True},
        {"strength": -0.1},
        {"strength": 1.01},
        {"strength": float("nan")},
        {"strength": float("inf")},
        {"path": 4},
        {"name": []},
        {"extra": 1},
        {"enabled": True},
        None,
    ],
)
def test_invalid_settings(raw):
    with pytest.raises(ValueError):
        LutSettings.from_dict(raw)


def test_roundtrips_and_disabled_defaults():
    settings = LutSettings(enabled=True, path="managed.cube", name="Film", strength=0.4)
    profile = Profile(name="Test", lut=settings)
    assert Profile.from_dict(profile.to_dict()).lut == settings
    old = Profile(name="Old").to_dict()
    old.pop("lut")
    assert not Profile.from_dict(old).lut.enabled
    plan = EncodePlan(source="in", output="out", lut=settings, lut_filter_path="snapshot.cube")
    assert EncodePlan.from_dict(plan.to_dict()).lut == settings
    assert EncodePlan.from_dict(plan.to_dict()).lut_filter_path == "snapshot.cube"
    assert not EncodePlan.from_dict({"source": "in", "output": "out"}).lut.enabled


def test_cube_roundtrip_and_binary_layout(tmp_path):
    table = identity_table(3)
    path, binary, size = store_table(table, tmp_path)
    assert size == 3
    np.testing.assert_array_equal(parse_cube(path), table)
    np.testing.assert_array_equal(
        np.frombuffer(binary.read_bytes(), dtype="<f4").reshape(-1, 3), table
    )
    np.testing.assert_array_equal(table[:3], [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]])


def test_domains_normalize_and_clamp(tmp_path):
    source = tmp_path / "domain.cube"
    source.write_text("LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n-1 -1 -1\n3 3 3\n")
    table = parse_cube(source)
    np.testing.assert_array_equal(table[0], [0, 0, 0])
    np.testing.assert_array_equal(table[-1], [1, 1, 1])
    np.testing.assert_array_equal(table[32], [0, 0, 0])


@pytest.mark.parametrize(
    "text",
    [
        "hello",
        "LUT_3D_SIZE 66",
        "LUT_3D_SIZE 2\n0 0 0",
        "LUT_1D_SIZE 2\n0 0 0\nnan 1 1",
        "LUT_1D_SIZE 2\nDOMAIN_MAX 0 1 1\n0 0 0\n1 1 1",
        "LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n",
    ],
)
def test_malformed_tables(tmp_path, text):
    path = tmp_path / "bad.lut"
    path.write_text(text)
    with pytest.raises(ValueError):
        parse_cube(path)


def test_renamed_cube_and_import_snapshot(tmp_path, storage):
    path = tmp_path / "Film.lut"
    path.write_text('TITLE "Film"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0\n')
    imported = import_lut(path, storage)
    assert imported.name == "Film"
    settings = LutSettings(enabled=True, path=str(imported.path), strength=0.5)
    snapshot = Path(
        snapshot_lut(
            settings,
            VideoInfo(path="source", duration=1, width=2, height=2, fps=30, video_codec="h264"),
        )
    )
    path.write_text("broken")
    np.testing.assert_allclose(parse_cube(snapshot), 0.5, atol=1e-7)
    assert snapshot_lut(
        settings,
        VideoInfo(path="source", duration=1, width=2, height=2, fps=30, video_codec="h264"),
    ) == str(snapshot)
    imported.path.write_text("changed")
    with pytest.raises(ValueError, match="changed"):
        snapshot_lut(
            settings,
            VideoInfo(path="source", duration=1, width=2, height=2, fps=30, video_codec="h264"),
        )


@pytest.mark.parametrize(
    "metadata",
    [
        {"color_transfer": "smpte2084"},
        {"color_transfer": "arib-std-b67"},
        {"color_primaries": "bt2020"},
        {"color_space": "bt2020nc"},
        {"color_transfer": "linear"},
    ],
)
def test_hdr_rejected_before_lut_read(metadata):
    with pytest.raises(ValueError, match="SDR"):
        snapshot_lut(
            LutSettings(enabled=True, path="not-read"),
            VideoInfo(
                path="source", duration=1, width=2, height=2, fps=30, video_codec="h264", **metadata
            ),
        )


def test_request_plan_and_filter(tmp_path, storage):
    from tuck.bridge_serialization import plan_preview_dict
    from tuck.bridge_validation import parse_plan_request
    from tuck.encoding.filters import build_plan_video_filters
    from tuck.planner import plan

    path, _, _ = store_table(1 - identity_table(2), storage)
    raw = {"enabled": True, "strength": 0.25, "path": str(path), "name": "Invert"}
    request = parse_plan_request({"source": "source.mp4", "lut": raw}, str)
    info = VideoInfo(
        path="source.mp4",
        width=64,
        height=64,
        fps=30,
        duration=2,
        video_codec="h264",
        bitrate=1000000,
    )
    profile = Profile(name="Test")
    result = plan("source.mp4", profile, request=request, source_info=info)
    assert result.lut.to_dict() == raw
    assert plan_preview_dict(result)["lut"] == raw
    filters = build_plan_video_filters(result)
    assert filters[-1].startswith("lut3d=")
    assert filters[-1].endswith("interp=trilinear")
    np.testing.assert_allclose(
        parse_cube(Path(result.lut_filter_path)), identity_table(2) * 0.5 + 0.25
    )


@pytest.mark.ffmpeg
@pytest.mark.parametrize(
    "strength, expected", [(0, (32, 96, 192)), (0.5, (128, 128, 128)), (1, (223, 159, 63))]
)
def test_ffmpeg_strength(tmp_path, storage, strength, expected):
    import subprocess

    from tuck.encoding.filters import build_plan_video_filters
    from tuck.media_tools import find_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg unavailable")
    path, _, _ = store_table(1 - identity_table(2), storage)
    settings = LutSettings(enabled=True, strength=strength, path=str(path))
    info = VideoInfo(path="raw", duration=1, width=2, height=2, fps=30, video_codec="rawvideo")
    plan = EncodePlan(
        source="raw",
        output="out",
        source_info=info,
        lut=settings,
        lut_filter_path=snapshot_lut(settings, info),
    )
    filters = build_plan_video_filters(plan)
    args = [
        ffmpeg,
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        "2x2",
        "-i",
        "pipe:0",
    ]
    if filters:
        args += ["-vf", ",".join(filters)]
    args += ["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    result = subprocess.run(args, input=bytes((32, 96, 192)) * 4, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode()
    np.testing.assert_allclose(
        np.frombuffer(result.stdout, dtype=np.uint8).reshape(-1, 3), [expected] * 4, atol=1
    )


@pytest.mark.parametrize("channels", [1, 3])
def test_discreet_lut(tmp_path, channels):
    source = tmp_path / "discreet.lut"
    values = (
        list(range(256))
        if channels == 1
        else list(range(256)) + list(reversed(range(256))) + [128] * 256
    )
    source.write_text(f"LUT: {channels} 256\n" + "\n".join(map(str, values)))
    table = parse_cube(source)
    if channels == 1:
        np.testing.assert_allclose(table, identity_table(65), atol=1e-7)
    else:
        np.testing.assert_allclose(table[0], [0, 1, 128 / 255], atol=1e-7)
        np.testing.assert_allclose(table[-1], [1, 0, 128 / 255], atol=1e-7)


def test_bridge_import_binary_cors_and_token_release(tmp_path, storage):
    import urllib.error
    import urllib.request

    from tuck.bridge import BridgeAPI
    from tuck.media_server import MediaServer
    from tuck.settings import get_settings_manager
    from tuck.sidecar.handlers import dispatch
    from tuck.sidecar.protocol import Request

    source, _, _ = store_table(identity_table(3), tmp_path)
    server = MediaServer()
    server.start()
    api = BridgeAPI.__new__(BridgeAPI)
    api._settings = get_settings_manager()
    api._media_server = server
    try:
        response = dispatch(api, Request("lut", "load_lut", {"path": str(source)}))
        assert response.ok
        result = response.result
        assert set(result) == {"path", "name", "size", "table_url", "token"}
        with urllib.request.urlopen(result["table_url"], timeout=5) as binary:
            assert binary.headers["Access-Control-Allow-Origin"] == "*"
            assert len(binary.read()) == 3**3 * 3 * 4
        request = urllib.request.Request(result["table_url"], headers={"Range": "bytes=0-11"})
        with urllib.request.urlopen(request, timeout=5) as binary:
            assert binary.status == 206
            assert binary.headers["Access-Control-Allow-Origin"] == "*"
            assert len(binary.read()) == 12
        api.release_media_token(result["token"])
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(result["table_url"], timeout=5)
        assert error.value.code == 403
        assert not dispatch(api, Request("bad", "load_lut", {"path": 5})).ok
        assert not api.load_lut(str(tmp_path / "missing.cube"))["ok"]
    finally:
        server.stop()


@pytest.mark.ffmpeg
@pytest.mark.parametrize("two_pass", [False, True])
def test_lut_after_blending_full_export(tmp_path, storage, two_pass):
    import subprocess

    import av

    from tuck.encoding.runner import FFmpegEngine
    from tuck.media_tools import find_ffmpeg
    from tuck.models import PlanRequest, Segment
    from tuck.models.frame_blending import FrameBlending
    from tuck.planner import plan
    from tuck.probe import probe

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg unavailable")
    source = tmp_path / "source.mkv"
    pixels = np.full((8, 16, 16, 3), (32, 96, 192), dtype=np.uint8)
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            "16x16",
            "-framerate",
            "8",
            "-i",
            "pipe:0",
            "-c:v",
            "libx264rgb",
            "-crf",
            "0",
            "-preset",
            "ultrafast",
            str(source),
        ],
        input=pixels.tobytes(),
        capture_output=True,
        check=True,
        timeout=30,
    )
    path, _, _ = store_table(1 - identity_table(2), storage)
    lut = LutSettings(enabled=True, path=str(path), strength=0.75)
    profile = Profile(name="Test", video_encoder="libx264", two_pass=two_pass, preset="ultrafast")
    request = PlanRequest(
        source=str(source),
        lut=lut,
        frame_blending=FrameBlending(enabled=True),
        fps_mode="custom",
        custom_fps=4,
        segments=[Segment(0, 1)],
    )
    result = plan(source, profile, source_info=probe(source), request=request)
    output = FFmpegEngine().encode(result)
    with av.open(str(output)) as container:
        frames = list(container.decode(video=0))
    assert len(frames) == 4
    np.testing.assert_allclose(
        frames[0].to_ndarray(format="rgb24").mean(axis=(0, 1)), [175, 143, 95], atol=5
    )
    assert not list(tmp_path.glob(".tuck-*"))


@pytest.mark.ffmpeg
def test_ffmpeg_lut_path_escaping(tmp_path):
    import subprocess

    from tuck.encoding.filters import build_plan_video_filters
    from tuck.media_tools import find_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("FFmpeg unavailable")
    directory = tmp_path / "user's,[LUT]; folder"
    path, _, _ = store_table(identity_table(2), directory)
    plan = EncodePlan(
        source="raw",
        output="out",
        lut=LutSettings(enabled=True, path=str(path)),
        lut_filter_path=str(path),
        target_width=2,
        target_height=2,
    )
    args = [
        ffmpeg,
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        "2x2",
        "-i",
        "pipe:0",
        "-vf",
        ",".join(build_plan_video_filters(plan)),
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    result = subprocess.run(args, input=bytes((32, 96, 192)) * 4, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode()
    assert result.stdout == bytes((32, 96, 192)) * 4


def test_large_import_rejected(tmp_path):
    from tuck.lut import MAX_IMPORT_BYTES

    path = tmp_path / "large.cube"
    with path.open("wb") as source:
        source.truncate(MAX_IMPORT_BYTES + 1)
    with pytest.raises(ValueError, match="16 MiB"):
        parse_cube(path)


def test_profile_lut_survives_disk_reload_and_partial_edit(storage):
    from tuck.bridge import BridgeAPI
    from tuck.settings import SettingsManager

    api = BridgeAPI()
    api._settings.load()
    api._settings.set_profiles([Profile(name="LUT", profile_id="lut-test")])
    payload = {
        "enabled": True,
        "path": str(storage / "managed.cube"),
        "name": "Film",
        "strength": 0.37,
    }
    assert api.update_profile("lut-test", {"lut": payload})["ok"]
    assert api.update_profile("lut-test", {"name": "Renamed"})["ok"]
    reloaded = next(
        profile for profile in SettingsManager().get_profiles() if profile.profile_id == "lut-test"
    )
    assert reloaded.name == "Renamed"
    assert reloaded.lut.to_dict() == payload
    assert not api.update_profile("lut-test", {"lut": {"strength": float("inf")}})["ok"]
    assert (
        next(
            profile
            for profile in SettingsManager().get_profiles()
            if profile.profile_id == "lut-test"
        ).lut.to_dict()
        == payload
    )


def test_remembered_library_deduplicates_and_preserves_names(tmp_path, storage):
    from tuck.lut import list_luts

    first = tmp_path / "Film.cube"
    cube, _, _ = store_table(identity_table(2), tmp_path / "inputs")
    first.write_bytes(cube.read_bytes())
    imported = import_lut(first, storage)
    renamed = tmp_path / "Other name.cube"
    renamed.write_bytes(first.read_bytes())
    assert import_lut(renamed, storage).name == "Film"
    assert import_lut(imported.path, storage).name == "Film"
    first.write_bytes(store_table(1 - identity_table(2), tmp_path / "inputs")[0].read_bytes())
    second = import_lut(first, storage)
    assert second.path != imported.path
    assert list_luts(storage) == sorted(
        [{"path": str(imported.path), "name": "Film"}, {"path": str(second.path), "name": "Film"}],
        key=lambda item: item["path"],
    )
    snapshot_lut(
        LutSettings(enabled=True, path=str(imported.path), strength=0.3),
        VideoInfo(path="s", duration=1, width=2, height=2, fps=30, video_codec="h264"),
    )
    assert len(list_luts(storage)) == 2
    imported.path.write_text("changed")
    assert list_luts(storage) == [{"path": str(second.path), "name": "Film"}]
    assert imported.path.exists()


def test_library_recovers_profile_names_and_survives_new_manager(tmp_path, storage):
    from tuck.bridge import BridgeAPI
    from tuck.lut import list_luts
    from tuck.settings import SettingsManager
    from tuck.sidecar.handlers import dispatch
    from tuck.sidecar.protocol import Request

    cube, _, _ = store_table(identity_table(2), storage)
    settings = LutSettings(path=str(cube), name="Older import")
    assert list_luts(storage, [settings]) == [{"path": str(cube), "name": "Older import"}]
    assert import_lut(cube, storage).name == "Older import"
    api = BridgeAPI.__new__(BridgeAPI)
    api._settings = SettingsManager()
    response = dispatch(api, Request("library", "list_luts", {}))
    assert response.ok
    assert response.result == {"luts": [{"path": str(cube), "name": "Older import"}]}
    assert not dispatch(api, Request("bad", "list_luts", {"extra": True})).ok


def test_library_concurrent_imports_and_corruption(tmp_path, storage):
    from concurrent.futures import ThreadPoolExecutor

    from tuck.lut import list_luts

    sources = []
    for index in range(6):
        cube, _, _ = store_table(identity_table(2) * (index + 1) / 6, tmp_path / str(index))
        source = cube.with_name(f"Film {index}.cube")
        source.write_bytes(cube.read_bytes())
        sources.append(source)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda path: import_lut(path, storage), sources))
    assert len(list_luts(storage)) == 6
    manifest = storage / "library.json"
    manifest.write_text("broken")
    with pytest.raises(ValueError, match="could not be read"):
        list_luts(storage)
    with pytest.raises(ValueError, match="could not be read"):
        import_lut(sources[0], storage)
    assert manifest.read_text() == "broken"


def test_plan_error_field_survives_dispatch(tmp_path, storage, monkeypatch):
    from tuck.bridge import BridgeAPI
    from tuck.sidecar.handlers import dispatch
    from tuck.sidecar.protocol import Request

    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    api = BridgeAPI()
    info = VideoInfo(
        path=str(source),
        duration=1,
        width=2,
        height=2,
        fps=480,
        video_codec="h264",
        pixel_format="yuv420p",
    )
    monkeypatch.setattr(api, "_probe_once", lambda path: info)
    for settings, expected_field in [
        ({"frame_blending": {"enabled": True}}, "frame_blending"),
        ({"lut": {"enabled": True, "path": "missing.cube"}}, "lut"),
        ({"lut": {"strength": -1}}, "lut"),
        ({"frame_blending": {"amount": -1}}, "frame_blending"),
    ]:
        raw = {"source": str(source), "fps_mode": "source", **settings}
        response = dispatch(api, Request("plan", "create_plan", {"request": raw}))
        assert not response.ok
        assert response.error.details["field"] == expected_field
        if settings == {"frame_blending": {"enabled": True}}:
            assert (
                response.error.message
                == "Frame blending supports up to 240 FPS. Choose a lower output frame rate."
            )


def test_managed_load_recovers_selected_profile_without_scanning_library(storage, monkeypatch):
    from tuck.bridge import BridgeAPI
    from tuck.lut import list_luts

    cube, _, _ = store_table(identity_table(2), storage)
    api = BridgeAPI()
    api._settings.load()
    api._settings.set_profiles(
        [Profile(name="Profile", lut=LutSettings(path=str(cube), name="Remembered"))]
    )
    with monkeypatch.context() as context:

        def unexpected_scan(path, directory):
            raise AssertionError("Selecting a LUT must not scan library assets")

        context.setattr("tuck.lut._valid_library_asset", unexpected_scan)
        result = api.load_lut(str(cube))
    assert result["ok"]
    assert result["name"] == "Remembered"
    api.release_media_token(result["token"])
    assert list_luts(storage) == [{"path": str(cube), "name": "Remembered"}]


@pytest.mark.parametrize("size", [16, 32, 48])
def test_canonical_lut_reloads_preserve_exact_nodes_and_paths(tmp_path, storage, size):
    from tuck.lut import list_luts

    values = np.random.default_rng(7).random((size**3, 3), dtype=np.float32)
    cube, binary, _ = store_table(values, tmp_path)
    np.testing.assert_array_equal(parse_cube(cube), values)
    imported = import_lut(cube, storage)
    original_path = imported.path
    original_binary = imported.table_path.read_bytes()
    for _ in range(3):
        imported = import_lut(imported.path, storage)
        assert imported.path == original_path
        assert imported.table_path.read_bytes() == original_binary
    assert imported.table_path.read_bytes() == binary.read_bytes()
    assert len(list_luts(storage)) == 1


@pytest.mark.parametrize("size", [16, 32, 48])
def test_domain_normalization_is_stable_after_first_import(tmp_path, storage, size):
    values = np.random.default_rng(7).random((size**3, 3), dtype=np.float32)
    cube, _, _ = store_table(values, tmp_path)
    source = tmp_path / "Non-unit domain.cube"
    source.write_bytes(b"DOMAIN_MIN -0.25 0 0.1\nDOMAIN_MAX 1.5 1.25 0.9\n" + cube.read_bytes())
    imported = import_lut(source, storage)
    table = parse_cube(imported.path)
    expected = np.frombuffer(imported.table_path.read_bytes(), dtype="<f4").reshape(-1, 3)
    np.testing.assert_array_equal(table, expected)
    reloaded = import_lut(imported.path, storage)
    assert reloaded.path == imported.path
    assert reloaded.table_path == imported.table_path


def test_managed_lut_modified_under_hash_is_rejected(storage):
    cube, _, _ = store_table(identity_table(2), storage)
    cube.write_text("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n")
    with pytest.raises(ValueError, match="changed"):
        import_lut(cube, storage)


@pytest.fixture
def legacy_chain(storage):
    import json

    # The old float32 coordinate grid moves node 2 by exactly 2**-24 at size 4.
    paths = []
    for drift in (0, 2**-24, 2**-23):
        values = np.zeros((4, 4, 4, 3), dtype=np.float32)
        values[:, :, 1] = 1
        values[:, :, 2] = drift
        values[:, :, 3] = 1
        paths.append(store_table(values.reshape(-1, 3), storage)[0])
    unrelated = store_table(identity_table(4), storage)[0]
    entries = {
        paths[0].stem: "Original",
        paths[1].stem: paths[0].stem,
        paths[2].stem: paths[1].stem,
        unrelated.stem: "Original",
    }
    (storage / "library.json").write_text(json.dumps(entries))
    return paths, unrelated


def test_exact_legacy_chain_migration_preserves_assets_and_profiles(storage, legacy_chain):
    import json

    from tuck.lut import list_luts

    paths, unrelated = legacy_chain
    before = {path: path.read_bytes() for path in [*paths, unrelated]}
    items = list_luts(storage)
    assert {item["path"] for item in items} == {str(paths[0]), str(unrelated)}
    metadata = json.loads((storage / "library.json").read_text())
    assert metadata["version"] == 2
    assert metadata["migration_pending"] == []
    assert metadata["aliases"] == {paths[1].stem: paths[0].stem, paths[2].stem: paths[0].stem}
    profile = LutSettings(enabled=True, path=str(paths[2]), name="Old profile")
    assert len(list_luts(storage, [profile])) == 2
    assert import_lut(paths[2], storage, saved_name=profile.name).path == paths[0]
    info = VideoInfo(path="s", duration=1, width=2, height=2, fps=30, video_codec="h264")
    assert snapshot_lut(profile, info) == str(paths[0])
    assert profile.path == str(paths[2])
    assert all(path.read_bytes() == data for path, data in before.items())


def test_clear_history_preserves_aliases_and_disables_backfill(storage, legacy_chain):
    from tuck.bridge import BridgeAPI
    from tuck.lut import list_luts
    from tuck.sidecar.handlers import dispatch
    from tuck.sidecar.protocol import Request

    paths, unrelated = legacy_chain
    list_luts(storage)
    api = BridgeAPI()
    response = dispatch(api, Request("clear", "clear_lut_history", {}))
    assert response.ok and response.result == {"cleared": True}
    profile = LutSettings(enabled=True, path=str(paths[-1]), name="Old profile")
    assert list_luts(storage, [profile]) == []
    assert import_lut(paths[-1], storage, saved_name=profile.name).path == paths[0]
    assert list_luts(storage, [profile]) == []
    assert all(path.exists() for path in [*paths, unrelated])
    assert not dispatch(api, Request("bad", "clear_lut_history", {"extra": True})).ok


def test_legacy_migration_has_persistent_work_bound(storage):
    import json

    from tuck.lut import list_luts

    entries = {f"{number:064x}": f"Missing {number}" for number in range(130)}
    manifest = storage / "library.json"
    storage.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(entries))
    assert list_luts(storage) == []
    metadata = json.loads(manifest.read_text())
    assert len(metadata["migration_pending"]) == 2
    assert list_luts(storage) == []
    assert json.loads(manifest.read_text())["migration_pending"] == []


def test_explicit_import_after_clear_can_readd_aliased_content(tmp_path, storage, legacy_chain):
    from tuck.lut import clear_lut_history, list_luts

    paths, _ = legacy_chain
    list_luts(storage)
    clear_lut_history(storage)
    source = tmp_path / "Imported again.cube"
    source.write_bytes(paths[-1].read_bytes())
    imported = import_lut(source, storage)
    assert imported.path == paths[0]
    assert list_luts(storage) == [{"path": str(paths[0]), "name": "Imported again"}]


def test_unrepresentable_lut_domain_is_rejected(tmp_path):
    source = tmp_path / "Extreme domain.cube"
    source.write_text(
        "LUT_1D_SIZE 2\nDOMAIN_MIN -1e308 -1e308 -1e308\n"
        "DOMAIN_MAX 1e308 1e308 1e308\n0 0 0\n1 1 1\n"
    )
    with pytest.raises(ValueError, match="domain"):
        parse_cube(source)
