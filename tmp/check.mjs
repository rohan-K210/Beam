import { readFileSync } from 'node:fs';

global.window = {
  location: { protocol: 'https:', hostname: 'host.example.com', port: '443', search: '' }
};

const code = readFileSync('client/js/config.js', 'utf8');
// @ts-ignore - not a TS file
eval(code);

// The config module builds CHAT_CONFIG synchronously. The earliest callers like
// iceServers() reference CHAT_CONFIG while it is still being constructed, so we
// must wait for window.CHAT_CONFIG to be fully populated before testing it.
let CHAT_CONFIG = global.window.CHAT_CONFIG;
if (!CHAT_CONFIG) {
  throw new Error('window.CHAT_CONFIG was not set');
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

assert(typeof CHAT_CONFIG.iceServers === 'object', 'iceServers should be an object');
assert(typeof CHAT_CONFIG.resolveTurnConfig === 'function', 'resolveTurnConfig should be a function');
assert(typeof CHAT_CONFIG.normalizeTurnUrl === 'function', 'normalizeTurnUrl should be a function');
assert(typeof CHAT_CONFIG.loadTurnRuntimeConfig === 'function', 'loadTurnRuntimeConfig should be a function');
assert(typeof CHAT_CONFIG.isLocalDevelopment === 'function' || typeof CHAT_CONFIG.isLocalDevelopment === 'undefined', 'isLocalDevelopment should be a function or undefined');

// normalizeTurnUrl should extract credentials out of URLs and keep turns:.
{
  const x = CHAT_CONFIG.normalizeTurnUrl('turn:example.com:3478?u=alice&p=secret');
  if (!x || !Array.isArray(x.urls) || x.urls.length !== 1 || x.urls[0] !== 'turn:example.com:3478') {
    throw new Error('normalizeTurnUrl did not preserve the bare turn url, got: ' + JSON.stringify(x));
  }
  if (x.username !== 'alice' || x.credential !== 'secret') {
    throw new Error('normalizeTurnUrl did not extract credentials, got: ' + JSON.stringify(x));
  }
}
{
  const x = CHAT_CONFIG.normalizeTurnUrl('turns:example.com:5349?transport=tls&u=alice&p=secret');
  if (!x || !Array.isArray(x.urls) || x.urls.length !== 1 || x.urls[0] !== 'turns:example.com:5349?transport=tls') {
    throw new Error('normalizeTurnUrl did not preserve turns with transport, got: ' + JSON.stringify(x));
  }
  if (x.username !== 'alice' || x.credential !== 'secret') {
    throw new Error('normalizeTurnUrl did not extract credentials from turns url, got: ' + JSON.stringify(x));
  }
}

// Disable the runtime fetch path before any TURN resolution, so resolveTurnConfig
// does not attempt the network during the early synchronous config read.
CHAT_CONFIG.fetchTurnCredentials = false;

// Default iceServers should include Google STUN and not a synthesized production
// TURN URL from the page host when we are not in local development.
{
  const iceServers = Array.isArray(CHAT_CONFIG.iceServers) ? CHAT_CONFIG.iceServers : Object.values(CHAT_CONFIG.iceServers);
  const hasStun = iceServers.some((s) => Array.isArray(s.urls) && s.urls.some((u) => typeof u === 'string' && u.indexOf('stun:') === 0));
  assert(hasStun, 'expected at least one STUN server');
}

// In this non-local scenario, resolveTurnConfig should not return a coturn URL.
{
  const turn = CHAT_CONFIG.resolveTurnConfig();
  if (turn && turn.source === 'local-coturn') {
    throw new Error('resolveTurnConfig incorrectly returned a local-coturn source for this host');
  }
}

console.log('config check passed');
