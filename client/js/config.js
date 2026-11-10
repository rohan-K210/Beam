'use strict';

window.CHAT_CONFIG = (function createChatConfig() {
  const GOOGLE_STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const LOCAL_TURN_USERNAME = 'chat';
  const LOCAL_TURN_CREDENTIAL = 'chatpass';
  const TURN_URL_LIMIT = 20;
  const TURN_REFRESH_MARGIN_MS = 30_000;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = window.location.hostname || 'localhost';
  const port = window.location.port ? `:${window.location.port}` : '';
  let turnRuntimePromise = null;
  let turnRuntimeRefreshAt = 0;

  const config = {
    signalingUrl: `${protocol}//${hostname}${port}`,
    iceServers: GOOGLE_STUN_SERVERS,
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

  function isLocalDevelopment() {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
      String(window.location.hostname || '').toLowerCase()
    );
  }

  function normalizeTurnUrl(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    const match = /^(turns?):(?:\/\/)?(\[[0-9a-f:]+\]|[^:/?#@\s]+)(?::(\d{1,5}))?(?:\?([^#]*))?$/i.exec(value);
    if (!match) return null;

    const scheme = match[1].toLowerCase();
    const host = match[2];
    const portValue = match[3];
    const queryString = match[4] || '';
    if (portValue && (Number(portValue) < 1 || Number(portValue) > 65535)) return null;

    let transport = null;
    if (queryString) {
      const query = new URLSearchParams(queryString);
      for (const key of query.keys()) {
        if (!['transport'].includes(key.toLowerCase())) return null;
      }
      if (query.getAll('transport').length > 1) return null;
      if (query.has('transport')) {
        transport = String(query.get('transport')).toLowerCase();
        if (!['udp', 'tcp'].includes(transport)) return null;
        if (scheme === 'turns' && transport !== 'tcp') return null;
      }
    }

    const authority = `${host}${portValue ? `:${portValue}` : ''}`;
    return {
      urls: [`${scheme}:${authority}${transport ? `?transport=${transport}` : ''}`],
    };
  }

  function assertTurnCredentials(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('The TURN credential response is invalid.');
    }
    const username = credentials.username;
    const credential = credentials.credential;
    const urls = Array.isArray(credentials.urls) ? credentials.urls : [];
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      username.length > 1024 ||
      typeof credential !== 'string' ||
      !credential ||
      credential.length > 2048 ||
      urls.length === 0 ||
      urls.length > TURN_URL_LIMIT
    ) {
      throw new Error('The TURN credential response is incomplete.');
    }

    const normalized = urls.map(normalizeTurnUrl);
    if (normalized.some((entry) => !entry)) {
      throw new Error('The TURN credential response contains an invalid URL.');
    }

    let ttl;
    if (credentials.ttl !== undefined) {
      ttl = Number(credentials.ttl);
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 31_536_000) {
        throw new Error('The TURN credential response contains an invalid expiry.');
      }
    }

    return {
      urls: normalized.flatMap((entry) => entry.urls),
      username,
      credential,
      ...(ttl ? { ttl } : {}),
      source: 'runtime',
    };
  }

  async function loadTurnRuntimeConfig() {
    if (turnRuntimePromise && Date.now() < turnRuntimeRefreshAt) {
      return turnRuntimePromise;
    }

    turnRuntimeRefreshAt = Infinity;
    turnRuntimePromise = (async function fetchTurnRuntimeConfig() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch('/turn-credentials', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(
            response.status === 404
              ? 'TURN is not configured on this server.'
              : `TURN credentials could not be loaded (HTTP ${response.status}).`
          );
          error.status = response.status;
          throw error;
        }

        let body;
        try {
          body = await response.json();
        } catch {
          throw new Error('The TURN credential endpoint returned invalid JSON.');
        }
        const credentials = assertTurnCredentials(body);
        turnRuntimeRefreshAt = credentials.ttl
          ? Date.now() +
            credentials.ttl * 1000 -
            Math.min(TURN_REFRESH_MARGIN_MS, credentials.ttl * 200)
          : Infinity;
        return credentials;
      } finally {
        clearTimeout(timeout);
      }
    })();

    try {
      return await turnRuntimePromise;
    } catch (error) {
      turnRuntimePromise = null;
      turnRuntimeRefreshAt = 0;
      throw error;
    }
  }

  async function refreshTurnConfiguration() {
    turnRuntimePromise = null;
    turnRuntimeRefreshAt = 0;
    return resolveIceConfiguration();
  }

  async function resolveTurnConfig() {
    const params = new URLSearchParams(window.location.search);
    const urlOverride = params.get('turnUrls');
    if (urlOverride && isLocalDevelopment()) {
      const urls = urlOverride.split(',').map((url) => url.trim()).filter(Boolean);
      if (!urls.length || urls.length > TURN_URL_LIMIT) {
        throw new Error('The local TURN URL override is invalid.');
      }
      const normalized = urls.map(normalizeTurnUrl);
      if (normalized.some((entry) => !entry)) {
        throw new Error('The local TURN URL override contains an invalid URL.');
      }
      return {
        urls: normalized.flatMap((entry) => entry.urls),
        username: LOCAL_TURN_USERNAME,
        credential: LOCAL_TURN_CREDENTIAL,
        source: 'local-url-override',
      };
    }

    try {
      return await loadTurnRuntimeConfig();
    } catch (error) {
      if (isLocalDevelopment()) {
        return {
          urls: [`turn:${hostname}:3478`],
          username: LOCAL_TURN_USERNAME,
          credential: LOCAL_TURN_CREDENTIAL,
          source: 'local-coturn',
          warning:
            error.status === 404
              ? ''
              : 'Managed TURN credentials could not be loaded; using local coturn.',
        };
      }
      throw error;
    }
  }

  async function resolveIceConfiguration() {
    try {
      const turn = await resolveTurnConfig();
      if (!turn) {
        return {
          iceServers: GOOGLE_STUN_SERVERS,
          turnConfigured: false,
          warning: 'TURN is not configured; using Google STUN only.',
        };
      }
      return {
        iceServers: [
          ...GOOGLE_STUN_SERVERS,
          { urls: turn.urls, username: turn.username, credential: turn.credential },
        ],
        turnConfigured: true,
        source: turn.source,
        warning: turn.warning || '',
        ...(turn.ttl ? { ttl: turn.ttl } : {}),
      };
    } catch (error) {
      return {
        iceServers: GOOGLE_STUN_SERVERS,
        turnConfigured: false,
        warning: `${error.message || 'TURN credentials could not be loaded.'} Using Google STUN only.`,
      };
    }
  }

  config.isLocalDevelopment = isLocalDevelopment;
  config.normalizeTurnUrl = normalizeTurnUrl;
  config.loadTurnRuntimeConfig = loadTurnRuntimeConfig;
  config.resolveTurnConfig = resolveTurnConfig;
  config.resolveIceConfiguration = resolveIceConfiguration;
  config.refreshTurnConfiguration = refreshTurnConfiguration;

  return config;
})();
