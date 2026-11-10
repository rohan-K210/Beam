'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('applies relay-only ICE policy and detects a selected relay candidate pair', async () => {
  let constructedConfiguration;
  let peerConnection;

  class FakeRTCPeerConnection {
    constructor(configuration) {
      constructedConfiguration = configuration;
      peerConnection = this;
      this.connectionState = 'connected';
    }

    async getStats() {
      return new Map([
        ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', {
          id: 'pair',
          type: 'candidate-pair',
          state: 'succeeded',
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
          protocol: 'udp',
        }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay' }],
        ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' }],
      ]);
    }

    close() {
      this.connectionState = 'closed';
    }
  }

  const sandbox = {
    window: {},
    RTCPeerConnection: FakeRTCPeerConnection,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, '../client/js/peer.js'), 'utf8'),
    sandbox
  );

  const configuration = {
    iceServers: [{ urls: 'turn:relay.example.test:3478', username: 'u', credential: 'p' }],
    iceTransportPolicy: 'relay',
  };
  let route;
  sandbox.window.createPeerSession({
    polite: true,
    initiator: false,
    configuration,
    sendSignal() {},
    onRoute(value) {
      route = value;
    },
  });

  assert.equal(constructedConfiguration.iceTransportPolicy, 'relay');
  peerConnection.onconnectionstatechange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(route.route, 'relay');
  assert.equal(route.localType, 'relay');
  assert.equal(route.remoteType, 'srflx');
});
