'use strict';
const assert = require('node:assert/strict');
const readline = require('node:readline');
const { connectTrafficGateway } = require('../../runtime/traffic-gateway.cjs');
const { createHostedInterceptors } = require('../../runtime/host-interceptors.cjs');
const lines = readline.createInterface({ input: process.stdin });
const messages = lines[Symbol.asyncIterator]();
const read = async () => JSON.parse((await messages.next()).value);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const root = new AbortController();
(async () => {
  const endpoints = await read();
  const gateway = await connectTrafficGateway(endpoints.gateway, { signal: root.signal });
  write({ ready: true });
  const registration = await read();
  const host = createHostedInterceptors({ rootSignal: root.signal, coreRequest: async (method) => {
    if (method === 'services.traffic.connect') return endpoints.host;
    if (method === 'services.traffic.register') return registration;
    throw new Error('unexpected management operation');
  } });
  const bytes = Buffer.alloc(128 * 1024 + 3, 0x6a);
  let observed = 0, responseObserved = 0;
  const hook = await host.registerInterceptor({}, {
    async request(request) {
      assert.equal(request.headers.some(([name]) => name === 'authorization'), false);
      const chunks = []; for await (const chunk of request.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), bytes); observed++;
      return { request: { body: [Buffer.from('changed:'), bytes] } };
    },
    async response(response) {
      const chunks = []; for await (const chunk of response.body) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), 'upstream'); responseObserved++;
      return { body: [Buffer.from('rewritten:'), ...chunks] };
    },
    webSocket() { return { serverToClient: frame => ({ ...frame, data: Buffer.concat([Buffer.from('frame:'), frame.data]) }) }; },
  });
  await gateway.refresh();
  const exchange = new AbortController();
  const response = await gateway.handlers.http({ id: 'http', url: 'https://allowed.invalid/responses', method: 'POST', headers: [['authorization', 'fixture-secret'], ['content-type', 'text/plain']], body: [bytes] }, {
    signal: exchange.signal, cancel: () => exchange.abort(),
    async forward(request) {
      assert.equal(request.headers.find(([name]) => name === 'authorization')[1], 'fixture-secret');
      const chunks = []; for await (const chunk of request.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from('changed:'), bytes]));
      return { status: 200, headers: [], body: [Buffer.from('upstream')] };
    },
  });
  const chunks = []; for await (const chunk of response.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'rewritten:upstream'); exchange.abort();
  const ws = new AbortController();
  await gateway.handlers.webSocket({ id: 'ws', url: 'wss://allowed.invalid/responses', headers: [], protocols: [] }, {
    signal: ws.signal, cancel: () => ws.abort(),
    async forward(options) {
      const frame = await options.serverToClient({ binary: true, data: bytes }, { signal: ws.signal });
      assert.deepEqual(frame.data, Buffer.concat([Buffer.from('frame:'), bytes]));
      return null;
    },
  });
  await hook.setEnabled(false);
  // Native retirement must cancel an established exchange, not only the next
  // callback. Gateway and Host are separate sockets, so their delivery order
  // across peers is not implied by the management acknowledgement.
  if (!ws.signal.aborted) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('retirement_not_delivered')), 1000);
    ws.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  assert.equal(ws.signal.aborted, true);
  assert.equal(gateway.status().leases, 0);
  assert.equal(hook.inspect().exchanges, 0);
  await gateway.refresh();
  assert.equal(gateway.status().registered, 0);
  assert.equal(observed, 1); assert.equal(responseObserved, 1);
  write({ completed: true, requestBytes: bytes.length, observed, responseObserved });
  root.abort(); lines.close();
})().catch(error => { write({ error: error.code || error.message, stack: error.stack }); root.abort(); lines.close(); process.exitCode = 1; });
