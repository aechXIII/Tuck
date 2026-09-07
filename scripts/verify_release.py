"""Validate a built release manifest against the files on disk.

This is the last gate before a release is published. It never trusts the
manifest's own claims: every artifact is re-hashed, every immutable input is
compared against the checked-in lock, and a public release is refused unless the
Tauri updater signing key was configured for the run.

    python scripts/verify_release.py --manifest tuck-release-manifest.json
    python scripts/verify_release.py --manifest <path> --artifacts-dir dist --require-signed

Exit code is non-zero on any failure.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent


def _load_build_metadata():
    spec = importlib.util.spec_from_file_location(
        "tuck_build_metadata", _HERE / "build_metadata.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bm = _load_build_metadata()


class VerifyError(RuntimeError):
    pass


def _require(condition: object, message: str) -> None:
    if not condition:
        raise VerifyError(message)


def _check_version(manifest: dict, root: Path) -> str:
    version = manifest.get("version")
    _require(isinstance(version, str) and version, "manifest has no version")
    try:
        checkout = bm.project_version(root)
    except bm.MetadataError as exc:
        raise VerifyError(str(exc)) from exc
    _require(
        version == checkout,
        f"manifest version {version} does not match the checkout ({checkout})",
    )
    return version


def _check_artifacts(manifest: dict, version: str, artifacts_dir: Path) -> None:
    artifacts = manifest.get("artifacts")
    _require(isinstance(artifacts, list) and artifacts, "manifest lists no artifacts")

    seen: dict[str, dict] = {}
    for artifact in artifacts:
        _require(isinstance(artifact, dict), "artifact entry is not an object")
        platform = artifact.get("platform")
        _require(platform in bm.PLATFORMS, f"artifact has an unknown platform: {platform!r}")
        _require(platform not in seen, f"more than one {platform} artifact in the manifest")
        seen[platform] = artifact

    missing = sorted(set(bm.PLATFORMS) - set(seen))
    _require(not missing, f"manifest is missing artifacts for: {', '.join(missing)}")
    extra = sorted(set(seen) - set(bm.PLATFORMS))
    _require(not extra, f"manifest has unexpected artifacts for: {', '.join(extra)}")

    for platform, artifact in seen.items():
        expected_name = bm.artifact_name(platform, version)
        name = artifact.get("name")
        _require(
            name == expected_name,
            f"{platform} artifact is named {name!r}, expected {expected_name!r}",
        )
        _require(
            artifact.get("arch") == bm.ARCH, f"{name}: unexpected arch {artifact.get('arch')!r}"
        )

        binary = artifacts_dir / str(name)
        _require(binary.is_file(), f"artifact file is missing: {binary}")

        size = binary.stat().st_size
        _require(
            artifact.get("size_bytes") == size,
            f"{name}: manifest size {artifact.get('size_bytes')} != {size} on disk",
        )
        digest = bm.sha256_file(binary)
        _require(
            artifact.get("sha256") == digest,
            f"{name}: manifest sha256 does not match the file on disk",
        )

        checksum = binary.with_name(binary.name + ".sha256")
        _require(checksum.is_file(), f"missing checksum file: {checksum.name}")
        _require(
            checksum.read_text(encoding="ascii").strip() == bm.checksum_line(binary),
            f"{checksum.name}: does not match {name}",
        )

        verified = artifact.get("verified")
        _require(isinstance(verified, dict), f"{name}: no verification record")
        _require(
            verified.get("verify_package") is True,
            f"{name}: package inspection did not pass before upload",
        )
        _require(
            verified.get("smoke") is True,
            f"{name}: startup smoke did not pass before upload",
        )


def _check_immutable_inputs(manifest: dict, root: Path) -> None:
    recorded = manifest.get("immutable_inputs")
    _require(isinstance(recorded, list) and recorded, "manifest records no immutable inputs")

    by_file = {entry.get("file"): entry for entry in recorded if isinstance(entry, dict)}
    for rel in bm.IMMUTABLE_INPUTS:
        entry = by_file.get(rel)
        _require(entry is not None, f"manifest does not pin {rel}")
        target = root / rel
        _require(target.is_file(), f"immutable input is missing from the checkout: {rel}")
        _require(
            entry.get("sha256") == bm.sha256_file(target),
            f"{rel}: manifest hash does not match the checked-in lock",
        )
        _require(
            entry.get("size_bytes") == target.stat().st_size,
            f"{rel}: manifest size does not match the checked-in lock",
        )


def _check_notices(manifest: dict, root: Path) -> None:
    listed = manifest.get("notices")
    _require(isinstance(listed, list) and listed, "manifest lists no third-party notices")
    for rel in bm.NOTICES.values():
        _require(rel in listed, f"manifest does not list {rel}")
        target = root / bm.NOTICES_DIR / rel
        _require(
            target.is_file() and target.stat().st_size > 0,
            f"third-party notices file is missing or empty: {bm.NOTICES_DIR}/{rel}",
        )


def _check_signing(manifest: dict, *, require_signed: bool) -> None:
    signing = manifest.get("signing")
    _require(isinstance(signing, dict), "manifest has no signing record")
    _require(
        "windows_authenticode" in signing and "tauri_updater" in signing,
        "signing record is incomplete",
    )
    if not require_signed:
        return
    _require(
        manifest.get("channel") == "release",
        "a signed release must use the 'release' channel, not a candidate",
    )
    _require(
        signing.get("tauri_updater") == "enabled",
        "public release blocked: the Tauri updater signing key was not configured for this run. "
        "Generate a keypair with `npm run tauri signer generate`, then set the "
        "TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD secrets on the "
        "protected tag environment and re-run the tagged release. CI builds unsigned "
        "candidate artifacts without it, but will not publish an unsigned production release.",
    )


def verify_release(
    manifest_path: Path,
    *,
    artifacts_dir: Path | None = None,
    root: Path = _ROOT,
    require_signed: bool = False,
) -> dict:
    _require(manifest_path.is_file(), f"manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    _require(
        manifest.get("schema_version") == bm.MANIFEST_SCHEMA_VERSION,
        f"unsupported manifest schema_version: {manifest.get('schema_version')!r}",
    )
    _require(manifest.get("product") == bm.PRODUCT, "manifest is not a Tuck release manifest")
    _require(
        manifest.get("channel") in bm.CHANNELS,
        f"unknown release channel: {manifest.get('channel')!r}",
    )

    version = _check_version(manifest, root)
    _check_artifacts(manifest, version, artifacts_dir or manifest_path.parent)
    _check_immutable_inputs(manifest, root)
    _check_notices(manifest, root)
    _check_signing(manifest, require_signed=require_signed)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        help="Directory holding the built artifacts (default: the manifest's directory).",
    )
    parser.add_argument(
        "--require-signed",
        action="store_true",
        help="Fail unless this is a signed public release.",
    )
    args = parser.parse_args(argv)

    try:
        manifest = verify_release(
            args.manifest,
            artifacts_dir=args.artifacts_dir,
            require_signed=args.require_signed,
        )
    except (VerifyError, json.JSONDecodeError) as exc:
        print(f"VERIFY FAILED: {exc}", file=sys.stderr)
        return 1

    names = ", ".join(sorted(a["name"] for a in manifest["artifacts"]))
    print(
        f"RELEASE OK  {manifest['product']} {manifest['version']} ({manifest['channel']}): {names}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
