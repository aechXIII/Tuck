import os
import shutil
import subprocess
from pathlib import Path

import pytest

WRAPPER = Path(__file__).parent.parent / "scripts" / "tuck.cmd"

pytestmark = pytest.mark.skipif(os.name != "nt", reason="tuck.cmd is the Windows CLI wrapper")


@pytest.fixture
def installed_wrapper(tmp_path: Path) -> Path:
    # cmd.exe stands in for TuckCli.exe so the test can see exactly what the wrapper passes on
    app = tmp_path / "Program Files" / "Tuck"
    app.mkdir(parents=True)
    (app / "bin").mkdir()
    shutil.copy2(WRAPPER, app / "bin" / "tuck.cmd")
    shutil.copy2(os.environ["COMSPEC"], app / "TuckCli.exe")
    shutil.copy2(os.environ["COMSPEC"], app / "Tuck.exe")
    return app / "bin" / "tuck.cmd"


def test_wrapper_runs_the_cli_in_the_parent_folder_with_every_argument(installed_wrapper, tmp_path):
    elsewhere = tmp_path / "work"
    elsewhere.mkdir()

    result = subprocess.run(
        [str(installed_wrapper), "/d", "/c", "echo", "compress", "two words.mp4"],
        capture_output=True,
        text=True,
        cwd=elsewhere,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'compress "two words.mp4"'


def test_wrapper_returns_the_cli_exit_code(installed_wrapper, tmp_path):
    result = subprocess.run(
        [str(installed_wrapper), "/d", "/c", "exit", "7"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        timeout=30,
    )

    assert result.returncode == 7


def test_bare_command_finds_the_wrapper_with_only_bin_on_path(installed_wrapper, tmp_path):
    environment = {**os.environ, "PATH": str(installed_wrapper.parent)}
    result = subprocess.run(
        [os.environ["COMSPEC"], "/d", "/c", "tuck", "/d", "/c", "echo", "two words.mp4"],
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env=environment,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == '"two words.mp4"'
