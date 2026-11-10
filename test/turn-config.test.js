'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const configSource = fs.readFileSync(path.join(root, 'client/js/config.js'), 'utf8');

function loadConfig({ hostname = 'beam.example.com', search = '', fetchImpl } = {}) {
  const sandbox = {
    window: {
      location: {
        protocol: 'https:',
        hostname,
        port: '',
        search,
      },
    },
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl || (async () => ({ ok: false, status: 404 })),
  };
  vm.createContext(sandbox);
  vm.runInContext(configSource, sandbox);
  return sandbox.window.CHAT_CONFIG;
}

function runtimeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('normalizes TURN URLs with and without transport parameters', () => {
  const config = loadConfig();
  assert.equal(config.normalizeTurnUrl('turn:relay.example.test:3478').urls[0], 'turn:relay.example.test:3478');
  assert.equal(
    config.normalizeTurnUrl('turn:relay.example.test:80?transport=udp').urls[0],
    'turn:relay.example.test:80?transport=udp'
  );
  assert.equal(
    config.normalizeTurnUrl('turn:relay.example.test:80?transport=tcp').urls[0],
    'turn:relay.example.test:80?transport=tcp'
  );
  assert.equal(
    config.normalizeTurnUrl('turns:relay.example.test:443?transport=tcp').urls[0],
    'turns:relay.example.test:443?transport=tcp'
  );
  assert.equal(config.normalizeTurnUrl('turn:relay.example.test:3478?u=user&p=password'), null);
  assert.equal(config.normalizeTurnUrl('turn:relay.example.test:3478?transport=tls'), null);
});

test('loads credentials asynchronously once and preserves Google STUN', async () => {
  let fetchCount = 0;
  let resolveResponse;
  const config = loadConfig({
    fetchImpl: () => {
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  });

  const first = config.loadTurnRuntimeConfig();
  const second = config.loadTurnRuntimeConfig();
  assert.equal(typeof first.then, 'function');
  assert.equal(fetchCount, 1);
  let completed = false;
  const resolved = config.resolveIceConfiguration().then((result) => {
    completed = true;
    return result;
  });
  assert.equal(completed, false);

  resolveResponse(
    runtimeResponse({
      urls: [
        'turn:relay.example.test:80?transport=udp',
        'turn:relay.example.test:80?transport=tcp',
        'turns:relay.example.test:443?transport=tcp',
      ],
      username: 'temporary-user',
      credential: 'temporary-password',
      ttl: 300,
    })
  );

  const [credentials, sharedCredentials, ice] = await Promise.all([first, second, resolved]);
  assert.equal(credentials, sharedCredentials);
  assert.equal(fetchCount, 1);
  assert.equal(ice.turnConfigured, true);
  assert.equal(ice.ttl, 300);
  assert.equal(ice.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  assert.equal(ice.iceServers[1].urls, 'stun:stun1.l.google.com:19302');
  assert.equal(ice.iceServers[2].urls.length, 3);
  assert.equal(ice.iceServers[2].username, 'temporary-user');
});

test('falls back visibly to STUN when remote TURN credentials fail', async () => {
  const config = loadConfig({
    fetchImpl: async () => runtimeResponse({ error: 'unavailable' }, 503),
  });
  const result = await config.resolveIceConfiguration();
  assert.equal(result.turnConfigured, false);
  assert.match(result.warning, /HTTP 503/);
  assert.equal(result.iceServers.length, 2);
  assert.equal(result.iceServers.every((server) => server.urls.startsWith('stun:')), true);
});

test('refreshes runtime TURN credentials when an expiring credential is replaced', async () => {
  let fetchCount = 0;
  const config = loadConfig({
    fetchImpl: async () => {
      fetchCount += 1;
      return runtimeResponse({
        urls: ['turn:relay.example.test:3478'],
        username: `temporary-user-${fetchCount}`,
        credential: `temporary-password-${fetchCount}`,
        ttl: 600,
      });
    },
  });

  const initial = await config.resolveIceConfiguration();
  const refreshed = await config.refreshTurnConfiguration();
  assert.equal(fetchCount, 2);
  assert.equal(initial.iceServers[2].username, 'temporary-user-1');
  assert.equal(refreshed.iceServers[2].username, 'temporary-user-2');
  assert.equal(refreshed.ttl, 600);
});

test('uses local coturn only on localhost and accepts local URL overrides', async () => {
  const override = loadConfig({
    hostname: 'localhost',
    search: '?turnUrls=turn%3A127.0.0.1%3A3478%3Ftransport%3Dudp',
    fetchImpl: async () => {
      throw new Error('URL overrides should not fetch credentials');
    },
  });
  const overridden = await override.resolveIceConfiguration();
  assert.equal(overridden.source, 'local-url-override');
  assert.equal(overridden.iceServers.at(-1).urls[0], 'turn:127.0.0.1:3478?transport=udp');

  const local = loadConfig({ hostname: 'localhost' });
  const localResult = await local.resolveIceConfiguration();
  assert.equal(localResult.source, 'local-coturn');
  assert.equal(localResult.iceServers.at(-1).urls[0], 'turn:localhost:3478');

  const remote = loadConfig({
    hostname: 'beam.example.com',
    search: '?turnUrls=turn%3A127.0.0.1%3A3478',
  });
  const remoteResult = await remote.resolveIceConfiguration();
  assert.equal(remoteResult.turnConfigured, false);
  assert.equal(remoteResult.iceServers.length, 2);
});

test('waits for ICE configuration before starting signaling or creating peer sessions', async () => {
  const appSource = fs.readFileSync(path.join(root, 'client/js/app.js'), 'utf8');
  let finishIceConfig;
  let joinHandler;
  let currentSignaling;
  let peerConfiguration;
  let peerSessionOptions;
  let peerCreateCount = 0;
  let sendHandler;
  let fileHandler;
  const sentMessages = [];
  let fileSent = false;
  const statusCalls = [];
  const ui = new Proxy(
    {
      setPeerStatus(state, detail) {
        statusCalls.push({ state, detail });
      },
      onJoinSubmit(handler) {
        joinHandler = handler;
      },
      onSend(handler) {
        sendHandler = handler;
      },
      onFileSelected(handler) {
        fileHandler = handler;
      },
    },
    {
      get(target, property) {
        if (property in target) return target[property];
        return () => {};
      },
    }
  );
  const sandbox = {
    window: {
      CHAT_CONFIG: {
        fileTransfer: {},
        iceTransportPolicy: 'all',
        resolveIceConfiguration: () =>
          new Promise((resolve) => {
            finishIceConfig = resolve;
          }),
      },
      ChatUI: ui,
      location: {
        search: '?relay=1&turnCredential=permanent-secret&p=top-level-secret&turnUrls=turn%3Arelay.example.test%3A3478%3Fu%3Dname%26p%3Dsecret',
        href: 'https://beam.example.com/?relay=1&turnCredential=permanent-secret&p=top-level-secret&turnUrls=turn%3Arelay.example.test%3A3478%3Fu%3Dname%26p%3Dsecret',
        protocol: 'https:',
        hostname: 'beam.example.com',
      },
      history: {
        replaceState(_state, _title, url) {
          const nextUrl = new URL(url);
          sandbox.window.location.href = nextUrl.toString();
          sandbox.window.location.search = nextUrl.search;
        },
      },
      addEventListener() {},
      Signaling: class FakeSignaling {
        constructor() {
          currentSignaling = this;
          this.listeners = new Map();
        }
        on(type, handler) {
          if (!this.listeners.has(type)) this.listeners.set(type, []);
          this.listeners.get(type).push(handler);
          return this;
        }
        connect() {}
        stop() {}
        send() {}
        emit(type, payload) {
          for (const handler of this.listeners.get(type) || []) handler(payload);
        }
      },
      createPeerSession(options) {
        peerCreateCount += 1;
        peerSessionOptions = options;
        peerConfiguration = options.configuration;
        return {
          handleSignal() {},
          close() {},
          restartIce() {},
          isOpen: () => true,
        };
      },
      createFileTransfer() {
        return {
          isSending: () => false,
          sendFile: async () => {
            fileSent = true;
          },
        };
      },
    },
    document: {
      getElementById: () => ({ addEventListener() {} }),
    },
    URL,
    URLSearchParams,
    Map,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => 'test-client-id' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);

  assert.equal(sandbox.window.location.href.includes('permanent-secret'), false);
  assert.equal(sandbox.window.location.href.includes('top-level-secret'), false);
  assert.equal(sandbox.window.location.href.includes('turnUrls'), false);
  assert.equal(joinHandler, undefined);
  assert.equal(currentSignaling, undefined);
  const loadedIceConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:relay.example.test:3478', username: 'u', credential: 'p' },
    ],
    turnConfigured: true,
    warning: '',
  };
  finishIceConfig(loadedIceConfiguration);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof joinHandler, 'function');
  joinHandler('test-room');
  assert.ok(currentSignaling);
  assert.equal(peerConfiguration, undefined);
  currentSignaling.emit('joined', { peerId: 1, limit: 4, peers: [] });
  currentSignaling.emit('peer-joined', { peerId: 2, clientId: 'remote-client-id' });
  assert.equal(peerConfiguration.iceTransportPolicy, 'relay');
  assert.equal(peerConfiguration.iceServers.length, 2);

  const channel = {
    readyState: 'open',
    binaryType: '',
    addEventListener() {},
    send(message) {
      sentMessages.push(message);
    },
  };
  peerSessionOptions.onChannel(channel);
  assert.equal(typeof sendHandler, 'function');
  assert.equal(typeof fileHandler, 'function');
  assert.equal(sendHandler('hello'), true);
  assert.equal(JSON.parse(sentMessages[0]).text, 'hello');
  fileHandler({ name: 'sample.txt', size: 3, type: 'text/plain' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fileSent, true);

  loadedIceConfiguration.turnConfigured = false;
  loadedIceConfiguration.warning = 'TURN unavailable; STUN only.';
  currentSignaling.emit('peer-joined', { peerId: 3, clientId: 'another-client-id' });
  assert.equal(peerCreateCount, 1);
  assert.equal(statusCalls.at(-1).state, 'error');
  assert.match(statusCalls.at(-1).detail, /requires a configured TURN server/);
});
