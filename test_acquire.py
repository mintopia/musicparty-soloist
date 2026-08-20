"""Assert-based self-test for Soloist binary acquisition.

Runnable standalone (`python3 test_acquire.py`) or under pytest. No network:
the download path is exercised via a `file://` base URL pointing at a locally
built tarball, and the "binary" is a tiny shell script that mimics
`soloist --version` (exit 0).
"""

import os
import tarfile
import tempfile
import time
from pathlib import Path

from soloist_proxy.acquire import (
    TARBALLS,
    AcquisitionError,
    acquire_soloist,
    binary_is_fresh,
    detect_arch,
    tarball_url,
    validate_binary,
)

FAKE_SOLOIST = "#!/bin/sh\necho 'soloist 1.2.3'\nexit 0\n"


def test_arch_mapping():
    assert detect_arch("x86_64") == "x86_64"
    assert detect_arch("amd64") == "x86_64"
    assert detect_arch("aarch64") == "arm64"
    assert detect_arch("arm64") == "arm64"
    assert detect_arch("armv7l") == "arm32"
    for arch in ("x86_64", "arm64", "arm32"):
        assert TARBALLS[arch] in tarball_url(arch, "https://x/y")


def test_unsupported_arch_raises():
    try:
        detect_arch("mips")
    except AcquisitionError as e:
        assert "mips" in str(e)
    else:
        raise AssertionError("expected AcquisitionError for unsupported arch")


def test_freshness():
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "soloist"
        assert binary_is_fresh(p) is False  # missing
        p.write_text("x")
        assert binary_is_fresh(p) is True  # just written
        old = time.time() - 61 * 86400
        os.utime(p, (old, old))
        assert binary_is_fresh(p) is False  # 61 days > 60


def _build_tarball(dst_dir, arch, body=FAKE_SOLOIST):
    """Write a real <TARBALLS[arch]> into dst_dir containing an executable soloist."""
    with tempfile.TemporaryDirectory() as work:
        binp = Path(work) / "soloist"
        binp.write_text(body)
        binp.chmod(0o755)
        tar_path = Path(dst_dir) / TARBALLS[arch]
        with tarfile.open(tar_path, "w:gz") as tf:
            tf.add(binp, arcname="soloist")
    return tar_path


def test_acquire_downloads_and_validates():
    with tempfile.TemporaryDirectory() as serve, tempfile.TemporaryDirectory() as cache:
        _build_tarball(serve, "x86_64")
        base = Path(serve).as_uri()  # file:// URL
        binary = acquire_soloist(cache, base, arch="x86_64")
        assert binary.exists()
        assert validate_binary(binary) is True
        assert binary.read_text() == FAKE_SOLOIST


def test_acquire_skips_when_fresh():
    with tempfile.TemporaryDirectory() as serve, tempfile.TemporaryDirectory() as cache:
        _build_tarball(serve, "x86_64")
        base = Path(serve).as_uri()
        acquire_soloist(cache, base, arch="x86_64")
        # Point the base URL at nothing: a fresh+valid cache must not re-download.
        binary = acquire_soloist(cache, "file:///no/such/dir", arch="x86_64")
        assert binary.exists()


def test_acquire_redownloads_when_stale():
    with tempfile.TemporaryDirectory() as serve, tempfile.TemporaryDirectory() as cache:
        _build_tarball(serve, "x86_64")
        base = Path(serve).as_uri()
        binary = acquire_soloist(cache, base, arch="x86_64")
        old = time.time() - 61 * 86400
        os.utime(binary, (old, old))
        assert binary_is_fresh(binary) is False
        # Rebuild the tarball with different content; stale cache must be replaced.
        _build_tarball(serve, "x86_64", body=FAKE_SOLOIST + "# v2\n")
        binary2 = acquire_soloist(cache, base, arch="x86_64")
        assert binary2.read_text().endswith("# v2\n")


def test_missing_binary_in_tarball_fails():
    with tempfile.TemporaryDirectory() as serve, tempfile.TemporaryDirectory() as cache:
        # Tarball with a wrongly-named member.
        with tempfile.TemporaryDirectory() as work:
            junk = Path(work) / "notsoloist"
            junk.write_text("x")
            with tarfile.open(Path(serve) / TARBALLS["x86_64"], "w:gz") as tf:
                tf.add(junk, arcname="notsoloist")
        try:
            acquire_soloist(cache, Path(serve).as_uri(), arch="x86_64")
        except AcquisitionError as e:
            assert "soloist" in str(e).lower()
        else:
            raise AssertionError("expected AcquisitionError for missing binary")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} checks passed")
