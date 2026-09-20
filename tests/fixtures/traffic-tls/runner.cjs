'use strict';
// localhost-{cert,key}.pem is a public test-only self-signed key pair. The CA
// is trusted only by the isolated Node process launched from traffic_tls.test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../../..');
const { WebSocket, WebSocketServer } = require(path.join(root, 'frontend/node_modules/ws'));
const { createTrafficRuntime } = require(path.join(root, 'runtime/host-traffic-bundle.cjs'));
const trusted = process.argv[2] === 'trusted';

(async () => {
  const server = https.createServer({ key: fs.readFileSync(path.join(__dirname, 'localhost-key.pem')), cert: fs.readFileSync(path.join(__dirname, 'localhost-cert.pem')) }, (_req, res) => res.end('verified HTTPS'));
  const connections = new Set();
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  const wsServer = new WebSocketServer({ server });
  let upgrades = 0;
  wsServer.on('connection', ws => { upgrades++; ws.send('immediate WSS welcome'); ws.on('message', (data, binary) => ws.send(data, { binary })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const upstreamOrigin = `https://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const runtime = createTrafficRuntime({ rootSignal: controller.signal, makeError: (code, message) => Object.assign(new Error(message), { code }), async coreRequest(method, params, signal) {
    if (signal.aborted) throw signal.reason;
    if (method === 'host.network.authorizeChannel') return {};
    assert.equal(method, 'host.network.authorizeForward');
    const url = new URL(params.url), origin = new URL(url); if (origin.protocol === 'wss:') origin.protocol = 'https:';
    assert.equal(origin.origin, upstreamOrigin);
    return { url: url.href, origin: origin.origin };
  } });
  const channel = await runtime.api.openChannel({ handlerTimeoutMs: 3000 }, {
    http: (_request, exchange) => exchange.forward({ url: upstreamOrigin + '/fixture' }),
    webSocket: (_request, exchange) => exchange.forward({ url: upstreamOrigin.replace('https:', 'wss:') + '/fixture', serverToClient: frame => frame.binary ? frame : { data: 'checked:' + frame.data, binary: false } })
  });
  try {
    const response = await new Promise((resolve, reject) => {
      http.get(channel.endpoint + '/http', res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); }).on('error', reject);
    });
    assert.equal(response.status, trusted ? 200 : 502);
    if (trusted) assert.equal(response.text, 'verified HTTPS');
    const ws = new WebSocket(channel.endpoint.replace('http:', 'ws:') + '/socket');
    const messages = [];
    ws.on('message', (data, binary) => messages.push({ text: data.toString(), binary }));
    const closed = once(ws, 'close');
    if (trusted) {
      await once(ws, 'open');
      ws.send('echo');
      const until = Date.now() + 2000;
      while (messages.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(messages, [{ text: 'checked:immediate WSS welcome', binary: false }, { text: 'checked:echo', binary: false }]);
      assert.equal(upgrades, 1); ws.close(1000, 'fixture done'); await closed;
    } else {
      ws.on('error', () => {});
      const rejected = await new Promise((resolve, reject) => { ws.once('open', () => reject(new Error('untrusted WSS must not open'))); ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); }); });
      await closed.catch(() => {});
      assert.equal(rejected, 502); assert.equal(upgrades, 0);
    }
    process.stdout.write(JSON.stringify({ https: true, wss: true, trusted }) + '\n');
  } finally {
    controller.abort(); await channel.close(); runtime.closeAll();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => wsServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
