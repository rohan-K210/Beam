'use strict';

/**
 * Signaling client.
 *
 * Responsibilities:
 *  - open a WebSocket to the signaling server and join a room;
 *  - carry offer / answer / candidate messages to one peer, identified by a
 *    server-assigned peer id;
 *  - reconnect with a simple capped backoff after a drop and rejoin the room.
 *
 * Signaling state describes ONLY the WebSocket. It is deliberately independent
 * of every RTCPeerConnection: a lost socket does not close working peer links.
 *
 * Every connection attempt gets a generation number. Callbacks from an older
 * socket can therefore never overwrite the state of a newer one.
 */
window.Signaling = (function () {
  'use strict';

  const config = (window.CHAT_CONFIG && window.CHAT_CONFIG.reconnect) || {};
  const BASE_DELAY_MS = config.baseDelayMs || 1_000;
  const MAX_DELAY_MS = config.maxDelayMs || 10_000;

  class Signaling {
    constructor(url, room, clientId) {
      this.url = String(url || 'ws://localhost:8080').replace(/^http(s?):/i, 'ws$1:');
      this.room = room;
      this.clientId = clientId;
      this.ws = null;
      this.stopped = false;
      this.attempts = 0;
      this.reconnectTimer = null;
      this.generation = 0;

      /** @type {Map<string, Set<Function>>} */
      this.listeners = new Map();
    }

    /**
     * Events: status, joined, peer-joined, peer-left, full, error, offer,
     * answer, candidate.
     *
     * Status payload: { state, attempt?, delay?, reason?, message? }
     * state is one of: connecting | connected | reconnecting | disconnected |
     * error.
     */
    on(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
      return this;
    }

    emit(type, payload) {
      const handlers = this.listeners.get(type);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[signaling] "${type}" handler failed`, err);
        }
      }
    }

    connect() {
      if (this.stopped) return;

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;

      const generation = ++this.generation;
      const reconnecting = this.attempts > 0;

      this.emitStatus(reconnecting ? 'reconnecting' : 'connecting', {
        attempt: this.attempts,
        reason: reconnecting ? 'Retrying the signaling connection' : 'Opening the signaling socket',
      });

      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        console.warn('[signaling] could not construct WebSocket', err);
        this.emitStatus('error', {
          message: 'The signaling WebSocket could not be created.',
        });
        this.scheduleReconnect('WebSocket could not be created');
        return;
      }

      this.ws = ws;

      ws.onopen = () => {
        if (!this.isCurrent(ws, generation)) return;
        this.send({ type: 'join', room: this.room, clientId: this.clientId });
        this.emitStatus('connected', {
          reason: 'WebSocket open',
        });
      };

      ws.onmessage = (event) => {
        if (!this.isCurrent(ws, generation)) return;
        this.handleMessage(event.data);
      };

      ws.onclose = (event) => {
        if (!this.isCurrent(ws, generation)) return;
        this.ws = null;
        if (this.stopped) return;

        // A close starts the reconnect lifecycle immediately, so the indicator
        // moves to Reconnecting rather than flashing a dead-end Disconnected.
        this.scheduleReconnect(closeReason(event));
      };

      ws.onerror = () => {
        if (!this.isCurrent(ws, generation)) return;
        this.emitStatus('error', {
          message: 'The signaling WebSocket reported an error.',
        });
        // onclose normally follows; closing here makes that deterministic.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    }

    isCurrent(ws, generation) {
      return this.ws === ws && this.generation === generation && !this.stopped;
    }

    emitStatus(state, extra) {
      this.emit('status', { state, ...(extra || {}) });
    }

    handleMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        console.warn('[signaling] dropped non-JSON message');
        return;
      }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'joined') this.attempts = 0;
      this.emit(message.type, message);
    }

    send(message) {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        console.warn('[signaling] send failed', err);
        return false;
      }
    }

    /** Reconnect delay: 1 s, 2 s, 4 s, 8 s, then 10 s. */
    scheduleReconnect(reason) {
      if (this.stopped || this.reconnectTimer) return;

      this.attempts += 1;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this.attempts - 1));

      this.emitStatus('reconnecting', {
        attempt: this.attempts,
        delay,
        reason: reason || 'Waiting to reconnect',
      });

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }

    /**
     * Intentional close. Emits Disconnected exactly once and invalidates any
     * in-flight socket callbacks.
     */
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      this.generation += 1;

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;

      const ws = this.ws;
      this.ws = null;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'leave' }));
          } catch (err) {
            console.warn('[signaling] could not send leave message', err);
          }
        }
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close(1000, 'client stopped');
        } catch {
          /* ignore */
        }
      }

      this.emitStatus('disconnected', { reason: 'Disconnected by the client' });
    }

    isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }
  }

  function closeReason(event) {
    if (!event) return 'The signaling socket closed';
    if (typeof event.reason === 'string' && event.reason.trim()) return event.reason;
    if (event.code === 1006) return 'The signaling server became unreachable';
    if (event.code === 1001) return 'The signaling server shut down';
    return 'The signaling socket closed';
  }

  return Signaling;
})();
