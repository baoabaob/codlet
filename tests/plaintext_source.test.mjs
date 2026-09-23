import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createTrafficRuntime } = require('../runtime/host-traffic-bundle.cjs');
const { createTrafficInterceptors } = require('../runtime/traffic-interceptors.cjs');
const { createPlaintextSource } = require('../runtime/plaintext-source.cjs');
const { connectPlaintextSource } = require('../runtime/plaintext-source-client-bundle.cjs');
const { connectTrafficPeer, createTrafficStreams } = require('../runtime/traffic-wire.cjs');
const { connectTrafficGateway } = require('../runtime/traffic-gateway.cjs');
const { WebSocket, WebSocketServer } = require('../frontend/node_modules/ws');
const fail = code => Object.assign(new Error(code), { code });
const token = 'a'.repeat(43);
const frame = value => { const bytes = Buffer.from(JSON.stringify(value)); const result = Buffer.allocUnsafe(bytes.length + 4); result.writeUInt32BE(bytes.length); bytes.copy(result, 4); return result; };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function bodyText(body) {
  if (body == null) return '';
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
async function fixture(t) {
  const root = new AbortController();
  const registry = createTrafficInterceptors({ rootSignal: root.signal, maxActiveWebSocket: 32, authorize: async () => true });
  let source;
  const runtime = createTrafficRuntime({ rootSignal: root.signal, makeError: fail, async coreRequest(method, params) {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'host.network.authorizeForward') return { url: params.url };
    if (method === 'services.network.resolve') return { proxyUrl: null,
      caPem: params.profile?.startsWith('source-route:') ? source.trustForProfile(params.profile, new URL(params.url)) : '' };
    throw fail('unexpected_rpc');
  } });
  source = await createPlaintextSource({ runtime, gateway: { handlers: registry.handlers }, signal: root.signal });
  const client = connectPlaintextSource(source.descriptor);
  await client.ready;
  t.after(async () => { client.close(); source.close(); registry.close(); root.abort(); });
  return { root, registry, source, client };
}
test('registered private base routes HTTP and split SSE through the same interceptor chain', async t => {
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.url, '/v1/responses?mode=stream&encoded=%2F..');
    assert.equal(await bodyText(request), 'rewritten');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: fir'); response.end('st\n\n');
  });
  const port = await listen(upstream); t.after(() => upstream.close());
  const { registry, source, client } = await fixture(t);
  const owner = new AbortController();
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal }, { id: 'rewrite',
    origins: [`http://127.0.0.1:${port}`] }, {
    request: () => ({ request: { body: 'rewritten' } }),
    response: response => ({ status: 201, headers: response.headers }),
  });
  const reservation = client.reserveRoute({ upstreamBaseUrl: `http://127.0.0.1:${port}/v1` });
  const incoming = http.request(`${reservation.baseUrl}/responses?mode=stream&encoded=%2F..`, { method: 'POST' });
  incoming.end('original');
  await reservation.ready;
  const result = await new Promise((resolve, reject) => {
    incoming.on('response', async response => { try { resolve({ status: response.statusCode, body: await bodyText(response) }); } catch (error) { reject(error); } });
    incoming.on('error', reject);
  });
  assert.deepEqual(result, { status: 201, body: 'data: first\n\n' });
  assert.equal(source.status().routes, 1);
  await reservation.close();
  const closed = await fetch(`${reservation.baseUrl}/responses`);
  assert.equal(closed.status, 502);
});

test('route update changes future dispatch atomically while an active response stays pinned', async t => {
  let seenFirst;
  const firstSeen = new Promise(resolve => { seenFirst = resolve; });
  let finishFirst;
  const firstFinished = new Promise(resolve => { finishFirst = resolve; });
  const first = http.createServer(async (_request, response) => { seenFirst(); await firstFinished; response.end('first'); });
  const second = http.createServer((_request, response) => response.end('second'));
  const [firstPort, secondPort] = await Promise.all([listen(first), listen(second)]);
  t.after(() => { first.close(); second.close(); });
  const { client } = await fixture(t);
  const route = await client.registerRoute({ upstreamBaseUrl: `http://127.0.0.1:${firstPort}/v1` });
  const active = fetch(`${route.baseUrl}/responses`).then(response => response.text());
  await firstSeen;
  assert.deepEqual(await route.update({ upstreamBaseUrl: `http://127.0.0.1:${secondPort}/v1` }), { updated: true });
  assert.equal(await (await fetch(`${route.baseUrl}/responses`)).text(), 'second');
  finishFirst();
  assert.equal(await active, 'first');
  await assert.rejects(route.update({ upstreamBaseUrl: 'https://other.example/v1?invalid=1' }), { code: 'invalid_target' });
  assert.equal(await (await fetch(`${route.baseUrl}/responses`)).text(), 'second');
  await route.close();
  await assert.rejects(route.update({ upstreamBaseUrl: `http://127.0.0.1:${firstPort}/v1` }), { code: 'route_closed' });
});

test('provider base registration accepts ordinary URL normalization without relaxing path boundaries', async t => {
  const { client } = await fixture(t);
  for (const upstreamBaseUrl of ['https://example.com', 'https://example.com:443', 'https://例子.测试']) {
    const route = await client.registerRoute({ upstreamBaseUrl });
    assert.match(route.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/u);
    await route.close();
  }
  await assert.rejects(client.registerRoute({ upstreamBaseUrl: 'https://example.com/a/../b' }), { code: 'invalid_target' });
});

test('route custom CA is bounded, scoped to its upstream origin, and can be cleared on update', async t => {
  const [cert, key] = await Promise.all(['localhost-cert.pem', 'localhost-key.pem'].map(name =>
    readFile(new URL(`./fixtures/traffic-tls/${name}`, import.meta.url), 'utf8')));
  const upstream = https.createServer({ cert, key }, (_request, response) => response.end('trusted'));
  const port = await new Promise(resolve => upstream.listen(0, 'localhost', () => resolve(upstream.address().port)));
  t.after(() => upstream.close());
  const { client, source } = await fixture(t);
  const route = await client.registerRoute({ upstreamBaseUrl: `https://localhost:${port}/v1`, additionalCaPem: cert.repeat(60) });
  assert.equal(await (await fetch(`${route.baseUrl}/responses`)).text(), 'trusted');
  assert.equal(source.status().routes, 1);
  await route.update({ upstreamBaseUrl: `https://localhost:${port}/v1`, additionalCaPem: '' });
  assert.equal((await fetch(`${route.baseUrl}/responses`)).status, 502);
  await assert.rejects(route.update({ upstreamBaseUrl: `https://localhost:${port}/v1`, additionalCaPem: 'not a certificate' }), { code: 'invalid_ca_bundle' });
  await route.close();
});

test('delegated HTTP calls original forward with rewritten request and streams response', async t => {
  const { registry, client, source } = await fixture(t);
  const owner = new AbortController();
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal }, { id: 'desktop', origins: ['https://desktop.example'] }, {
    request: () => ({ request: { headers: [['content-type', 'text/plain']], body: 'changed' } }),
    response: () => ({ status: 202 }),
  });
  let calls = 0;
  const result = await client.interceptHttp({ url: 'https://desktop.example/data', method: 'POST',
    headers: [['authorization', 'secret'], ['content-type', 'text/plain'], ['content-length', '8']], body: Buffer.from('original') }, {
    async forward(input, { signal }) {
      assert.equal(signal.aborted, false); calls++;
      assert.equal(input.url, 'https://desktop.example/data');
      assert.equal(input.credentialMode, 'original');
      assert.equal(input.headers.some(([name]) => name.toLowerCase() === 'content-length'), false);
      assert.equal(await bodyText(input.body), 'changed');
      return { status: 200, finalUrl: input.url, headers: [['content-type', 'text/event-stream']],
        body: (async function* () { yield 'data: a'; yield '\n\n'; })() };
    },
  });
  assert.equal(result.status, 202);
  assert.equal(await bodyText(result.body), 'data: a\n\n');
  assert.equal(calls, 1); assert.equal(source.status().exchanges, 0);
});

test('cross-origin delegated rewrite strips original credentials before original forward', async t => {
  const { registry, client } = await fixture(t);
  const owner = new AbortController();
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal }, { id: 'redirect', origins: ['https://desktop.example'] }, {
    request: () => ({ request: { url: 'https://other.example/data' } }),
  });
  // The first authorize call is intercept, the redirect grant is provided by
  // this fixture's trusted authorize implementation.
  const response = await client.interceptHttp({ url: 'https://desktop.example/data', method: 'GET',
    headers: [['authorization', 'Bearer private'], ['accept', 'application/json']] }, {
    async forward(input) {
      assert.equal(input.url, 'https://other.example/data');
      assert.equal(input.credentialMode, 'omit');
      assert.deepEqual(input.headers, [['accept', 'application/json']]);
      return { status: 200, finalUrl: input.url, headers: [], body: 'okay' };
    },
  });
  assert.equal(await bodyText(response.body), 'okay');
});

test('automatic redirected response is hidden from an interceptor without final-origin grant', async t => {
  const { registry, client } = await fixture(t);
  const owner = new AbortController();
  let observed = 0;
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal }, { id: 'redirected',
    origins: ['https://desktop.example'] }, {
    request: () => null,
    response: () => { observed++; return { status: 299 }; },
  });
  const response = await client.interceptHttp({ url: 'https://desktop.example/data', method: 'GET', headers: [] }, {
    async forward(input) {
      return { status: 200, finalUrl: 'https://other.example/final', headers: [], body: 'redirected secret' };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(observed, 0);
  assert.equal(await bodyText(response.body), 'redirected secret');
});

test('response interceptor may consume an empty 302 stream and replace it with an empty body', async t => {
  const { registry, client, source } = await fixture(t);
  const outer = new AbortController();
  const owner = new AbortController();
  let observed = 0;
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal }, {
    id: 'empty-redirect', origins: ['https://desktop.example'],
  }, {
    async response(response) {
      if (response.status !== 302) return null;
      observed++;
      assert.equal(await bodyText(response.body), '');
      return { body: '' };
    },
  });
  const redirected = await client.interceptHttp({ url: 'https://desktop.example/first', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) {
      return { status: 302, finalUrl: input.url, headers: [['location', '/second']],
        body: (async function* () {})() };
    },
  });
  assert.equal(redirected.status, 302);
  await redirected.body.cancel();
  assert.equal(observed, 1);
  assert.equal(source.status().exchanges, 0);
  const next = await client.interceptHttp({ url: 'https://desktop.example/second', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) { return { status: 200, finalUrl: input.url, headers: [], body: 'next hop' }; },
  });
  assert.equal(next.status, 200);
  assert.equal(await bodyText(next.body), 'next hop');
  assert.equal(outer.signal.aborted, false);
});

test('empty 302 rewrite survives a real gateway relay and Native leaseClosed release ordering', async t => {
  const root = new AbortController();
  let gatewayHandle, gatewayEvent, nextLease = 0, observed = 0, rewriteRedirect = true;
  const hostLeases = new Map();
  const nativePeer = {
    async request(method, params, options = {}) {
      if (method === 'ready') return { ready: true };
      if (method === 'snapshot') return { revision: 1, registrations: [{
        registration: 'fixture-response', pluginId: 'fixture', generation: 1,
        options: { id: 'response', origins: ['https://desktop.example'], handlers: ['response'] },
      }] };
      if (method === 'applied') return { applied: true };
      if (method === 'authorize') return { allowed: true };
      if (method === 'open') {
        const lease = `fixture-lease-${++nextLease}`;
        const controller = new AbortController();
        const streams = createTrafficStreams({ request: async (_operation, relay) =>
          gatewayHandle(relay.operation, { lease: relay.lease, payload: relay.payload }) }, lease, controller.signal);
        hostLeases.set(lease, { controller, streams });
        const result = { lease }; options.prepareResult?.(result); return result;
      }
      if (method === 'relay') {
        const host = hostLeases.get(params.lease);
        if (!host) throw fail('stream_retired');
        if (params.operation !== 'invoke') return host.streams.handle(params.operation, params.payload);
        const { kind, value } = params.payload;
        if (kind !== 'response' || value.status !== 302 || !rewriteRedirect) return null;
        observed++;
        assert.equal(await bodyText(host.streams.importBody(value.body)), '');
        return { body: host.streams.exportBody('') };
      }
      if (method === 'release') {
        const host = hostLeases.get(params.lease);
        if (host) { hostLeases.delete(params.lease); host.controller.abort(); host.streams.dispose(); gatewayEvent({ event: 'leaseClosed', lease: params.lease }); }
        return { released: true };
      }
      throw fail('unexpected_rpc');
    },
    close() {}, status: () => ({ open: true, pending: 0, incoming: 0, queuedBytes: 0 }),
  };
  const gateway = await connectTrafficGateway({ host: '127.0.0.1', port: 1, token: 'fixture' }, {
    signal: root.signal,
    connect: async (_endpoint, { handle, event }) => { gatewayHandle = handle; gatewayEvent = event; return nativePeer; },
  });
  const runtime = createTrafficRuntime({ rootSignal: root.signal, makeError: fail, async coreRequest(method, params) {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'host.network.authorizeForward') return { url: params.url };
    if (method === 'services.network.resolve') return { proxyUrl: null, caPem: '' };
    throw fail('unexpected_rpc');
  } });
  const source = await createPlaintextSource({ runtime, gateway, signal: root.signal });
  const client = connectPlaintextSource(source.descriptor);
  await client.ready;
  t.after(() => { client.close(); source.close(); gateway.close(); root.abort(); });
  const outer = new AbortController();
  const first = await client.interceptHttp({ url: 'https://desktop.example/first', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) { return { status: 302, finalUrl: input.url, headers: [['location', '/second']], body: (async function* () {})() }; },
  });
  assert.equal(first.status, 302);
  await first.body.cancel();
  assert.equal(observed, 1);
  assert.equal(source.status().exchanges, 0);
  const second = await client.interceptHttp({ url: 'https://desktop.example/second', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) { return { status: 200, finalUrl: input.url, headers: [], body: 'next hop' }; },
  });
  assert.equal(await bodyText(second.body), 'next hop');
  rewriteRedirect = false;
  const passthrough = await client.interceptHttp({ url: 'https://desktop.example/plain-redirect', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) { return { status: 302, finalUrl: input.url, headers: [['location', '/final']], body: (async function* () {})() }; },
  });
  assert.equal(passthrough.status, 302);
  assert.equal(await bodyText(passthrough.body), '');
  assert.equal(source.status().exchanges, 0);
  const finalHop = await client.interceptHttp({ url: 'https://desktop.example/final', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) { return { status: 200, finalUrl: input.url, headers: [], body: 'final' }; },
  });
  assert.equal(await bodyText(finalHop.body), 'final');
  assert.equal(outer.signal.aborted, false);
  assert.equal(gateway.status().leases, 0);
});

test('real gateway preserves original finite forward errors before exchange cleanup', async t => {
  const root = new AbortController();
  let event, nextLease = 0;
  const nativePeer = {
    async request(method, params, options = {}) {
      if (method === 'ready') return { ready: true };
      if (method === 'snapshot') return { revision: 1, registrations: [{
        registration: 'fixture-request', pluginId: 'fixture', generation: 1,
        options: { id: 'request', origins: ['https://desktop.example'], handlers: ['request'] },
      }] };
      if (method === 'applied') return { applied: true };
      if (method === 'authorize') return { allowed: true };
      if (method === 'open') { const result = { lease: `error-lease-${++nextLease}` }; options.prepareResult?.(result); return result; }
      if (method === 'relay') return null;
      if (method === 'release') { event({ event: 'leaseClosed', lease: params.lease }); return { released: true }; }
      throw fail('unexpected_rpc');
    },
    close() {}, status: () => ({ open: true, pending: 0, incoming: 0, queuedBytes: 0 }),
  };
  const gateway = await connectTrafficGateway({ host: '127.0.0.1', port: 1, token: 'fixture' }, {
    signal: root.signal, connect: async (_endpoint, callbacks) => { event = callbacks.event; return nativePeer; },
  });
  const runtime = createTrafficRuntime({ rootSignal: root.signal, makeError: fail, async coreRequest(method, params) {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'host.network.authorizeForward') return { url: params.url };
    if (method === 'services.network.resolve') return { proxyUrl: null, caPem: '' };
    throw fail('unexpected_rpc');
  } });
  const source = await createPlaintextSource({ runtime, gateway, signal: root.signal });
  const client = connectPlaintextSource(source.descriptor);
  await client.ready;
  t.after(() => { client.close(); source.close(); gateway.close(); root.abort(); });
  const input = { url: 'https://desktop.example/failure', method: 'GET', headers: [] };
  await assert.rejects(client.interceptHttp(input, {
    async forward(next) { return { status: 0, finalUrl: next.url, headers: [], body: null }; },
  }), { code: 'invalid_response' });
  await assert.rejects(client.interceptHttp(input, {
    async forward() { throw fail('desktop_redirect_unavailable'); },
  }), { code: 'desktop_redirect_unavailable' });
  assert.equal(source.status().exchanges, 0);
  assert.equal(client.status().open, true);
  const recovered = await client.interceptHttp(input, {
    async forward(next) { return { status: 200, finalUrl: next.url, headers: [], body: 'recovered' }; },
  });
  assert.equal(await bodyText(recovered.body), 'recovered');
});

test('cancelling a streaming redirect body leaves the source and outer signal usable for the next hop', async t => {
  const { client, source } = await fixture(t);
  const outer = new AbortController();
  let originalBodyClosed = false, firstForwardSignal;
  const first = await client.interceptHttp({ url: 'https://desktop.example/first', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input, { signal }) {
      firstForwardSignal = signal;
      return { status: 302, finalUrl: input.url, headers: [['location', '/second']],
        body: (async function* () {
          try { yield 'redirect prefix'; await new Promise(() => {}); }
          finally { originalBodyClosed = true; }
        })() };
    },
  });
  assert.equal(first.status, 302);
  const iterator = first.body[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.toString(), 'redirect prefix');
  const cancelled = first.body.cancel();
  assert(cancelled instanceof Promise);
  await cancelled;
  assert.equal(source.status().exchanges, 0);
  const second = await client.interceptHttp({ url: 'https://desktop.example/second', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input, { signal }) {
      assert.equal(signal.aborted, false);
      assert.equal(input.url, 'https://desktop.example/second');
      return { status: 200, finalUrl: input.url, headers: [], body: 'second hop' };
    },
  });
  assert.equal(await bodyText(second.body), 'second hop');
  assert.equal(outer.signal.aborted, false);
  assert.equal(client.status().open, true);
  for (let attempt = 0; attempt < 20 && source.status().exchanges; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(source.status().exchanges, 0);
  assert.equal(firstForwardSignal.aborted, true);
  assert.equal(originalBodyClosed, true);
});

test('an unread redirect body can be cancelled without draining before the next delegated hop', async t => {
  const { client, source } = await fixture(t);
  const outer = new AbortController();
  let originalCancelled = false;
  const first = await client.interceptHttp({ url: 'https://desktop.example/first', method: 'GET', headers: [] }, {
    signal: outer.signal,
    async forward(input) {
      const body = { cancel() { originalCancelled = true; }, [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      } };
      return { status: 302, finalUrl: input.url, headers: [['location', '/second']], body };
    },
  });
  await first.body.cancel();
  assert.equal(originalCancelled, true);
  assert.equal(source.status().exchanges, 0);
  const second = await client.interceptHttp({ url: 'https://desktop.example/second', method: 'GET', headers: [] }, {
    signal: outer.signal, async forward(input) { return { status: 200, finalUrl: input.url, headers: [], body: 'complete' }; },
  });
  assert.equal(await bodyText(second.body), 'complete');
  assert.equal(outer.signal.aborted, false);
});

test('route registration collision and unknown route stay outside the gateway', async t => {
  const { source, client } = await fixture(t);
  client.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  const peer = await connectTrafficPeer(source.descriptor.endpoint);
  t.after(() => peer.close());
  const base = 'http://127.0.0.1:12345/v1';
  await peer.request('route.register', { token, upstreamBaseUrl: base });
  await assert.rejects(peer.request('route.register', { token, upstreamBaseUrl: base }), { code: 'route_collision' });
  const traversal = await fetch(`${source.descriptor.routeBaseUrl}/${token}/%252e%252e/escape`);
  assert.equal(traversal.status, 400);
  const unknown = await fetch(`${source.descriptor.routeBaseUrl}/${'b'.repeat(43)}/responses`);
  assert.equal(unknown.status, 502);
});

test('concurrent source peer registrations never exceed 32 routes after asynchronous admission', async t => {
  const { source, client } = await fixture(t);
  client.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  const peer = await connectTrafficPeer(source.descriptor.endpoint);
  t.after(() => peer.close());
  const attempts = Array.from({ length: 40 }, (_, index) => peer.request('route.register', {
    token: Buffer.alloc(32, index + 1).toString('base64url'),
    upstreamBaseUrl: 'https://example.com',
  }));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 32);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 8);
  assert(rejected.every(result => result.reason.code === 'resource_limit'));
  assert.equal(source.status().routes, 32);
  peer.close();
  for (let attempt = 0; attempt < 20 && source.status().routes; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(source.status().routes, 0);
});

test('private source peer rejects a wrong credential before route registration', async t => {
  const { source, client } = await fixture(t);
  client.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(connectTrafficPeer({ ...source.descriptor.endpoint, token: 'wrong' }), { code: 'peer_closed' });
  assert.equal(source.status().routes, 0);
});

test('simultaneous authenticated source candidates admit one owner and shutdown closes pending sockets', async t => {
  const { source, client } = await fixture(t);
  client.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  const endpoint = source.descriptor.endpoint;
  const sockets = [net.connect(endpoint.port, endpoint.host), net.connect(endpoint.port, endpoint.host)];
  t.after(() => sockets.forEach(socket => socket.destroy()));
  await Promise.all(sockets.map(socket => new Promise(resolve => socket.once('connect', resolve))));
  sockets.forEach(socket => { socket.on('error', () => {}); socket.resume(); });
  sockets.forEach(socket => socket.write(frame({ token: endpoint.token })));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sockets.filter(socket => !socket.destroyed).length, 1);
  source.close();
  await Promise.all(sockets.map(socket => socket.destroyed ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('source socket did not close')), 1000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  })));
  assert.equal(sockets.filter(socket => !socket.destroyed).length, 0);
});

test('delegated cancellation aborts the original forward callback and retires streams', async t => {
  const { client, source } = await fixture(t);
  const controller = new AbortController();
  let started;
  const called = new Promise(resolve => { started = resolve; });
  let cancelled = false;
  const pending = client.interceptHttp({ url: 'https://desktop.example/data', method: 'GET', headers: [] }, {
    signal: controller.signal,
    forward: (_input, { signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => { cancelled = true; reject(fail('request_cancelled')); }, { once: true });
    }),
  });
  await called; controller.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
  for (let attempt = 0; attempt < 20 && source.status().exchanges; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(source.status().exchanges, 0);
});

test('interceptor revocation cancels an in-flight delegated original forward', async t => {
  const { registry, client, source } = await fixture(t);
  const owner = new AbortController();
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal },
    { id: 'revoke', origins: ['https://desktop.example'] }, { request: () => null });
  let started;
  const called = new Promise(resolve => { started = resolve; });
  let cancelled = false;
  const pending = client.interceptHttp({ url: 'https://desktop.example/data', method: 'GET', headers: [] }, {
    forward: (_input, { signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => { cancelled = true; reject(fail('request_cancelled')); }, { once: true });
    }),
  });
  await called; owner.abort();
  await assert.rejects(pending);
  for (let attempt = 0; attempt < 20 && source.status().exchanges; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true); assert.equal(source.status().exchanges, 0);
});

test('registered WebSocket route transforms both directions', async t => {
  const upstream = http.createServer(), ws = new WebSocketServer({ server: upstream });
  ws.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
  const port = await listen(upstream);
  t.after(() => { for (const socket of ws.clients) socket.terminate(); ws.close(); upstream.close(); });
  const { registry, client } = await fixture(t);
  const owner = new AbortController();
  registry.register({ pluginId: 'fixture', generation: 1, signal: owner.signal }, { id: 'ws',
    origins: [`http://127.0.0.1:${port}`] }, {
    webSocket: () => ({
      clientToServer: frame => frame.binary ? new Uint8Array([1, ...frame.data]) : `to:${frame.data}`,
      serverToClient: frame => frame.binary ? new Uint8Array([...frame.data, 4]) : `${frame.data}:back`,
    }),
  });
  const route = await client.registerRoute({ upstreamBaseUrl: `http://127.0.0.1:${port}/v1` });
  const socket = new WebSocket(route.baseUrl.replace(/^http:/u, 'ws:') + '/responses');
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send('hello');
  const result = await new Promise((resolve, reject) => { socket.once('message', data => resolve(data.toString())); socket.once('error', reject); });
  assert.equal(result, 'to:hello:back');
  socket.send(Buffer.from([2, 3]));
  const binary = await new Promise((resolve, reject) => { socket.once('message', (data, isBinary) => resolve({ data: [...data], isBinary })); socket.once('error', reject); });
  assert.deepEqual(binary, { data: [1, 2, 3, 4], isBinary: true });
  socket.close();
  await route.close();
});

test('five simultaneous WebSocket exchanges leave HTTP capacity available', async t => {
  const upstream = http.createServer((_request, response) => response.end('http')), ws = new WebSocketServer({ server: upstream });
  ws.on('connection', socket => socket.on('message', data => socket.send(data)));
  const port = await listen(upstream);
  t.after(() => { for (const socket of ws.clients) socket.terminate(); ws.close(); upstream.close(); });
  const { client, source } = await fixture(t);
  const route = await client.registerRoute({ upstreamBaseUrl: `http://127.0.0.1:${port}/v1` });
  const sockets = Array.from({ length: 5 }, () => new WebSocket(route.baseUrl.replace(/^http:/u, 'ws:') + '/responses'));
  t.after(() => sockets.forEach(socket => socket.terminate()));
  await Promise.all(sockets.map(socket => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); })));
  assert.equal(source.status().routeChannel.activeRequests, 5);
  const echoed = await Promise.all(sockets.map((socket, index) => new Promise((resolve, reject) => {
    socket.once('message', data => resolve(data.toString())); socket.once('error', reject); socket.send(String(index));
  })));
  assert.deepEqual(echoed, ['0', '1', '2', '3', '4']);
  assert.equal(await (await fetch(`${route.baseUrl}/plain`)).text(), 'http');
  await route.close();
});
