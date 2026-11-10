/** @type {InstanceType<window.Signaling>|null} */ let signaling = null;
let signalingState = 'disconnected';
let roomActive = false;
let signalingDetail = '';
let myPeerId = null;
let roomLimit = 0;

const sessions = new Map();

(function () {
  'use strict';

  const cfg = window.CHAT_CONFIG || {};
  const initialParams = new URLSearchParams(window.location.search);
  const ui = window.ChatUI;
  let room = initialParams.get('room') || '';

  const fileConfig = cfg.fileTransfer || {};
  const icePolicy =
    initialParams.get('relay') === '1' ? 'relay' : cfg.iceTransportPolicy || 'all';

  const peerConfiguration = {
    iceServers: Array.isArray(cfg.iceServers) ? cfg.iceServers : [],
    iceTransportPolicy: icePolicy,
  };

  const signalingUrl =
    initialParams.get('signal') || cfg.signalingUrl || 'ws://localhost:8080';

  // Stable for this page load. It lets the signaling server give us the same
  // seat and peer id after a short socket drop, so peers do not tear down a
  // still-working WebRTC connection.
  const clientId = (function createClientId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  })();

  function normalizeRoom(value) {
    return String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 64);
  }

  function updateRoomInUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('room', room);
    window.history.replaceState(null, '', url);
  }

  function peerLabel(peerId) {
    return `Peer ${peerId}`;
  }

  function peerLabelOnly(peerId) {
    return `Peer ${peerId}`;
  }

  function buildInviteUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set('room', room);
    if (signalingUrl !== (cfg.signalingUrl || 'ws://localhost:8080')) {
      url.searchParams.set('signal', signalingUrl);
    } else if (!initialParams.has('signal')) {
      url.searchParams.delete('signal');
    }
    if (icePolicy === 'relay') url.searchParams.set('relay', '1');
    return url.toString();
  }

  function $(id) {
    return document.getElementById(id);
  }

  const statusEl = $('status');
  const statusLabel = $('status-label');
  const statusDetail = $('status-detail');
  const roomNameEl = $('room-name');
  const factRoom = $('fact-room');
  const factPeers = $('fact-peers');
  const factRoute = $('fact-route');
  const factSignaling = $('fact-signaling');
  const factIce = $('fact-ice');
  const bannerEl = $('signal-banner');
  const bannerText = $('signal-banner-text');
  const messagesEl = $('messages');
  const transfersEl = $('transfers');
  const emptyState = $('empty-state');
  const chatForm = $('chat-form');
  const messageInput = $('message-input');
  const sendButton = $('send-button');
  const fileInput = $('file-input');
  const fileTarget = $('file-target');
  const joinOverlay = $('join-overlay');
  const joinForm = $('join-form');
  const roomInput = $('room-input');
  const joinMessage = $('join-message');
  const copyButton = $('copy-link');

  const STATUS_LABELS = {
    connecting: 'Connecting to server',
    waiting: 'Waiting for peers',
    negotiating: 'Negotiating',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    disconnected: 'Disconnected',
    failed: 'Connection failed',
    full: 'Room full',
    closed: 'Disconnected',
  };

  let sendHandler = null;
  let fileHandler = null;
  let joinHandler = null;

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  ui.setSignalingUrl(signalingUrl);
  ui.setIcePolicy(icePolicy);
  ui.onJoinSubmit(joinRoom);
  ui.onSend(handleSendText);
  ui.onFileSelected(handleFileSelected);
  document.getElementById('copy-link').addEventListener('click', copyInviteLink);

  if (room) {
    joinRoom(room);
  } else {
    ui.setRoom('');
    ui.setControlsEnabled(false);
    ui.setPeers(0, 0, 0);
    ui.setFileTargets([]);
    ui.setStatus('waiting', 'Choose a room to begin');
    ui.showJoinForm('');
  }

  // -------------------------------------------------------------------------
  // Room lifecycle
  // -------------------------------------------------------------------------

  function joinRoom(nextRoom) {
    const clean = normalizeRoom(nextRoom);
    if (!clean) return;

    room = clean;
    roomActive = true;
    updateRoomInUrl();

    ui.setRoom(room);
    ui.hideJoinForm();
    ui.resetConversation();
    ui.setRoute('Waiting');
    ui.hideBanner();
    ui.setControlsEnabled(false);
    ui.setFileTargets([]);

    if (signaling) {
      signaling.stop();
      signaling = null;
    }
    destroyAllSessions();

    myPeerId = null;
    roomLimit = 0;
    signalingState = 'connecting';
    ui.setStatus('connecting', 'Opening the signaling socket…');
    ui.addSystem(`Joining room "${room}"…`);

    startSignaling();
  }

  function startSignaling() {
    signaling = new window.Signaling(signalingUrl, room, clientId);
    const active = signaling;

    active.on('status', handleSignalingStatus);
    active.on('joined', handleJoined);
    active.on('peer-joined', handlePeerJoined);
    active.on('peer-left', handlePeerLeft);
    active.on('full', handleRoomFull);
    active.on('error', handleSignalingError);

    active.on('offer', (message) => routeSignal('offer', message));
    active.on('answer', (message) => routeSignal('answer', message));
    active.on('candidate', (message) => routeSignal('candidate', message));

    active.connect();
  }

  function handleSignalingStatus(status) {
    signalingState = status.state;
    signalingDetail = status.reason || status.message || signalingDetail;

    switch (status.state) {
      case 'connecting':
        ui.setSignalStatus('connecting', 'Opening the signaling socket…');
        break;

      case 'connected':
        ui.setSignalStatus('connected', 'WebSocket open');
        ui.hideBanner();
        break;

      case 'reconnecting': {
        const seconds = Math.max(1, Math.round((status.delay || 0) / 1000));
        const reason = status.reason || 'Signaling offline';
        ui.setSignalStatus('reconnecting', reason);
        ui.showBanner(
          `${reason}. Established peer links keep working. ` +
            `Reconnecting in ~${seconds}s (attempt ${String(status.attempt)})…`
        );
        break;
      }

      case 'disconnected':
        ui.setSignalStatus('disconnected', 'No signaling connection.');
        break;

      case 'error':
        ui.setSignalStatus('error', status.message || 'A signaling error occurred.');
        ui.showBanner('Signaling reported an error: ' + (status.message || '—'));
        break;

      default:
        break;
    }

    refreshStatus();
  }

  function handleJoined(message) {
    myPeerId = Number(message.peerId);
    roomLimit = Number(message.limit) || 0;
    ui.hideBanner();

    if (Array.isArray(message.peers)) {
      for (const peer of message.peers) {
        if (peer && Number(peer.peerId) !== myPeerId) {
          ensureSession(Number(peer.peerId), peer.clientId, false);
        }
      }
    }

    if (message.resumed) {
      ui.addSystem('Signaling reconnected; existing peer links were kept.');
    }

    refreshStatus();
  }

  function handlePeerJoined(message) {
    const remotePeerId = Number(message.peerId);
    if (!Number.isInteger(remotePeerId) || remotePeerId === myPeerId) return;

    ensureSession(remotePeerId, message.clientId, true);
    refreshStatus();
  }

  function handlePeerLeft(message) {
    const remotePeerId = Number(message.peerId);
    const entry = sessions.get(remotePeerId);
    if (!entry) return;

    closeEntryEntry(entry);
    sessions.delete(remotePeerId);
    refreshStatus();
  }

  function handleRoomFull(message) {
    roomActive = false;
    roomLimit = Number(message.limit) || roomLimit;

    if (signaling) {
      signaling.stop();
      signaling = null;
    }
    signalingState = 'closed';
    destroyAllSessions();

    ui.hideBanner();
    ui.setStatus('full', `This room already has ${roomLimit} participants.`);
    ui.setPeers(0, 0, roomLimit);
    ui.setFileTargets([]);
    ui.setRoute('Waiting');
    ui.addSystem(`The room is full (${roomLimit} participants max). Choose another room.`);
    ui.showJoinForm(
      room,
      `That room already has ${roomLimit} participants — try another name or wait for someone to leave.`
    );
  }

  function handleSignalingError(message) {
    ui.addSystem(`Signaling error: ${message.message || message.code || 'unknown'}`);
  }

  // -------------------------------------------------------------------------
  // Peer sessions
  // -------------------------------------------------------------------------

  function ensureSession(remotePeerId, remoteClientId, announce) {
    if (!Number.isInteger(remotePeerId)) return null;

    const byId = sessions.get(remotePeerId);
    if (byId) {
      if (remoteClientId) byId.clientId = remoteClientId;
      return byId;
    }

    if (remoteClientId) {
      for (const [oldId, entry] of sessions) {
        if (entry.clientId !== remoteClientId) continue;

        if (entry.state === 'failed' || entry.state === 'closed') {
          closeEntryEntry(entry);
          sessions.delete(oldId);
          break;
        }

        sessions.delete(oldId);
        entry.remotePeerId = remotePeerId;
        sessions.set(remotePeerId, entry);
        if (!isEntryOpen(entry)) entry.session.restartIce();
        return entry;
      }
    }

    const entry = {
      remotePeerId,
      clientId: remoteClientId || null,
      session: null,
      channel: null,
      fileTransfer: null,
      state: 'new',
      route: null,
      transfers: new Map(),
      openAnnounced: false,
      failureAnnounced: false,
    };

    const initiator = myPeerId !== null && myPeerId > remotePeerId;

    entry.session = window.createPeerSession({
      initiator,
      polite: !initiator,
      configuration: peerConfiguration,
      sendSignal: (payload) => {
        if (!signaling) return;
        signaling.send({
          ...payload,
          to: entry.remotePeerId,
        });
      },
      onStateChange: (state) => handlePeerState(entry, state),
      onChannel: (channel) => handleChannel(entry, channel),
      onRoute: (route) => handleRoute(entry, route),
    });

    sessions.set(remotePeerId, entry);
    if (announce) {
      ui.addSystem(`${peerLabel(remotePeerId)} joined. Negotiating a direct connection…`);
    }
    return entry;
  }

  function routeSignal(type, message) {
    const from = Number(message.from);
    if (!Number.isInteger(from) || from === myPeerId) return;

    let entry = sessions.get(from);
    if (!entry) {
      entry = ensureSession(from, message.fromClientId, false);
    }
    if (entry) entry.session.handleSignal(type, message);
  }

  function handleChannel(entry, channel) {
    if (entry.channel === channel) return;

    if (entry.channel) {
      try {
        entry.channel.close();
      } catch {
        /* ignore */
      }
    }

    entry.channel = channel;
    entry.openAnnounced = false;
    entry.transfers.clear();
    channel.binaryType = 'arraybuffer';

    entry.fileTransfer = window.createFileTransfer({
      channel,
      chunkSize: fileConfig.chunkSize,
      bufferHighWaterMark: fileConfig.bufferHighWaterMark,
      bufferLowWaterMark: fileConfig.bufferLowWaterMark,
      maxFileBytes: fileConfig.maxFileBytes,

      onSendStart: ({ id, name, size }) => {
        const card = ui.addTransfer({
          name,
          size,
          direction: 'out',
          peerLabel: peerLabel(entry.remotePeerId),
        });
        entry.transfers.set(`out:${id}`, card);
      },
      onSendProgress: ({ id, sent, size }) => {
        const card = entry.transfers.get(`out:${id}`);
        if (card) card.update(sent, size);
      },
      onSendComplete: ({ id }) => {
        const card = entry.transfers.get(`out:${id}`);
        if (card) card.complete();
      },
      onReceiveStart: ({ id, name, size }) => {
        const card = ui.addTransfer({
          name,
          size,
          direction: 'in',
          peerLabel: peerLabel(entry.remotePeerId),
        });
        entry.transfers.set(`in:${id}`, card);
      },
      onReceiveProgress: ({ id, received, size }) => {
        const card = entry.transfers.get(`in:${id}`);
        if (card) card.update(received, size);
      },
      onReceiveComplete: ({ id, url, verified }) => {
        const card = entry.transfers.get(`in:${id}`);
        if (card) card.complete(url, verified);
        if (verified === false) {
          ui.addSystem(
            `${peerLabel(entry.remotePeerId)} sent a file whose SHA-256 digest did not match. ` +
              'The download is available but should be treated as corrupt.'
          );
        }
      },
      onError: (err, context) => handleTransferError(entry, err, context),
    });

    channel.addEventListener('open', () => handleChannelOpen(entry));
    channel.addEventListener('close', () => handleChannelClose(entry));
    channel.addEventListener('message', (event) => handleChannelMessage(entry, event));
    channel.addEventListener('error', () => {
      ui.addSystem(`${peerLabel(entry.remotePeerId)}: the data channel reported an error.`);
    });

    if (channel.readyState === 'open') handleChannelOpen(entry);
  }

  function handlePeerState(entry, state) {
    entry.state = state;
    if (state === 'connected' || state === 'connecting') entry.failureAnnounced = false;

    if (state === 'failed' && !entry.failureAnnounced) {
      entry.failureAnnounced = true;
      ui.addSystem(
        `${peerLabel(entry.remotePeerId)}: connection failed after ICE restart attempts.`
      );
    }

    refreshStatus();
  }

  function handleRoute(entry, route) {
    entry.route = route;
    refreshStatus();
  }

  function handleChannelOpen(entry) {
    if (!sessions.has(entry.remotePeerId) || entry.openAnnounced) return;

    entry.openAnnounced = true;
    entry.state = 'connected';
    ui.addSystem(
      `${peerLabel(entry.remotePeerId)} connected. Messages and files to this peer ` +
        'travel directly between browsers (DTLS encrypted).'
    );
    refreshStatus();
  }

  function handleChannelClose(entry) {
    if (!sessions.has(entry.remotePeerId)) return;
    refreshStatus();
  }

  function handleChannelMessage(entry, event) {
    const data = event.data;

    if (typeof data === 'string') {
      handleEnvelope(entry, data);
      return;
    }

    if (data instanceof ArrayBuffer && entry.fileTransfer) {
      entry.fileTransfer.receiveChunk(data);
    }
  }

  function handleEnvelope(entry, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'chat') {
      if (typeof message.text === 'string' && message.text.length > 0) {
        ui.addChat(
          message.text.slice(0, 8000),
          'peer',
          peerLabel(entry.remotePeerId)
        );
      }
      return;
    }

    if (message.type === 'file-meta' && entry.fileTransfer) {
      entry.fileTransfer.receiveMeta(message);
    }
  }

  function handleTransferError(entry, err, context) {
    const reason = (err && err.message) || 'unknown error';
    ui.addSystem(`${peerLabel(entry.remotePeerId)}: file transfer failed — ${reason}`);

    if (context && context.id != null) {
      const card = entry.transfers.get(`${context.direction}:${context.id}`);
      if (card) card.fail(`Transfer failed: ${reason}`);
    }
  }

  function closeEntryEntry(entry) {
    try {
      entry.session.close();
    } catch {
      /* ignore */
    }
    entry.channel = null;
    entry.fileTransfer = null;
    entry.route = null;
  }

  function destroyAllSessions() {
    for (const entry of sessions.values()) closeEntryEntry(entry);
    sessions.clear();
  }

  function isEntryOpen(entry) {
    return (
      !!entry.channel && entry.channel.readyState === 'open' && entry.session.isOpen()
    );
  }

  function refreshStatus() {
    if (!roomActive) return;

    const entries = [...sessions.values()];
    const open = entries.filter(isEntryOpen);
    const connected = open.length;
    const closed = entries.length - connected;

    ui.setPeers(
      connected,
      entries.length + (myPeerId ? 1 : 0),
      roomLimit
    );
    ui.setControlsEnabled(connected > 0);
    ui.setFileTargets(
      open.map((entry) => ({
        value: String(entry.remotePeerId),
        label: peerLabelOnly(entry.remotePeerId),
      }))
    );
    ui.setRoute(
      connected > 0 ? open.map(routeLabel).join(' · ') : 'Waiting'
    );

    if (connected > 0) {
      const waiting = closed;
      const parts = [
        `${connected} peer${connected === 1 ? '' : 's'} connected`,
        waiting > 0 ? `${waiting} connecting` : null,
        routeSummaryFrom(open),
      ].filter(Boolean);
      ui.setPeerStatus('connected', parts.join(' · '));
      return;
    }

    if (entries.length === 0) {
      if (!myPeerId) {
        ui.setPeerStatus('waiting', 'Awaiting participants');
        return;
      }
      if (signalingState === 'connecting') {
        ui.setPeerStatus('waiting', 'Awaiting participants');
        return;
      }
      const capacity = roomLimit ? ` · ${myPeerId}/${roomLimit}` : '';
      ui.setPeerStatus('waiting', 'Waiting in room' + capacity);
      return;
    }

    const peerStates = entries.map((e) => e.state);
    if (peerStates.includes('failed')) {
      ui.setPeerStatus('failed', 'A peer link failed; renegotiation is in progress.');
      return;
    }
    if (peerStates.includes('reconnecting') || peerStates.includes('disconnected')) {
      ui.setPeerStatus('reconnecting', 'A peer link dropped; ICE recovery is in progress.');
      return;
    }
    ui.setPeerStatus('connecting', 'Negotiating peer links…');
    return;
  }

  function routeSummaryFrom(open) {
    const how = open.map((entry) => entry.route ? routeLabel(entry.route) : 'checking route').join(' · ');
    return how ? `Routes: ${how}` : '';
  }

  function routeLabel(route) {
    if (!route) return 'checking route';
    if (route.route === 'relay') return 'via TURN relay';
    return `direct (${route.localType} ↔ ${route.remoteType})`;
  }

  // -------------------------------------------------------------------------
  // Chat and file actions
  // -------------------------------------------------------------------------

  function handleSendText(text) {
    const open = [...sessions.values()].filter(isEntryOpen);
    if (open.length === 0) {
      ui.addSystem('No peer is connected yet.');
      return false;
    }

    let sent = 0;
    for (const entry of open) {
      try {
        entry.channel.send(JSON.stringify({ type: 'chat', text }));
        sent += 1;
      } catch (err) {
        ui.addSystem(
          `Could not send to ${peerLabel(entry.remotePeerId)}: ${err.message}`
        );
      }
    }

    if (sent === 0) return false;

    ui.addChat(text, 'own');
    return true;
  }

  function handleFileSelected(file) {
    const entry = getFileTargetEntry();
    if (!entry) {
      ui.addSystem('Connect to a peer before sending a file.');
      return;
    }
    if (entry.fileTransfer.isSending()) {
      ui.addSystem(
        `A file is already being sent to ${peerLabel(entry.remotePeerId)}. Wait for it to finish.`
      );
      return;
    }

    ui.addSystem(
      `Sending "${file.name}" (${ui.formatBytes(file.size)}) to ` +
        `${peerLabel(entry.remotePeerId)}…`
    );
    // The transfer module reports progress and failures through callbacks.
    entry.fileTransfer.sendFile(file).catch(() => {});
  }

  function getFileTargetEntry() {
    const selectedId = Number(ui.getFileTarget());
    const selected = sessions.get(selectedId);
    if (selected && isEntryOpen(selected)) return selected;
    return [...sessions.values()].find(isEntryOpen) || null;
  }

  async function copyInviteLink() {
    const link = buildInviteUrl();
    let copied = false;

    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      copied = false;
    }

    ui.setCopyButtonLabel(copied ? 'Copied!' : 'Copy failed');
    setTimeout(() => ui.setCopyButtonLabel('Copy link'), 1_600);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function setControlsEnabled(enabled) {
    messageInput.disabled = !enabled;
    sendButton.disabled = !enabled;
    fileInput.disabled = !enabled;
    fileTarget.disabled = !enabled || fileTarget.options.length === 0;
    messageInput.placeholder = enabled ? 'Message the room…' : 'Waiting for a peer…';
    chatForm.classList.toggle('composer--disabled', !enabled);
  }

  function setFileTargets(targets) {
    const previous = fileTarget.value;

    fileTarget.replaceChildren();
    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.value;
      option.textContent = target.label;
      fileTarget.append(option);
    }

    const keep = targets.some((target) => target.value === previous);
    if (keep) fileTarget.value = previous;
    else if (targets.length) fileTarget.value = targets[0].value;

    fileTarget.disabled = targets.length === 0;
    // With a single peer the target is unambiguous; hide the picker to save
    // space. The option still exists so the send path is identical.
    fileTarget.hidden = targets.length < 2;
  }

  function getFileTarget() {
    return fileTarget.value;
  }

  function onSend(handler) {
    sendHandler = handler;
  }

  function onFileSelected(handler) {
    fileHandler = handler;
  }

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !sendHandler) return;
    if (sendHandler(text)) {
      messageInput.value = '';
      messageInput.focus();
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    // Reset immediately so choosing the same file twice fires another event.
    fileInput.value = '';
    if (file && fileHandler) fileHandler(file);
  });

  // -------------------------------------------------------------------------
  // Room switching
  // -------------------------------------------------------------------------

  function resetConversation() {
    messagesEl.replaceChildren();
    transfersEl.replaceChildren();
    // The empty state was removed by the first message; it is fine to leave it
    // gone after a room switch because a system message follows immediately.
  }

  window.addEventListener('beforeunload', () => {
    roomActive = false;
    destroyAllSessions();
    if (signaling) signaling.stop();
  });
})();