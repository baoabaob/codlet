'use strict';
const { randomUUID, X509Certificate } = require('node:crypto');
const { listenTrafficPeer, createTrafficStreams } = require('./traffic-wire.cjs');
const failure = code => Object.assign(new Error(code), { code });
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const HTTP = new Set(['http:', 'https:']);
const MAX_ROUTES = 32, MAX_EXCHANGES = 4;

function baseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw failure('invalid_target');
  const rawPath = /^(?:https?):\/\/[^/?#]+(\/[^?#]*)?/iu.exec(value)?.[1] ?? '/';
  if (/\\/u.test(value) || /%2e|%2f|%5c|%25/iu.test(rawPath)
    || rawPath.split('/').some(part => part === '.' || part === '..')) throw failure('invalid_target');
  const url = new URL(value);
  if (!HTTP.has(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('invalid_target');
  url.pathname = url.pathname.replace(/\/+$/u, '') + '/';
  return url;
}
function certificateBundle(value, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024) throw failure('invalid_ca_bundle');
  if (!value) return '';
  const matches = [...value.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu)];
  if (!matches.length || matches.length > 64 || value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, '').trim()) throw failure('invalid_ca_bundle');
  try { for (const match of matches) new X509Certificate(match[0]); } catch { throw failure('invalid_ca_bundle'); }
  return value;
}
function pathForRoute(path) {
  const pathname = typeof path === 'string' ? path.split('?')[0] : '';
  if (typeof path !== 'string' || path.length > 8192 || !path.startsWith('/') || path.startsWith('//')
    || /\\|%2e|%2f|%5c|%25/iu.test(pathname)) throw failure('invalid_target');
  const match = /^\/([A-Za-z0-9_-]{43})(\/[^?]*)?(\?.*)?$/u.exec(path);
  if (!match) throw failure('target_not_found');
  const suffix = match[2] ?? '/';
  if (suffix.split('/').some(part => part === '.' || part === '..')) throw failure('invalid_target');
  return { token: match[1], suffix: suffix + (match[3] ?? '') };
}
function headers(value) {
  if (!Array.isArray(value) || value.length > 128) throw failure('invalid_headers');
  let size = 0;
  return value.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(pair[0]) || /[\r\n]/u.test(pair[1])) throw failure('invalid_headers');
    size += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
    if (size > 32768) throw failure('invalid_headers');
    return [pair[0], pair[1]];
  });
}
const pack = (value, streams) => ({ ...value, ...(Object.hasOwn(value, 'body') ? { body: streams.exportBody(value.body) } : {}) });
const unpack = (value, streams) => ({ ...value, ...(Object.hasOwn(value, 'body') ? { body: streams.importBody(value.body) } : {}) });
const origin = value => new URL(value).origin;
const framing = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-authorization']);
const sameOriginHeaders = (value, initialUrl) => {
  const { networkProfile: ignored, ...request } = value;
  const clean = headers(request.headers ?? []).filter(([name]) => !framing.has(name.toLowerCase()));
  return origin(request.url) === origin(initialUrl) ? { ...request, headers: clean, credentialMode: 'original' } : {
    ...request, credentialMode: 'omit',
    headers: clean.filter(([name]) => ['accept', 'content-type', 'content-encoding'].includes(name.toLowerCase())),
  };
};

// Core-owned source admission. The caller supplies the real Native gateway and
// shared Host transport runtime; no source identity changes interceptor grants.
async function createPlaintextSource({ runtime, gateway, signal }) {
  if (!runtime?.api?.openChannel || !gateway?.handlers?.http || !gateway?.handlers?.webSocket || !signal) throw new TypeError('trusted source dependencies are required');
  const routes = new Map(), exchanges = new Map(), routeWaiters = new Map(), trustProfiles = new Map();
  const owned = Symbol('native-owned-sources');
  let closed = false;
  function createConfig(base, caPem) {
    if (!caPem) return { base, profile: null };
    const profile = { id: `source-route:${randomUUID()}`, origin: base.origin, caPem, refs: 1 };
    trustProfiles.set(profile.id, profile);
    return { base, profile };
  }
  function retain(profile) { if (profile) profile.refs++; }
  function release(profile) { if (profile && --profile.refs === 0) trustProfiles.delete(profile.id); }
  function trustForProfile(id, target) {
    const profile = trustProfiles.get(id);
    if (!profile) throw failure('invalid_network_profile');
    const normalized = new URL(target.href);
    if (normalized.protocol === 'wss:') normalized.protocol = 'https:';
    if (normalized.protocol === 'ws:') normalized.protocol = 'http:';
    return normalized.origin === profile.origin ? profile.caPem : '';
  }
  function track(route, exchange, config) {
    if (route.closed) throw failure('route_closed');
    route.active.add(exchange); retain(config.profile);
    exchange.signal.addEventListener('abort', () => { route.active.delete(exchange); release(config.profile); }, { once: true });
    return Object.freeze({ signal: exchange.signal, cancel: exchange.cancel,
      forward: input => exchange.forward({ ...input, networkProfile: config.profile?.id ?? 'native-inherited' }) });
  }
  async function readCertificate(peer, token, reference, fallback = '') {
    if (reference === undefined) return fallback;
    const controller = new AbortController();
    const streams = createTrafficStreams(peer, token, controller.signal);
    try {
      const chunks = [];
      for await (const chunk of streams.importBody(reference, 128 * 1024)) chunks.push(Buffer.from(chunk));
      let value;
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw failure('invalid_ca_bundle'); }
      return certificateBundle(value);
    } finally { controller.abort(); streams.dispose(); }
  }
  function awaitRoute(token, exchange) {
    const existing = routes.get(token);
    if (existing) return Promise.resolve(existing);
    if ([...routeWaiters.values()].reduce((size, set) => size + set.size, 0) >= 4) return Promise.reject(failure('resource_limit'));
    return new Promise((resolve, reject) => {
      let set = routeWaiters.get(token);
      if (!set) routeWaiters.set(token, set = new Set());
      const finish = (error, route) => {
        clearTimeout(timer); exchange.signal.removeEventListener('abort', cancelled); set.delete(finish);
        if (!set.size) routeWaiters.delete(token);
        if (error) reject(error); else resolve(route);
      };
      const cancelled = () => finish(failure('request_cancelled'));
      const timer = setTimeout(() => finish(failure('target_not_found')), 3000);
      set.add(finish); exchange.signal.addEventListener('abort', cancelled, { once: true });
    });
  }
  function resolveRoute(token, route) {
    for (const finish of [...(routeWaiters.get(token) ?? [])]) finish(null, route);
  }
  const routeChannel = await runtime.api.openChannel({ maxConcurrent: 4, maxWebSocketConcurrent: 32, maxRequestBytes: 64 * 1024 * 1024,
    maxResponseBytes: 64 * 1024 * 1024, maxWebSocketMessageBytes: 8 * 1024 * 1024,
    maxWebSocketQueueBytes: 16 * 1024 * 1024, handlerTimeoutMs: 300000 }, {
    async http(request, exchange) {
      const { token, suffix } = pathForRoute(request.path);
      const route = await awaitRoute(token, exchange);
      if (route.peer === owned && (await gateway.native('authorizeSource', { source: token }, exchange.signal)).allowed !== true) throw failure('permission_denied');
      const config = route.config;
      const target = new URL(suffix.slice(1), config.base);
      if (target.origin !== config.base.origin || !target.pathname.startsWith(config.base.pathname)) throw failure('invalid_target');
      return gateway.handlers.http({ ...request, url: target.href }, track(route, exchange, config));
    },
    async webSocket(request, exchange) {
      const { token, suffix } = pathForRoute(request.path);
      const route = await awaitRoute(token, exchange);
      if (route.peer === owned && (await gateway.native('authorizeSource', { source: token }, exchange.signal)).allowed !== true) throw failure('permission_denied');
      const config = route.config;
      const target = new URL(suffix.slice(1), config.base);
      if (target.origin !== config.base.origin || !target.pathname.startsWith(config.base.pathname)) throw failure('invalid_target');
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      return gateway.handlers.webSocket({ ...request, url: target.href }, track(route, exchange, config));
    },
  });
  function retire(record, notify = true) {
    if (!record || !exchanges.has(record.id)) return;
    exchanges.delete(record.id); clearTimeout(record.timer);
    record.controller.abort(failure('stream_retired')); record.streams.dispose();
    if (notify) record.peer.request('http.cancel', { exchange: record.id }, { timeoutMs: 2000 }).catch(() => {});
  }
  function closeRoutes(peer) {
    for (const [token, route] of routes) if (route.peer === peer) {
      routes.delete(token); route.closed = true; release(route.config.profile); for (const exchange of route.active) exchange.cancel();
    }
    for (const record of [...exchanges.values()]) if (record.peer === peer) retire(record);
  }
  // Only the trusted gateway snapshot can create these routes. The public Host
  // receives its own opaque URL, never the Native launch-source peer token.
  function syncOwnedRoutes(values) {
    if (closed) throw failure('traffic_unavailable');
    const present = new Set(values.map(value => value.token));
    for (const [token, route] of routes) if (route.peer === owned && !present.has(token)) {
      routes.delete(token); route.closed = true;
      for (const exchange of route.active) exchange.cancel();
    }
    for (const value of values) {
      if (!TOKEN.test(value.token)) throw failure('invalid_target');
      const existing = routes.get(value.token);
      if (existing) {
        if (existing.peer !== owned || existing.config.base.href !== baseUrl(value.upstreamBaseUrl).href) throw failure('route_collision');
        continue;
      }
      if ([...routes.values()].filter(route => route.peer === owned).length >= MAX_ROUTES) throw failure('resource_limit');
      const route = { peer: owned, config: createConfig(baseUrl(value.upstreamBaseUrl), ''), active: new Set(), closed: false };
      routes.set(value.token, route); resolveRoute(value.token, route);
    }
  }
  async function handle(peer, method, params) {
    if (closed || signal.aborted) throw failure('traffic_unavailable');
    if (method === 'route.register') {
      if ([...routes.values()].filter(route => route.peer !== owned).length >= MAX_ROUTES) throw failure('resource_limit');
      if (!TOKEN.test(params?.token) || routes.has(params.token)) throw failure('route_collision');
      const base = baseUrl(params.upstreamBaseUrl);
      const caPem = await readCertificate(peer, params.token, params.additionalCaPem);
      if (closed || signal.aborted) throw failure('traffic_unavailable');
      if (routes.has(params.token)) throw failure('route_collision');
      if ([...routes.values()].filter(route => route.peer !== owned).length >= MAX_ROUTES) throw failure('resource_limit');
      const route = { peer, config: createConfig(base, caPem), active: new Set(), closed: false };
      routes.set(params.token, route); resolveRoute(params.token, route);
      return { baseUrl: `${routeChannel.endpoint}/${params.token}` };
    }
    if (method === 'route.close') {
      const route = routes.get(params?.token);
      if (!route || route.peer !== peer) throw failure('target_not_found');
      routes.delete(params.token); route.closed = true; release(route.config.profile); for (const exchange of route.active) exchange.cancel();
      return { closed: true };
    }
    if (method === 'route.update') {
      const route = routes.get(params?.token);
      if (!route || route.peer !== peer) throw failure('target_not_found');
      const base = baseUrl(params.upstreamBaseUrl);
      const caPem = await readCertificate(peer, params.token, params.additionalCaPem, route.config.profile?.caPem ?? '');
      if (route.closed || routes.get(params.token) !== route) throw failure('route_closed');
      const next = createConfig(base, caPem), previous = route.config;
      route.config = next; release(previous.profile);
      return { updated: true };
    }
    if (method === 'http.cancel' || method === 'http.release') {
      const record = exchanges.get(params?.exchange);
      if (!record || record.peer !== peer) return { retired: true };
      retire(record, method === 'http.cancel'); return { retired: true };
    }
    if (method === 'relay') {
      const record = exchanges.get(params?.lease);
      if (!record || record.peer !== peer) throw failure('stream_retired');
      return record.streams.handle(params.operation, params.payload);
    }
    if (method !== 'http.intercept') throw failure('invalid_method');
    if (exchanges.size >= MAX_EXCHANGES || !TOKEN.test(params?.exchange) || exchanges.has(params.exchange)) throw failure('resource_limit');
    const input = params.request;
    if (!input || typeof input.url !== 'string' || input.url.length > 8192 || !HTTP.has(new URL(input.url).protocol)
      || new URL(input.url).username || new URL(input.url).password || new URL(input.url).hash
      || typeof input.method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/u.test(input.method)) throw failure('invalid_target');
    const controller = new AbortController();
    const record = { id: params.exchange, peer, controller, streams: createTrafficStreams(peer, params.exchange, controller.signal), timer: null };
    record.timer = setTimeout(() => retire(record), 300000);
    exchanges.set(record.id, record);
    const request = Object.freeze({ id: randomUUID(), url: input.url, method: input.method, headers: headers(input.headers ?? []),
      body: record.streams.importBody(input.body) });
    const exchange = Object.freeze({
      signal: controller.signal, cancel: () => retire(record),
      async forward(value) {
        if (controller.signal.aborted) throw failure('stream_retired');
        const scoped = sameOriginHeaders(value, request.url);
        const result = await peer.request('http.forward', { exchange: record.id, request: pack(scoped, record.streams) },
          { signal: controller.signal, timeoutMs: 300000 });
        if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw failure('invalid_response');
        if (typeof result.finalUrl !== 'string' || result.finalUrl.length > 8192) throw failure('invalid_response');
        let final;
        try { final = new URL(result.finalUrl); } catch { throw failure('invalid_response'); }
        if (!HTTP.has(final.protocol) || final.username || final.password || final.hash) throw failure('invalid_response');
        return unpack({ ...result, headers: headers(result.headers ?? []) }, record.streams);
      },
    });
    try {
      const response = await gateway.handlers.http(request, exchange);
      if (controller.signal.aborted) throw failure('stream_retired');
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw failure('invalid_response');
      return pack({ ...response, headers: headers(response.headers ?? []).filter(([name]) => !framing.has(name.toLowerCase())) }, record.streams);
    } catch (error) {
      // Let the failing http.intercept RPC carry its finite original code.
      // Sending http.cancel first aborts the client's pending RPC and masks
      // errors such as invalid_response as request_cancelled.
      retire(record, false); throw error;
    }
  }
  let peerServer;
  try {
    peerServer = await listenTrafficPeer({ signal, handle, onClose: closeRoutes });
    const descriptor = Object.freeze({ version: 1, kind: 'plaintext', protocols: Object.freeze(['http', 'sse', 'webSocket']),
      operations: Object.freeze(['route.register', 'route.update', 'route.close', 'http.intercept']),
      endpoint: peerServer.endpoint, routeBaseUrl: routeChannel.endpoint });
    function close() {
      if (closed) return;
      closed = true; peerServer.close();
      for (const set of routeWaiters.values()) for (const finish of [...set]) finish(failure('traffic_unavailable'));
      for (const token of [...routes.keys()]) { const route = routes.get(token); routes.delete(token); route.closed = true; release(route.config.profile); for (const exchange of route.active) exchange.cancel(); }
      for (const record of [...exchanges.values()]) retire(record);
      routeChannel.close();
    }
    return Object.freeze({ descriptor, close, trustForProfile, syncOwnedRoutes, status: () => ({ open: !closed, routes: routes.size, exchanges: exchanges.size,
      routeChannel: routeChannel.status(), peer: peerServer.status() }) });
  } catch (error) { await routeChannel.close(); throw error; }
}
module.exports = { createPlaintextSource };
