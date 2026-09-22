// Small synthetic Node HTTP experiment, never a native/Desktop performance claim.
import fs from 'node:fs/promises';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTrafficRuntime, createTrafficInterceptors } = require('../runtime/host-traffic-bundle.cjs');
const iterations = 40, body = Buffer.alloc(32 * 1024, 65);
const upstream = http.createServer(async (request, response) => { for await (const _chunk of request) {} response.write(body.subarray(0, 16384)); response.end(body.subarray(16384)); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${upstream.address().port}`;
function request(proxy) {
  return new Promise((resolve, reject) => {
    const url = proxy ? new URL(proxy) : null;
    const outgoing = http.request(url ? `http://${url.host}` : target, { method: 'POST', agent: false, path: proxy ? target + '/responses' : '/responses', headers: { Host: new URL(target).host, ...(url ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}` } : {}) } }, incoming => { incoming.resume(); incoming.once('end', resolve); incoming.once('error', reject); if (incoming.statusCode !== 200) reject(new Error('fixture_failed')); });
    outgoing.once('error', reject); outgoing.end(body);
  });
}
const results = [];
for (const mode of ['direct', 'ingress-no-interceptors', 'passthrough-interceptor', 'body-transform']) {
  const root = new AbortController();
  const runtime = createTrafficRuntime({ rootSignal: root.signal, makeError: (code, message) => Object.assign(new Error(message), { code }), coreRequest: async (method, input) => {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'host.network.authorizeForward' && new URL(input.url).origin === target) return { url: input.url };
    if (method === 'services.network.resolve') return { proxyUrl: null };
    throw new Error('fixture_policy_denied');
  } });
  const registry = createTrafficInterceptors({ rootSignal: root.signal, authorize: async () => true, networkProfile: 'fixture-direct' });
  if (mode.includes('interceptor') && mode !== 'ingress-no-interceptors' || mode === 'body-transform') registry.register({ pluginId: 'benchmark', generation: 1, signal: root.signal }, { id: 'measure', origins: [target] }, mode === 'body-transform' ? {
    request: request => ({ request: { body: (async function* () { for await (const chunk of request.body) { const copy = Buffer.from(chunk); copy[0] = 66; yield copy; } })() } }),
    response: response => ({ body: (async function* () { for await (const chunk of response.body) { const copy = Buffer.from(chunk); copy[0] = 67; yield copy; } })() }),
  } : { request: () => null, response: () => null });
  const ingress = mode === 'direct' ? null : await runtime.openProcessIngress({}, registry.handlers, { origins: [target], certificateFor: () => { throw new Error('HTTPS_not_in_this_benchmark'); } });
  for (let index = 0; index < 5; index++) await request(ingress?.proxyUrl);
  global.gc?.(); const before = process.memoryUsage(), cpu = process.cpuUsage(), samples = [];
  for (let index = 0; index < iterations; index++) { const start = performance.now(); await request(ingress?.proxyUrl); samples.push(performance.now() - start); }
  const used = process.cpuUsage(cpu), after = process.memoryUsage();
  root.abort(); if (ingress) await ingress.close();
  await new Promise(resolve => setTimeout(resolve, 20)); global.gc?.();
  const released = process.memoryUsage();
  samples.sort((a, b) => a - b);
  const percentile = p => Number(samples[Math.ceil(samples.length * p) - 1].toFixed(3));
  results.push({ mode, iterations, concurrency: 1, bodyBytes: body.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, before, after, released, registryActiveAfterClose: registry.status().active, queuePeakBytes: null });
}
await new Promise(resolve => upstream.close(resolve));
const report = { date: new Date().toISOString(), scope: 'synthetic-node-http-only-not-native-private-memory', node: process.version, gc: !!global.gc, results };
await fs.mkdir(new URL('../.codlet-artifacts/transparent-traffic/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../.codlet-artifacts/transparent-traffic/benchmark.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
