import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTrafficInterceptors } = require('../runtime/traffic-interceptors.cjs');
const origin = 'https://fixture.invalid';
function setup(t, authorize = async (_owner, action) => action !== 'sensitiveHeaders') {
  const root = new AbortController();
  const registry = createTrafficInterceptors({ rootSignal: root.signal, authorize, networkProfile: 'saved-upstream' });
  t.after(() => root.abort());
  const owners = [];
  function register(id, callbacks, options = {}) {
    const owner = { pluginId: id, generation: 1, signal: (owners[owners.push(new AbortController()) - 1]).signal };
    return registry.register(owner, { id: 'test', origins: [origin], ...options }, callbacks);
  }
  const controller = new AbortController(), forwarded = [];
  const exchange = { signal: controller.signal, cancel: () => controller.abort(), forward: async request => { forwarded.push(request); return { status: 200, headers: [['set-cookie', 'fixture']], body: ['response'] }; } };
  t.after(() => controller.abort());
  const request = { url: `${origin}/responses?private=fixture`, method: 'POST', headers: [['authorization', 'Bearer fixture'], ['x-vendor-secret', 'fixture'], ['content-type', 'text/plain']], body: ['request'] };
  return { root, registry, register, owners, forwarded, controller, exchange, request };
}
test('request order is deterministic, response order reverses, sensitive headers stay opaque', async t => {
  const trace = [];
  const next = setup(t);
  for (const id of ['z', 'a']) next.register(id, { request(request) { trace.push(`${id}:request`); assert(!request.headers.some(([name]) => name === 'authorization')); return { request: { body: [id] } }; }, response(response) { trace.push(`${id}:response`); assert(!response.headers.some(([name]) => name === 'set-cookie')); } });
  await next.registry.handlers.http(next.request, next.exchange);
  assert.deepEqual(trace, ['a:request', 'z:request', 'z:response', 'a:response']);
  assert.equal(next.forwarded[0].networkProfile, 'saved-upstream');
  assert(next.forwarded[0].headers.some(([name, value]) => name === 'authorization' && value === 'Bearer fixture'));
  assert.equal(next.registry.status().active, 1);
  next.controller.abort(); assert.equal(next.registry.status().active, 0);
});
test('first terminal decision wins and later plugins never observe a blocked request', async t => {
  const value = setup(t);
  value.register('a', { request: () => ({ block: true }), response: (_response, context) => { assert.equal(context.source, 'synthetic'); } });
  value.register('b', { request: () => { assert.fail('must not run'); } });
  assert.equal((await value.registry.handlers.http(value.request, value.exchange)).status, 403);
  assert.equal(value.forwarded.length, 0);
});
test('origin rewrites require a separate grant and remove even unknown credential headers', async t => {
  const seen = [], value = setup(t, async (_owner, action, url) => { seen.push([action, url]); return true; });
  value.register('a', { request: () => ({ request: { url: 'https://alternate.invalid/responses' } }) });
  value.register('b', { request: () => assert.fail('a rewrite must not expand another observer scope') });
  await value.registry.handlers.http(value.request, value.exchange);
  assert.deepEqual(value.forwarded[0].headers, [['content-type', 'text/plain']]);
  assert(seen.some(([action, url]) => action === 'redirect' && url === 'https://alternate.invalid/responses'));
  const denied = setup(t, async (_owner, action) => action !== 'redirect');
  denied.register('a', { request: () => ({ request: { url: 'https://alternate.invalid/' } }) });
  await assert.rejects(denied.registry.handlers.http(denied.request, denied.exchange), { code: 'permission_denied' });
  assert.equal(denied.forwarded.length, 0);
});
test('unprivileged header rewrites preserve hidden headers and cannot inject credentials', async t => {
  const value = setup(t);
  value.register('a', { request: () => ({ request: { headers: [['content-type', 'application/json']] } }) });
  await value.registry.handlers.http(value.request, value.exchange);
  assert.deepEqual(value.forwarded[0].headers, [['content-type', 'application/json'], ['authorization', 'Bearer fixture'], ['x-vendor-secret', 'fixture']]);
  const denied = setup(t);
  denied.register('b', { request: () => ({ request: { headers: [['Authorization', 'other']] } }) });
  await assert.rejects(denied.registry.handlers.http(denied.request, denied.exchange), { code: 'permission_denied' });
});
test('synthetic responses enforce the same sensitive-header grant as response rewrites', async t => {
  const denied = setup(t);
  denied.register('a', { request: () => ({ respond: { status: 200, headers: [['Set-Cookie', 'session=fixture; HttpOnly']] } }) });
  await assert.rejects(denied.registry.handlers.http(denied.request, denied.exchange), { code: 'permission_denied' });
  assert.equal(denied.forwarded.length, 0);

  const ordinary = setup(t);
  ordinary.register('a', { request: () => ({ respond: { status: 200, headers: [['Content-Type', 'text/plain']], body: 'synthetic' } }) });
  assert.deepEqual((await ordinary.registry.handlers.http(ordinary.request, ordinary.exchange)).headers, [['Content-Type', 'text/plain']]);

  const privileged = setup(t, async () => true);
  privileged.register('a', { request: () => ({ respond: { status: 200, headers: [['Set-Cookie', 'session=fixture; HttpOnly']] } }) });
  assert.deepEqual((await privileged.registry.handlers.http(privileged.request, privileged.exchange)).headers, [['Set-Cookie', 'session=fixture; HttpOnly']]);
});
test('disable, generation retirement and timeout cancel exchanges and release their slots', async t => {
  for (const mode of ['disable', 'retire', 'timeout']) {
    const value = setup(t); let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const handle = value.register('a', { request: () => { entered(); return new Promise(() => {}); } }, { timeoutMs: 20 });
    const pending = value.registry.handlers.http(value.request, value.exchange);
    await started;
    if (mode === 'disable') handle.setEnabled(false);
    if (mode === 'retire') value.owners[0].abort();
    await assert.rejects(pending, { code: mode === 'timeout' ? 'interceptor_timeout' : 'interceptor_retired' });
    assert.equal(value.registry.status().active, 0); assert(value.controller.signal.aborted);
  }
});
test('callback errors never propagate private messages into the traffic failure code', async t => {
  const value = setup(t);
  value.register('a', { request: () => { throw Object.assign(new Error('private token and body'), { code: 'private-url-query' }); } });
  await assert.rejects(value.registry.handlers.http(value.request, value.exchange), error => error.code === 'interceptor_failed' && !String(error).includes('private'));
});
test('WebSocket transforms execute in both directions and stop after permission revocation', async t => {
  let allowed = true;
  const value = setup(t, async () => allowed);
  for (const id of ['b', 'a']) value.register(id, { webSocket: () => ({ clientToServer: frame => ({ ...frame, data: frame.data + id }), serverToClient: frame => ({ ...frame, data: frame.data + id }) }) });
  await value.registry.handlers.webSocket({ ...value.request, url: 'wss://fixture.invalid/responses', protocols: [] }, value.exchange);
  const forward = value.forwarded[0], frame = { data: '', binary: false }, context = { signal: value.exchange.signal };
  assert.deepEqual(await forward.clientToServer(frame, context), { data: 'ab', binary: false });
  assert.deepEqual(await forward.serverToClient(frame, context), { data: 'ba', binary: false });
  allowed = false;
  await assert.rejects(forward.clientToServer(frame, context), { code: 'permission_denied' });
});
