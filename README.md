# Soloist Proxy

This project provides a wrapper around
[Spotify Soloist](https://developer.spotify.com/documentation/soloist), the official headless
Linux Spotify Connect client. It adds authentication, webhook support, basic web interface and lyric support.

It can be run standalone using `npx` or it can be run through docker which will also provide audio device management and a snapcast server for streaming synchronised audio.

This was originally built to accompany [Music Party](https://github.com/mintopia/musicparty), which works better with a websocket providing Spotify playback events.

## Features

* **Web Console** - A web console allows you to configure Soloist Proxy, view now playing status with playback controls and provides a lyrics overlay and debug information.
* **Websocket Authorisation** - The websocket provided by Soloist doesn't have any authentication, so Soloist Proxy allows you to specify a required query parameter or auth header.
* **Websocket Relay** - Soloist Proxy can be configured to make an outbound websocket connection with optional authorisation. It will then relay all communications.
* **Webhooks** - You can configure webhooks, with a minimum interval, webhook secret and hooks for particular events.
* **Lyrics** - Uses [LRCLIB](https://lrclib.net/) to fetch lyrics for the currently playing song and provides an unauthenticated HTML overlay for use with OBS or anything else that can overlay a webpage.
* **Snapcast** - The docker version has a [Snapcast](https://github.com/badaix/snapcast) server you can use for streaming audio around your network.
* **Autoplay** - Set Soloist Proxy to automatically start playback in Soloist when it has authenticated with Spotify.
* **PipeWire Included** - Soloist requires PipeWire for audio, which is generally not included in most headless linux distributions. If you use the docker version, it's handled for you - you just need to map the sound devices through.

## Installation

### Docker (Linux)

The easiest way, it means you don't have to worry about PipeWire and you get the benefits of it. Use a `docker-compose.yml` like this one for running it.

```yml
services:
  soloist:
    image: ghcr.io/mintopia/musicparty-soloist:latest
    network_mode: host
    restart: unless-stopped
    devices:
      - /dev/snd:/dev/snd
    volumes:
      - /run/udev:/run/udev:ro
      - ./config:/config
      - soloist-data:/data
      - soloist-cache:/cache

volumes:
  soloist-data:
  soloist-cache:
```

The data volume is used for Soloist's data and the cache volume hosts the download of Soloist (which isn't bundled into the docker image).

`/run/udev` and and `/dev/snd` are passed through to the container so that it can enumerate and use ALSA audio devices in pipewire. If you're using Snapcast, you don't need to pass those through.

`host` network mode is needed for Spotify to auto-discover the Soloist instance and authenticate it.

You can bring it up by running:

```bash
docker compose up -d
```

And now you can visit `http://<host>:8687` to access Soloist and begin setup.

### Standalone (npx)

To use this, you will need to have Node.js 24+ and configure your own PipeWire devices for audio output and there's no Snapcast server provided. Soloist will use the default PipeWire device but can be overridden in Soloist Proxy configuration.

```bash
npx @mintopia/musicparty-soloist
```

You can now visit `http://<host>:8687` and begin first-time setup.

## Usage

### Soloist API Key

The API Key authorizes the Soloist. Obtain it from the [Spotify for Developers](https://developer.spotify.com) dashboard; it needs a Spotify Premium account. It does **not** log a user in — pairing over Spotify Connect is a separate step. It is stored as `soloist.api_key` in the Config File, passed to Soloist as `--api-key`, and masked in the UI.

### First Run

1. **Authentication** - On a fresh install the panel shows a setup page for you to enter a username and password.
3. **Set Soloist API Key** - Set the Soloist API Key and Device Name. For the standalone version, you can optionally choose your audio device here. When done, hit **save** and Soloist will start.
3. **Pair with Spotify.** - Once Soloist is running, open Spotify on any device on the same LAN and pick your device from the Connect menu (the speaker icon).

### Ports

| Port | Service |
|------|---------|
| 8687 | Auth proxy (control WebSocket) + web UI + Lyrics Overlay |
| 1704 | Snapcast audio stream |
| 1705 | Snapcast control (TCP JSON-RPC) |
| 1780 | Snapcast web UI |

### Configuration

Most of the configuration can be done from the web panel, but you can also edit the `config.yaml` directly.

## FAQs

### Can I run this on Windows or Mac?

Not easily. The Spotify login uses Spotify Connect which requires zeroconf/mDNS on your LAN. The discovery traffic doesn't cross docker's bridge network so you need to use host networking, macvlan or ipvlan.

These aren't available on Docker Desktop for Mac or Windows which uses VMs/WSL2. If you can get the mdns broadcasts forwarded to the container, it could work. You can also try copying the session data from another deployment and it might work.

### Do I need PipeWire on a headless Linux box, and how do I run it?

Yes and No - Spotify Soloist requires PipeWire, so you need to have it on the host, which is honestly a pain on a headless system. If you don't want to bother with it - run the docker version here, it'll take care of it for you as long as you pass through the sound devices as per the `docker-compose.yml` example above.

### Is there HTTPS/TLS?

I've not included it as it was extra configuration and more services inside the container, but if you do want to do this, I'd suggest using [Caddy](https://caddyserver.com/) as a reverse proxy for it and just forwarding traffic through. Caddy supports auto-HTTPS using ACME HTTP and DNS challenges with LetsEncrypt.

### I have a valid API key, but playback says "Authentication required" and reports `logged_in: false`. What's wrong?

The API key authorizes the app but doesn't log you into Spotify. To log you into Spotify and auth, you need to open Spotify on a device on the same network (or can do mdns broadcast to the Soloist instance). It will then show up as a standard device you can select in Spotify.

### Is there HTTPS or TLS?
No. The proxy serves plain HTTP and WebSocket with no built-in TLS. If you want HTTPS — for example to expose the console or overlay beyond your LAN — put your own reverse proxy (Caddy, nginx, Traefik) in front and terminate TLS there.

### Why does it download Soloist on startup?

The Soloist license from Spotify doesn't allow distribution of Soloist, and builds are only valid for 90 days, so Soloist Proxy manages this by downloading it on first run and keeping it up to date.

### What is Music Party?

[Music Party](https://github.com/mintopia/musicparty) is my collaborative jukebox intended for LAN parties. It uses Discord to authenticate users and then allows people to upvote and downvote music. It's always needed to either poll the Spotify API or used various hacky methods to get live updates from Spotify - and this solves it.

## Links

- Spotify Soloist — https://developer.spotify.com/documentation/soloist
- Snapcast — https://github.com/badaix/snapcast
- LRCLIB - https://lrclib.net

## License

[MIT](LICENSE) © 2026 Jessica Smith
