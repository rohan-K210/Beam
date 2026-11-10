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
- `client/js/app.js` - page wiring: room form, relay mode, exit behavior, waits for
  `CHAT_CONFIG.resolveIceConfiguration()` and supports `?signal=` / `?relay=1`.
- `client/js/config.js` - ICE servers, async TURN resolution, signaling URL,
  file-transfer and reconnect settings. Only localhost uses the development coturn
  fallback; remote deployments never synthesize a TURN URL from the page host.
- `client/js/file-transfer.js` - file transfer logic and verification.
- `client/js/ui.js` - DOM/text UI helpers.
- `client/js/peer.js` - WebRTC peer/connection logic.
- `client/js/signaling.js` - WebSocket signaling client.
- `server/index.js` - signaling server and static file serving.
- `server/turn-credentials.js` - validated Metered/static TURN credential endpoint
  with per-IP rate limiting.
- `docker-compose.yml` - local coturn run configuration.
- `.env.example` - env layout for local and deployment use.
- `.gitignore` - excludes `.env`.

## Current state

- UI rewrite to the light palette + Space Grotesk is in place.
- TURN configuration is asynchronous: peer connections wait for credentials,
  Google STUN is always retained, expiring credentials are refreshed, and failures
  are surfaced while normal policy falls back to STUN. Relay-only policy is
  rejected if TURN is unavailable.
- Metered API keys are read only by the server from its environment. Local coturn
  remains a localhost-only development fallback, and URL overrides are limited to
  local testing.
- Automated Node tests cover URL validation, async loading, Metered/static endpoint
  validation and rate limiting, application startup order, relay policy handling,
  and mocked stats-based relay route detection. Live TURN allocation and browser
  chat/file-transfer behavior still require browser/network credentials to verify.

## Local run

```bash
npm install
npm start
```

That serves the client at `http://localhost:8080` and runs WebSocket signaling.

## Security notes

- Metered API keys are server-side only; TURN credentials are delivered to the
  browser at runtime because ICE needs them.
- Client identities are server-assigned.
- WebSocket payload is capped at 256 KB.
- Room/client IDs are validated.
- Static serving is scoped to the client directory.

## Known limitations

- WebRTC needs a reachable URL for cross-device use; plain localhost works for local
  testing.
- Metered's standard credential response does not document expiry in its URL list;
  use Metered rotation or another provider's documented expiring credentials.
