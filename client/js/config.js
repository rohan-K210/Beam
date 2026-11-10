'use strict';

/**
 * Central client configuration. Edit this file, or override per session from
 * the URL query string:
 *
 *   ?signal=wss://my-tunnel.example.com   signaling server URL
 *   ?relay=1                              force iceTransportPolicy: "relay"
 *   ?room=demo                            join a room without the form
 *   ?turnUrls=turn:my-turn.example.com:3478?u=username&p=password  override TURN URLs
 *
 * Signaling URL defaults to ws://localhost:8080, matching `npm start`.
 */
window.CHAT_CONFIG = {
  signalingUrl: (function () {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hostname = window.location.hostname || 'localhost';
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${protocol}//${hostname}${port}`;
  })(),

  /** ... */

  iceServers: (function () {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    let turnConfig = null;
    try {
      turnConfig = CHAT_CONFIG.resolveTurnConfig();
    } catch (e) {
      turnConfig = null;
    }
    if (!turnConfig) return iceServers;

    const urls = turnConfig.urls
      .map(function (raw) { return CHAT_CONFIG.normalizeTurnUrl(raw); })
      .filter(Boolean);
    if (urls.length === 0) return iceServers;

    iceServers.push({
      urls,
      username: turnConfig.username,
      credential: turnConfig.credential,
    });
    return iceServers;
  })(),

  resolveTurnConfig: function () {
    const params = new URLSearchParams(window.location.search);
    const urlOverride = params.get('turnUrls');
    const usernameOverride = params.get('turnUsername');
    const credentialOverride = params.get('turnCredential');

    if (urlOverride && urlOverride.trim()) {
      const urls = urlOverride.split(',').map((u) => u.trim()).filter(Boolean);
      if (urls.length) {
        let out = {
          urls,
          username: usernameOverride || 'chat',
          credential: credentialOverride || 'chatpass',
          source: 'url-override',
        };
        for (const u of urls) {
          const parsed = CHAT_CONFIG.normalizeTurnUrl(u);
          if (parsed && parsed.username) out.username = parsed.username;
          if (parsed && parsed.credential) out.credential = parsed.credential;
        }
        urlOverride = null;
        return out;
      }
    }

    if (CHAT_CONFIG.fetchTurnCredentials !== false && typeof CHAT_CONFIG.loadTurnRuntimeConfig === 'function') {
      const runtime = CHAT_CONFIG.loadTurnRuntimeConfig();
      if (runtime && runtime.urls && runtime.urls.length) {
        return {
          urls: runtime.urls,
          username: runtime.username || 'chat',
          credential: runtime.credential || 'chatpass',
          source: 'runtime',
          ttl: runtime.ttl,
        };
      }
    }

    // Local development only.
    if (typeof CHAT_CONFIG.isLocalDevelopment === 'function' && CHAT_CONFIG.isLocalDevelopment()) {
      return {
        urls: [`turn:${window.location.hostname || 'localhost'}:3478`],
        username: 'chat',
        credential: 'chatpass',
        source: 'local-coturn',
      };
    }

    return null;
  },

  normalizeTurnUrl: function (raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let s = raw.trim();

    if (s.indexOf('//') === 0) {
      s = s.slice(2);
    }

    const colonAt = s.indexOf(':');
    const questionAt = s.indexOf('?');
    if (colonAt < 0 || (questionAt >= 0 && colonAt >= questionAt)) {
      return null;
    }
    if (colonAt <= 0 || colonAt >= questionAt) {
      return null;
    }

    const scheme = s.slice(0, colonAt);
    const afterScheme = s.slice(colonAt + 1);

    if (scheme !== 'turn' && scheme !== 'turns') {
      return null;
    }

    let hostAndPort = afterScheme;
    let queryString = null;

    if (questionAt > 0) {
      hostAndPort = afterScheme.slice(0, questionAt);
      queryString = afterScheme.slice(questionAt + 1);
    } else {
      queryString = '';
    }
    if (hostAndPort.trim() === '') {
      return null;
    }
    hostAndPort = hostAndPort.trim();

    let transport = null;
    let username = null;
    let credential = null;

    let turnUrl = scheme + ':' + hostAndPort;

    if (queryString && queryString.length > 0) {
      const q = new URLSearchParams(queryString);
      if (q.has('transport')) {
        transport = String(q.get('transport')).trim();
        if (!['udp', 'tcp', 'tls'].includes(transport)) {
          transport = null;
        }
      }
      const u = q.get('u') || q.get('username');
      const p = q.get('p') || q.get('password');
      if (u != null && u !== '') {
        username = u;
      }
      if (p != null && p !== '') {
        credential = p;
      }
    }

    // second declaration removed
    if (transport !== null) {
      turnUrl = turnUrl + '?transport=' + transport;
    }

    const out = { urls: [turnUrl] };
    if (username) out.username = username;
    if (credential) out.credential = credential;
    return out;
  },

  _turnRuntimeConfigCached: null,
  _turnRuntimeConfigFetching: false,

  loadTurnRuntimeConfig: (function () {
    return function () {
      if (CHAT_CONFIG._turnRuntimeConfigCached) return CHAT_CONFIG._turnRuntimeConfigCached;
      if (CHAT_CONFIG._turnRuntimeConfigFetching) return null;

      CHAT_CONFIG._turnRuntimeConfigFetching = true;
      let fetchingForThisCall = true;

      let promise;
      try {
        promise = fetch('/turn-credentials', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          redirect: 'follow',
        });
      } catch (e) {
        CHAT_CONFIG._turnRuntimeConfigFetching = false;
        fetchingForThisCall = false;
        return null;
      }

      return promise
        .then(function (response) {
          if (!response || !response.ok) {
            return null;
          }
          return response.json().catch(function () { return null; });
        })
        .then(function (body) {
          if (!body || typeof body !== 'object') {
            CHAT_CONFIG._turnRuntimeConfigCached = null;
            CHAT_CONFIG._turnRuntimeConfigFetching = false;
            return null;
          }

          const urls = (
            Array.isArray(body.urls) ?
              body.urls :
              Array.isArray(body.turnUrls) ?
              body.turnUrls :
              []
          );
          const entries = urls.filter(function (u) { return typeof u === 'string'; });
          const credentials = body.credentials || body;
          const username = credentials.username || body.username || null;
          const credential = credentials.credential || credentials.password || body.credential || body.password || null;

          const frozen = {
            urls: entries,
            username: username || null,
            credential: credential || null,
            ttl: body.ttl || body.credentialTtl || null,
            source: 'runtime',
          };
          CHAT_CONFIG._turnRuntimeConfigCached = frozen;
          CHAT_CONFIG._turnRuntimeConfigFetching = false;
          fetchingForThisCall = false;
          return frozen;
        })
        .catch(function () {
          if (!CHAT_CONFIG._turnRuntimeConfigCached && !fetchingForThisCall) {
            CHAT_CONFIG._turnRuntimeConfigCached = null;
          }
          CHAT_CONFIG._turnRuntimeConfigFetching = false;
          return null;
        });
    };
  })(),

  fetchTurnCredentials: true,

  iceTransportPolicy: 'all',

  fileTransfer: {
    chunkSize: 16 * 1024,
    bufferHighWaterMark: 1024 * 1024,
    bufferLowWaterMark: 256 * 1024,
    maxFileBytes: 100 * 1024 * 1024,
  },

  reconnect: {
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
  },
};
