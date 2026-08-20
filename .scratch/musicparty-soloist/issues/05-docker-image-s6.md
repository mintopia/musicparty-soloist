# 05: Docker image + s6

**What to build:** A Docker image that runs the standalone app (Soloist supervisor + Proxy) under s6-overlay as PID 1, with host networking. No audio path yet — this is the containerized equivalent of the standalone deliverable. Persistent volumes back the Soloist data-dir and the binary cache; a healthcheck confirms the Proxy is listening.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Image runs s6-overlay as PID 1 with the Python app as an s6 service (proper reaping + restart)
- [ ] Host networking; the Proxy is reachable on 8687 from the LAN
- [ ] Volumes persist the Soloist data-dir and the binary cache across container restarts
- [ ] Docker healthcheck = TCP probe on 8687
- [ ] Container behaves like the standalone deliverable: device appears in Spotify, authed WS control works
