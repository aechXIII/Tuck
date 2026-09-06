import ctypes
import json
import os
from ctypes import wintypes

import pytest

from tuck import instance
from tuck.instance import handle_ipc_payload


@pytest.mark.skipif(os.name != "nt", reason="Win32 signatures are configured only on Windows")
def test_file_mapping_functions_use_pointer_safe_win32_signatures() -> None:
    kernel32 = ctypes.windll.kernel32

    assert kernel32.CreateFileMappingW.argtypes == [
        wintypes.HANDLE,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPCWSTR,
    ]
    assert kernel32.CreateFileMappingW.restype is wintypes.HANDLE
    assert kernel32.OpenFileMappingW.argtypes == [
        wintypes.DWORD,
        wintypes.BOOL,
        wintypes.LPCWSTR,
    ]
    assert kernel32.OpenFileMappingW.restype is wintypes.HANDLE
    assert kernel32.MapViewOfFile.argtypes == [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_size_t,
    ]
    assert kernel32.MapViewOfFile.restype is wintypes.LPVOID
    assert kernel32.UnmapViewOfFile.argtypes == [wintypes.LPVOID]
    assert kernel32.UnmapViewOfFile.restype is wintypes.BOOL
    assert kernel32.CloseHandle.argtypes == [wintypes.HANDLE]
    assert kernel32.CloseHandle.restype is wintypes.BOOL
    assert instance._kernel32 is kernel32


class TestHandleIpcPayload:
    def test_valid_payload_with_real_files(self, tmp_path):

        f1 = tmp_path / "test1.mp4"
        f1.write_text("dummy")
        f2 = tmp_path / "test2.mp4"
        f2.write_text("dummy")

        captured: list[list[str]] = []

        def on_files(paths):
            captured.append(paths)

        payload = json.dumps([str(f1), str(f2)]).encode("utf-8")
        result = handle_ipc_payload(payload, on_files=on_files)
        assert result is True
        assert len(captured) == 1
        assert len(captured[0]) == 2

    def test_invalid_utf8(self):

        result = handle_ipc_payload(b"\xff\xfe\x00\x01")
        assert result is False

    def test_not_json(self):

        result = handle_ipc_payload(b"not valid json")
        assert result is False

    def test_not_a_list(self):

        payload = json.dumps({"not": "a list"}).encode("utf-8")
        result = handle_ipc_payload(payload)
        assert result is False

    def test_empty_list(self):

        payload = json.dumps([]).encode("utf-8")
        result = handle_ipc_payload(payload)
        assert result is False

    def test_all_nonexistent_paths(self):

        payload = json.dumps(["/nonexistent/path/file.mp4"]).encode("utf-8")
        result = handle_ipc_payload(payload)
        assert result is False

    def test_mixed_valid_and_invalid(self, tmp_path):

        f1 = tmp_path / "good.mp4"
        f1.write_text("dummy")

        captured: list[list[str]] = []

        def on_files(paths):
            captured.append(paths)

        payload = json.dumps([str(f1), "/nonexistent/bad.mp4", "not_a_path_just_string"]).encode(
            "utf-8"
        )
        result = handle_ipc_payload(payload, on_files=on_files)

        assert result is True
        assert len(captured) == 1
        assert len(captured[0]) == 1

    def test_callback_not_called_when_no_handler(self, tmp_path):

        f1 = tmp_path / "test.mp4"
        f1.write_text("dummy")

        payload = json.dumps([str(f1)]).encode("utf-8")
        result = handle_ipc_payload(payload)  # No callback
        assert result is True

    def test_payload_with_non_string_items(self, tmp_path):

        f1 = tmp_path / "good.mp4"
        f1.write_text("dummy")

        captured: list[list[str]] = []

        def on_files(paths):
            captured.append(paths)

        payload = json.dumps([str(f1), 42, None, 3.14]).encode("utf-8")
        result = handle_ipc_payload(payload, on_files=on_files)
        assert result is True
        assert len(captured) == 1
        assert len(captured[0]) == 1


class TestBridgeIpcFiles:
    def test_add_ipc_files_no_duplicates(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api.add_ipc_files(["/a/b.mp4", "/c/d.mp4"])
        api.add_ipc_files(["/a/b.mp4", "/e/f.mp4"])

        assert len(api._ipc_files) == 3

    def test_get_ipc_files_clears_buffer(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        api.add_ipc_files(["/x/y.mp4", "/z/w.mp4"])
        result = api.get_ipc_files()
        assert result == ["/x/y.mp4", "/z/w.mp4"]

        assert api.get_ipc_files() == []

    def test_get_ipc_files_empty_buffer(self, tmp_path, monkeypatch):

        import tuck.settings as settings_mod

        monkeypatch.setattr(settings_mod, "_config_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_data_dir", lambda: tmp_path)
        monkeypatch.setattr(settings_mod, "_cache_dir", lambda: tmp_path)

        from tuck.bridge import BridgeAPI

        api = BridgeAPI()
        result = api.get_ipc_files()
        assert result == []
