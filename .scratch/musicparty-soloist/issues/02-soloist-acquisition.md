# 02: Soloist acquisition

**What to build:** At startup, ensure a usable Soloist binary exists in the cache dir. Auto-detect the host architecture, download the matching tarball, extract it, and validate it by running `soloist --version` and checking exit 0. Re-download if the binary is missing or older than 60 days (margin before the 90-day hard expiry). The binary is never committed or baked in — redistribution is prohibited (see ADR-0001 context / PLAN).

**Blocked by:** 01 (config for the cache dir path).

**Status:** done

- [x] Detects arch via `platform.machine()` → `x86_64` / `arm64` (aarch64) / `arm32` (armv7l)
- [x] Downloads the correct arch tarball to the cache dir and extracts the `soloist` binary
- [x] Validates the extracted binary with `soloist --version` (exit 0) before trusting it
- [x] Skips download when a cached binary exists and is ≤60 days old; re-downloads otherwise
- [x] Self-test (assert-based) covers the arch → tarball mapping

## Comments

Implemented in `soloist_proxy/acquire.py` with `test_acquire.py` (7 assert-based checks).
Uses stdlib only (`urllib`, `tarfile`, `subprocess`) — no new deps. Arch map handles
`x86_64`/`amd64`, `aarch64`/`arm64`, `armv7l`/`armv7`/`armhf`. Extraction reads the
`soloist` member by name (never the tar path) so there's no path-traversal risk.

Gap: no download URL is documented anywhere for the (closed, non-redistributable)
Soloist build, so `DEFAULT_BASE_URL` is a marked placeholder, overridable via
`$SOLOIST_DOWNLOAD_BASE`. Cache dir defaults to `./.soloist-cache` (matches
`.gitignore`), overridable via `$SOLOIST_CACHE_DIR` — issue 03 (supervisor) wires the
resolved path from config. Freshness uses the cached file's mtime as a proxy for the
90-day build expiry; the supervisor's exit-10 handler is the real recovery path.
