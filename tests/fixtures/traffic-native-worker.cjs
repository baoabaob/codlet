'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const tls = require('node:tls');
const readline = require('node:readline');
const { startTrafficWorker } = require('../../runtime/traffic-worker-bundle.cjs');
const { createHostedInterceptors } = require('../../runtime/host-interceptors.cjs');
const lines = readline.createInterface({ input: process.stdin });
const messages = lines[Symbol.asyncIterator]();
const read = async () => JSON.parse((await messages.next()).value);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const root = new AbortController(); let worker;
(async () => {
  const config = await read();
  worker = await startTrafficWorker({ endpoint: config.gateway, directory: config.directory, trustOutputs: ['CODEX_CA_CERTIFICATE'] }, { signal: root.signal, environment: {} });
  write({ ready: true });
  const { registration, descriptor } = await read();
  const host = createHostedInterceptors({ rootSignal: root.signal, coreRequest: async method => method === 'services.traffic.connect' ? config.host : { registration } });
  await host.registerInterceptor({}, { request(request) {
    assert.equal(request.url, 'https://allowed.invalid/responses');
    return { respond: { status: 200, body: 'native-worker-through-TLS' } };
  } });
  assert.equal(worker.status().gateway.registered, 1, 'registration resolves only after the gateway applied its origin filter');
  const proxy = new URL(descriptor.proxyUrl), ca = await fs.readFile(descriptor.bundlePath);
  const tunnel = await new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'allowed.invalid:443', headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` } });
    request.on('error', reject); request.once('connect', (response, socket) => { if (response.statusCode === 200) resolve(socket); else { socket.destroy(); reject(new Error('tunnel_failed')); } }); request.end();
  });
  const secure = tls.connect({ socket: tunnel, servername: 'allowed.invalid', ca, rejectUnauthorized: true });
  const chunks = [];
  await new Promise((resolve, reject) => {
    secure.on('error', reject); secure.on('data', chunk => chunks.push(chunk)); secure.once('end', resolve);
    secure.once('secureConnect', () => secure.write('GET /responses HTTP/1.1\r\nHost: allowed.invalid\r\nConnection: close\r\n\r\n'));
  });
  assert(Buffer.concat(chunks).toString().includes('native-worker-through-TLS'));
  await worker.close(); root.abort();
  await assert.rejects(fs.stat(descriptor.bundlePath), { code: 'ENOENT' });
  write({ completed: true, tlsVerified: true, trustRemoved: true }); lines.close();
})().catch(async error => { write({ error: error.code || error.message, stack: error.stack }); root.abort(); await worker?.close(); lines.close(); process.exitCode = 1; });
