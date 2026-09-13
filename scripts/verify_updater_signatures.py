"""Block publication unless both packages verify against the app's updater key."""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import tempfile
from pathlib import Path


def verify(config: Path, artifacts: Path, minisign: str = "minisign") -> None:
    data = json.loads(config.read_text(encoding="utf-8"))
    version = data["version"]
    names = (f"Tuck-Setup-{version}-x64.exe", f"Tuck-{version}-x86_64.AppImage")
    with tempfile.TemporaryDirectory(prefix="tuck-signatures-") as temporary:
        key = Path(temporary) / "updater.pub"
        key.write_bytes(base64.b64decode(data["plugins"]["updater"]["pubkey"], validate=True))
        for name in names:
            package = artifacts / name
            encoded = package.with_name(name + ".sig").read_text(encoding="utf-8").strip()
            signature = Path(temporary) / "package.minisig"
            # Tauri wraps the standard Minisign text in one more base64 layer
            signature.write_bytes(base64.b64decode(encoded, validate=True))
            subprocess.run(
                [minisign, "-V", "-m", str(package), "-p", str(key), "-x", str(signature)],
                check=True,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("src-tauri/tauri.conf.json"))
    parser.add_argument("--minisign", default="minisign")
    args = parser.parse_args()
    verify(args.config, args.artifacts_dir, args.minisign)


if __name__ == "__main__":
    main()
