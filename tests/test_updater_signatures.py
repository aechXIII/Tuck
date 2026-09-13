"""Exercise the release gate with real Minisign signatures and disposable keys."""

import base64
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def signed_packages(tmp_path):
    executable = os.environ.get("MINISIGN") or shutil.which("minisign")
    if not executable:
        pytest.skip("Minisign is required for signature integration tests")
    public = tmp_path / "key.pub"
    secret = tmp_path / "key.key"
    subprocess.run(
        [executable, "-G", "-W", "-p", str(public), "-s", str(secret)],
        check=True,
        capture_output=True,
    )
    config = tmp_path / "tauri.conf.json"
    config.write_text(
        json.dumps(
            {
                "version": "1.0.0",
                "plugins": {"updater": {"pubkey": base64.b64encode(public.read_bytes()).decode()}},
            }
        )
    )
    packages = [tmp_path / "Tuck-Setup-1.0.0-x64.exe", tmp_path / "Tuck-1.0.0-x86_64.AppImage"]
    for package in packages:
        package.write_bytes(b"disposable package " + package.name.encode())
        signature = package.with_suffix(package.suffix + ".minisig")
        subprocess.run(
            [executable, "-S", "-W", "-s", str(secret), "-m", str(package), "-x", str(signature)],
            check=True,
            capture_output=True,
        )
        package.with_suffix(package.suffix + ".sig").write_bytes(
            base64.b64encode(signature.read_bytes())
        )
    return executable, config, packages


def verifier():
    spec = importlib.util.spec_from_file_location(
        "verify_updater_signatures", ROOT / "scripts/verify_updater_signatures.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_matching_packages_pass(signed_packages):
    executable, config, packages = signed_packages
    verifier().verify(config, packages[0].parent, executable)


@pytest.mark.parametrize("platform", [0, 1])
def test_changed_package_blocks_release(signed_packages, platform):
    executable, config, packages = signed_packages
    packages[platform].write_bytes(b"tampered")
    with pytest.raises(subprocess.CalledProcessError):
        verifier().verify(config, packages[0].parent, executable)


def test_wrong_public_key_blocks_release(signed_packages, tmp_path):
    executable, config, packages = signed_packages
    public = tmp_path / "other.pub"
    subprocess.run(
        [executable, "-G", "-W", "-p", str(public), "-s", str(tmp_path / "other.key")],
        check=True,
        capture_output=True,
    )
    data = json.loads(config.read_text())
    data["plugins"]["updater"]["pubkey"] = base64.b64encode(public.read_bytes()).decode()
    config.write_text(json.dumps(data))
    with pytest.raises(subprocess.CalledProcessError):
        verifier().verify(config, packages[0].parent, executable)
