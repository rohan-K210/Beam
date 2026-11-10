'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

class FakeDataChannel {
  constructor() {
    this.listeners = new Map();
    this.readyState = 'open';
    this.bufferedAmount = 0;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  send(data) {
    const copy = data instanceof ArrayBuffer ? data.slice(0) : data;
    queueMicrotask(() => {
      for (const handler of this.peer.listeners.get('message') || []) {
        handler({ data: copy });
      }
    });
  }
}

function createFileTransferModule() {
  const sandbox = {
    window: {},
    Blob,
    URL,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Map,
    crypto: webcrypto,
    globalThis: { crypto: webcrypto },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../client/js/file-transfer.js'), 'utf8'),
    sandbox
  );
  return sandbox.window.createFileTransfer;
}

test('transfers file chunks with integrity verification over a data-channel pair', async () => {
  const createFileTransfer = createFileTransferModule();
  const senderChannel = new FakeDataChannel();
  const receiverChannel = new FakeDataChannel();
  senderChannel.peer = receiverChannel;
  receiverChannel.peer = senderChannel;

  let received;
  const transferEvents = [];
  const receiver = createFileTransfer({
    channel: receiverChannel,
    chunkSize: 1024,
    onReceiveStart: ({ name, size }) => transferEvents.push(`start:${name}:${size}`),
    onReceiveComplete: (result) => {
      received = result;
    },
  });
  let deliveredChunks = 0;
  receiverChannel.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') receiver.receiveMeta(JSON.parse(data));
    else {
      deliveredChunks += 1;
      receiver.receiveChunk(data);
    }
  });
  const sender = createFileTransfer({
    channel: senderChannel,
    chunkSize: 1024,
    onSendComplete: ({ size }) => transferEvents.push(`sent:${size}`),
  });

  const contents = 'Beam file transfer test payload. '.repeat(200);
  const file = new Blob([contents], { type: 'text/plain' });
  Object.defineProperty(file, 'name', { value: 'sample.txt' });
  await sender.sendFile(file);

  for (let attempt = 0; attempt < 20 && !received; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(received, `receiver did not complete: ${transferEvents.join(', ')}; chunks=${deliveredChunks}`);
  assert.equal(received.name, 'sample.txt');
  assert.equal(received.verified, true);
  assert.equal(transferEvents[0], `start:sample.txt:${file.size}`);
  assert.equal(transferEvents[1], `sent:${file.size}`);
  assert.equal(await (await fetch(received.url)).text(), contents);
  URL.revokeObjectURL(received.url);
  void receiver;
});
