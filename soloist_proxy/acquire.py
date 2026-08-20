"""Soloist binary acquisition.

At startup we must have a usable Soloist binary in the cache dir. The binary is
never committed or baked into any image (redistribution is prohibited) so it is
always downloaded at runtime: detect the host arch, fetch the matching tarball,
extract the ``soloist`` binary, and validate it with ``soloist --version``.

Re-download when the cached binary is missing, older than 60 days (margin before
the 90-day hard expiry), or fails validation.
"""

from __future__ import annotations

import os
import platform
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

# ponytail: download host is a placeholder — no URL is documented for the (closed,
# non-redistributable) Soloist build. Override with $SOLOIST_DOWNLOAD_BASE once the
# real endpoint is known; the arch->filename mapping below is the stable part.
DEFAULT_BASE_URL = "https://download.soloist.spotify.example/latest"
DEFAULT_CACHE_DIR = "./.soloist-cache"
MAX_AGE_DAYS = 60

# platform.machine() (lowercased) -> our arch token
_ARCH_MAP = {
    "x86_64": "x86_64",
    "amd64": "x86_64",
    "aarch64": "arm64",
    "arm64": "arm64",
    "armv7l": "arm32",
    "armv7": "arm32",
    "armhf": "arm32",
}

# arch token -> tarball filename
TARBALLS = {
    "x86_64": "soloist-linux-x86_64.tar.gz",
    "arm64": "soloist-linux-arm64.tar.gz",
    "arm32": "soloist-linux-arm32.tar.gz",
}


class AcquisitionError(Exception):
    """Could not obtain a usable Soloist binary."""


def detect_arch(machine: str | None = None) -> str:
    """Map ``platform.machine()`` to our arch token, or raise if unsupported."""
    raw = machine if machine is not None else platform.machine()
    arch = _ARCH_MAP.get(raw.lower())
    if arch is None:
        raise AcquisitionError(f"unsupported architecture: {raw!r}")
    return arch


def tarball_url(arch: str, base_url: str | None = None) -> str:
    base = base_url or os.environ.get("SOLOIST_DOWNLOAD_BASE") or DEFAULT_BASE_URL
    return f"{base.rstrip('/')}/{TARBALLS[arch]}"


def _default_cache_dir() -> Path:
    return Path(os.environ.get("SOLOIST_CACHE_DIR") or DEFAULT_CACHE_DIR)


def binary_is_fresh(path, max_age_days: int = MAX_AGE_DAYS) -> bool:
    """True if the binary exists and its mtime is within ``max_age_days``.

    mtime is a proxy for the build's freshness — good enough to pre-empt the
    90-day expiry; the supervisor's exit-10 handler is the real safety net.
    """
    p = Path(path)
    if not p.is_file():
        return False
    age_days = (time.time() - p.stat().st_mtime) / 86400
    return age_days <= max_age_days


def validate_binary(path) -> bool:
    """True if ``<path> --version`` runs and exits 0."""
    p = Path(path)
    if not p.is_file():
        return False
    try:
        result = subprocess.run(
            [str(p), "--version"], capture_output=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _download_and_extract(arch: str, cache: Path, base_url: str | None) -> Path:
    """Download the arch tarball and extract its ``soloist`` binary into ``cache``."""
    url = tarball_url(arch, base_url)
    binary = cache / "soloist"
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        tarball = Path(tmp.name)
    try:
        urllib.request.urlretrieve(url, tarball)
        with tarfile.open(tarball, "r:gz") as tf:
            member = next(
                (m for m in tf.getmembers() if m.isfile() and Path(m.name).name == "soloist"),
                None,
            )
            if member is None:
                raise AcquisitionError(f"no 'soloist' binary in tarball from {url}")
            src = tf.extractfile(member)
            if src is None:
                raise AcquisitionError(f"could not read 'soloist' from tarball at {url}")
            binary.write_bytes(src.read())  # write by name, never the tar path — no traversal
    except (OSError, tarfile.TarError) as e:
        raise AcquisitionError(f"failed to download/extract {url}: {e}") from e
    finally:
        tarball.unlink(missing_ok=True)
    binary.chmod(0o755)
    return binary


def acquire_soloist(
    cache_dir=None,
    base_url: str | None = None,
    *,
    arch: str | None = None,
    max_age_days: int = MAX_AGE_DAYS,
    force: bool = False,
) -> Path:
    """Ensure a usable Soloist binary exists in ``cache_dir``; return its path.

    Reuses the cached binary when it is fresh (≤ ``max_age_days`` old) and valid;
    otherwise downloads, extracts, and validates a fresh one.
    """
    cache = Path(cache_dir) if cache_dir is not None else _default_cache_dir()
    binary = cache / "soloist"

    if not force and binary_is_fresh(binary, max_age_days) and validate_binary(binary):
        return binary

    cache.mkdir(parents=True, exist_ok=True)
    binary = _download_and_extract(arch or detect_arch(), cache, base_url)
    if not validate_binary(binary):
        raise AcquisitionError(f"downloaded binary failed 'soloist --version' at {binary}")
    return binary


def _main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Ensure a usable Soloist binary is cached.")
    ap.add_argument("--cache-dir", help="Cache dir (default: $SOLOIST_CACHE_DIR or ./.soloist-cache)")
    ap.add_argument("--base-url", help="Download base URL (default: $SOLOIST_DOWNLOAD_BASE)")
    ap.add_argument("--force", action="store_true", help="Re-download even if a fresh binary is cached")
    args = ap.parse_args()
    try:
        path = acquire_soloist(args.cache_dir, args.base_url, force=args.force)
    except AcquisitionError as e:
        print(f"acquisition error: {e}", flush=True)
        return 1
    print(f"OK: soloist binary at {path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
