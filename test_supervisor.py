"""Assert-based self-test for the Soloist supervisor.

Runnable standalone (`python3 test_supervisor.py`) or under pytest. No real
Soloist binary: a tiny shell script stands in, exiting with a scripted sequence
of codes (1 -> 10 -> 0) so one supervise() call exercises every branch —
backoff restart, exit-10 re-acquire, and clean-exit stop.
"""

import asyncio
import tempfile
from pathlib import Path

from soloist_proxy.config import Config, ProxyConfig, SoloistConfig
from soloist_proxy.supervisor import build_argv, supervise


def _cfg(data_dir="./data"):
    return Config(
        soloist=SoloistConfig(
            device_name="Party Speaker",
            api_key="secret",
            data_dir=data_dir,
            extra_args=["--verbose"],
        ),
        proxy=ProxyConfig(listen="0.0.0.0:8687", token="tok"),
        soloist_ws="127.0.0.1:3678",
        stream_name="Spotify",
    )


def test_build_argv():
    argv = build_argv("/bin/soloist", _cfg(data_dir="/persist"))
    assert argv[0] == "/bin/soloist"
    assert "-w" in argv and "127.0.0.1:3678" in argv
    assert argv[argv.index("--device-name") + 1] == "Party Speaker"
    assert argv[argv.index("--api-key") + 1] == "secret"
    assert argv[argv.index("--data-dir") + 1] == "/persist"
    assert argv[-1] == "--verbose"  # extra_args appended last


def _counter_script(path: Path, counter: Path):
    """A fake soloist: exit 1, then 10, then 0 on successive runs."""
    path.write_text(
        "#!/bin/sh\n"
        f'n=$(cat "{counter}" 2>/dev/null || echo 0)\n'
        f'echo $((n+1)) > "{counter}"\n'
        'case "$n" in\n'
        "  0) exit 1 ;;\n"
        "  1) exit 10 ;;\n"
        "  *) exit 0 ;;\n"
        "esac\n"
    )
    path.chmod(0o755)


def test_supervise_lifecycle():
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "soloist"
        counter = Path(tmp) / "count"
        _counter_script(script, counter)

        calls = []

        def fake_acquire(cache_dir=None, base_url=None, *, force=False):
            calls.append(force)
            return script

        code = asyncio.run(
            supervise(_cfg(), acquire=fake_acquire, backoff_base=0.01, backoff_max=0.02)
        )

        assert code == 0  # clean exit stops the loop
        # initial acquire (force=False) + one forced re-acquire on exit 10
        assert calls == [False, True]
        assert int(counter.read_text()) == 3  # ran three times: 1 -> 10 -> 0


def test_supervise_cancel_terminates_child():
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "soloist"
        script.write_text("#!/bin/sh\nsleep 30\n")  # never exits on its own
        script.chmod(0o755)

        def fake_acquire(cache_dir=None, base_url=None, *, force=False):
            return script

        async def run_and_cancel():
            task = asyncio.create_task(supervise(_cfg(), acquire=fake_acquire))
            await asyncio.sleep(0.2)  # let the child spawn
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        asyncio.run(run_and_cancel())  # returns => child was reaped, no hang


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} checks passed")
