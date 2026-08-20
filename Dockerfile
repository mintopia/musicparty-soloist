# Musicparty Soloist — containerized standalone deliverable (no audio path yet).
# s6-overlay is PID 1: it reaps zombies and supervises/restarts the Python app.
# Run with host networking so the Proxy on 8687 is reachable from the LAN.
FROM python:3.12-slim-bookworm

ARG S6_OVERLAY_VERSION=3.2.0.2
ARG TARGETARCH

# s6-overlay (arch tarball + noarch tarball). curl+xz only needed for this fetch.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl xz-utils ca-certificates; \
    case "${TARGETARCH:-amd64}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      arm)   S6_ARCH=arm ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    curl -fsSL "${base}/s6-overlay-noarch.tar.xz"      -o /tmp/s6-noarch.tar.xz; \
    curl -fsSL "${base}/s6-overlay-${S6_ARCH}.tar.xz"  -o /tmp/s6-arch.tar.xz; \
    tar -C / -Jxpf /tmp/s6-noarch.tar.xz; \
    tar -C / -Jxpf /tmp/s6-arch.tar.xz; \
    apt-get purge -y curl xz-utils; \
    apt-get autoremove -y; \
    rm -rf /tmp/s6-*.tar.xz /var/lib/apt/lists/*
# ca-certificates stays: the runtime Soloist binary download is HTTPS.

# Audio path (ticket 06): PipeWire null-sink Soloist plays into, WirePlumber to
# route the stream onto it, and the pw-* CLI used to probe the sink at startup.
# dbus: WirePlumber runs under a private session bus (reserve-device /
# portal-permissionstore plugins need one); machine-id lets that bus start.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends pipewire pipewire-bin wireplumber dbus; \
    dbus-uuidgen --ensure=/etc/machine-id; \
    rm -rf /var/lib/apt/lists/*
COPY docker/pipewire/soloist-sink.conf /etc/pipewire/pipewire.conf.d/10-soloist-sink.conf
COPY docker/wireplumber/80-disable-bluez.lua /etc/wireplumber/bluetooth.lua.d/80-disable-bluez.lua

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY soloist_proxy ./soloist_proxy
COPY config.example.yaml ./config.yaml
COPY docker/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod +x /etc/s6-overlay/s6-rc.d/soloist-proxy/run \
             /etc/s6-overlay/s6-rc.d/pipewire/run \
             /etc/s6-overlay/s6-rc.d/wireplumber/run

# Persistent volumes: Soloist session data-dir and the downloaded-binary cache.
# XDG_RUNTIME_DIR: where PipeWire puts its socket; every client inherits it.
# SOLOIST_PIPEWIRE_DEVICE: the null-sink Soloist plays into (Docker audio route).
ENV SOLOIST_PROXY_CONFIG=/app/config.yaml \
    SOLOIST_DATA_DIR=/data \
    SOLOIST_CACHE_DIR=/cache \
    XDG_RUNTIME_DIR=/run/pipewire \
    SOLOIST_PIPEWIRE_DEVICE=soloist-sink
VOLUME ["/data", "/cache"]

EXPOSE 8687
# start-period is generous: first boot downloads the Soloist binary before the Proxy binds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8687), 3).close()"

ENTRYPOINT ["/init"]
