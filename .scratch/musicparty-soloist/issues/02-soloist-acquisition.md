# 02: Soloist acquisition

**What to build:** At startup, ensure a usable Soloist binary exists in the cache dir. Auto-detect the host architecture, download the matching tarball, extract it, and validate it by running `soloist --version` and checking exit 0. Re-download if the binary is missing or older than 60 days (margin before the 90-day hard expiry). The binary is never committed or baked in — redistribution is prohibited (see ADR-0001 context / PLAN).

**Blocked by:** 01 (config for the cache dir path).

**Status:** ready-for-agent

- [ ] Detects arch via `platform.machine()` → `x86_64` / `arm64` (aarch64) / `arm32` (armv7l)
- [ ] Downloads the correct arch tarball to the cache dir and extracts the `soloist` binary
- [ ] Validates the extracted binary with `soloist --version` (exit 0) before trusting it
- [ ] Skips download when a cached binary exists and is ≤60 days old; re-downloads otherwise
- [ ] Self-test (assert-based) covers the arch → tarball mapping
