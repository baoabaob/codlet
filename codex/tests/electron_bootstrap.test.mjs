import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { attachElectronTrafficBeforeEntry } = createRequire(import.meta.url)('../host/electron-bootstrap.cjs');
class Peer extends EventTarget {
  static mismatch = false;
  static commands = [];
  closed = false;
  readyState = 1;
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event('close')); }
  send(encoded) {
    const { id, method, params } = JSON.parse(encoded); Peer.commands.push({ method, params });
    let result = {};
    if (method === 'Debugger.evaluateOnCallFrame') result = { result: { value: params.expression.includes('installElectronTraffic') ? { installed: true, pid: 1234 } : { pid: Peer.mismatch ? 9999 : 1234, executable: fs.realpathSync(process.execPath), type: 'browser', ready: false } } };
    if (method === 'Runtime.evaluate') result = { result: { value: params.expression.startsWith('globalThis[Symbol.for("codlet.private.main-traffic-result.') ? { value: { installed:true,activatedSources:[{id:'desktop-main-http',operations:['http.intercept'],protocols:['http'],coverage:['desktop-main-wEe-fetch']}],unsupportedSources:[] } } : true } };
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }));
      if (method === 'Runtime.runIfWaitingForDebugger') this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Debugger.paused', params: { callFrames: [{ callFrameId: 'first' }] } }) }));
    });
  }
}
test('main handshake validates exact new process before disclosing launch settings, installs before resume and closes inspector', async () => {
  const args = { inspectorUrl: 'ws://127.0.0.1:12345/01234567-0123-0123-0123-0123456789ab', expectedPid: 1234, executable: process.execPath, configuration: { secretMarker: 'private-source-token' }, mainSource:'module.exports.installElectronTraffic=()=>({ready:async()=>({installed:true})})', WebSocketClass: Peer, verifyClosed: async () => {} };
  Peer.mismatch = true; Peer.commands = [];
  await assert.rejects(attachElectronTrafficBeforeEntry(args), { code: 'main_bootstrap_identity_mismatch' });
  assert.equal(JSON.stringify(Peer.commands).includes('private-source-token'), false);
  assert.equal(Peer.commands.some(value => value.method === 'Debugger.resume'), false);
  Peer.mismatch = false; Peer.commands = [];
  const result = await attachElectronTrafficBeforeEntry(args);
  assert.equal(result.exactChildVerified, true); assert.equal(result.activatedSources[0].id,'desktop-main-http');
  const install = Peer.commands.findIndex(value => value.params?.expression?.includes('installElectronTraffic'));
  assert(install < Peer.commands.findIndex(value => value.method === 'Debugger.resume'));
  assert(Peer.commands.at(-1).params.expression.includes('.closeInspector()'));
});
