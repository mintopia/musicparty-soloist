# 03: Soloist supervisor

**What to build:** Launch the Soloist daemon with the local WebSocket enabled (`-w 127.0.0.1:3678`) plus the configured `--device-name`, `--api-key`, `--data-dir`, and any `extra_args`. The Connect device appears in Spotify. Supervise the process: on **exit code 10 (expired build)** re-acquire the binary and restart; on other non-zero exits restart with backoff. Data-dir points at a persistent location so session state survives restarts.

**Blocked by:** 01, 02.

**Status:** done

- [x] Soloist launches with `-w`, device name, API Key, data-dir, and `extra_args`; device is visible in Spotify Connect
- [x] Exit code 10 triggers re-acquisition (ticket 02) then restart
- [x] Other non-zero exits trigger restart with backoff; clean shutdown does not loop
- [x] Logs the daemon's lifecycle events to stdout

## Comments

Implemented in `soloist_proxy/supervisor.py`. `supervise()` is an asyncio coroutine
(runs alongside the Proxy): `build_argv` assembles `-w`/`--device-name`/`--api-key`/
`--data-dir` + `extra_args`; exit 10 re-acquires with `force=True` and restarts now;
other non-zero restarts with capped exponential backoff (reset after a healthy run);
exit 0 stops. Cancellation terminates the child (SIGTERM→SIGKILL). Added a `data_dir`
config field (`SOLOIST_DATA_DIR` override, default `./.soloist-data`, created on start)
so session state persists. Self-test in `test_supervisor.py` covers argv, the 1→10→0
lifecycle, and cancel-terminates-child.
