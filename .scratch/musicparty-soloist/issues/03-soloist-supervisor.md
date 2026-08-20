# 03: Soloist supervisor

**What to build:** Launch the Soloist daemon with the local WebSocket enabled (`-w 127.0.0.1:3678`) plus the configured `--device-name`, `--api-key`, `--data-dir`, and any `extra_args`. The Connect device appears in Spotify. Supervise the process: on **exit code 10 (expired build)** re-acquire the binary and restart; on other non-zero exits restart with backoff. Data-dir points at a persistent location so session state survives restarts.

**Blocked by:** 01, 02.

**Status:** ready-for-agent

- [ ] Soloist launches with `-w`, device name, API Key, data-dir, and `extra_args`; device is visible in Spotify Connect
- [ ] Exit code 10 triggers re-acquisition (ticket 02) then restart
- [ ] Other non-zero exits trigger restart with backoff; clean shutdown does not loop
- [ ] Logs the daemon's lifecycle events to stdout
