'use strict';

/**
 * Beam signaling server.
 *
 * The server has three jobs:
 *   1. serve the client files, so `npm start` is enough to run the demo;
 *   2. return validated TURN credentials when the deployment is configured;
 *   3. let browsers in the same room exchange WebRTC session descriptions and
 *      ICE candidates, and release seats on intentional departures.
 *
 * Chat text and file bytes NEVER pass through this process. The relay
 * whitelist below is the structural guarantee: only join, leave, offer,
 * answer and candidate are understood, and every offer/answer/candidate is
 * addressed to one specific peer. Anything else, including { type: 'chat' },
 * is dropped.
 *
 * Client -> server: join, leave, offer, answer, candidate
 * Server -> client: joined, peer-joined, peer-left, full, error
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createTurnCredentialsHandler } = require('./turn-credentials');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');

const handleTurnCredentials = createTurnCredentialsHandler();

/** Small meshes stay manageable; raise deliberately for larger demos. */
const MAX_PEERS_PER_ROOM = clamp(
  Number.parseInt(process.env.MAX_PEERS_PER_ROOM || '4', 10) || 4,
  2,
  8
);

/**
 * When a socket closes we keep the member's seat and peer id for a short
 * grace period. A client that reconnects within this window resumes the same
 * identity, so existing peer connections are not torn down and rebuilt.
 */
const PEER_GRACE_MS = 20_000;

// ws protocol-level heartbeat: browsers answer ping frames automatically.
const HEARTBEAT_INTERVAL_MS = 30_000;

const RELAY_TYPES = new Set(['offer', 'answer', 'candidate']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * room name -> Map<peerId, member>
 * member = { peerId, clientId, ws, room, leaveTimer }
 */
const rooms = new Map();

// ---------------------------------------------------------------------------
// Static file server (convenience: it also hosts the WebSocket endpoint)
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (pathname === '/turn-credentials') {
    handleTurnCredentials(req, res);
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(CLIENT_DIR, relative);

  // Path traversal guard: the resolved file must stay inside CLIENT_DIR.
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

// ---------------------------------------------------------------------------
// WebSocket signaling
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.member = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'join') {
      handleJoin(ws, message);
      return;
    }

    if (message.type === 'leave') {
      handleLeave(ws);
      return;
    }

    handleRelay(ws, message);
  });

  ws.on('close', () => handleSocketClose(ws));
  ws.on('error', (err) => log(`socket error: ${err.message}`));
});

function handleJoin(ws, message) {
  if (ws.member) return; // one room per socket

  const room = normalizeRoom(message.room);
  if (!room) {
    send(ws, { type: 'error', code: 'invalid-room', message: 'A room name is required.' });
    return;
  }

  const clientId = normalizeClientId(message.clientId);
  if (!clientId) {
    send(ws, { type: 'error', code: 'invalid-client', message: 'A client id is required.' });
    return;
  }

  let members = rooms.get(room);
  if (!members) {
    members = new Map();
    rooms.set(room, members);
  }

  // Reconnect with the same client id: reuse the seat and peer id. Other
  // participants are not notified, because their DataChannels never died.
  const resumed = [...members.values()].find((member) => member.clientId === clientId);
  if (resumed) {
    clearTimeout(resumed.leaveTimer);
    resumed.leaveTimer = null;

    if (resumed.ws && resumed.ws !== ws) {
      // The same tab opened a second socket; drop the stale one without
      // releasing the room seat.
      const stale = resumed.ws;
      stale.member = null;
      stale.close(4001, 'replaced by a newer connection');
    }

    resumed.ws = ws;
    ws.member = resumed;

    send(ws, {
      type: 'joined',
      room,
      peerId: resumed.peerId,
      clientId,
      resumed: true,
      limit: MAX_PEERS_PER_ROOM,
      peers: otherPeers(members, resumed.peerId),
    });
    log(`peer ${resumed.peerId} resumed room "${room}" (${members.size}/${MAX_PEERS_PER_ROOM})`);
    return;
  }

  if (members.size >= MAX_PEERS_PER_ROOM) {
    send(ws, { type: 'full', room, limit: MAX_PEERS_PER_ROOM });
    return;
  }

  const member = {
    // Random in-room ids instead of a global counter: after a server restart a
    // counter would reuse ids that live client sessions still hold, and a new
    // peer could be mistaken for an old one. Collisions here are negligible.
    peerId: generatePeerId(members),
    clientId,
    room,
    ws,
    leaveTimer: null,
  };
  members.set(member.peerId, member);
  ws.member = member;

  send(ws, {
    type: 'joined',
    room,
    peerId: member.peerId,
    clientId,
    resumed: false,
    limit: MAX_PEERS_PER_ROOM,
    peers: otherPeers(members, member.peerId),
  });

  for (const peer of members.values()) {
    if (peer === member) continue;
    send(peer.ws, {
      type: 'peer-joined',
      peerId: member.peerId,
      clientId: member.clientId,
    });
  }

  log(`peer ${member.peerId} joined room "${room}" (${members.size}/${MAX_PEERS_PER_ROOM})`);
}

/**
 * Relay offer/answer/candidate to exactly one peer. The sender only supplies
 * a target peer id; the server passes its own authenticated socket identity as
 * `from`, so a client cannot impersonate another peer.
 */
function handleRelay(ws, message) {
  const member = ws.member;
  if (!member || !RELAY_TYPES.has(message.type)) return;

  const targetId = Number(message.to);
  if (!Number.isInteger(targetId)) return;

  const target = rooms.get(member.room)?.get(targetId);
  if (!target || target === member || !target.ws) return;

  const outgoing = {
    type: message.type,
    from: member.peerId,
    fromClientId: member.clientId,
  };

  if (message.type === 'candidate') {
    if (!message.candidate || typeof message.candidate !== 'object') return;
    outgoing.candidate = message.candidate;
  } else {
    if (!message.description || typeof message.description !== 'object') return;
    outgoing.description = message.description;
  }

  send(target.ws, outgoing);
}

function handleSocketClose(ws) {
  const member = ws.member;
  if (!member) return;
  ws.member = null;

  // A newer socket already took over this member; do not release the seat.
  if (member.ws !== ws) return;
  member.ws = null;

  member.leaveTimer = setTimeout(() => removeMember(member), PEER_GRACE_MS);
  // Do not keep Node alive just for a grace timer.
  member.leaveTimer.unref?.();
}

function handleLeave(ws) {
  const member = ws.member;
  if (!member) return;

  ws.member = null;
  member.ws = null;
  clearTimeout(member.leaveTimer);
  member.leaveTimer = null;
  removeMember(member);
}

function removeMember(member) {
  const members = rooms.get(member.room);
  if (!members || members.get(member.peerId) !== member) return;
  if (member.ws) return; // resumed while the timer was pending

  members.delete(member.peerId);

  for (const peer of members.values()) {
    send(peer.ws, { type: 'peer-left', peerId: member.peerId });
  }
  if (members.size === 0) rooms.delete(member.room);

  log(`peer ${member.peerId} left room "${member.room}" (${members.size}/${MAX_PEERS_PER_ROOM})`);
}

function generatePeerId(members) {
  let id;
  do {
    id = randomInt(1, 2 ** 31);
  } while (members.has(id));
  return id;
}

function otherPeers(members, selfId) {
  return [...members.values()]
    .filter((member) => member.peerId !== selfId)
    .map((member) => ({ peerId: member.peerId, clientId: member.clientId }));
}

function normalizeRoom(rawRoom) {
  if (typeof rawRoom !== 'string') return null;
  // Control characters are removed; names are opaque keys and are always
  // rendered with textContent on the client.
  const room = rawRoom.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return room || null;
}

function normalizeClientId(rawClientId) {
  if (typeof rawClientId !== 'string') return null;
  const clientId = rawClientId.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(clientId) ? clientId : null;
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Dead-connection cleanup
// ---------------------------------------------------------------------------

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      // Missed a full ping interval: close() is async, terminate() is not.
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

function shutdown() {
  log('shutting down');
  clearInterval(heartbeat);
  for (const members of rooms.values()) {
    for (const member of members.values()) clearTimeout(member.leaveTimer);
  }
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  const proto = process.env.NODE_ENV === 'production' || isHttpsBehindProxy()
    ? 'https'
    : 'http';
  // Log the address the deployment should use, without assuming localhost.
  log(`client      ${proto}://0.0.0.0:${PORT}`);
  log(`signaling   ${proto === 'https' ? 'wss' : 'ws'}://0.0.0.0:${PORT}`);
  log(`listening   ${HOST}:${PORT}`);
  log(`room limit  ${MAX_PEERS_PER_ROOM} peers`);
  const meteredConfigured = Boolean(process.env.METERED_APP_NAME && process.env.METERED_API_KEY);
  const staticTurnConfigured = Boolean(
    process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL
  );
  log(meteredConfigured || staticTurnConfigured ? 'turn        credential endpoint enabled' : 'turn        not configured; STUN only');
});

/**
 * Best-effort inference of whether the deployment is served over TLS.
 *
 * Render terminates TLS at its edge, so the Node process itself sees HTTP. Do
 * not rely on this to decide signaling scheme; the client derives its signaling
 * URL from the page URL instead. This is only used for startup log labels.
 */
function isHttpsBehindProxy() {
  // Render and similar platforms often set standard proxy-forwarded env vars.
  if (
    process.env.NODE_ENV === 'production' &&
    (process.env.RENDER_internal__https !== undefined ||
      process.env.HTTPS === 'on' ||
      process.env.Forwarded ||
      process.env.XForwardedProto)
  ) {
    return true;
  }

  // Fallback: treat the common production hostname hint as a cue, not a rule.
  if (process.env.HOSTNAME && /\.render\.app$/.test(process.env.HOSTNAME)) {
    return true;
  }

  return false;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
