"""Run the Linux installer with local release downloads and an isolated home."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux installer behavior")
ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("tampered", [False, True])
def test_install_from_formatted_release_feed(tmp_path, tampered):
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    name = "Tuck-0.5.0-x86_64.AppImage"
    contents = b"test AppImage"
    (downloads / name).write_bytes(b"modified" if tampered else contents)
    (downloads / "SHA256SUMS").write_text(f"{hashlib.sha256(contents).hexdigest()}  {name}\n")
    (downloads / "latest.json").write_text(
        json.dumps(
            {
                "version": "0.5.0",
                "platforms": {
                    "linux-x86_64": {
                        "signature": "test",
                        "url": f"https://github.com/aechXIII/Tuck/releases/download/v0.5.0/{name}",
                    }
                },
            },
            indent=2,
        )
    )
    (downloads / "128x128.png").write_bytes(b"test icon")
    binaries = tmp_path / "bin"
    binaries.mkdir()
    curl = binaries / "curl"
    curl.write_text(
        f"#!{sys.executable}\nimport os, shutil, sys\nfrom pathlib import Path\n"
        "url = next(arg for arg in sys.argv if arg.startswith('https://'))\n"
        "output = sys.argv[sys.argv.index('-o') + 1]\n"
        "shutil.copyfile(Path(os.environ['TEST_DOWNLOADS']) / url.rsplit('/', 1)[1], output)\n"
    )
    curl.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir()
    env = dict(
        os.environ,
        HOME=str(home),
        XDG_DATA_HOME=str(home / ".local/share"),
        PATH=f"{binaries}:{os.environ['PATH']}",
        TEST_DOWNLOADS=str(downloads),
    )
    result = subprocess.run(
        ["sh", str(ROOT / "scripts/install-linux.sh")], env=env, capture_output=True, text=True
    )
    app = home / ".local/share/tuck/Tuck.AppImage"
    if tampered:
        assert result.returncode != 0
        assert not app.exists()
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        assert app.read_bytes() == contents
        assert (home / ".local/bin/tuck").is_file()

        app.write_text('#!/bin/sh\necho "runtime error" >&2\nexit 7\n')
        launched = subprocess.run(
            [str(home / ".local/bin/tuck")], env=env, capture_output=True, text=True
        )
        assert launched.returncode == 7
        assert "runtime error" in launched.stderr
