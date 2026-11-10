'use strict';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 30;
const MAX_RATE_LIMIT_CLIENTS = 5_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const MAX_TURN_URLS = 20;

function normalizeTurnUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const match = /^(turns?):(?:\/\/)?(\[[0-9a-f:]+\]|[^:/?#@\s]+)(?::(\d{1,5}))?(?:\?([^#]*))?$/i.exec(value);
  if (!match) return null;

  const scheme = match[1].toLowerCase();
  const host = match[2];
  const port = match[3];
  const queryString = match[4] || '';
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;

  let transport = null;
  if (queryString) {
    const query = new URLSearchParams(queryString);
    for (const key of query.keys()) {
      if (key.toLowerCase() !== 'transport') return null;
    }
    if (query.getAll('transport').length > 1) return null;
    if (query.has('transport')) {
      transport = String(query.get('transport')).toLowerCase();
      if (!['udp', 'tcp'].includes(transport)) return null;
      if (scheme === 'turns' && transport !== 'tcp') return null;
    }
  }

  return `${scheme}:${host}${port ? `:${port}` : ''}${transport ? `?transport=${transport}` : ''}`;
}

function createTurnCredentialsHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const recentRequests = new Map();

  return async function handleTurnCredentials(req, res) {
    setResponseHeaders(res);
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
      return;
    }

    if (!allowRequest(req, recentRequests, now())) {
      sendJson(res, 429, { error: 'Too many TURN credential requests.' }, { 'Retry-After': '60' });
      return;
    }

    const appName = typeof env.METERED_APP_NAME === 'string' ? env.METERED_APP_NAME.trim() : '';
    const apiKey = typeof env.METERED_API_KEY === 'string' ? env.METERED_API_KEY.trim() : '';
    if (appName || apiKey) {
      if (!/^[a-z0-9-]{1,63}$/i.test(appName) || !apiKey || apiKey.length > 4096) {
        sendJson(res, 503, { error: 'Metered TURN is not configured correctly.' });
        return;
      }
      if (typeof fetchImpl !== 'function') {
        sendJson(res, 503, { error: 'Metered TURN credentials are unavailable.' });
        return;
      }
      await sendMeteredCredentials(res, appName, apiKey, fetchImpl);
      return;
    }

    const rawUrls = typeof env.TURN_URLS === 'string' ? env.TURN_URLS : '';
    const username = typeof env.TURN_USERNAME === 'string' ? env.TURN_USERNAME : '';
    const credential = typeof env.TURN_CREDENTIAL === 'string' ? env.TURN_CREDENTIAL : '';
    if (!rawUrls.trim() && !username && !credential) {
      sendJson(res, 404, { error: 'TURN is not configured for this deployment.' });
      return;
    }

    const rawUrlValues = rawUrls.split(',').map((value) => value.trim()).filter(Boolean);
    const urls = rawUrlValues.map(normalizeTurnUrl);
    if (
      urls.length === 0 ||
      urls.length > MAX_TURN_URLS ||
      urls.some((url) => !url) ||
      !username.trim() ||
      username.length > 1024 ||
      !credential ||
      credential.length > 2048
    ) {
      sendJson(res, 503, { error: 'TURN credentials are not configured correctly.' });
      return;
    }

    sendJson(res, 200, { urls, username, credential });
  };
}

async function sendMeteredCredentials(res, appName, apiKey, fetchImpl) {
  const url = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
  url.searchParams.set('apiKey', apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      sendJson(res, 502, { error: 'The Metered TURN credential service rejected the request.' });
      return;
    }

    const contentLength = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
      sendJson(res, 502, { error: 'The Metered TURN response is too large.' });
      return;
    }

    let text;
    try {
      text = await response.text();
    } catch {
      sendJson(res, 502, { error: 'The Metered TURN response could not be read.' });
      return;
    }
    if (text.length > MAX_PROVIDER_RESPONSE_BYTES) {
      sendJson(res, 502, { error: 'The Metered TURN response is too large.' });
      return;
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 502, { error: 'The Metered TURN response was invalid.' });
      return;
    }

    const credentials = validateMeteredResponse(body);
    if (!credentials) {
      sendJson(res, 502, { error: 'The Metered TURN response contained invalid credentials.' });
      return;
    }
    sendJson(res, 200, credentials);
  } catch {
    sendJson(res, 502, { error: 'The Metered TURN credential service is unavailable.' });
  } finally {
    clearTimeout(timeout);
  }
}

function validateMeteredResponse(body) {
  if (!Array.isArray(body) || body.length === 0 || body.length > MAX_TURN_URLS * 2) {
    return null;
  }

  const urls = [];
  let username = null;
  let credential = null;
  let ttl = null;

  for (const entry of body) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const entryUrls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    if (entryUrls.every((value) => typeof value === 'string' && value.startsWith('stun:'))) {
      continue;
    }
    if (
      typeof entry.username !== 'string' ||
      !entry.username.trim() ||
      entry.username.length > 1024 ||
      typeof entry.credential !== 'string' ||
      !entry.credential ||
      entry.credential.length > 2048
    ) {
      return null;
    }
    if (username !== null && (username !== entry.username || credential !== entry.credential)) {
      return null;
    }
    username = entry.username;
    credential = entry.credential;

    for (const rawUrl of entryUrls) {
      const normalized = normalizeTurnUrl(rawUrl);
      if (!normalized) return null;
      urls.push(normalized);
    }
    const entryTtl = readTtl(entry);
    if (entryTtl === false) return null;
    if (entryTtl !== null && ttl !== null && entryTtl !== ttl) return null;
    if (entryTtl !== null) ttl = entryTtl;
  }

  if (!urls.length || urls.length > MAX_TURN_URLS || username === null || credential === null) {
    return null;
  }
  return { urls, username, credential, ...(ttl ? { ttl } : {}) };
}

function readTtl(entry) {
  const raw = entry.ttl ?? entry.expiresIn ?? entry.credentialTtl;
  if (raw === undefined) return null;
  const ttl = Number(raw);
  return Number.isFinite(ttl) && ttl > 0 && ttl <= 31_536_000 ? ttl : false;
}

function allowRequest(req, recentRequests, timestamp) {
  const client = (req.socket && req.socket.remoteAddress) || 'unknown';
  const previous = recentRequests.get(client);
  if (previous && timestamp - previous.startedAt < RATE_LIMIT_WINDOW_MS) {
    previous.count += 1;
    return previous.count <= RATE_LIMIT_REQUESTS;
  }

  for (const [address, window] of recentRequests) {
    if (timestamp - window.startedAt >= RATE_LIMIT_WINDOW_MS) recentRequests.delete(address);
  }
  if (recentRequests.size >= MAX_RATE_LIMIT_CLIENTS && !recentRequests.has(client)) {
    return false;
  }
  recentRequests.set(client, { startedAt: timestamp, count: 1 });
  return true;
}

function setResponseHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res, status, body, extraHeaders = {}) {
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

module.exports = {
  createTurnCredentialsHandler,
  normalizeTurnUrl,
  validateMeteredResponse,
};
