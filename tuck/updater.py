from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from packaging.version import Version

from . import __version__

logger = logging.getLogger(__name__)

GITHUB_API_RELEASES = "https://api.github.com/repos/{owner}/{repo}/releases"
GITHUB_REPO_OWNER = "aechXIII"
GITHUB_REPO_NAME = "Tuck"
REQUEST_TIMEOUT = 15
DOWNLOAD_TIMEOUT = 300

_SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")


class UpdateInfo:
    def __init__(
        self,
        version: Version,
        notes: str,
        download_url: str,
        file_size: int = 0,
        checksum: str = "",
    ) -> None:
        self.version = version
        self.notes = notes
        self.download_url = download_url
        self.file_size = file_size
        self.checksum = checksum


class UpdateChecker:
    def __init__(self, url: str, expected_sha256: str) -> None:
        if not _SHA256_RE.match(expected_sha256.lower()):
            raise ValueError(
                f"expected_sha256 must be a 64-hex SHA-256, got: {expected_sha256[:20]}..."
            )
        self._url = url
        self._expected_sha256 = expected_sha256.lower()
        self._downloaded_path: Path | None = None
        self._total_size: int = 0
        self._downloaded_size: int = 0
        self._error: str = ""
        self._done: bool = False
        self._cancelled: bool = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:

        self._thread = threading.Thread(target=self._download, daemon=True)
        self._thread.start()

    def get_progress(self) -> dict:

        if self._error:
            return {"downloading": False, "error": self._error}
        if self._done:
            return {
                "downloading": False,
                "done": True,
                "path": str(self._downloaded_path) if self._downloaded_path else "",
                "size_mb": round(self._total_size / (1024 * 1024), 2) if self._total_size else 0,
            }
        if self._total_size > 0:
            pct = (self._downloaded_size / self._total_size) * 100
            return {
                "downloading": True,
                "progress": round(pct, 1),
                "downloaded_mb": round(self._downloaded_size / (1024 * 1024), 2),
                "total_mb": round(self._total_size / (1024 * 1024), 2),
            }
        return {"downloading": True, "progress": 0}

    def cancel(self) -> None:
        self._cancelled = True

    def install(self) -> Path:

        if not self._downloaded_path or not self._downloaded_path.exists():
            raise RuntimeError("No update downloaded")
        if not self._downloaded_path.is_file():
            raise FileNotFoundError(f"Installer not found: {self._downloaded_path}")
        logger.info("Launching installer: %s", self._downloaded_path)
        try:
            subprocess.Popen(
                [str(self._downloaded_path)],
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except OSError as e:
            logger.error("Failed to launch installer %s: %s", self._downloaded_path, e)
            raise OSError(f"Failed to launch installer: {e}") from e
        return self._downloaded_path

    def _write_download_chunks(self, resp, f, hasher) -> None:
        while True:
            if self._cancelled:
                return
            chunk = resp.read(8192)
            if not chunk:
                return
            f.write(chunk)
            hasher.update(chunk)
            self._downloaded_size += len(chunk)

    def _finalize_download(self, tmp_path: Path, hasher) -> None:
        actual_hash = hasher.hexdigest().lower()
        if actual_hash != self._expected_sha256:
            self._error = (
                f"Checksum mismatch.\n"
                f"Expected: {self._expected_sha256[:16]}...\n"
                f"Got:      {actual_hash[:16]}..."
            )
            tmp_path.unlink(missing_ok=True)
            logger.error("Checksum mismatch for %s", self._url)
            return

        cache_dir = Path(tempfile.gettempdir()) / "Tuck" / "updates"
        cache_dir.mkdir(parents=True, exist_ok=True)
        final_name = f"Tuck-Setup-{self._expected_sha256[:8]}.exe"
        final_path = cache_dir / final_name
        shutil.move(str(tmp_path), str(final_path))
        self._downloaded_path = final_path
        self._done = True
        logger.info("Update downloaded and verified: %s", final_path)

    def _download(self) -> None:

        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".exe") as tmp:
                tmp_path = Path(tmp.name)

            req = Request(self._url, headers={"User-Agent": "Tuck-Updater/1.0"})
            with urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
                self._total_size = int(resp.headers.get("Content-Length", 0))
                hasher = hashlib.sha256()
                with open(tmp_path, "wb") as f:
                    self._write_download_chunks(resp, f, hasher)

            if self._cancelled:
                tmp_path.unlink(missing_ok=True)
                return

            self._finalize_download(tmp_path, hasher)

        except Exception as e:
            self._error = str(e)
            logger.error("Update download failed: %s", e)
            if tmp_path and tmp_path.exists():
                with contextlib.suppress(Exception):
                    tmp_path.unlink(missing_ok=True)


def _parse_release_version(release: dict, current: Version) -> Version | None:
    if release.get("draft") or release.get("prerelease"):
        return None
    tag = release.get("tag_name", "").lstrip("v")
    try:
        release_ver = Version(tag)
    except Exception:
        return None
    if release_ver <= current:
        return None
    return release_ver


def _find_release_assets(assets: list) -> tuple[dict | None, dict | None]:
    installer_asset = None
    checksum_asset = None
    for asset in assets:
        name = asset.get("name", "")
        if name.endswith(".exe") and "x64" in name:
            installer_asset = asset
        elif name.endswith(".sha256"):
            checksum_asset = asset
    return installer_asset, checksum_asset


def _extract_checksum(cs_data: str) -> str:
    parts = cs_data.split()
    if not parts:
        return ""
    candidate = parts[0].strip().lower()
    if _SHA256_RE.match(candidate):
        return candidate
    for part in parts:
        clean = part.strip().lower()
        if _SHA256_RE.match(clean):
            return clean
    return ""


def _fetch_release_checksum(checksum_asset: dict | None) -> str:
    if not checksum_asset:
        return ""
    checksum_url = checksum_asset.get("browser_download_url", "")
    try:
        cs_req = Request(checksum_url, headers={"User-Agent": "Tuck-Updater/1.0"})
        with urlopen(cs_req, timeout=REQUEST_TIMEOUT) as cs_resp:
            cs_data = cs_resp.read().decode().strip()
        return _extract_checksum(cs_data)
    except Exception:
        logger.debug("Could not fetch checksum from %s", checksum_url, exc_info=True)
        return ""


def _build_update_info(release: dict, release_ver: Version) -> UpdateInfo | None:
    installer_asset, checksum_asset = _find_release_assets(release.get("assets", []))
    if not installer_asset:
        return None

    download_url = installer_asset.get("browser_download_url", "")
    file_size = installer_asset.get("size", 0)
    notes = _sanitize_notes(release.get("body", "") or "")

    checksum = _fetch_release_checksum(checksum_asset)
    if not checksum or not _SHA256_RE.match(checksum):
        logger.warning("No valid SHA-256 checksum for release %s", release.get("tag_name", ""))
        return None

    return UpdateInfo(
        version=release_ver,
        notes=notes,
        download_url=download_url,
        file_size=file_size,
        checksum=checksum,
    )


def check_for_updates(
    owner: str = GITHUB_REPO_OWNER,
    repo: str = GITHUB_REPO_NAME,
) -> UpdateInfo | None:

    current = Version(__version__)

    try:
        url = GITHUB_API_RELEASES.format(owner=owner, repo=repo)
        req = Request(
            url,
            headers={
                "User-Agent": "Tuck-Updater/1.0",
                "Accept": "application/vnd.github.v3+json",
            },
        )
        with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            releases = json.loads(resp.read().decode())

        if not isinstance(releases, list):
            return None

        for release in releases:
            release_ver = _parse_release_version(release, current)
            if release_ver is None:
                continue

            info = _build_update_info(release, release_ver)
            if info is not None:
                return info

        return None

    except (URLError, json.JSONDecodeError, OSError) as e:
        logger.debug("Update check failed: %s", e)
        return None


# removes HTML tags from GitHub release notes before showing them in a plain-text label
def _sanitize_notes(notes: str) -> str:

    cleaned = re.sub(r"<[^>]*>", "", notes)

    if len(cleaned) > 2000:
        cleaned = cleaned[:1997] + "..."
    return cleaned.strip()
