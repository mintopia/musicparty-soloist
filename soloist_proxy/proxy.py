"""The Proxy: an authenticating WebSocket front for the Soloist WebSocket.

Soloist's control WS is unauthenticated and localhost-only (see ADR-0001). This
server listens on ``proxy.listen``, gates each connection on the shared Auth Token
(``Authorization: Bearer <token>`` header or ``?token=<token>`` query param,
constant-time compared), and relays frames verbatim to Soloist's local WS. It is a
dumb pipe — its only job is authentication.

Many Downstream Clients fan out against a *single* shared Soloist connection
(``SoloistHub``): one upstream WS, every upstream frame broadcast to all clients,
every client frame forwarded onto that one upstream. The hub reconnects with
backoff if Soloist drops.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import sys
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from .config import Config

log = logging.getLogger("soloist.proxy")

_BEARER = "Bearer "


def _presented_token(request) -> str | None:
    """Pull the Auth Token from the Bearer header, else the ``?token=`` query."""
    auth = request.headers.get("Authorization")
    if auth and auth.startswith(_BEARER):
        return auth[len(_BEARER):]
    tokens = parse_qs(urlsplit(request.path).query).get("token")
    return tokens[0] if tokens else None


def check_auth(connection, request, token: str):
    """process_request hook: return a 401 Response on bad/missing token, else None."""
    presented = _presented_token(request)
    if presented is None or not hmac.compare_digest(presented, token):
        log.warning("rejected connection from %s: bad/missing token", connection.remote_address)
        return connection.respond(401, "Unauthorized\n")
    return None


class SoloistHub:
    """A single shared upstream connection to Soloist, fanned out to N clients.

    ``run()`` keeps the one upstream WS connected and broadcasts every frame it
    receives to all registered clients; ``forward()`` sends a client frame onto
    that shared upstream. Reconnects with capped backoff if the upstream drops.
    """

    def __init__(self, url: str, *, backoff_base=0.5, backoff_max=30.0, ready_timeout=5.0):
        self.url = url
        self._clients: set = set()
        self._conn = None
        self._ready = asyncio.Event()
        self._backoff_base = backoff_base
        self._backoff_max = backoff_max
        self._ready_timeout = ready_timeout

    def register(self, client) -> None:
        self._clients.add(client)

    def unregister(self, client) -> None:
        self._clients.discard(client)

    async def forward(self, message) -> None:
        """Send one client frame to the shared upstream (dropped if it never comes up)."""
        try:
            await asyncio.wait_for(self._ready.wait(), self._ready_timeout)
        except asyncio.TimeoutError:
            return
        conn = self._conn
        if conn is None:
            return
        try:
            await conn.send(message)
        except ConnectionClosed:
            pass  # upstream dropped mid-send; run() is already reconnecting

    async def _broadcast(self, message) -> None:
        for client in list(self._clients):
            try:
                await client.send(message)  # str or bytes, verbatim
            except ConnectionClosed:
                self._clients.discard(client)

    async def run(self) -> None:
        """Maintain the single upstream connection, broadcasting to clients, forever."""
        backoff = self._backoff_base
        while True:
            try:
                async with connect(self.url) as conn:
                    log.info("connected to soloist upstream %s", self.url)
                    self._conn = conn
                    self._ready.set()
                    backoff = self._backoff_base
                    async for message in conn:
                        await self._broadcast(message)
            except (OSError, InvalidHandshake, asyncio.TimeoutError) as e:
                log.warning("soloist upstream %s error: %s", self.url, e)
            finally:
                self._conn = None
                self._ready.clear()
            log.info("soloist upstream down; reconnecting in %.1fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._backoff_max)


def _listen_parts(listen: str) -> tuple[str, int]:
    host, _, port = listen.rpartition(":")
    return host or "0.0.0.0", int(port)


@asynccontextmanager
async def make_server(cfg: Config):
    """Start the shared hub and yield the running Proxy server.

    Split from :func:`serve_proxy` so tests can start it on an ephemeral port and
    inspect the bound socket without ``serve_forever``.
    """
    host, port = _listen_parts(cfg.proxy.listen)
    hub = SoloistHub(f"ws://{cfg.soloist_ws}")

    async def handler(connection):
        hub.register(connection)
        try:
            async for message in connection:
                await hub.forward(message)
        finally:
            hub.unregister(connection)

    def process_request(connection, request):
        return check_auth(connection, request, cfg.proxy.token)

    log.info("proxy listening on %s -> ws://%s", cfg.proxy.listen, cfg.soloist_ws)
    hub_task = asyncio.create_task(hub.run(), name="soloist-hub")
    try:
        async with serve(handler, host, port, process_request=process_request) as server:
            yield server
    finally:
        hub_task.cancel()
        await asyncio.gather(hub_task, return_exceptions=True)


async def serve_proxy(cfg: Config) -> None:
    """Run the Proxy until cancelled."""
    async with make_server(cfg) as server:
        await server.serve_forever()


def _main() -> int:
    import argparse

    from .config import ConfigError, load_config

    ap = argparse.ArgumentParser(description="Run the Soloist auth proxy.")
    ap.add_argument("--config", help="Path to the YAML config")
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
        asyncio.run(serve_proxy(cfg))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
