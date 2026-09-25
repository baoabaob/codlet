import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { connectTrafficGateway } = require('../runtime/traffic-gateway.cjs');
const origin = 'https://fixture.invalid';
const hook = { registration: 'hook', pluginId: 'fixture', generation: 1,
  options: { id: 'noop', origins: [origin], handlers: ['request'], timeoutMs: 2000 } };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
async function fixture(t, { sources = async () => {}, snapshot, applied = () => {} } = {}) {
  const root = new AbortController(), calls = []; let event, revision = 1, registrations = [], allowed = true, lease = 0;
  const peer = { async request(method, params, options = {}) {
    calls.push({ method, params });
    if (method === 'snapshot') return snapshot ? snapshot() : { revision, registrations, sources: [] };
    if (method === 'authorize') return { allowed };
    if (method === 'open') { const result = { lease: String(++lease) }; options.prepareResult?.(result); return result; }
    if (method === 'relay') return null;
    if (method === 'applied') { applied(params); return {}; }
    if (['ready', 'release'].includes(method)) return {};
    throw new Error(method);
  }, close() {}, status: () => ({ open: true }) };
  const gateway = await connectTrafficGateway({}, { signal: root.signal, onSources: sources,
    connect: async (_endpoint, options) => { event = options.event; return peer; } });
  t.after(() => root.abort());
  async function request() {
    const controller = new AbortController();
    try { return await gateway.handlers.http({ url: origin + '/responses', method: 'GET', headers: [] }, {
      signal: controller.signal, cancel: () => controller.abort(), forward: async () => ({ status: 200, headers: [], body: 'ok' }),
    }); } finally { controller.abort(); }
  }
  return { gateway, calls, request, event: value => event(value),
    change(next) { registrations = next; event({ event: 'changed', revision: ++revision }); },
    deny() { allowed = false; } };
}

test('stable HTTP/WS traffic reuses the applied snapshot; explicit refresh still synchronizes', async t => {
  const value = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await value.request()).status, 200);
  const ws = new AbortController();
  await value.gateway.handlers.webSocket({ url: origin.replace('https:', 'wss:') + '/responses', headers: [], protocols: [] }, {
    signal: ws.signal, cancel: () => ws.abort(), forward: async () => null,
  }); ws.abort();
  assert.equal(value.calls.filter(v => v.method === 'snapshot').length, 1);
  assert.equal(value.calls.filter(v => v.method === 'applied').length, 1);
  assert.equal(value.calls.filter(v => v.method === 'authorize').length, 0);
  await value.gateway.refresh();
  assert.equal(value.calls.filter(v => v.method === 'snapshot').length, 2);
});

test('new rules apply before dispatch and cached rules still check authority for every exchange', async t => {
  const value = await fixture(t);
  value.change([hook]);
  assert.equal((await value.request()).status, 200);
  assert.equal((await value.request()).status, 200);
  assert.equal(value.calls.filter(v => v.method === 'snapshot').length, 2);
  assert.equal(value.calls.filter(v => v.method === 'relay').length, 2);
  const checks = value.calls.filter(v => v.method === 'authorize').length;
  assert(checks >= 2);
  value.deny();
  await assert.rejects(value.request(), { code: 'permission_denied' });
  assert.equal(value.calls.filter(v => v.method === 'relay').length, 2, 'denied exchange must not reach the plugin');
  value.change([]);
  assert.equal((await value.request()).status, 200);
  assert.equal(value.gateway.status().registered, 0);
  assert.equal(value.gateway.status().leases, 0);
});

test('a change during source application is drained before concurrent requests resume', async t => {
  const entered = deferred(), gate = deferred(); let block = false;
  const value = await fixture(t, { sources: async () => { if (block) { block = false; entered.resolve(); await gate.promise; } } });
  block = true; value.change([hook]); await entered.promise;
  let completed = 0;
  const requests = [value.request(), value.request()].map(value => value.then(result => { completed++; return result; }));
  value.change([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, 0, 'requests wait for a pending source update');
  gate.resolve(); await Promise.all(requests);
  assert.deepEqual(value.calls.filter(v => v.method === 'applied').map(v => v.params.revision), [1, 2, 3]);
  assert.equal(value.calls.filter(v => v.method === 'relay').length, 0, 'removed rule cannot observe waiting requests');
});

test('failed push synchronization closes the gateway instead of using a stale snapshot', async t => {
  let fail = false;
  const value = await fixture(t, { snapshot: () => { if (fail) throw new Error('fixture'); return { revision: 1, registrations: [], sources: [] }; } });
  fail = true; value.event({ event: 'changed', revision: 2 });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(value.request(), { code: 'traffic_unavailable' });
  assert.equal(value.gateway.status().retired, true);
});

test('a change at the refresh promise boundary applies without waiting for user traffic', { timeout: 3000 }, async t => {
  const third = deferred();
  const value = await fixture(t, { applied({ revision }) {
    if (revision === 2) queueMicrotask(() => queueMicrotask(() => value.change([])));
    if (revision === 3) third.resolve();
  } });
  value.change([hook]);
  await third.promise;
  assert.equal(value.gateway.status().registered, 0);
  assert.deepEqual(value.calls.filter(v => v.method === 'applied').map(v => v.params.revision), [1, 2, 3]);
});
