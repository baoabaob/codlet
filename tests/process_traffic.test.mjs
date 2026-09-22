import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createTrafficRuntime, createTrafficInterceptors } = require('../runtime/host-traffic-bundle.cjs');
const { WebSocket, WebSocketServer } = require('../frontend/node_modules/ws');
const fixture = name => readFile(new URL(`./fixtures/process-traffic/${name}.pem`, import.meta.url));
const [cert, key, ca] = await Promise.all(['cert', 'key', 'ca'].map(fixture));
const fail = (code, message) => Object.assign(new Error(message), { code });
const auth = url => `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
test('unmatched CONNECT forwards opaque TLS without calling certificate or plugin handlers', { timeout: 5000 }, async t => {
  let certificates = 0, callbacks = 0;
  const upstream = https.createServer({ cert, key }, (_request, response) => response.end('opaque'));
  const port = await listen(upstream); t.after(() => upstream.close());
  const { proxy } = await setup(t, { http() { callbacks++; throw new Error('not reached'); } }, {
    origins: [], matchesOrigin: () => false,
    certificateFor() { certificates++; throw new Error('not reached'); },
    openTunnel: () => new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => resolve(socket)); socket.once('error', reject);
    }),
  });
  assert.equal((await through(proxy.proxyUrl, 'https://codlet-probe.invalid/')).body, 'opaque');
  assert.equal(certificates, 0); assert.equal(callbacks, 0);
});
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }

export async function tunnel(proxy, hostname = 'codlet-probe.invalid', trusted = true) {
  const url = new URL(proxy);
  const socket = await new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: `${hostname}:443`, headers: { 'Proxy-Authorization': auth(url) } });
    request.on('error', reject);
    request.on('connect', (response, socket, head) => { if (response.statusCode !== 200) { socket.destroy(); reject(fail('connect_rejected', 'CONNECT rejected')); } else { if (head.length) socket.unshift(head); resolve(socket); } });
    request.end();
  });
  return await new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: hostname, ...(trusted ? { ca } : {}), rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    secure.on('error', reject); secure.once('secureConnect', () => resolve(secure));
  });
}
export async function through(proxy, target, { body, headers = {}, trusted = true } = {}) {
  const destination = new URL(target), url = new URL(proxy);
  let agent;
  const secure = destination.protocol === 'https:';
  if (secure) { const socket = await tunnel(proxy, destination.hostname, trusted); agent = new https.Agent({ keepAlive: false }); agent.createConnection = () => socket; }
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(secure ? target : `http://${url.host}`, {
      method: body === undefined ? 'GET' : 'POST', path: secure ? destination.pathname + destination.search : target,
      agent: agent ?? false, headers: { Host: destination.host, 'Proxy-Authorization': auth(url), ...headers },
    }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); if (body !== undefined) request.write(body); request.end();
  });
}
async function setup(t, handlers, configuration = {}) {
  const root = new AbortController();
  const runtime = createTrafficRuntime({ rootSignal: root.signal, makeError: fail, async coreRequest(method, input) {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'host.network.authorizeForward') return { url: input.url };
    throw fail('unexpected_rpc', method);
  } });
  const proxy = await runtime.openProcessIngress({}, handlers, { origins: ['http://codlet-probe.invalid', 'https://codlet-probe.invalid'], certificateFor: async () => ({ key, cert }), ...configuration });
  t.after(() => proxy.close());
  return { root, runtime, proxy };
}

test('authenticated process ingress preserves HTTP/HTTPS destination, bytes and origin auth', { timeout: 10000 }, async t => {
  const seen = [];
  const { proxy, runtime } = await setup(t, { http: async incoming => {
    const chunks = []; for await (const chunk of incoming.body) chunks.push(Buffer.from(chunk));
    seen.push({ url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
    return { status: 201, body: (async function* () { yield 'data: first\n'; yield '\ndata: second\n\n'; })() };
  } });
  assert.equal(runtime.api.openProcessIngress, undefined, 'only the Core owner can prepare an ingress');
  for (const protocol of ['http', 'https']) {
    const result = await through(proxy.proxyUrl, `${protocol}://codlet-probe.invalid/v1/responses?private=fixture`, { body: 'fixture request', headers: { Authorization: 'Bearer fixture' } });
    assert.equal(result.status, 201); assert.equal(result.body, 'data: first\n\ndata: second\n\n');
  }
  assert.deepEqual(seen.map(value => value.url), ['http://codlet-probe.invalid/v1/responses?private=fixture', 'https://codlet-probe.invalid/v1/responses?private=fixture']);
  assert(seen.every(value => value.body === 'fixture request' && value.headers.some(([name, value]) => name.toLowerCase() === 'authorization' && value === 'Bearer fixture')));
  assert(seen.every(value => !value.headers.some(([name]) => name.toLowerCase() === 'proxy-authorization')));
  assert(!JSON.stringify(proxy.status()).includes('private'));
  await assert.rejects(through(proxy.proxyUrl, 'https://codlet-probe.invalid/', { trusted: false }));
  const unauthenticated = new URL(proxy.proxyUrl); unauthenticated.password = 'wrong';
  assert.equal((await through(unauthenticated.href, 'http://codlet-probe.invalid/')).status, 407);
  assert.equal((await through(proxy.proxyUrl, 'http://different.invalid/')).status, 400);
  assert.equal((await through(proxy.proxyUrl, 'https://codlet-probe.invalid/', { headers: { Host: 'different.invalid' } })).status, 400);
});

test('HTTP, CONNECT and WebSocket ingress challenge before any privileged work and allow authenticated retries', { timeout: 10000 }, async t => {
  let requests = 0, certificates = 0, upgrades = 0;
  const upstream = http.createServer(), websocketServer = new WebSocketServer({ server: upstream });
  const upstreamPort = await listen(upstream);
  t.after(() => { for (const socket of websocketServer.clients) socket.terminate(); websocketServer.close(); upstream.close(); });
  const { proxy } = await setup(t, {
    http: () => { requests++; return { status: 200, body: 'authenticated' }; },
    webSocket: async (_request, exchange) => { upgrades++; await exchange.forward({ url: `ws://127.0.0.1:${upstreamPort}/` }); },
  }, { certificateFor: () => { certificates++; return { key, cert }; } });
  const endpoint = new URL(proxy.proxyUrl);
  async function responseHead(method, path, headers = []) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: endpoint.hostname, port: endpoint.port });
      let received = '';
      socket.setTimeout(2000, () => socket.destroy(new Error('proxy header deadline')));
      socket.once('error', reject);
      socket.once('connect', () => socket.write([
        `${method} ${path} HTTP/1.1`, 'Host: codlet-probe.invalid', ...headers, '', '',
      ].join('\r\n')));
      socket.on('data', data => {
        received += data.toString();
        const end = received.indexOf('\r\n\r\n');
        if (end >= 0) { socket.destroy(); resolve(received.slice(0, end)); }
      });
      socket.once('end', () => reject(new Error('proxy closed before response headers')));
    });
  }
  const websocket = ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
  for (const credential of [[], ['Proxy-Authorization: Basic d3Jvbmc6d3Jvbmc=']]) {
    for (const [method, path, headers] of [
      ['GET', 'http://codlet-probe.invalid/', []],
      ['CONNECT', 'codlet-probe.invalid:443', []],
      ['GET', 'http://codlet-probe.invalid/', websocket],
    ]) {
      const head = await responseHead(method, path, [...headers, ...credential]);
      assert.match(head, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/);
      assert.match(head, /\r\nproxy-authenticate: Basic realm="Codlet"(?:\r\n|$)/i);
      assert.match(head, /\r\nconnection: close(?:\r\n|$)/i);
    }
  }
  assert.deepEqual({ requests, certificates, upgrades }, { requests: 0, certificates: 0, upgrades: 0 });
  for (const protocol of ['http', 'https']) {
    const response = await through(proxy.proxyUrl, `${protocol}://codlet-probe.invalid/`);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'authenticated');
    assert.equal(response.headers['proxy-authenticate'], undefined);
  }
  const upgraded = await responseHead('GET', 'http://codlet-probe.invalid/', [...websocket, `Proxy-Authorization: ${auth(endpoint)}`]);
  assert.match(upgraded, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.doesNotMatch(upgraded, /proxy-authenticate/i);
  assert.deepEqual({ requests, certificates, upgrades }, { requests: 2, certificates: 1, upgrades: 1 });
});

test('WSS process ingress reuses bounded bidirectional text and binary transforms', { timeout: 10000 }, async t => {
  const server = http.createServer(), ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
  const port = await listen(server);
  t.after(() => { for (const connection of ws.clients) connection.terminate(); ws.close(); server.close(); });
  let observed;
  const { proxy } = await setup(t, { webSocket: async (incoming, exchange) => {
    observed = incoming.url;
    await exchange.forward({ url: `ws://127.0.0.1:${port}/`, clientToServer: frame => frame.binary ? new Uint8Array([1, ...frame.data]) : 'request:' + frame.data,
      serverToClient: frame => frame.binary ? new Uint8Array([...frame.data, 2]) : frame.data + ':response' });
  } });
  const socket = await tunnel(proxy.proxyUrl);
  const agent = new https.Agent(); agent.createConnection = () => socket;
  const client = new WebSocket('wss://codlet-probe.invalid/v1/responses', { agent });
  t.after(() => client.terminate());
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  assert.equal(observed, 'wss://codlet-probe.invalid/v1/responses');
  for (const [value, expected] of [['hello', Buffer.from('request:hello:response')], [Buffer.from([8, 9]), Buffer.from([1, 8, 9, 2])]]) {
    const received = new Promise(resolve => client.once('message', resolve)); client.send(value); assert.deepEqual(await received, expected);
  }
  const closed = new Promise(resolve => client.once('close', resolve)); proxy.disconnect(); await closed;
  assert.equal(proxy.status().open, true);
  assert.equal((await through(proxy.proxyUrl, 'http://codlet-probe.invalid/')).status, 405, 'new connections still reach the authenticated listener');
});

test('ingress lifetime cancels a stalled handler without waiting for plugin code', { timeout: 5000 }, async t => {
  let signal;
  const { proxy } = await setup(t, { http: (_request, exchange) => { signal = exchange.signal; return new Promise(() => {}); } }, { lifetimeMs: 50 });
  const result = await through(proxy.proxyUrl, 'http://codlet-probe.invalid/');
  assert.equal(result.status, 502); assert.equal(signal.aborted, true);
  assert.equal(proxy.status().activeRequests, 0);
});

test('plain WS CONNECT is pinned to an HTTP origin and does not require a TLS handshake', { timeout: 5000 }, async t => {
  const server = http.createServer(), ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.on('message', data => socket.send(data)));
  const port = await listen(server); t.after(() => { for (const client of ws.clients) client.terminate(); ws.close(); server.close(); });
  const { proxy } = await setup(t, { webSocket: async (request, exchange) => { assert.equal(request.url, 'ws://codlet-probe.invalid/'); await exchange.forward({ url: `ws://127.0.0.1:${port}/` }); } });
  const url = new URL(proxy.proxyUrl);
  const socket = await new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: 'codlet-probe.invalid:80', headers: { 'Proxy-Authorization': auth(url) } });
    request.once('error', reject); request.once('connect', (response, socket) => { assert.equal(response.statusCode, 200); resolve(socket); }); request.end();
  });
  const agent = new http.Agent(); agent.createConnection = () => socket;
  const client = new WebSocket('ws://codlet-probe.invalid/', { agent }); t.after(() => client.terminate());
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const message = new Promise(resolve => client.once('message', resolve)); client.send('plain WS');
  assert.equal((await message).toString(), 'plain WS');
});

test('origin changes strip unknown vendor credentials even without the interceptor registry', async t => {
  let received;
  const server = http.createServer(async (request, response) => { received = request.headers; for await (const _chunk of request) {} response.end('ok'); });
  const port = await listen(server); t.after(() => server.close());
  const { proxy } = await setup(t, { http: (request, exchange) => exchange.forward({ url: `http://127.0.0.1:${port}/`, method: request.method, headers: request.headers, body: request.body }) });
  assert.equal((await through(proxy.proxyUrl, 'http://codlet-probe.invalid/', { body: 'hello', headers: { Authorization: 'Bearer fixture', 'X-Vendor-Secret': 'fixture', 'Content-Type': 'text/plain' } })).body, 'ok');
  assert.equal(received.authorization, undefined); assert.equal(received['x-vendor-secret'], undefined); assert.equal(received['content-type'], 'text/plain');
});

test('registry permission denials retain HTTP 403 and WSS handshake 403', { timeout: 5000 }, async t => {
  const root = new AbortController(); t.after(() => root.abort());
  const registry = createTrafficInterceptors({ rootSignal: root.signal, authorize: async () => false });
  registry.register({ pluginId: 'denied', generation: 1, signal: root.signal }, { id: 'test', origins: ['http://codlet-probe.invalid', 'https://codlet-probe.invalid'] }, { request: () => null, webSocket: () => null });
  const { proxy } = await setup(t, registry.handlers);
  assert.equal((await through(proxy.proxyUrl, 'http://codlet-probe.invalid/')).status, 403);
  const socket = await tunnel(proxy.proxyUrl), agent = new https.Agent(); agent.createConnection = () => socket;
  const client = new WebSocket('wss://codlet-probe.invalid/', { agent });
  await assert.rejects(new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); }), /403/);
  assert.equal(registry.status().active, 0);
});

test('an inherited proxy pointing at the ingress fails without recursively opening tunnels', async t => {
  const root = new AbortController(); let proxyUrl;
  const runtime = createTrafficRuntime({ rootSignal: root.signal, makeError: fail, coreRequest: async (method, input) => {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'host.network.authorizeForward') return { url: input.url };
    if (method === 'services.network.resolve') return { proxyUrl };
    throw new Error('unexpected RPC');
  } });
  t.after(() => root.abort());
  const proxy = await runtime.openProcessIngress({}, { http: (request, exchange) => exchange.forward({ url: request.url, networkProfile: 'mistaken-child-environment' }) }, { origins: ['http://codlet-probe.invalid'], certificateFor: () => ({ key, cert }) });
  t.after(() => proxy.close());
  proxyUrl = `http://${new URL(proxy.proxyUrl).host}`;
  const response = await through(proxy.proxyUrl, 'http://codlet-probe.invalid/');
  assert.equal(response.status, 502); assert.equal(response.body, 'proxy_loop_detected'); assert.equal(proxy.status().activeRequests, 0);
});
