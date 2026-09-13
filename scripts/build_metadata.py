"""Shared release build metadata.

One source of truth for the release version, canonical artifact names, SHA-256
checksum files, the machine-readable release manifest, and changelog release
notes. The CI release workflow calls the subcommands here so the workflow YAML
never re-implements naming or hashing rules that the tests pin.

Subcommands::

    python scripts/build_metadata.py version
    python scripts/build_metadata.py artifact-name --platform windows
    python scripts/build_metadata.py checksum <file>
    python scripts/build_metadata.py entry --platform windows --kind nsis-installer \
        --path <file> --verified-package --verified-smoke --out entry.json
    python scripts/build_metadata.py manifest --channel release-candidate \
        --entry win.json --entry linux.json --git-commit <sha> --git-ref <ref> \
        --out tuck-release-manifest.json
    python scripts/build_metadata.py updater-manifest --windows-sig w.sig \
        --linux-sig l.sig --notes notes.md --out latest.json
    python scripts/build_metadata.py release-notes --changelog CHANGELOG.md --out notes.md
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PRODUCT = "Tuck"
ARCH = "x86_64"
MANIFEST_SCHEMA_VERSION = 1
MANIFEST_FILENAME = "tuck-release-manifest.json"
CHECKSUMS_FILENAME = "SHA256SUMS"
UPDATER_FEED_FILENAME = "latest.json"

CHANNELS = ("release-candidate", "release")

# Authoritative version declarations. Every one of these must carry the same
# string, or the release is blocked.
VERSION_SOURCES: dict[str, str] = {
    "tuck/__init__.py": r'^__version__ = "([^"]+)"$',
    "pyproject.toml": r'^version = "([^"]+)"$',
    "package.json": r'"version": "([^"]+)"',
    "src-tauri/Cargo.toml": r'^version = "([^"]+)"$',
    "src-tauri/tauri.conf.json": r'"version": "([^"]+)"',
}

# Immutable native-tool inputs. Their bytes are pinned by a lock file and every
# release records the lock hash so a later audit can prove nothing was swapped.
IMMUTABLE_INPUTS: tuple[str, ...] = (
    "packaging/ffmpeg-sources.lock.json",
    "packaging/ffmpeg-linux-sources.lock.json",
    "packaging/webview2-bootstrapper.lock.json",
)

# Human-readable third-party notices. They live under ``packaging/`` in the
# checkout and are copied next to the manifest (by basename) in a release.
NOTICES_DIR = "packaging"
NOTICES: dict[str, str] = {
    "windows": "THIRD_PARTY_NOTICES.md",
    "linux": "THIRD_PARTY_NOTICES_LINUX.md",
}

PLATFORMS = ("windows", "linux")


class MetadataError(RuntimeError):
    """A metadata rule was violated (version drift, unknown platform, ...)."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_version_declarations(root: Path = ROOT) -> dict[str, str]:
    """Map each authoritative file to the version string it declares."""

    found: dict[str, str] = {}
    for rel, pattern in VERSION_SOURCES.items():
        text = (root / rel).read_text(encoding="utf-8")
        match = re.search(pattern, text, re.MULTILINE)
        if match is None:
            raise MetadataError(f"no version declaration found in {rel}")
        found[rel] = match.group(1)
    return found


def project_version(root: Path = ROOT) -> str:
    """The single release version, or raise if the declarations disagree."""

    declared = collect_version_declarations(root)
    distinct = sorted(set(declared.values()))
    if len(distinct) != 1:
        drift = ", ".join(f"{rel}={ver}" for rel, ver in sorted(declared.items()))
        raise MetadataError(f"version drift across release metadata: {drift}")
    return distinct[0]


def artifact_name(platform: str, version: str) -> str:
    """Canonical downloadable filename: product, version, OS, and architecture."""

    if platform == "windows":
        return f"{PRODUCT}-Setup-{version}-x64.exe"
    if platform == "linux":
        return f"{PRODUCT}-{version}-{ARCH}.AppImage"
    raise MetadataError(f"unknown platform: {platform}")


def checksum_line(path: Path) -> str:
    """A `sha256sum`-compatible line for `path`."""

    return f"{sha256_file(path)}  {path.name}"


def write_checksum(path: Path) -> Path:
    out = path.with_name(path.name + ".sha256")
    out.write_text(checksum_line(path) + "\n", encoding="ascii")
    return out


def immutable_inputs(root: Path = ROOT) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for rel in IMMUTABLE_INPUTS:
        target = root / rel
        entries.append(
            {
                "file": rel,
                "sha256": sha256_file(target),
                "size_bytes": target.stat().st_size,
            }
        )
    return entries


UPDATER_TARGETS: dict[str, str] = {
    "windows": "windows-x86_64",
    "linux": "linux-x86_64",
}
UPDATER_BASE_URL = "https://github.com/aechXIii/Tuck/releases/download"


def artifact_entry(
    path: Path,
    platform: str,
    *,
    kind: str,
    verified_package: bool,
    verified_smoke: bool,
    signed: bool = False,
) -> dict[str, object]:
    if platform not in PLATFORMS:
        raise MetadataError(f"unknown platform: {platform}")
    return {
        "name": path.name,
        "platform": platform,
        "arch": ARCH,
        "kind": kind,
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "signed": signed,
        "verified": {"verify_package": verified_package, "smoke": verified_smoke},
    }


def signing_status(*, updater_enabled: bool) -> dict[str, str]:
    # Windows Authenticode stays unsigned for 0.5.0 (no certificate); the Tauri
    # updater signing key is the gate for a public release.
    return {
        "windows_authenticode": "unsigned",
        "tauri_updater": "enabled" if updater_enabled else "disabled",
    }


def build_manifest(
    *,
    channel: str,
    artifacts: list[dict[str, object]],
    root: Path = ROOT,
    git: dict[str, str] | None = None,
    updater_enabled: bool | None = None,
    generated_utc: str | None = None,
) -> dict[str, object]:
    if channel not in CHANNELS:
        raise MetadataError(f"unknown channel: {channel}")
    version = project_version(root)
    stamp = generated_utc or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # the updater is enabled for the release only when every artifact was signed
    if updater_enabled is None:
        updater_enabled = bool(artifacts) and all(a.get("signed") for a in artifacts)
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "product": PRODUCT,
        "version": version,
        "channel": channel,
        "generated_utc": stamp,
        "git": dict(git or {}),
        "signing": signing_status(updater_enabled=updater_enabled),
        "artifacts": list(artifacts),
        "immutable_inputs": immutable_inputs(root),
        "notices": sorted(set(NOTICES.values())),
    }


def render_release_notes(changelog_text: str, version: str) -> str:
    """Extract the `## [version]` section from a keep-a-changelog document."""

    pattern = re.compile(
        r"^## \[" + re.escape(version) + r"\].*?(?=^## \[|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(changelog_text)
    if match is None:
        raise MetadataError(f"no changelog entry found for {version}")
    return match.group(0).strip()


def build_updater_manifest(
    *,
    version: str,
    notes: str,
    signatures: dict[str, str],
    base_url: str = UPDATER_BASE_URL,
    pub_date: str | None = None,
) -> dict[str, object]:
    """The `latest.json` the Tauri updater polls.

    `signatures` maps platform (``windows``/``linux``) to the contents of that
    artifact's ``.sig`` file produced by `tauri build`.
    """

    stamp = pub_date or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tag = f"v{version}"
    platforms: dict[str, object] = {}
    for platform, target in UPDATER_TARGETS.items():
        signature = signatures.get(platform)
        if not signature:
            raise MetadataError(f"missing updater signature for {platform}")
        platforms[target] = {
            "signature": signature.strip(),
            "url": f"{base_url}/{tag}/{artifact_name(platform, version)}",
        }
    return {
        "version": version,
        "notes": notes,
        "pub_date": stamp,
        "platforms": platforms,
    }


def _load_entries(paths: list[Path]) -> list[dict[str, object]]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in paths]


def _cmd_version(_args: argparse.Namespace) -> int:
    print(project_version())
    return 0


def _cmd_artifact_name(args: argparse.Namespace) -> int:
    print(artifact_name(args.platform, project_version()))
    return 0


def _cmd_checksum(args: argparse.Namespace) -> int:
    out = write_checksum(args.path)
    print(f"{checksum_line(args.path)}  -> {out.name}")
    return 0


def _cmd_entry(args: argparse.Namespace) -> int:
    signed = False
    if args.signature is not None:
        signed = args.signature.is_file() and args.signature.stat().st_size > 0
    entry = artifact_entry(
        args.path,
        args.platform,
        kind=args.kind,
        verified_package=args.verified_package,
        verified_smoke=args.verified_smoke,
        signed=signed,
    )
    args.out.write_text(json.dumps(entry, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(entry, indent=2, sort_keys=True))
    return 0


def _cmd_manifest(args: argparse.Namespace) -> int:
    git: dict[str, str] = {}
    if args.git_commit:
        git["commit"] = args.git_commit
    if args.git_ref:
        git["ref"] = args.git_ref
    manifest = build_manifest(
        channel=args.channel,
        artifacts=_load_entries(args.entry),
        git=git,
        updater_enabled=True if args.updater_enabled else None,
    )
    args.out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


def _cmd_updater_manifest(args: argparse.Namespace) -> int:
    signatures = {
        "windows": args.windows_sig.read_text(encoding="utf-8"),
        "linux": args.linux_sig.read_text(encoding="utf-8"),
    }
    manifest = build_updater_manifest(
        version=project_version(),
        notes=args.notes.read_text(encoding="utf-8").strip(),
        signatures=signatures,
    )
    args.out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


def _cmd_release_notes(args: argparse.Namespace) -> int:
    notes = render_release_notes(args.changelog.read_text(encoding="utf-8"), project_version())
    args.out.write_text(notes + "\n", encoding="utf-8")
    print(notes)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("version").set_defaults(func=_cmd_version)

    p_name = sub.add_parser("artifact-name")
    p_name.add_argument("--platform", required=True, choices=PLATFORMS)
    p_name.set_defaults(func=_cmd_artifact_name)

    p_sum = sub.add_parser("checksum")
    p_sum.add_argument("path", type=Path)
    p_sum.set_defaults(func=_cmd_checksum)

    p_entry = sub.add_parser("entry")
    p_entry.add_argument("--platform", required=True, choices=PLATFORMS)
    p_entry.add_argument("--kind", required=True)
    p_entry.add_argument("--path", required=True, type=Path)
    p_entry.add_argument("--verified-package", action="store_true")
    p_entry.add_argument("--verified-smoke", action="store_true")
    p_entry.add_argument(
        "--signature", type=Path, help="Path to the artifact's .sig file, if signed."
    )
    p_entry.add_argument("--out", required=True, type=Path)
    p_entry.set_defaults(func=_cmd_entry)

    p_manifest = sub.add_parser("manifest")
    p_manifest.add_argument("--channel", required=True, choices=CHANNELS)
    p_manifest.add_argument("--entry", action="append", required=True, type=Path)
    p_manifest.add_argument("--git-commit", default="")
    p_manifest.add_argument("--git-ref", default="")
    p_manifest.add_argument("--updater-enabled", action="store_true")
    p_manifest.add_argument("--out", required=True, type=Path)
    p_manifest.set_defaults(func=_cmd_manifest)

    p_updater = sub.add_parser("updater-manifest")
    p_updater.add_argument("--windows-sig", required=True, type=Path)
    p_updater.add_argument("--linux-sig", required=True, type=Path)
    p_updater.add_argument("--notes", required=True, type=Path)
    p_updater.add_argument("--out", required=True, type=Path)
    p_updater.set_defaults(func=_cmd_updater_manifest)

    p_notes = sub.add_parser("release-notes")
    p_notes.add_argument("--changelog", required=True, type=Path)
    p_notes.add_argument("--out", required=True, type=Path)
    p_notes.set_defaults(func=_cmd_release_notes)

    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except MetadataError as exc:
        print(f"metadata error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
