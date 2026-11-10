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

  /**
   * STUN discovers a peer's public address (NAT mapping). TURN relays traffic
   * when no direct path can be found. STUN never guarantees a direct path:
   * symmetric NATs and strict firewalls often require TURN.
   *
   * Default STUN servers (Google) work globally. TURN URLs can be overridden
   * via the `turnUrls` URL parameter or by editing this config.
   * Format: turn:host:port?u=username&p=password
   * Set turnUrls to a comma-separated URL list and provide credentials with
   * turnUsername and turnCredential, e.g.
   * ?turnUrls=turn:coturn.example.com:3478&turnUsername=myuser&turnCredential=mypass
   */
  iceServers: (function () {
    // Always include Google STUN (works globally).
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    let turnUrls = [];
    let username = 'chat';
    let credential = 'chatpass';
    try {
      const params = new URLSearchParams(window.location.search);
      const override = params.get('turnUrls');
      if (override) turnUrls = override.split(',').map((url) => url.trim()).filter(Boolean);
      username = params.get('turnUsername') || username;
      credential = params.get('turnCredential') || credential;
    } catch {
      /* Keep the same-host development TURN defaults. */
    }

    if (turnUrls.length === 0) {
      // A colocated coturn server works for localhost, LAN, or a public host
      // without making each browser try to reach its own localhost.
      turnUrls = [`turn:${window.location.hostname || 'localhost'}:3478`];
    }

    iceServers.push({ urls: turnUrls, username, credential });
    return iceServers;
  })(),

  /**
   * "all" lets ICE try host/srflx/relay candidates. "relay" forces all traffic
   * through TURN, which is how the coturn setup is tested.
   */
  iceTransportPolicy: 'all',

  fileTransfer: {
    // SCTP messages stay well under the browser's maximum message size.
    chunkSize: 16 * 1024,
    // Pause sending while the SCTP send buffer is above this...
    bufferHighWaterMark: 1024 * 1024,
    // ...and resume once bufferedAmountLowThreshold (this value) is reached.
    bufferLowWaterMark: 256 * 1024,
    // SHA-256 is computed over the whole file, so the cap is kept moderate.
    // Keep the same value on both sides: metadata is validated against it.
    maxFileBytes: 100 * 1024 * 1024,
  },

  reconnect: {
    // Simple capped exponential backoff, no jitter.
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
  },
};
