# Beam - WebRTC file sharing (with text chat)

Beam is a lightweight browser-to-browser WebRTC app: text chat plus peer-to-peer
file transfer. Signal exchange happens through a small Node.js WebSocket signaling
server, so two browsers can open a data channel without needing a third-party
browser-signaling service.

This project ships a light UI (Space Grotesk, warm paper palette) and is
intended to be easy to host on a small Node.js platform or run locally with
Docker Compose.

## What is in this repo

- `client/` - static frontend (HTML, CSS, JS). The signaling server serves it.
- `server/index.js` - signaling + static serving only. Photonics/WebRTC lives in
  the browser.

### Features

- WebRTC data channels for chat and file transfer.
- Browser-to-browser file transfer with SHA-256 verification and progress UI.
- Room-based sessions (client IDs are server-assigned).
- Optional TURN support and Google STUN by default.

## Local development

From the project root:

```bash
npm install
npm start
```

That starts the signaling server on `http://localhost:8080`, which also serves
the client directory as static files. Open the same URL in two tabs/browsers,
enter a shared room name, and you should be able to chat and send files.

## TURN / WebRTC connectivity

### Local development with coturn

The default local setup uses coturn via Docker Compose. The server reads its TURN
settings from a `.env` file (see `.env.example`). The client builds a coturn TURN
candidate URL from the page's own hostname/port only during local development, so
coturn typically needs to run on the same machine the browser is on.

For TURN testing, set `?relay=1` in the URL so ICE is forced to use relay
candidates instead of trying host/srflx candidates first.

### Production / external TURN provider

In production, the server no longer synthesizes `turn:<host>:3478` from the
page host. Instead:

- The client always includes the Google STUN servers.
- If the deployment has configured TURN, the server can expose a `/turn-credentials`
  endpoint. The client fetches credentials from there once per page load and never
  embeds long-term TURN credentials in the page HTML/JS.
- A TURN provider should issue short-lived credentials where possible. The server
  helper `getTurnCredentialsSync` is where that minting lives; for a long-term
  credential provider you can set `TURN_USERNAME` and `TURN_CREDENTIAL` in the
  server's environment and let the endpoint return those values. The client treats
  the response as opaque credentials (urls + username + credential) and sends them
  straight to the WebRTC layer.

### What to put in the env

See `.env.example`. Relevant keys:

- `PORT` - server listen port (default 8080).
- `HOST` - interface to bind (default `0.0.0.0`). This is important for Render,
  which expects the process to listen on the port it assigns and on `0.0.0.0`.
- TURN keys - `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, and optionally
  `TURN_API_SECRET` for a provider-specific short-lived credential path.

## Hosting notes

- This app is a static site plus a WebSocket signaling server. A host that serves
  Node.js + static files is the natural fit.
- WebRTC needs a real public URL. Local testing over plain `localhost` works; for
  cross-device testing you usually need a reachable URL and WSS for signaling when
  the page is served over HTTPS. WebRTC candidates themselves are not tied to the
  signaling scheme, but browsers are picky about mixed content in some setups.
- If you host behind a proxy, make sure the WebSocket upgrade path reaches the
  Node process.

## Security posture

- The client does not ship permanent TURN credentials in the page by default.
- Client IDs are server-assigned; the browser does not choose its own identity.
- WebSocket messages are capped at 256 KB.
- Room IDs and client IDs are validated before use.
- DOM is written with safe text nodes and attributes rather than raw HTML where
  possible.
- Static file serving is limited to the client directory. Do not serve this app
  from a directory that contains secrets.

## File-based knowledge

- `PROJECT_REPORT.md` - an auto-generated structural summary of the repo.
- `.env.example` - the env layout to copy into `.env` for local use.

## Backlog / decisions

- The TURN credential endpoint is intentionally generic. The actual minting logic
  is the part that depends on which provider you use, so it is a small server-side
  helper rather than a full integration.
- Local coturn remains the default local path; production should prefer an external
  TURN provider and short-lived credentials rather than long-term static ones.
