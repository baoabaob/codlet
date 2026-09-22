'use strict';
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { createHash } = require('node:crypto');
const { createTrafficRuntime } = require('./host-traffic.cjs');
const { connectTrafficGateway } = require('./traffic-gateway.cjs');
const { prepareProcessTrafficEnvironment } = require('./process-traffic-environment.cjs');
const failure = code => Object.assign(new Error(code), { code });

function environmentRoute(environment, target) {
  const get = name => environment[name.toLowerCase()] ?? environment[name.toUpperCase()];
  const host = target.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const port = target.port || (['https:', 'wss:'].includes(target.protocol) ? '443' : '80');
  const noProxy = get('NO_PROXY') ?? '';
  for (const item of noProxy.toLowerCase().split(/[\s,]+/u).filter(Boolean)) {
    if (item === '*') return { proxyUrl: null };
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(item);
    if (!match || match[2] && match[2] !== port) continue;
    const pattern = match[1].replace(/^\[|\]$/gu, '');
    const suffix = pattern.replace(/^\*?\./u, '');
    if (host === suffix || (pattern.startsWith('.') || pattern.startsWith('*.')) && host.endsWith(`.${suffix}`)) return { proxyUrl: null };
  }
  const proxyUrl = get(['https:', 'wss:'].includes(target.protocol) ? 'HTTPS_PROXY' : 'HTTP_PROXY') || get('ALL_PROXY');
  return proxyUrl ? { proxyUrl } : null;
}

async function startTrafficWorker(configuration, { signal: rootSignal, environment = process.env }) {
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort();
  if (rootSignal.aborted) throw failure('host_stopping');
  const origins = new Set(), credentials = new Map();
  let gateway, ingress, prepared;
  const original = Object.freeze({ ...environment });
  let caPem = '';
  for (const file of new Set(configuration.trustInputs ?? [])) {
    const handle = await fs.open(file, 'r');
    try { if ((await handle.stat()).size > 128 * 1024) throw failure('invalid_ca_bundle'); caPem += await handle.readFile('utf8'); }
    finally { await handle.close(); }
  }
  if (Buffer.byteLength(caPem) > 128 * 1024) throw failure('invalid_ca_bundle');
  const ca = [...tls.getCACertificates('default'), ...tls.getCACertificates('system'), ...(caPem ? [caPem] : [])];
  function checkLoop(target) {
    if (ingress && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port === new URL(ingress.proxyUrl).port) throw failure('proxy_loop_detected');
  }
  async function resolve(target, requestSignal) {
    checkLoop(target);
    const route = environmentRoute(original, target) ?? await gateway.native('systemRoute', { url: target.href }, requestSignal);
    if (!route.proxyUrl) return { proxyUrl: null, caPem };
    const proxy = new URL(route.proxyUrl); checkLoop(proxy);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) throw failure('invalid_proxy');
    let proxyCredentialRef;
    if (proxy.username || proxy.password) {
      const secret = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      proxyCredentialRef = createHash('sha256').update(proxy.href).digest('hex');
      if (!credentials.has(proxyCredentialRef) && credentials.size >= 64) throw failure('resource_limit');
      credentials.set(proxyCredentialRef, { secret, origin: proxy.origin }); proxy.username = ''; proxy.password = '';
    }
    return { proxyUrl: proxy.href, proxyCredentialRef, caPem };
  }
  async function openTunnel(target, requestSignal) {
    const route = await resolve(target, requestSignal);
    if (requestSignal.aborted) throw failure('request_cancelled');
    const hostname = target.hostname.replace(/^\[|\]$/gu, ''), port = Number(target.port || 443);
    return new Promise((resolveSocket, reject) => {
      let socket, request, finished = false;
      const stop = () => { request?.destroy(); socket?.destroy(); };
      const aborted = () => done(failure('request_cancelled'));
      const timer = setTimeout(() => done(failure('proxy_timeout')), 10000);
      const done = error => {
        if (finished) return; finished = true; clearTimeout(timer); requestSignal.removeEventListener('abort', aborted);
        if (error) { stop(); reject(error); }
        else {
          requestSignal.addEventListener('abort', stop, { once: true });
          socket.once('close', () => requestSignal.removeEventListener('abort', stop));
          resolveSocket(socket);
        }
      };
      requestSignal.addEventListener('abort', aborted, { once: true });
      if (!route.proxyUrl) {
        socket = net.createConnection({ host: hostname, port });
        socket.once('connect', () => done()); socket.on('error', () => done(failure('connect_failed')));
      } else {
        const proxy = new URL(route.proxyUrl), authority = `${target.hostname}:${port}`;
        const secret = route.proxyCredentialRef ? credentials.get(route.proxyCredentialRef).secret : null;
        request = (proxy.protocol === 'https:' ? https : http).request(proxy, { method: 'CONNECT', path: authority, agent: false, ca, rejectUnauthorized: true,
          headers: { Host: authority, ...(secret ? { 'Proxy-Authorization': `Basic ${Buffer.from(secret).toString('base64')}` } : {}) } });
        request.on('error', () => done(failure('proxy_failed')));
        request.once('connect', (response, connected, head) => {
          socket = connected;
          if (finished) { socket.destroy(); return; }
          socket.on('error', () => {});
          if (response.statusCode !== 200) { done(failure('proxy_rejected')); return; }
          if (head.length) socket.unshift(head); done();
        });
        request.end();
      }
      if (requestSignal.aborted) aborted();
    });
  }
  const runtime = createTrafficRuntime({ rootSignal: signal, makeError: (code, message) => Object.assign(new Error(message), { code }),
    async coreRequest(method, params, requestSignal) {
      if (method === 'host.network.authorizeChannel') return {};
      if (method === 'host.network.authorizeForward') {
        const target = new URL(params.url);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.hash) throw failure('invalid_target');
        checkLoop(target); return { url: target.href };
      }
      if (method === 'services.network.resolve') return resolve(new URL(params.url), requestSignal);
      if (method === 'services.credentials.resolve') {
        const value = credentials.get(params.reference);
        if (!value || value.origin !== params.origin) throw failure('invalid_credential'); return { secret: value.secret };
      }
      throw failure('permission_denied');
    },
  });
  let closing;
  function close() {
    if (closing) return closing;
    signal.removeEventListener('abort', onAbort); rootSignal.removeEventListener('abort', stop);
    closing = Promise.resolve().then(async () => {
      controller.abort(); gateway?.close(); await ingress?.close(); runtime.closeAll(); await prepared?.close(); credentials.clear();
    });
    return closing;
  }
  const onAbort = () => { close().catch(() => {}); };
  rootSignal.addEventListener('abort', stop, { once: true });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (rootSignal.aborted) { stop(); throw failure('host_stopping'); }
    gateway = await connectTrafficGateway(configuration.endpoint, { signal, networkProfile: 'native-inherited', onUnavailable: stop, onOrigins(values) { origins.clear(); for (const value of values) origins.add(new URL(value).origin); } });
    const { caPem: additionalCaPem } = await gateway.native('certificateAuthority');
    ingress = await runtime.openProcessIngress({ maxWebSocketMessageBytes: 8 * 1024 * 1024, maxWebSocketQueueBytes: 16 * 1024 * 1024 }, gateway.handlers, {
      origins: [], matchesOrigin: origin => origins.has(origin), openTunnel,
      certificateFor: (origin, requestSignal) => gateway.native('certificate', { url: `${origin}/` }, requestSignal),
    });
    prepared = await prepareProcessTrafficEnvironment({ environment: original, directory: configuration.directory, proxyUrl: ingress.proxyUrl, additionalCaPem, trustInputs: configuration.trustInputs ?? [], trustOutputs: configuration.trustOutputs });
    if (signal.aborted) { await prepared.close(); throw failure('host_stopping'); }
    await gateway.native('launched', { proxyUrl: ingress.proxyUrl, bundlePath: prepared.bundlePath, environmentPatch: prepared.environmentPatch,
      trust: { outputs: [...configuration.trustOutputs], launchCaPem: additionalCaPem, inheritedInputsMerged: true, systemStoreModified: false }, bypass: 'preserve-original-no-proxy' });
    return Object.freeze({ close, status: () => ({ gateway: gateway.status(), ingress: ingress.status() }) });
  } catch (error) { await close(); throw error; }
}
module.exports = { startTrafficWorker, environmentRoute };
