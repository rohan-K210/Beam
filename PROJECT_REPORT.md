# Project Report

## Beam

Beam is a small browser WebRTC collaboration app: peer-to-peer file transfer and
text chat over data channels, with a Node.js WebSocket signaling server and static
frontend. The visual system was reworked around a light palette (Space Grotesk
headline font, paper/ink-navy/slate/signal-orange/warm-grey/muted-text palette)
and then the backend and client ICE/TURN layer were adjusted so the same app can be
hosted on a managed Node.js platform instead of only running locally.

## Stack

- **Frontend:** HTML + vanilla JS + CSS in `client/`. WebRTC is browser-to-browser;
  signaling is WebSocket. File transfer runs over WebRTC data channels with SHA-256
  verification.
- **Backend:** Node.js HTTP server + WebSocket signaling in `server/index.js`. It
  also serves the client directory as static files.
- **Runtime hosting target:** a Render Free Web Service style Node.js process
  (default `PORT=8080`, bind `0.0.0.0`). Static site and signaling share the same
  process.
- **WebRTC connectivity:** Google STUN by default; optional external managed TURN;
  local coturn in development via Docker Compose.

## Key files

- `client/index.html` - page shell, Google Fonts link for Space Grotesk, canvas/UI
  wiring.
- `client/styles.css` - visual system: light palette, typography, chat/message
  layout, file-transfer cards, buttons, status, topbar, sidebar, overlay,
  responsive breakpoints.
- `client/js/app.js` - page wiring: room form, relay mode, exit behavior, uses
  `CHAT_CONFIG.iceServers` and `?signal=` / `?relay=1`.
- `client/js/config.js` - ICE servers, TURN resolution, signaling URL, file-transfer
  and reconnect settings. TURN is now runtime-resolved and does not synthesize a
  production `turn:<host>:3478` URL from the page host.
- `client/js/file-transfer.js` - file transfer logic and verification.
- `client/js/ui.js` - DOM/text UI helpers.
- `client/js/peer.js` - WebRTC peer/connection logic.
- `client/js/signaling.js` - WebSocket signaling client.
- `server/index.js` - signaling server, static file serving, optional
  `/turn-credentials` endpoint, TURN env handling.
- `docker-compose.yml` - local coturn run configuration.
- `.env.example` - env layout for local and deployment use.
- `.gitignore` - excludes `.env`.

## Current state

- UI rewrite to the light palette + Space Grotesk is in place.
- Deployment/TURN work is in progress: server reads TURN env vars and can expose
  `/turn-credentials`; client resolves TURN at runtime and falls back to STUN only
  when no TURN is configured. Local coturn behavior is preserved for development.
- The remaining work is docs + verification, especially `.env.example`, README, and
  confirmatory local tests for signaling, chat, file transfer, coturn path, and the
  absence of permanent credentials in client assets.

## Local run

```bash
npm install
npm start
```

That serves the client at `http://localhost:8080` and runs WebSocket signaling.

## Security notes

- Permanent TURN credentials are not embedded in the page by default.
- Client identities are server-assigned.
- WebSocket payload is capped at 256 KB.
- Room/client IDs are validated.
- Static serving is scoped to the client directory.

## Known limitations

- WebRTC needs a reachable URL for cross-device use; plain localhost works for local
  testing.
- The TURN credential source itself is provider-specific and is intentionally kept as
  a small server-side helper rather than a full integration.
