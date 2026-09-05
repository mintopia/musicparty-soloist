# Deploy to the hardware

How to build the current working tree into the Docker image and update the running
instance on the test Pi. The instance runs a **locally-built** image
(`musicparty-soloist:test`), not the ghcr image in the repo's `docker-compose.yml`.

## Connection

Host, SSH login, and web credentials live in `.hardware` (never hardcode them). The
target is an aarch64 Raspberry Pi. Connect with:

```bash
export SSHPASS=<TEST_PASSWORD from .hardware>
SSH="sshpass -e ssh -o StrictHostKeyChecking=no root@<TEST_HOST from .hardware>"
```

## Layout on the server (`/opt/musicparty/`)

- `docker-compose.yml` — the deploy compose. `image: musicparty-soloist:test`,
  `network_mode: host` (required: Spotify Connect login is mDNS and does not cross
  Docker's bridge). Do not edit to add a `build:` — the build is a separate step.
- `build/` — a **plain source copy** (not a git checkout) used as the Docker build
  context. This is what you sync into.
- `config/`, `soloist-data/`, `soloist-cache/` — persistent bind mounts (config.yaml,
  the Spotify login, the binary cache). **Recreating the container preserves these;
  never delete or rsync into them.**

## Process

1. **Sync the working tree into `build/`.** Run from the repo root. `--delete` mirrors;
   the excludes keep local secrets, caches, and dev cruft off the server (the image's
   `.dockerignore` also drops most of these from the build context):

   ```bash
   rsync -az --delete \
     --exclude='.git' --exclude='node_modules' --exclude='dist' \
     --exclude='.soloist-data' --exclude='.soloist-cache' --exclude='.hardware' \
     --exclude='.impeccable' --exclude='.claude' --exclude='config.yaml' --exclude='.env' \
     -e "sshpass -e ssh -o StrictHostKeyChecking=no" \
     ./ root@<TEST_HOST>:/opt/musicparty/build/
   ```

   Preview first with `--dry-run --itemize-changes`; a checksum diff
   (`rsync -a -c --dry-run --itemize-changes ./src/ …:/opt/musicparty/build/src/ | grep '^<f.*c'`)
   confirms which source files actually changed.

2. **Build the image** (context is `build/`; the heavy apt layers are cached, so only
   the `npm ci` + `vite build` layers rebuild — ~1 min on the Pi):

   ```bash
   $SSH 'cd /opt/musicparty/build && docker build -t musicparty-soloist:test .'
   ```

3. **Recreate the container** from the deploy compose (uses the local image; no pull):

   ```bash
   $SSH 'cd /opt/musicparty && docker compose up -d --force-recreate'
   ```

4. **Verify health** (the container has a healthcheck; wait for `healthy`):

   ```bash
   $SSH 'for i in $(seq 1 20); do
     s=$(docker inspect -f "{{.State.Health.Status}}" musicparty-soloist-1); echo "$s";
     [ "$s" = healthy ] && break; sleep 3; done
     docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"'
   ```

## Notes

- The recreate causes a brief service interruption — the running party audio drops for
  a few seconds. Confirm with the user before deploying if a session is live.
- The web session cookie is signed with the session secret **and** the web password,
  both in the persisted `config.yaml`, so an existing cookie usually survives a
  recreate. Re-login (`POST /login` with the `.hardware` web creds) if it doesn't.
- Config is the single source of truth (ADR-0010); it is never baked into the image.
  Change runtime settings in the web UI or `config/config.yaml`, not by rebuilding.
