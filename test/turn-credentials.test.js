'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  createTurnCredentialsHandler,
  normalizeTurnUrl,
  validateMeteredResponse,
} = require('../server/turn-credentials');

async function createEndpoint(t, options) {
  const handler = createTurnCredentialsHandler(options);
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/turn-credentials') {
      handler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/turn-credentials`;
}

test('validates TURN URL variants and rejects credentials embedded in URL queries', () => {
  assert.equal(normalizeTurnUrl('turn:relay.example.test:3478'), 'turn:relay.example.test:3478');
  assert.equal(
    normalizeTurnUrl('turn:relay.example.test:80?transport=udp'),
    'turn:relay.example.test:80?transport=udp'
  );
  assert.equal(
    normalizeTurnUrl('turn:relay.example.test:80?transport=tcp'),
    'turn:relay.example.test:80?transport=tcp'
  );
  assert.equal(
    normalizeTurnUrl('turns:relay.example.test:443?transport=tcp'),
    'turns:relay.example.test:443?transport=tcp'
  );
  assert.equal(normalizeTurnUrl('turn:relay.example.test:3478?u=user&p=password'), null);
});

test('validates Metered credentials and supports TURN UDP, TCP, and TLS URLs', () => {
  const result = validateMeteredResponse([
    { urls: 'stun:relay.example.test:80' },
    {
      urls: 'turn:relay.example.test:80?transport=udp',
      username: 'temporary',
      credential: 'secret',
      ttl: 300,
    },
    {
      urls: [
        'turn:relay.example.test:80?transport=tcp',
        'turns:relay.example.test:443?transport=tcp',
      ],
      username: 'temporary',
      credential: 'secret',
      ttl: 300,
    },
  ]);
  assert.deepEqual(result, {
    urls: [
      'turn:relay.example.test:80?transport=udp',
      'turn:relay.example.test:80?transport=tcp',
      'turns:relay.example.test:443?transport=tcp',
    ],
    username: 'temporary',
    credential: 'secret',
    ttl: 300,
  });
  assert.equal(
    validateMeteredResponse([
      {
        urls: 'turn:relay.example.test:3478',
        username: 'temporary',
        credential: 'secret',
        ttl: -1,
      },
    ]),
    null
  );
});

test('fetches Metered credentials server-side without returning the API key', async (t) => {
  const apiKey = 'private-test-api-key';
  let upstreamUrl;
  const endpoint = await createEndpoint(t, {
    env: { METERED_APP_NAME: 'beam-test', METERED_API_KEY: apiKey },
    fetchImpl: async (url, options) => {
      upstreamUrl = new URL(url);
      assert.equal(options.redirect, 'error');
      return {
        ok: true,
        headers: { get: () => '256' },
        text: async () => JSON.stringify([
          { urls: 'stun:relay.example.test:80' },
          {
            urls: [
              'turn:relay.example.test:80?transport=udp',
              'turn:relay.example.test:80?transport=tcp',
              'turns:relay.example.test:443?transport=tcp',
            ],
            username: 'temporary-user',
            credential: 'temporary-password',
            ttl: 600,
          },
        ]),
      };
    },
  });

  const response = await fetch(endpoint);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(upstreamUrl.hostname, 'beam-test.metered.live');
  assert.equal(upstreamUrl.pathname, '/api/v1/turn/credentials');
  assert.equal(upstreamUrl.searchParams.get('apiKey'), apiKey);
  assert.deepEqual(body.urls.length, 3);
  assert.equal(body.username, 'temporary-user');
  assert.equal(body.credential, 'temporary-password');
  assert.equal(body.ttl, 600);
  assert.equal(JSON.stringify(body).includes(apiKey), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('returns validated static TURN settings and explicit unavailable errors', async (t) => {
  const staticEndpoint = await createEndpoint(t, {
    env: {
      TURN_URLS: 'turn:relay.example.test:3478,turns:relay.example.test:5349?transport=tcp',
      TURN_USERNAME: 'dev-user',
      TURN_CREDENTIAL: 'dev-password',
    },
  });
  const staticResponse = await fetch(staticEndpoint);
  const staticBody = await staticResponse.json();
  assert.equal(staticResponse.status, 200);
  assert.equal(staticBody.urls.length, 2);

  const unavailableEndpoint = await createEndpoint(t, { env: {} });
  const unavailableResponse = await fetch(unavailableEndpoint);
  assert.equal(unavailableResponse.status, 404);
  assert.match((await unavailableResponse.json()).error, /not configured/);
});

test('rate limits repeated credential requests per source IP', async (t) => {
  const endpoint = await createEndpoint(t, {
    env: {},
    now: () => 1_000,
  });
  let status;
  for (let request = 0; request < 31; request += 1) {
    status = (await fetch(endpoint)).status;
  }
  assert.equal(status, 429);
});
