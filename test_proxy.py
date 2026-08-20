"""Assert-based self-test for the auth Proxy.

Runnable standalone (`python3 test_proxy.py`) or under pytest. Spins up a fake
upstream WS (echo) to stand in for Soloist, fronts it with the Proxy, and checks:

- missing token   -> 401 at the upgrade
- wrong token     -> 401 at the upgrade
- correct token   -> upgrade succeeds, frames relay verbatim, two clients fan out
- token via `?token=` query param also passes

No real Soloist binary or network beyond localhost.
"""

import asyncio

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import InvalidStatus

from soloist_proxy.config import Config, ProxyConfig, SoloistConfig
from soloist_proxy.proxy import _listen_parts, _presented_token, make_server

TOKEN = "s3cr3t-token"


def _cfg(soloist_ws: str) -> Config:
    return Config(
        soloist=SoloistConfig(device_name="Party Speaker", api_key="k", data_dir="./d"),
        proxy=ProxyConfig(listen="127.0.0.1:0", token=TOKEN),
        soloist_ws=soloist_ws,
        stream_name="Spotify",
    )


class _Req:
    def __init__(self, headers=None, path="/"):
        self.headers = headers or {}
        self.path = path


def test_presented_token():
    assert _presented_token(_Req({"Authorization": f"Bearer {TOKEN}"})) == TOKEN
    assert _presented_token(_Req(path=f"/?token={TOKEN}")) == TOKEN
    assert _presented_token(_Req()) is None
    assert _presented_token(_Req({"Authorization": "Basic abc"})) is None


async def _run_gate_checks():
    # Fake Soloist WS: an echo server that records how many upstream connections
    # it receives — the fan-out contract is N clients over ONE upstream.
    conns = []

    async def counting_echo(ws):
        conns.append(ws)
        async for msg in ws:
            await ws.send(msg)

    async with serve(counting_echo, "127.0.0.1", 0) as upstream:
        up_port = upstream.sockets[0].getsockname()[1]
        cfg = _cfg(f"127.0.0.1:{up_port}")

        # Bring up the real Proxy on an ephemeral port via make_server().
        async with make_server(cfg) as proxy:
            port = proxy.sockets[0].getsockname()[1]
            base = f"ws://127.0.0.1:{port}"

            # missing token -> 401
            try:
                await connect(base)
                assert False, "missing token should be rejected"
            except InvalidStatus as e:
                assert e.response.status_code == 401

            # wrong token -> 401
            try:
                await connect(base, additional_headers={"Authorization": "Bearer nope"})
                assert False, "wrong token should be rejected"
            except InvalidStatus as e:
                assert e.response.status_code == 401

            # good token: header client + query-param client, both authenticated
            async with (
                connect(base, additional_headers={"Authorization": f"Bearer {TOKEN}"}) as c1,
                connect(f"{base}/?token={TOKEN}") as c2,
            ):
                # c1's frame goes to the shared upstream, whose echo fans out to BOTH.
                await c1.send("ping")
                assert await c1.recv() == "ping"
                assert await c2.recv() == "ping"
                # binary frame preserved verbatim, also fanned out
                await c2.send(b"\x00\x01binary")
                assert await c1.recv() == b"\x00\x01binary"
                assert await c2.recv() == b"\x00\x01binary"

    # Two clients were served over exactly one Soloist upstream connection.
    assert len(conns) == 1


def test_auth_gate_and_fanout():
    asyncio.run(_run_gate_checks())


def test_listen_parts():
    assert _listen_parts("0.0.0.0:8687") == ("0.0.0.0", 8687)
    assert _listen_parts("127.0.0.1:1234") == ("127.0.0.1", 1234)
    assert _listen_parts(":9000") == ("0.0.0.0", 9000)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} checks passed")
