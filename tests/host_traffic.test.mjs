import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createTrafficRuntime } = require('../runtime/host-traffic-bundle.cjs');
const { WebSocket, WebSocketServer } = require('../frontend/node_modules/ws');
const tick = delay => new Promise(resolve => setTimeout(resolve, delay));
const failure = (code, message, data) => Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function runtime(origins, errorFactory = failure) {
  const root = new AbortController(), calls = [];
  const value = createTrafficRuntime({
    rootSignal: root.signal,
    makeError: errorFactory,
    async coreRequest(method, params, signal) {
      calls.push([method, params]);
      if (signal.aborted) throw signal.reason;
      if (method === 'host.network.authorizeChannel') return { transport: 'http-loopback', coverage: 'explicit-endpoint' };
      if (method === 'host.network.authorizeForward') {
        const url = new URL(params.url);
        const policy = new URL(url); if (policy.protocol === 'ws:') policy.protocol = 'http:'; else if (policy.protocol === 'wss:') policy.protocol = 'https:';
        if (!origins.has(policy.origin)) throw failure('policy_denied', 'origin denied');
        return { url: url.href, origin: policy.origin };
      }
      throw failure('method_not_found', method);
    },
  });
  return { ...value, root, calls };
}

function request(url, { method = 'GET', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, response => {
      const chunks = [], arrivals = [];
      response.on('data', chunk => { chunks.push(chunk); arrivals.push(Date.now()); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), arrivals }));
    });
    req.once('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test('explicit loopback channel rewrites a real binary POST and streams the selected upstream response', async t => {
  const seen = [[], []];
  const upstreams = await Promise.all([0, 1].map(index => listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen[index].push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(index ? 207 : 200, { 'content-type': 'text/event-stream', 'x-upstream': String(index), connection: 'close' });
    res.write('data: first\n\n');
    await tick(60);
    res.end('data: second\n\n');
  })));
  for (const server of upstreams) t.after(server.close);
  const managed = runtime(new Set(upstreams.map(server => server.origin)));
  t.after(() => managed.closeAll());

  const channel = await managed.api.openHttpChannel({ maxRequestBytes: 1024, maxResponseBytes: 4096 }, async (incoming, exchange) => {
    const chunks = [];
    for await (const chunk of incoming.body) chunks.push(Buffer.from(chunk));
    const route = incoming.headers.find(([name]) => name.toLowerCase() === 'x-route')?.[1] === 'two' ? 1 : 0;
    const response = await exchange.forward({
      url: `${upstreams[route].origin}/responses?selected=${route}`,
      method: 'POST',
      headers: [['content-type', 'application/octet-stream'], ['x-added', 'yes'], ['connection', 'x-remove'], ['x-remove', 'secret']],
      body: Buffer.concat([Buffer.from('changed:'), ...chunks]),
    });
    async function *body() {
      yield 'data: prefix\n\n';
      for await (const chunk of response.body) yield chunk;
    }
    return { status: response.status, headers: [...response.headers, ['x-plugin', 'transformed']], body: body() };
  });
  t.after(() => channel.close());

  const started = Date.now();
  const response = await request(`${channel.endpoint}/v1/responses`, {
    method: 'POST', headers: { 'x-route': 'two', authorization: 'Bearer downstream-only', 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2, 255]),
  });
  assert.equal(response.status, 207, response.body.toString());
  assert.equal(response.headers['x-plugin'], 'transformed');
  assert.equal(seen[0].length, 0);
  assert.equal(seen[1].length, 1);
  assert.equal(seen[1][0].method, 'POST');
  assert.equal(seen[1][0].headers['x-added'], 'yes');
  assert.equal(seen[1][0].headers.authorization, undefined, 'incoming credentials are never inherited');
  assert.equal(seen[1][0].headers['x-remove'], undefined, 'Connection-nominated headers are stripped');
  assert.deepEqual(seen[1][0].body, Buffer.concat([Buffer.from('changed:'), Buffer.from([0, 1, 2, 255])]));
  assert.equal(response.body.toString(), 'data: prefix\n\ndata: first\n\ndata: second\n\n');
  assert.ok(response.arrivals.length >= 2);
  assert.ok(response.arrivals[0] - started < 60, 'the first transformed SSE chunk arrives before upstream completion');
  assert.equal(managed.calls.filter(([method]) => method === 'host.network.authorizeChannel').length, 2, 'open and each inbound request are freshly authorized');
  assert.equal(managed.calls.filter(([method]) => method === 'host.network.authorizeForward').length, 1);
});

test('origin denial, handler timeout, byte caps and a second forward have deterministic failures without replay', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(async (req, res) => {
    upstreamCalls += 1;
    for await (const _chunk of req) {}
    res.end('upstream');
  });
  t.after(upstream.close);
  const managed = runtime(new Set([upstream.origin]));
  t.after(() => managed.closeAll());

  let mode = 'denied';
  const channel = await managed.api.openHttpChannel({ handlerTimeoutMs: 40, maxRequestBytes: 4, maxResponseBytes: 8 }, async (incoming, exchange) => {
    if (mode === 'denied') return exchange.forward({ url: 'http://127.0.0.1:1/blocked' });
    if (mode === 'timeout') return new Promise(() => {});
    if (mode === 'large-request') { for await (const _chunk of incoming.body) {} return { status: 204 }; }
    if (mode === 'informational') return { status: 103 };
    if (mode === 'connect') return exchange.forward({ url: `${upstream.origin}/tunnel`, method: 'connect' });
    const response = await exchange.forward({ url: `${upstream.origin}/once` });
    await assert.rejects(exchange.forward({ url: `${upstream.origin}/twice` }), { code: 'forward_response_pending' });
    return response;
  });
  t.after(() => channel.close());

  assert.equal((await request(`${channel.endpoint}/denied`)).status, 403);
  mode = 'timeout'; assert.equal((await request(`${channel.endpoint}/timeout`)).status, 504);
  mode = 'large-request'; assert.equal((await request(`${channel.endpoint}/large`, { method: 'POST', body: '12345' })).status, 413);
  mode = 'informational'; assert.equal((await request(`${channel.endpoint}/informational`)).status, 502);
  mode = 'connect'; assert.equal((await request(`${channel.endpoint}/connect`)).status, 502);
  mode = 'once'; assert.equal((await request(`${channel.endpoint}/once`)).status, 200);
  assert.equal(upstreamCalls, 1, 'Core never retries and the second dispatch is rejected');
});

test('multiple HTTP attempts are explicit, bounded and require releasing the prior response', async t => {
  const paths = [];
  const upstream = await listen((req, res) => {
    paths.push(req.url);
    if (req.url === '/first') res.writeHead(503, { 'content-type': 'text/plain' });
    else res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url);
  });
  t.after(upstream.close);
  const managed = runtime(new Set([upstream.origin]));
  t.after(() => managed.closeAll());
  let observed;
  const channel = await managed.api.openHttpChannel({ maxForwardAttempts: 2 }, async (_incoming, exchange) => {
    const first = await exchange.forward({ url: `${upstream.origin}/first` });
    assert.equal(exchange.forwardAttempts, 1);
    await assert.rejects(exchange.forward({ url: `${upstream.origin}/overlap` }), { code: 'forward_response_pending' });
    assert.equal(first.body.cancel(), true);
    const second = await exchange.forward({ url: `${upstream.origin}/second` });
    observed = { attempts: exchange.forwardAttempts, maximum: exchange.maxForwardAttempts };
    const chunks = [];
    for await (const chunk of second.body) chunks.push(Buffer.from(chunk));
    await assert.rejects(exchange.forward({ url: `${upstream.origin}/third` }), { code: 'forward_attempt_limit' });
    return { status: second.status, headers: second.headers, body: Buffer.concat(chunks) };
  });
  t.after(() => channel.close());

  const response = await request(`${channel.endpoint}/run`);
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), '/second');
  assert.deepEqual(paths, ['/first', '/second']);
  assert.deepEqual(observed, { attempts: 2, maximum: 2 });
  assert.equal(channel.status().forwardAttempts, 2);
  assert.equal(managed.calls.filter(([method]) => method === 'host.network.authorizeForward').length, 2);
});

test('channel count includes concurrent opens and releases capacity on close', async t => {
  const root = new AbortController();
  let releaseAuthorization;
  const gate = new Promise(resolve => { releaseAuthorization = resolve; });
  const managed = createTrafficRuntime({
    rootSignal: root.signal,
    makeError: failure,
    async coreRequest(method) {
      if (method !== 'host.network.authorizeChannel') throw failure('method_not_found', method);
      await gate;
      return { transport: 'http-loopback', coverage: 'explicit-endpoint' };
    },
  });
  t.after(() => managed.closeAll());
  const pending = Array.from({ length: 4 }, () => managed.api.openHttpChannel({}, () => ({ status: 204 })));
  await assert.rejects(managed.api.openHttpChannel({}, () => ({ status: 204 })), { code: 'channel_limit' });
  releaseAuthorization();
  const channels = await Promise.all(pending);
  await channels[0].close();
  const replacement = await managed.api.openHttpChannel({}, () => ({ status: 204 }));
  assert.equal(replacement.status().open, true);
  await Promise.all([...channels.slice(1), replacement].map(channel => channel.close()));
});

test('retiring while the loopback listen callback is pending closes the unregistered listener', async t => {
  const originalCreateServer = http.createServer;
  let boundPort;
  http.createServer = (...args) => {
    const server = originalCreateServer(...args);
    const originalListen = server.listen;
    server.listen = function (...listenArgs) {
      const callback = listenArgs.at(-1);
      listenArgs[listenArgs.length - 1] = () => {
        boundPort = server.address().port;
        setTimeout(callback, 40);
      };
      return originalListen.apply(this, listenArgs);
    };
    return server;
  };
  t.after(() => { http.createServer = originalCreateServer; });
  const managed = runtime(new Set());
  const opening = managed.api.openHttpChannel({}, () => ({ status: 204 }));
  while (boundPort === undefined) await tick(1);
  managed.closeAll();
  await assert.rejects(opening, { code: 'host_stopping' });
  const probe = await new Promise(resolve => {
    const socket = net.connect(boundPort, '127.0.0.1');
    socket.once('connect', () => resolve(false));
    socket.once('error', () => resolve(true));
  });
  assert.equal(probe, true);
});

test('closing a channel aborts an in-flight upstream and refuses CONNECT and Upgrade', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstream = await listen((_req, res) => res.once('close', upstreamClosed));
  t.after(upstream.close);
  const managed = runtime(new Set([upstream.origin]));
  t.after(() => managed.closeAll());
  const channel = await managed.api.openHttpChannel({}, (_incoming, exchange) => exchange.forward({ url: `${upstream.origin}/hang` }));

  const pending = request(`${channel.endpoint}/hang`).catch(error => error);
  await tick(30);
  await channel.close();
  await Promise.race([closed, tick(1000).then(() => assert.fail('upstream socket was not cancelled'))]);
  assert.ok(await pending instanceof Error);
  assert.equal(channel.status().open, false);

  const probe = await new Promise((resolve, reject) => {
    const parsed = new URL(channel.endpoint);
    const socket = net.connect(Number(parsed.port), parsed.hostname);
    socket.once('connect', () => reject(new Error('closed listener still accepted a socket')));
    socket.once('error', resolve);
  });
  assert.ok(probe instanceof Error);
});

test('cancellation after upstream headers destroys an unread or stalled SSE response', async t => {
  let resolveClosed;
  const upstreamClosed = new Promise(resolve => { resolveClosed = resolve; });
  const upstream = await listen((_req, res) => {
    res.once('close', resolveClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  t.after(upstream.close);
  const managed = runtime(new Set([upstream.origin]));
  t.after(() => managed.closeAll());
  const channel = await managed.api.openHttpChannel({}, async (_incoming, exchange) => exchange.forward({ url: `${upstream.origin}/stream` }));

  const firstChunk = new Promise((resolve, reject) => {
    const req = http.get(`${channel.endpoint}/stream`, response => response.once('data', resolve));
    req.once('error', reject);
  });
  assert.equal((await firstChunk).toString(), 'data: first\n\n');
  await channel.close();
  await Promise.race([upstreamClosed, tick(1000).then(() => assert.fail('stalled upstream response survived channel close'))]);

  const discardClosed = new Promise(resolve => { resolveClosed = resolve; });
  const discard = await managed.api.openHttpChannel({}, async (_incoming, exchange) => {
    await exchange.forward({ url: `${upstream.origin}/discard` });
    return { status: 204 };
  });
  await request(`${discard.endpoint}/discard`);
  await Promise.race([discardClosed, tick(1000).then(() => assert.fail('unread upstream body survived exchange completion'))]);
  await discard.close();
});

test('an upstream stream failure before body consumption is contained and observable', async t => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => res.destroy(), 5);
  });
  t.after(upstream.close);
  const managed = runtime(new Set([upstream.origin]));
  t.after(() => managed.closeAll());
  const channel = await managed.api.openHttpChannel({}, async (_incoming, exchange) => {
    const response = await exchange.forward({ url: `${upstream.origin}/cut` });
    await tick(20);
    await assert.rejects(async () => {
      for await (const _chunk of response.body) {}
    }, { code: 'stream_failed' });
    return { status: 204 };
  });
  t.after(() => channel.close());
  assert.equal((await request(`${channel.endpoint}/cut`)).status, 204);
});

test('downstream cancellation releases a slot held by a blocked response iterator or handler', async t => {
  const managed = runtime(new Set());
  t.after(() => managed.closeAll());
  let iteratorReturned = false;
  const blockedBody = {
    calls: 0,
    [Symbol.asyncIterator]() { return this; },
    next() {
      this.calls += 1;
      return this.calls === 1 ? Promise.resolve({ done: false, value: 'first' }) : new Promise(() => {});
    },
    return() { iteratorReturned = true; return Promise.resolve({ done: true }); },
  };
  const channel = await managed.api.openHttpChannel({ maxConcurrent: 1 }, incoming => {
    if (incoming.path === '/body') return { status: 200, body: blockedBody };
    if (incoming.path === '/handler') return new Promise(() => {});
    return { status: 204 };
  });
  t.after(() => channel.close());

  await new Promise((resolve, reject) => {
    const pending = http.get(`${channel.endpoint}/body`, response => {
      response.once('data', () => { pending.destroy(); resolve(); });
    });
    pending.once('error', reason => { if (reason.code !== 'ECONNRESET') reject(reason); });
  });
  const bodyDeadline = Date.now() + 1000;
  while (channel.status().activeRequests !== 0 && Date.now() < bodyDeadline) await tick(5);
  assert.equal(channel.status().activeRequests, 0);
  assert.equal(iteratorReturned, true);
  assert.equal((await request(`${channel.endpoint}/after-body`)).status, 204);

  const blockedHandler = http.get(`${channel.endpoint}/handler`);
  blockedHandler.once('error', () => {});
  const handlerDeadline = Date.now() + 1000;
  while (channel.status().activeRequests !== 1 && Date.now() < handlerDeadline) await tick(5);
  assert.equal(channel.status().activeRequests, 1);
  blockedHandler.destroy();
  const handlerReleaseDeadline = Date.now() + 1000;
  while (channel.status().activeRequests !== 0 && Date.now() < handlerReleaseDeadline) await tick(5);
  assert.equal(channel.status().activeRequests, 0);
  assert.equal((await request(`${channel.endpoint}/after-handler`)).status, 204);
});

test('one private endpoint proxies WebSocket text and binary frames with ordered transforms and subprotocol negotiation', async t => {
  const httpServer = http.createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer, handleProtocols: protocols => protocols.has('codex.v1') ? 'codex.v1' : false });
  const upstreamFrames = [], upgradeHeaders = [];
  let resolveUpstreamClose;
  const upstreamClose = new Promise(resolve => { resolveUpstreamClose = resolve; });
  webSocketServer.on('connection', socket => {
    socket.send('welcome');
    socket.once('close', code => resolveUpstreamClose(code));
    socket.on('message', (data, binary) => {
      upstreamFrames.push({ data: Buffer.from(data), binary });
      socket.send(binary ? Buffer.concat([Buffer.from([9]), data]) : `upstream:${data.toString()}`, { binary });
    });
  });
  webSocketServer.on('headers', (_headers, request) => upgradeHeaders.push(request.headers));
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => webSocketServer.close(() => httpServer.close(resolve))));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const managed = runtime(new Set([origin]));
  t.after(() => managed.closeAll());

  const channel = await managed.api.openChannel({ maxWebSocketMessageBytes: 1024, maxWebSocketQueueBytes: 2048 }, {
    http: () => ({ status: 200, body: 'http-ready' }),
    async webSocket(_request, exchange) {
      await exchange.forward({
        url: origin.replace('http:', 'ws:') + '/realtime', protocols: ['codex.v1'], headers: [['x-added', 'yes']],
        clientToServer(frame) { return frame.binary ? new Uint8Array([7, ...frame.data]) : `client:${frame.data}`; },
        serverToClient(frame) { return frame.binary ? new Uint8Array([8, ...frame.data]) : `plugin:${frame.data}`; },
      });
    },
  });
  t.after(() => channel.close());
  assert.deepEqual(channel.protocols, ['http', 'websocket']);
  assert.deepEqual(channel.status().protocols, ['http', 'websocket']);

  const endpoint = channel.endpoint.replace('http:', 'ws:') + '/v1/realtime';
  const client = new WebSocket(endpoint, ['codex.v1'], { headers: { authorization: 'Bearer downstream-only' } });
  t.after(() => client.terminate());
  const replies = [];
  client.on('message', (data, binary) => replies.push({ data: Buffer.from(data), binary }));
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  assert.equal(client.protocol, 'codex.v1');
  client.send('hello');
  client.send(Buffer.from([1, 2]), { binary: true });
  const until = Date.now() + 2000;
  while (replies.length < 3 && Date.now() < until) await tick(5);
  assert.equal(replies.length, 3);
  assert.deepEqual(upstreamFrames.map(frame => [frame.data, frame.binary]), [[Buffer.from('client:hello'), false], [Buffer.from([7, 1, 2]), true]]);
  assert.deepEqual(replies.map(frame => [frame.data, frame.binary]), [[Buffer.from('plugin:welcome'), false], [Buffer.from('plugin:upstream:client:hello'), false], [Buffer.from([8, 9, 7, 1, 2]), true]]);
  assert.equal(upgradeHeaders[0]['x-added'], 'yes');
  assert.equal(upgradeHeaders[0].authorization, undefined, 'downstream credentials are not inherited by the upstream handshake');
  client.close();
  await new Promise(resolve => client.once('close', resolve));
  assert.equal(await upstreamClose, 1005, 'a no-status close propagates without attempting close(1005)');
  assert.equal(managed.calls.filter(([method]) => method === 'host.network.authorizeForward').length, 1);
});

test('WebSocket origin denial rejects the handshake before accepting the downstream socket', async t => {
  const managed = runtime(new Set());
  t.after(() => managed.closeAll());
  const channel = await managed.api.openChannel({}, {
    webSocket: (_request, exchange) => exchange.forward({ url: 'ws://127.0.0.1:1/denied' }),
  });
  t.after(() => channel.close());
  const status = await new Promise(resolve => {
    const client = new WebSocket(channel.endpoint.replace('http:', 'ws:'));
    client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    client.once('open', () => resolve(101));
    client.once('error', () => {});
  });
  assert.equal(status, 403);
});

test('WebSocket limits apply after transforms and count zero-byte queued frames', async t => {
  const server = http.createServer();
  const serverSockets = new Set();
  server.on('connection', socket => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
  const upstreamWs = new WebSocketServer({ server });
  upstreamWs.on('connection', socket => socket.on('message', data => socket.send(data)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => {
    for (const socket of upstreamWs.clients) socket.terminate();
    for (const socket of serverSockets) socket.destroy();
    upstreamWs.close();
    server.close(resolve);
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const managed = runtime(new Set([origin]));
  t.after(() => managed.closeAll());
  const transformed = await managed.api.openChannel({ maxWebSocketMessageBytes: 4 }, {
    webSocket: (_request, exchange) => exchange.forward({ url: origin.replace('http:', 'ws:'), clientToServer: () => '12345' }),
  });
  const first = new WebSocket(transformed.endpoint.replace('http:', 'ws:'));
  await new Promise((resolve, reject) => { first.once('open', resolve); first.once('error', reject); });
  first.send('x');
  const transformedClose = await new Promise(resolve => first.once('close', resolve));
  assert.equal(transformedClose, 1011);
  await transformed.close();

  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const queued = await managed.api.openChannel({ maxWebSocketMessageBytes: 4, maxWebSocketQueueBytes: 16, maxWebSocketQueueFrames: 2 }, {
    webSocket: (_request, exchange) => exchange.forward({ url: origin.replace('http:', 'ws:'), clientToServer: async frame => { await wait; return frame; } }),
  });
  t.after(() => queued.close());
  const second = new WebSocket(queued.endpoint.replace('http:', 'ws:'));
  await new Promise((resolve, reject) => { second.once('open', resolve); second.once('error', reject); });
  const closed = new Promise(resolve => second.once('close', resolve));
  // Force the defensive queue bound independently of TCP backpressure. In
  // production pause() normally prevents these frames reaching JS this fast.
  const originalPause = net.Socket.prototype.pause;
  net.Socket.prototype.pause = function () { return this; };
  let queueClose;
  try {
    for (let index = 0; index < 16; index++) second.send(Buffer.alloc(0));
    queueClose = await Promise.race([closed, tick(1000).then(() => null)]);
  } finally {
    net.Socket.prototype.pause = originalPause;
    release();
  }
  if (queueClose === null) { second.terminate(); await queued.close(); }
  assert.equal(queueClose, 1013);
  await queued.close();
});

test('an upstream WebSocket HTTP rejection is returned before downstream acceptance', async t => {
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const managed = runtime(new Set([origin]));
  t.after(() => managed.closeAll());
  const channel = await managed.api.openChannel({}, {
    webSocket: (_request, exchange) => exchange.forward({ url: origin.replace('http:', 'ws:') }),
  });
  t.after(() => channel.close());
  const status = await new Promise(resolve => {
    const client = new WebSocket(channel.endpoint.replace('http:', 'ws:'));
    client.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    client.once('error', () => {});
  });
  assert.equal(status, 429);
});

test('a minimal worker error factory still preserves WebSocket 426 for HTTP fallback', async t => {
  const server = http.createServer((_request, response) => response.end('http-fallback'));
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const managed = runtime(new Set([origin]), (code, message) => Object.assign(new Error(message), { code }));
  t.after(() => managed.closeAll());
  const channel = await managed.api.openChannel({}, {
    http: (_request, exchange) => exchange.forward({ url: origin }),
    webSocket: (_request, exchange) => exchange.forward({ url: origin.replace('http:', 'ws:') }),
  });
  for (let turn = 0; turn < 2; turn++) {
    const status = await new Promise(resolve => {
      const client = new WebSocket(channel.endpoint.replace('http:', 'ws:'));
      client.once('unexpected-response', (_request, response) => { response.resume(); client.terminate(); resolve(response.statusCode); });
      client.once('error', () => {});
    });
    assert.equal(status, 426); assert.equal(await (await fetch(channel.endpoint)).text(), 'http-fallback');
  }
});
