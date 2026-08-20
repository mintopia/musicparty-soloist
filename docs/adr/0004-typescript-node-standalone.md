# The standalone proxy/manager is TypeScript on Node, not Python

The Proxy + supervisor were first built as an asyncio Python package
(`soloist_proxy`). We rewrote them in TypeScript, run on Node 22, to make the
standalone (non-Docker) deliverable easier to run: no virtualenv, no interpreter
version juggling — `npm ci && npm run build && node dist/main.js`. The behaviour is
unchanged: same YAML Config File and env-override names, same auth gate, same
exit-10 re-acquire, same single-upstream fan-out hub.

## Considered Options

- **Keep Python** (`asyncio` + `websockets` + `PyYAML`): works, but standalone runs
  need a matching interpreter and a venv; the friction is what prompted the pivot.
- **Bun / Deno single-binary**: genuinely standalone, but newer and less ubiquitous
  on target hosts. Node is the boring, universally-installed default; revisit if a
  zero-dependency single binary becomes a hard requirement.
- **Node + TypeScript** (chosen): ubiquitous runtime, `ws` + `yaml` the only runtime
  deps, tar extraction shells out to system `tar`, timing-safe compare and HTTPS
  download are Node built-ins.

## Consequences

The Docker base moves from `python:3.12-slim` to `node:22-trixie-slim`. Trixie
(glibc 2.41) is required because the Soloist binary needs `GLIBC_2.38+`, which
bookworm (2.36) lacks; the image also adds `libatomic1` and pulls the `_trixie`
Snapserver deb. Alpine is unsuitable — Soloist is a glibc binary and the
pipewire-enabled Snapserver ships only as a Debian .deb. The s6
longrun execs `node dist/main.js` instead of `python -m soloist_proxy`. All
`SOLOIST_*` / `PROXY_*` / `SNAPCAST_*` env var names are preserved, so existing
configs and compose files keep working.
