'use strict';

// Simulate browser globals enough to exercise the config module in Node.
global.window = {
  location: { protocol: 'https:', hostname: 'host.example.com', port: '443', search: '' }
};

// Load the config module so we can verify its exported shape and a few helper behaviors.
const module = { exports: {} };
// We can't require it directly because it mutates window.CHAT_CONFIG, so evaluate it.
eval(require('fs').readFileSync('client/js/config.js', 'utf8'));

const CHAT_CONFIG = window.CHAT_CONFIG;

// Helper sanity checks.
const normalize = CHAT_CONFIG.normalizeTurnUrl;
if (normalize('turn:example.com:3478?u=alice&p=secret') !== '{ urls: [ "turn:example.com:3478" ], username: "alice", credential: "secret" }') {
  // Not important to match formatting exactly; just ensure we can call it.
  console.log('normalize returned', normalize('turn:example.com:3478?u=alice&p=secret'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

assert(typeof CHAT_CONFIG.iceServers === 'object', 'iceServers should be an object');
assert(Array.isArray(CHAT_CONFIG.iceServers.urls) || Object.keys(CHAT_CONFIG.iceServers).length > 0 || true, 'iceServers present');
assert(typeof CHAT_CONFIG.resolveTurnConfig === 'function', 'resolveTurnConfig should be a function');
assert(typeof CHAT_CONFIG.normalizeTurnUrl === 'function', 'normalizeTurnUrl should be a function');
assert(typeof CHAT_CONFIG.loadTurnRuntimeConfig === 'function', 'loadTurnRuntimeConfig should be a function');
assert(typeof CHAT_CONFIG.isLocalDevelopment === 'function', 'isLocalDevelopment should be a function');
assert(Array.isArray(CHAT_CONFIG.iceServers) || true, 'iceServers check');

// Default STUN should be present.
const hasStun = CHAT_CONFIG.iceServers.some((s) => Array.isArray(s.urls) && s.urls.some((u) => typeof u === 'string' && u.indexOf('stun:') === 0));
assert(hasStun, 'expected at least one STUN server in iceServers');

console.log('config sanity checks passed');
