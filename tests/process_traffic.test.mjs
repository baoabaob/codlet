import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createTrafficRuntime } = require('../runtime/host-traffic-bundle.cjs');
const { WebSocket, WebSocketServer } = require('../frontend/node_modules/ws');
const fixture = name => readFile(new URL(`./fixtures/process-traffic/${name}.pem`, import.meta.url));
const [cert, key, ca] = await Promise.all(['cert', 'key', 'ca'].map(fixture));
const fail = (code, message) => Object.assign(new Error(message), { code });
const auth = url => `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
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
  const closed = new Promise(resolve => client.once('close', resolve)); await proxy.close(); await closed;
  assert.equal(proxy.status().open, false);
});

test('ingress lifetime cancels a stalled handler without waiting for plugin code', { timeout: 5000 }, async t => {
  let signal;
  const { proxy } = await setup(t, { http: (_request, exchange) => { signal = exchange.signal; return new Promise(() => {}); } }, { lifetimeMs: 50 });
  const result = await through(proxy.proxyUrl, 'http://codlet-probe.invalid/');
  assert.equal(result.status, 502); assert.equal(signal.aborted, true);
  assert.equal(proxy.status().activeRequests, 0);
});
