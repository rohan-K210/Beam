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
- `server/index.js` - signaling, static serving, and the TURN credential route.
- `server/turn-credentials.js` - provider credential validation and rate limiting.

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

The included Docker Compose service starts coturn on port 3478. On a page served
from `localhost`, Beam uses `turn:localhost:3478` and the development-only
`chat` / `chatpass` credentials. The local TURN server is never inferred for a
non-local hostname.

To try alternate TURN URLs locally, pass URL-encoded `turnUrls` parameters, for
example:

```text
http://localhost:8080/?room=demo&turnUrls=turn%3A127.0.0.1%3A3478%3Ftransport%3Dudp
```

Overrides are accepted only on localhost and use the local development
credentials. Do not put account keys, TURN passwords, or other permanent
credentials in URLs; URLs can be retained in browser history and logs. Custom
local coturn credentials should be supplied through the server environment:
set `TURN_USER` / `TURN_PASS` for Docker Compose and matching
`TURN_URLS=turn:localhost:3478`, `TURN_USERNAME`, and `TURN_CREDENTIAL` values
for the Node credential endpoint.

### Production with Metered TURN

1. Create a TURN credential in Metered and copy its app name and TURN credential
   API key from the dashboard.
2. Set `METERED_APP_NAME` and `METERED_API_KEY` in the Node service's environment
   (or its secret manager). Do not put the key in frontend JavaScript, shareable
   browser URLs, or committed files. `.env.example` contains blank placeholders only.
3. Serve Beam over HTTPS so the same-origin `/turn-credentials` request is
   available securely.

Before any peer connection is created, the browser requests
`/turn-credentials`. The backend calls Metered's
[TURN credential API](https://www.metered.ca/docs/turn-rest-api/get-credential/)
using the environment-only API key, validates the response, and returns only
TURN URLs and ICE credentials. It does not log the key or credentials. Metered
may return UDP, TCP, and TLS-capable (`turns:`) URLs; Beam retains the TURN
transports and continues to include Google's STUN servers.

Metered's credential API response does not document an expiry field in its
standard URL list. If the provider supplies a positive `ttl`, `expiresIn`, or
`credentialTtl` value, Beam validates it and refreshes the credentials before
expiry. Otherwise configure credential rotation in Metered according to its
[rotation guide](https://www.metered.ca/docs/turnserver-guides/rotating-turn-credentials/).
Do not treat an API key as an expiring ICE credential.

For manual TURN setups, set `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL`
on the server. These are returned via the same endpoint; use short-lived
credentials where your provider supports them. Leave all TURN variables blank
for explicit STUN-only operation. The endpoint is limited to 30 requests per
minute per source IP and returns `Cache-Control: no-store`.

To force relay-only ICE, append `&relay=1` to the room URL. If TURN credentials
are unavailable, Beam reports that state and does not create peer connections
with an unusable relay-only configuration. With the default `all` policy, it
falls back to Google STUN and clearly reports that TURN is unavailable.

### Server environment

See `.env.example`. `PORT` defaults to 8080 and `HOST` to `0.0.0.0`. Production
TURN credentials belong in the hosting provider's environment/secrets manager;
never commit a real key or password.

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

- The Metered API key stays on the server and is not included in frontend assets,
  shareable browser URLs, or client responses. TURN credentials are necessarily
  delivered to the browser for ICE; use provider-managed temporary credentials and
  rotation.
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

## TURN credential handling

- Managed Metered credentials are requested server-side from the documented API.
- Static `TURN_USERNAME` / `TURN_CREDENTIAL` values are supported for manually
  configured providers, but are returned to browsers and should not be used as
  permanent production secrets.
- Local coturn credentials are development-only.
