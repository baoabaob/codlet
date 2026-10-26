import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostedChannels } = require('../runtime/host-channels.cjs');
const { createHostedInterceptors } = require('../runtime/host-interceptors.cjs');
const { listenTrafficPeer } = require('../runtime/traffic-wire.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = code => Object.assign(new Error(code), { code });

for (const releaseFails of [false, true]) test(`forward reserves its attempt while prior response cancellation ${releaseFails ? 'fails' : 'waits'}`, async () => {
  const root = new AbortController(), release = deferred(), forwards = [];
  const peer = { request(method, params) {
    if (method === 'relay') return release.promise;
    assert.equal(method, 'channel.forward'); forwards.push(params.request.url);
    return Promise.resolve({ status: 200, headers: [], body: forwards.length === 1 ? { stream: 'a'.repeat(32) } : null });
  } };
  const channels = createHostedChannels({ rootSignal: root.signal, getPeer: async () => peer,
    coreRequest: async () => ({ id: 'channel', endpoint: 'http://127.0.0.1:1', protocols: ['http'] }) });
  try {
    const channel = await channels.openChannel({}, { async http(_request, exchange) {
      const first = await exchange.forward({ url: 'http://upstream/first' });
      assert.equal(first.body.cancel(), true);
      const next = exchange.forward({ url: 'http://upstream/second' });
      await assert.rejects(exchange.forward({ url: 'http://upstream/concurrent' }), { code: 'forward_response_pending' });
      assert.deepEqual(forwards, ['http://upstream/first']);
      if (releaseFails) {
        release.reject(failure('peer_closed'));
        await assert.rejects(next, { code: 'peer_closed' });
        await assert.rejects(exchange.forward({ url: 'http://upstream/replay' }), { code: 'peer_closed' });
        assert.equal(exchange.forwardAttempts, 1);
      } else { release.resolve({ cancelled: true }); await next; assert.equal(exchange.forwardAttempts, 2); }
      return { status: 204 };
    } });
    await channels.handle('invoke', { registration: channel.id, lease: 'lease', payload: {
      kind: 'channel.http', value: { id: 'request', headers: [], body: null }, context: { maxForwardAttempts: 4 },
    } }, peer);
    assert.deepEqual(forwards, releaseFails ? ['http://upstream/first'] : ['http://upstream/first', 'http://upstream/second']);
  } finally { channels.closeAll(); root.abort(); }
});

test('channel close keeps its original uncertain completion and activity until authoritative retirement', async () => {
  const root = new AbortController(), completion = deferred(); let dispatched = 0;
  const channels = createHostedChannels({ rootSignal: root.signal, getPeer: async () => ({}), coreRequest(method) {
    if (method.endsWith('openChannel')) return { id: 'channel', endpoint: 'http://127.0.0.1:1', protocols: ['http'] };
    dispatched++; return completion.promise;
  } });
  const channel = await channels.openChannel({}, { http: () => ({ status: 204 }) });
  const closing = channel.close(); assert.equal(channel.close(), closing);
  assert.equal(channels.activity().channels, 1); assert.equal(channel.status().open, false);
  completion.reject(failure('outcome_unknown'));
  await assert.rejects(closing, { code: 'outcome_unknown' });
  await assert.rejects(channel.close(), { code: 'outcome_unknown' });
  assert.equal(dispatched, 1); assert.equal(channels.activity().channels, 1);
  channels.event({ event: 'channelClosed', channel: 'channel' });
  assert.equal(channels.activity().channels, 0);
  channels.closeAll(); root.abort();
});

for (const kind of ['registration', 'source']) test(`${kind} close retains an uncertain receipt in Core update activity without replay`, async t => {
  const root = new AbortController(), completion = deferred(); let dispatched = 0;
  const listener = await listenTrafficPeer({ signal: root.signal, handle: (_peer, method) => {
    if (method === 'activate') return { revision: 1 };
    assert.equal(method, 'synchronized'); return { applied: true };
  } });
  t.after(() => { root.abort(); listener.close(); });
  const interceptors = createHostedInterceptors({ rootSignal: root.signal, coreRequest(method) {
    if (method.endsWith('connectPeer')) return listener.endpoint;
    if (method === 'services.traffic.register') return { registration: 'registration' };
    if (method.endsWith('openSource')) return { source: 'source', endpoint: 'http://127.0.0.1:1', revision: 1 };
    if (method.endsWith('sourceStatus')) return { applied: true, open: true };
    assert.equal(method, kind === 'registration' ? 'services.traffic.unregister' : 'services.traffic.closeSource');
    dispatched++; return completion.promise;
  } });
  const handle = kind === 'registration' ? await interceptors.registerInterceptor({}, { request: () => {} }) : await interceptors.openSource({});
  const closing = handle.close(); assert.equal(handle.close(), closing);
  assert.equal(interceptors.activity()[kind === 'registration' ? 'registrations' : 'sources'], 1);
  completion.reject(failure('outcome_unknown'));
  await assert.rejects(closing, { code: 'outcome_unknown' });
  await assert.rejects(handle.close(), { code: 'outcome_unknown' });
  assert.equal(dispatched, 1);
  assert.equal(interceptors.activity()[kind === 'registration' ? 'registrations' : 'sources'], 1);
  interceptors.closeAll();
});
