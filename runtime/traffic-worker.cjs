'use strict';
const { createHash } = require('node:crypto');
const { createTrafficRuntime } = require('./host-traffic.cjs');
const { connectTrafficGateway } = require('./traffic-gateway.cjs');
const { createPlaintextSource } = require('./plaintext-source.cjs');
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
  if (!configuration?.endpoint || !rootSignal || rootSignal.aborted) throw failure('host_stopping');
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort();
  const original = Object.freeze({ ...environment }), credentials = new Map();
  let gateway, source, closing;
  function checkLoop(target) {
    if (!source || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return;
    if (target.port === new URL(source.descriptor.routeBaseUrl).port || Number(target.port) === source.descriptor.endpoint.port) throw failure('proxy_loop_detected');
  }
  async function resolve(target, requestSignal, networkProfile) {
    checkLoop(target);
    const caPem = typeof networkProfile === 'string' && networkProfile.startsWith('source-route:')
      ? source?.trustForProfile(networkProfile, target) : '';
    if (caPem === undefined) throw failure('invalid_network_profile');
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
  const runtime = createTrafficRuntime({ rootSignal: signal, makeError: (code, message) => Object.assign(new Error(message), { code }),
    async coreRequest(method, params, requestSignal) {
      if (method === 'host.network.authorizeChannel') return {};
      if (method === 'host.network.authorizeForward') {
        const target = new URL(params.url);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.hash) throw failure('invalid_target');
        checkLoop(target); return { url: target.href };
      }
      if (method === 'services.network.resolve') return resolve(new URL(params.url), requestSignal, params.profile);
      if (method === 'services.credentials.resolve') {
        const value = credentials.get(params.reference);
        if (!value || value.origin !== params.origin) throw failure('invalid_credential');
        return { secret: value.secret };
      }
      throw failure('permission_denied');
    },
  });
  function close() {
    if (closing) return closing;
    signal.removeEventListener('abort', onAbort); rootSignal.removeEventListener('abort', stop);
    closing = Promise.resolve().then(async () => {
      controller.abort(); source?.close(); gateway?.close(); runtime.closeAll(); credentials.clear();
    });
    return closing;
  }
  const onAbort = () => { close().catch(() => {}); };
  rootSignal.addEventListener('abort', stop, { once: true });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    gateway = await connectTrafficGateway(configuration.endpoint, { signal, networkProfile: 'native-inherited', onUnavailable: stop });
    source = await createPlaintextSource({ runtime, gateway, signal });
    if (signal.aborted) throw failure('host_stopping');
    await gateway.native('launched', { source: source.descriptor, environmentPatch: { set: {}, removeCaseInsensitive: [] } });
    return Object.freeze({ close, status: () => ({ gateway: gateway.status(), source: source.status() }) });
  } catch (error) { await close(); throw error; }
}
module.exports = { startTrafficWorker, environmentRoute };
