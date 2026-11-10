'use strict';

/**
 * File transfer over one WebRTC DataChannel.
 *
 * A mesh creates one instance per peer connection, so two transfers to
 * different peers never share transfer ids or buffers.
 *
 * Wire format (chat and files share the channel, so each message is
 * self-describing):
 *
 *   chat text   JSON string  { type: "chat", text: "..." }
 *   file meta   JSON string  { type: "file-meta", id, name, size, mime, chunks, hash }
 *   file chunk  ArrayBuffer  [ uint32 transferId | uint32 chunkIndex | payload ]
 *
 * The 8-byte binary header avoids wrapping every 16 KB chunk in JSON, which
 * would inflate the transfer and add an encode/decode pass.
 *
 * Backpressure: DataChannel.send() only enqueues into the SCTP send buffer.
 * Sending a whole file in a loop grows that buffer without bound, delaying
 * chat and risking memory exhaustion. The sender pauses above a high-water
 * mark and resumes on the "bufferedamountlow" event.
 *
 * Integrity: the sender includes a SHA-256 digest in the metadata. The
 * receiver hashes the reassembled bytes and reports whether they match.
 */
window.createFileTransfer = function createFileTransfer(options) {
  'use strict';

  const {
    channel,
    chunkSize = 16 * 1024,
    bufferHighWaterMark = 1024 * 1024,
    bufferLowWaterMark = 256 * 1024,
    maxFileBytes = 100 * 1024 * 1024,
    onSendStart = () => {},
    onSendProgress = () => {},
    onSendComplete = () => {},
    onReceiveStart = () => {},
    onReceiveProgress = () => {},
    onReceiveComplete = () => {},
    onError = () => {},
  } = options;

  const HEADER_BYTES = 8;

  // Resume sending once the buffer drains below this threshold.
  channel.bufferedAmountLowThreshold = bufferLowWaterMark;

  /** @type {Map<number, {meta: object, chunks: (ArrayBuffer|undefined)[], received: number, bytes: number}>} */
  const incoming = new Map();

  let sending = false;
  // Random start keeps ids distinct in the two directions of one channel.
  let nextTransferId = 1 + Math.floor(Math.random() * 0xffff);

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async function sendFile(file) {
    if (sending) throw new Error('A file is already being sent to this peer.');
    if (channel.readyState !== 'open') throw new Error('Data channel is not open.');
    if (file.size > maxFileBytes) {
      throw new Error(`File is larger than the ${formatLimit(maxFileBytes)} limit.`);
    }

    sending = true;
    const id = nextTransferId;
    nextTransferId = nextTransferId >= 0xffffffff ? 1 : nextTransferId + 1;

    const name = file.name || 'file';
    const size = file.size;
    const chunks = Math.ceil(size / chunkSize);
    const mime = file.type || 'application/octet-stream';

    try {
      // hash and bytes are read before metadata, so the receiver knows what to
      // expect before the first chunk arrives.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(bytes.buffer);

      channel.send(
        JSON.stringify({ type: 'file-meta', id, name, size, mime, chunks, hash })
      );
      onSendStart({ id, name, size, chunks, hash });

      if (size === 0) {
        onSendComplete({ id, name, size, hash });
        return;
      }

      let sent = 0;
      for (let index = 0; index < chunks; index += 1) {
        if (channel.readyState !== 'open') {
          throw new Error('Data channel closed during transfer.');
        }

        await waitForSendBuffer();

        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, size);
        channel.send(packChunk(id, index, bytes.subarray(start, end)));

        sent += end - start;
        onSendProgress({ id, name, size, sent });
      }

      onSendComplete({ id, name, size, hash });
    } catch (err) {
      onError(err, { id, name, direction: 'out' });
      throw err;
    } finally {
      sending = false;
    }
  }

  /**
   * Wait until bufferedAmount has drained below the high-water mark.
   * bufferedAmountLowThreshold is set to the low-water mark, so the
   * "bufferedamountlow" event fires once the queue is comfortably empty.
   */
  async function waitForSendBuffer() {
    while (channel.bufferedAmount > bufferHighWaterMark) {
      if (channel.readyState !== 'open') {
        throw new Error('Data channel closed while waiting for send buffer.');
      }
      await new Promise((resolve, reject) => {
        const onLow = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error('Data channel closed while waiting for send buffer.'));
        };
        const cleanup = () => {
          channel.removeEventListener('bufferedamountlow', onLow);
          channel.removeEventListener('close', onClose);
        };
        channel.addEventListener('bufferedamountlow', onLow);
        channel.addEventListener('close', onClose);
      });
    }
  }

  function packChunk(id, index, payload) {
    const packet = new Uint8Array(HEADER_BYTES + payload.byteLength);
    const view = new DataView(packet.buffer);
    view.setUint32(0, id); // big-endian by default
    view.setUint32(4, index);
    packet.set(payload, HEADER_BYTES);
    return packet.buffer;
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  function receiveMeta(meta) {
    if (!meta || meta.type !== 'file-meta') return;

    const id = Number(meta.id);
    const size = Number(meta.size);
    const chunks = Number(meta.chunks);

    // Metadata is untrusted input: validate it before allocating anything.
    if (!Number.isSafeInteger(id) || id < 0) return;
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) return;
    if (!Number.isSafeInteger(chunks) || chunks !== Math.ceil(size / chunkSize)) return;
    if (incoming.has(id)) return;

    const name =
      typeof meta.name === 'string' && meta.name.trim()
        ? meta.name.slice(0, 255)
        : 'download';
    const mime =
      typeof meta.mime === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(meta.mime)
        ? meta.mime
        : 'application/octet-stream';
    const hash =
      typeof meta.hash === 'string' && /^[a-f0-9]{64}$/i.test(meta.hash)
        ? meta.hash.toLowerCase()
        : null;

    const entry = {
      meta: { id, name, size, mime, chunks, hash },
      chunks: new Array(chunks),
      received: 0,
      bytes: 0,
    };
    incoming.set(id, entry);

    onReceiveStart({ id, name, size, chunks, hash });

    // Empty file: no chunks will arrive, finish immediately.
    if (size === 0) finishReceive(id);
  }

  function receiveChunk(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) return;

    const view = new DataView(buffer);
    const id = view.getUint32(0);
    const index = view.getUint32(4);

    const entry = incoming.get(id);
    if (!entry) return;
    if (index >= entry.meta.chunks) return;
    if (entry.chunks[index]) return; // duplicate chunk

    const payload = buffer.slice(HEADER_BYTES);
    entry.chunks[index] = payload;
    entry.received += 1;
    entry.bytes += payload.byteLength;

    onReceiveProgress({
      id,
      name: entry.meta.name,
      size: entry.meta.size,
      received: entry.bytes,
    });

    if (entry.received === entry.meta.chunks) finishReceive(id);
  }

  async function finishReceive(id) {
    const entry = incoming.get(id);
    if (!entry) return;
    incoming.delete(id);

    const blob = new Blob(entry.chunks, { type: entry.meta.mime });
    const url = URL.createObjectURL(blob);

    let computedHash = null;
    try {
      computedHash = await sha256Hex(await blob.arrayBuffer());
    } catch {
      // Web Crypto is unavailable (e.g. a non-secure LAN origin). The transfer
      // still completes; integrity is simply reported as unverified.
    }

    let verified = null;
    if (entry.meta.hash && computedHash) {
      verified = entry.meta.hash === computedHash;
    }

    onReceiveComplete({
      id,
      name: entry.meta.name,
      size: entry.meta.size,
      url,
      verified,
      hash: computedHash,
    });
  }

  // -------------------------------------------------------------------------

  async function sha256Hex(buffer) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function formatLimit(bytes) {
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
  }

  return {
    sendFile,
    receiveMeta,
    receiveChunk,
    isSending: () => sending,
  };
};
