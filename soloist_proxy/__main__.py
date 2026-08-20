"""Standalone deliverable: supervise Soloist and serve the auth Proxy together.

Run as ``python -m soloist_proxy [--config ...]``. Loads the Config, then runs the
Soloist supervisor and the Proxy as concurrent asyncio tasks. If either stops, the
other is cancelled and the process exits. No audio — that is the Docker deliverable.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .config import ConfigError, load_config
from .proxy import serve_proxy
from .supervisor import supervise


async def _run(cfg, cache_dir=None, base_url=None) -> None:
    tasks = {
        asyncio.create_task(supervise(cfg, cache_dir=cache_dir, base_url=base_url), name="supervisor"),
        asyncio.create_task(serve_proxy(cfg), name="proxy"),
    }
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for t in done:
        t.result()  # re-raise a genuine failure


def _main() -> int:
    ap = argparse.ArgumentParser(prog="soloist_proxy", description="Soloist supervisor + auth proxy.")
    ap.add_argument("--config", help="Path to the YAML config")
    ap.add_argument("--cache-dir", help="Soloist binary cache dir")
    ap.add_argument("--base-url", help="Download base URL")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"config error: {e}", flush=True)
        return 1
    try:
        asyncio.run(_run(cfg, cache_dir=args.cache_dir, base_url=args.base_url))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
