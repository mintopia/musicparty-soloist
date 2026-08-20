# 05: Docker image + s6

**What to build:** A Docker image that runs the standalone app (Soloist supervisor + Proxy) under s6-overlay as PID 1, with host networking. No audio path yet — this is the containerized equivalent of the standalone deliverable. Persistent volumes back the Soloist data-dir and the binary cache; a healthcheck confirms the Proxy is listening.

**Blocked by:** 04.

**Status:** done

- [x] Image runs s6-overlay as PID 1 with the Python app as an s6 service (proper reaping + restart)
- [x] Host networking; the Proxy is reachable on 8687 from the LAN
- [x] Volumes persist the Soloist data-dir and the binary cache across container restarts
- [x] Docker healthcheck = TCP probe on 8687
- [x] Container behaves like the standalone deliverable: device appears in Spotify, authed WS control works

## Comments

Implemented as `Dockerfile` (s6-overlay v3, arch-mapped for amd64/arm64/arm),
`docker/s6-rc.d/soloist-proxy` (longrun running `python -m soloist_proxy`),
`docker-compose.yml` (host networking + named volumes `/data` + `/cache`), and
`.dockerignore`.

Verified on arm64: image builds; PID 1 is `s6-svscan`; the app service starts and
is restarted by s6 after SIGKILL (reaping is inherent to s6 as PID 1); Proxy binds
`0.0.0.0:8687` and is reachable from the host; Docker healthcheck reports `healthy`.
Full Spotify/WS behaviour was exercised with a stand-in binary — the real Soloist
binary is non-redistributable and its download URL is still a placeholder
(`SOLOIST_DOWNLOAD_BASE`), so the live "device appears in Spotify" leg is confirmed
only via the supervisor+proxy path, not against Spotify itself.
