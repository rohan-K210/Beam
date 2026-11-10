'use strict';

/**
 * All DOM rendering lives here.
 *
 * Every piece of user-controlled text (chat text, room names, file names) is
 * written with textContent, never innerHTML. That makes XSS through chat or
 * filenames impossible, independent of any server-side sanitisation.
 */
window.ChatUI = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const statusEl = $('status');
  const statusLabel = $('status-label');
  const statusDetail = $('status-detail');
  const roomNameEl = $('room-name');
  const factRoom = $('fact-room');
  const factPeers = $('fact-peers');
  const factRoute = $('fact-route');
  const factSignaling = $('fact-signaling');
  const factIce = $('fact-ice');
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
    error: 'Connection configuration error',
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
  // Status / session chrome
  // -------------------------------------------------------------------------

  function setStatus(state, detail) {
    statusEl.dataset.state = state;
    statusLabel.textContent = STATUS_LABELS[state] || state;
    statusDetail.textContent = detail || '';
  }

  function setSignalStatus(state, detail) {
    statusEl.dataset.state = state;
    statusLabel.textContent = STATUS_LABELS[state] || state;
    statusDetail.textContent = detail || '';
  }

  function setPeerStatus(state, detail) {
    statusEl.dataset.state = state;
    statusLabel.textContent = STATUS_LABELS[state] || state;
    statusDetail.textContent = detail || '';
  }

  function setRoom(room) {
    roomNameEl.textContent = room || '—';
    factRoom.textContent = room || '—';
    copyButton.disabled = !room;
  }

  function setSignalingUrl(url) {
    factSignaling.textContent = url;
  }

  function setIcePolicy(policy) {
    factIce.textContent = policy;
  }

  function setPeers(connected, total, limit) {
    if (!factPeers) return;
    if (!total && !connected) {
      factPeers.textContent = '—';
      return;
    }
    const capacity = limit ? ` · limit ${limit}` : '';
    factPeers.textContent = `${connected} connected · ${total} in room${capacity}`;
  }

  function setRoute(text) {
    factRoute.textContent = text || 'Waiting';
  }

  function setCopyButtonLabel(text) {
    copyButton.textContent = text;
  }

  // -------------------------------------------------------------------------
  // Join flow
  // -------------------------------------------------------------------------

  function showJoinForm(prefill, notice) {
    joinOverlay.hidden = false;
    if (typeof prefill === 'string') roomInput.value = prefill;
    if (notice) {
      joinMessage.textContent = notice;
      joinMessage.hidden = false;
    } else {
      joinMessage.hidden = true;
    }
    roomInput.focus();
    roomInput.select();
  }

  function hideJoinForm() {
    joinOverlay.hidden = true;
  }

  function onJoinSubmit(handler) {
    joinHandler = handler;
  }

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const room = roomInput.value.replace(/\s+/g, ' ').trim().slice(0, 64);
    if (!room) {
      roomInput.focus();
      return;
    }
    if (joinHandler) joinHandler(room);
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideEmptyState() {
    if (emptyState && emptyState.parentNode) emptyState.remove();
  }

  function appendRow(row) {
    const shouldScroll = nearBottom();
    hideEmptyState();
    messagesEl.append(row);
    if (shouldScroll) scrollToBottom();
  }

  /** direction: "own" | "peer" | "system"; sender is shown for peer messages. */
  function addChat(text, direction, sender) {
    const row = document.createElement('div');
    row.className = `message message--${direction}`;

    if (direction === 'system') {
      row.textContent = text;
    } else {
      const who = direction === 'own' ? 'You' : sender || 'Peer';

      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.textContent = `${who} · ${timeNow()}`;

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = text;

      row.append(meta, bubble);
    }

    appendRow(row);
  }

  function addSystem(text) {
    addChat(text, 'system');
  }

  // -------------------------------------------------------------------------
  // File transfer cards
  // -------------------------------------------------------------------------

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function addTransfer({ name, size, direction, peerLabel }) {
    const card = document.createElement('article');
    card.className = `transfer transfer--${direction}`;

    const peer = peerLabel || 'Peer';
    const verb = direction === 'out' ? 'Sending' : 'Receiving';
    const preposition = direction === 'out' ? 'to' : 'from';

    const head = document.createElement('div');
    head.className = 'transfer-head';

    const title = document.createElement('div');
    title.className = 'transfer-title';

    const icon = document.createElement('span');
    icon.className = 'transfer-icon';
    icon.textContent = direction === 'out' ? '↑' : '↓';
    icon.setAttribute('aria-hidden', 'true');

    const nameEl = document.createElement('span');
    nameEl.className = 'transfer-name';
    nameEl.textContent = name;

    title.append(icon, nameEl);

    const percentEl = document.createElement('span');
    percentEl.className = 'transfer-percent';
    percentEl.textContent = '0%';

    head.append(title, percentEl);

    const bar = document.createElement('div');
    bar.className = 'progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', '0');

    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    bar.append(fill);

    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    meta.textContent = `${verb} ${preposition} ${peer} · ${formatBytes(0)} / ${formatBytes(size)}`;

    const actions = document.createElement('div');
    actions.className = 'transfer-actions';

    card.append(head, bar, meta, actions);
    transfersEl.append(card);
    card.scrollIntoView({ block: 'nearest' });

    let lastPercent = -1;

    function update(transferred, total) {
      const safeTotal = Number(total) || 0;
      const percent =
        safeTotal > 0 ? Math.min(100, Math.round((transferred / safeTotal) * 100)) : 100;

      if (percent !== lastPercent) {
        lastPercent = percent;
        percentEl.textContent = `${percent}%`;
        fill.style.width = `${percent}%`;
        bar.setAttribute('aria-valuenow', String(percent));
        meta.textContent = `${verb} ${preposition} ${peer} · ${formatBytes(transferred)} / ${formatBytes(safeTotal)}`;
      }
    }

    function complete(downloadUrl, verified) {
      update(size, size);
      card.classList.add('transfer--done');
      percentEl.textContent = 'Done';
      meta.textContent = `${direction === 'out' ? 'Sent to' : 'Received from'} ${peer} · ${formatBytes(size)}`;

      if (verified === true) {
        const badge = document.createElement('span');
        badge.className = 'transfer-hash transfer-hash--ok';
        badge.textContent = 'SHA-256 verified';
        actions.append(badge);
      } else if (verified === false) {
        card.classList.add('transfer--error');
        const badge = document.createElement('span');
        badge.className = 'transfer-hash transfer-hash--bad';
        badge.textContent = 'SHA-256 mismatch';
        actions.append(badge);
      } else if (downloadUrl) {
        const badge = document.createElement('span');
        badge.className = 'transfer-hash';
        badge.textContent = 'Hash unavailable';
        actions.append(badge);
      }

      if (downloadUrl) {
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = name;
        link.className = 'button button--small';
        link.textContent = 'Download';
        actions.append(link);
      }
    }

    function fail(message) {
      card.classList.add('transfer--error');
      percentEl.textContent = 'Failed';
      meta.textContent = message;
    }

    return { update, complete, fail };
  }

  // -------------------------------------------------------------------------
  // Composer
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

  return {
    setStatus,
    setSignalStatus,
    setPeerStatus,
    setRoom,
    setSignalingUrl,
    setIcePolicy,
    setPeers,
    setRoute,
    setCopyButtonLabel,
    showJoinForm,
    hideJoinForm,
    onJoinSubmit,
    addChat,
    addSystem,
    addTransfer,
    setControlsEnabled,
    setFileTargets,
    getFileTarget,
    onSend,
    onFileSelected,
    resetConversation,
    formatBytes,
  };
})();
