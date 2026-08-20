"""Supervise the Soloist daemon.

Launch ``soloist`` with the local control WebSocket (``-w``), the configured
device name, API Key, data-dir, and any ``extra_args`` — this is what makes the
Connect device appear in Spotify. Then keep it running:

- **exit 10** (build expired): re-acquire the binary (ticket 02) and restart now.
- other non-zero: log and restart with capped exponential backoff.
- **exit 0** (clean shutdown): stop; do not loop.

Runs as an asyncio task so the Proxy can run alongside it. Cancelling the task
terminates the child (SIGTERM, then SIGKILL on timeout).
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

from .acquire import acquire_soloist
from .config import Config

EXIT_EXPIRED = 10
BACKOFF_BASE = 1.0
BACKOFF_MAX = 60.0
HEALTHY_SECONDS = 60.0  # a run this long is "healthy" — reset backoff after it
TERM_TIMEOUT = 10.0

log = logging.getLogger("soloist.supervisor")


def build_argv(binary: str | Path, cfg: Config) -> list[str]:
    """Assemble the Soloist command line from the binary path and config."""
    return [
        str(binary),
        "-w", cfg.soloist_ws,
        "--device-name", cfg.soloist.device_name,
        "--api-key", cfg.soloist.api_key,
        "--data-dir", cfg.soloist.data_dir,
        *cfg.soloist.extra_args,
    ]


async def _terminate(proc, timeout: float = TERM_TIMEOUT) -> None:
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()


async def supervise(
    cfg: Config,
    *,
    acquire=acquire_soloist,
    cache_dir=None,
    base_url: str | None = None,
    backoff_base: float = BACKOFF_BASE,
    backoff_max: float = BACKOFF_MAX,
) -> int:
    """Run the Soloist daemon under supervision until it exits cleanly.

    Returns the clean exit code (0). Never returns on crashes — it restarts.
    Cancel the task to shut down; the child is terminated on the way out.
    """
    loop = asyncio.get_running_loop()
    Path(cfg.soloist.data_dir).mkdir(parents=True, exist_ok=True)
    binary = acquire(cache_dir, base_url)
    backoff = backoff_base

    while True:
        argv = build_argv(binary, cfg)
        log.info(
            "starting soloist: device=%r ws=%s data-dir=%s",
            cfg.soloist.device_name, cfg.soloist_ws, cfg.soloist.data_dir,
        )
        proc = await asyncio.create_subprocess_exec(*argv)
        started = loop.time()
        try:
            code = await proc.wait()
        except asyncio.CancelledError:
            log.info("shutdown requested; terminating soloist (pid %s)", proc.pid)
            await _terminate(proc)
            raise
        ran = loop.time() - started

        if code == 0:
            log.info("soloist exited cleanly (0) after %.0fs; not restarting", ran)
            return code

        if code == EXIT_EXPIRED:
            log.warning("soloist build expired (exit 10); re-acquiring binary")
            binary = acquire(cache_dir, base_url, force=True)
            backoff = backoff_base
            continue  # restart immediately on a fresh binary

        if ran >= HEALTHY_SECONDS:
            backoff = backoff_base  # crash after a healthy run — start backoff over
        log.warning(
            "soloist exited with code %d after %.0fs; restarting in %.1fs",
            code, ran, backoff,
        )
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, backoff_max)


def _main() -> int:
    import argparse

    from .config import ConfigError, load_config

    ap = argparse.ArgumentParser(description="Supervise the Soloist daemon.")
    ap.add_argument("--config", help="Path to the YAML config")
    ap.add_argument("--cache-dir", help="Soloist binary cache dir")
    ap.add_argument("--base-url", help="Download base URL")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stdout,  # spec: lifecycle events to stdout
    )
    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"config error: {e}", flush=True)
        return 1
    try:
        return asyncio.run(supervise(cfg, cache_dir=args.cache_dir, base_url=args.base_url))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(_main())
