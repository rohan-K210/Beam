'use strict';

/**
 * One WebRTC session with one remote peer.
 *
 * In a mesh room there is one of these per remote participant. The session owns
 * a single RTCPeerConnection and a single reliable DataChannel; app.js keys
 * sessions by the peer id assigned by the signaling server.
 *
 * WebRTC ideas used here:
 *
 *  - SDP offer/answer: peers agree on DTLS fingerprints, ICE credentials and
 *    data channel parameters. SDP is carried by signaling, never user content.
 *  - ICE: gather host, server-reflexive (STUN) and relay (TURN) candidates,
 *    then test pairs until one works.
 *  - Perfect negotiation: both sides might renegotiate at the same moment.
 *    The "polite" side yields on an offer collision; the "impolite" side
 *    ignores the incoming offer. This is what makes simultaneous ICE restarts
 *    safe without a separate turn-taking protocol.
 *  - ICE restart: new ICE credentials and candidates on the SAME peer
 *    connection, so the DTLS association and DataChannel can survive a network
 *    change. It is not a new connection.
 */
window.createPeerSession = function createPeerSession(options) {
  'use strict';

  const {
    polite,
    initiator,
    configuration,
    sendSignal,
    onStateChange = () => {},
    onChannel = () => {},
    onRoute = () => {},
  } = options;

  const pc = new RTCPeerConnection(configuration);

  let channel = null;
  let closed = false;
  let lastRouteKey = '';

  // Perfect-negotiation state.
  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;

  // Candidates can arrive before the offer/answer they belong to.
  const pendingCandidates = [];

  // A failed route is retried a few times before the UI reports failure.
  const MAX_ICE_RESTARTS = 3;
  let restartCount = 0;
  let restartTimer = null;

  // -------------------------------------------------------------------------
  // Local negotiation and ICE
  // -------------------------------------------------------------------------

  pc.onnegotiationneeded = async () => {
    if (closed) return;
    try {
      makingOffer = true;
      // No-argument setLocalDescription lets the browser choose offer/answer.
      await pc.setLocalDescription();
      sendSignal({
        type: pc.localDescription.type,
        description: pc.localDescription.toJSON(),
      });
    } catch (err) {
      if (!closed) console.warn('[peer] failed to create/send offer', err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (closed) return;
    // A null candidate means gathering has finished; there is nothing to send.
    if (candidate) {
      sendSignal({ type: 'candidate', candidate: candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (closed) return;

    switch (pc.connectionState) {
      case 'connected':
        restartCount = 0;
        clearRestartTimer();
        onStateChange('connected');
        // One getStats() read is enough: the route is also refreshed after an
        // ICE restart, which is the only time it can legitimately change.
        reportRoute();
        break;

      case 'connecting':
        onStateChange('connecting');
        break;

      case 'disconnected':
        // Often transient (a Wi-Fi blip). Give ICE a moment to recover before
        // forcing a restart.
        onStateChange('disconnected');
        scheduleIceRestart(2_000);
        break;

      case 'failed':
        onStateChange('failed');
        scheduleIceRestart(0);
        break;

      case 'closed':
        onStateChange('closed');
        break;

      default:
        break;
    }
  };

  pc.ondatachannel = (event) => attachChannel(event.channel);

  // The impolite side creates the channel; the polite side receives it. The
  // caller is deterministic (higher peer id), so let it own the initial offer.
  if (initiator) {
    attachChannel(pc.createDataChannel('chat', { ordered: true }));
  }

  function attachChannel(nextChannel) {
    if (closed) return;
    channel = nextChannel;
    channel.binaryType = 'arraybuffer';
    onChannel(channel);
  }

  // -------------------------------------------------------------------------
  // Incoming signaling
  // -------------------------------------------------------------------------

  async function handleSignal(type, message) {
    if (closed) return;
    try {
      if (type === 'offer' || type === 'answer') {
        if (message.description) await handleDescription(message.description);
      } else if (type === 'candidate') {
        if (message.candidate) await handleRemoteCandidate(message.candidate);
      }
    } catch (err) {
      if (!closed) console.warn('[peer] signaling error', err);
    }
  }

  async function handleDescription(description) {
    // Perfect-negotiation collision test (MDN pattern):
    // a collision exists when an offer arrives while we are making our own
    // offer, or while the connection is not stable.
    const readyForOffer =
      !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) {
      // Impolite side keeps its own offer. The polite side implicitly rolls
      // back its offer in setRemoteDescription() and answers ours.
      return;
    }

    isSettingRemoteAnswerPending = description.type === 'answer';
    try {
      await pc.setRemoteDescription(description);
    } finally {
      isSettingRemoteAnswerPending = false;
    }

    // A remote description exists now, so queued candidates can be applied.
    await flushPendingCandidates();

    if (description.type === 'offer') {
      await pc.setLocalDescription();
      sendSignal({
        type: pc.localDescription.type,
        description: pc.localDescription.toJSON(),
      });
    }
  }

  async function handleRemoteCandidate(candidateInit) {
    if (!pc.remoteDescription) {
      // Adding a candidate before the remote description throws.
      pendingCandidates.push(candidateInit);
      return;
    }
    try {
      await pc.addIceCandidate(candidateInit);
    } catch (err) {
      // Candidates for an ignored, colliding offer are meaningless.
      if (!ignoreOffer && !closed) console.warn('[peer] addIceCandidate failed', err);
    }
  }

  async function flushPendingCandidates() {
    while (pendingCandidates.length && !closed) {
      const candidate = pendingCandidates.shift();
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!ignoreOffer) console.warn('[peer] queued candidate failed', err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // ICE restart
  // -------------------------------------------------------------------------

  function scheduleIceRestart(delay) {
    if (closed || restartTimer) return;

    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (closed || pc.connectionState === 'connected') return;

      if (restartCount >= MAX_ICE_RESTARTS) {
        onStateChange('failed');
        return;
      }

      restartCount += 1;
      onStateChange('reconnecting');
      console.info('[peer] ICE restart attempt', restartCount);

      try {
        // New ICE credentials; onnegotiationneeded then sends a fresh offer.
        pc.restartIce();
        scheduleIceRestart(5_000);
      } catch (err) {
        console.warn('[peer] restartIce failed', err);
        onStateChange('failed');
      }
    }, delay);
  }

  function clearRestartTimer() {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  // -------------------------------------------------------------------------
  // Route detection via getStats()
  // -------------------------------------------------------------------------

  async function reportRoute() {
    if (closed) return;
    const route = await detectRoute();
    if (!route || closed) return;

    const key = `${route.route}:${route.localType}:${route.remoteType}:${route.protocol}`;
    if (key === lastRouteKey) return;
    lastRouteKey = key;
    onRoute(route);
  }

  async function detectRoute() {
    if (closed || pc.connectionState !== 'connected') return null;

    let report;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }

    let selectedPairId = null;
    const pairs = [];
    const candidates = new Map();

    report.forEach((stat) => {
      if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        selectedPairId = stat.selectedCandidatePairId;
      } else if (stat.type === 'candidate-pair') {
        pairs.push(stat);
      } else if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
        candidates.set(stat.id, stat);
      }
    });

    const pair =
      (selectedPairId && pairs.find((p) => p.id === selectedPairId)) ||
      pairs.find((p) => p.selected || (p.nominated && p.state === 'succeeded')) ||
      pairs.find((p) => p.state === 'succeeded');

    if (!pair) return null;

    const local = candidates.get(pair.localCandidateId);
    const remote = candidates.get(pair.remoteCandidateId);
    const localType = local ? local.candidateType : 'unknown';
    const remoteType = remote ? remote.candidateType : 'unknown';

    return {
      route: localType === 'relay' || remoteType === 'relay' ? 'relay' : 'direct',
      localType,
      remoteType,
      protocol: pair.protocol || (local && local.protocol) || '',
    };
  }

  // -------------------------------------------------------------------------

  function close() {
    if (closed) return;
    closed = true;
    clearRestartTimer();

    if (channel) {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      channel = null;
    }
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    onStateChange('closed');
  }

  return {
    handleSignal,
    close,
    restartIce: () => {
      if (!closed) pc.restartIce();
    },
    isOpen: () => !!channel && channel.readyState === 'open',
    getChannel: () => channel,
    getRoute: detectRoute,
  };
};
