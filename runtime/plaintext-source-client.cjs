'use strict';
const { randomBytes } = require('node:crypto');
const { connectTrafficPeer, createTrafficStreams } = require('./traffic-wire.cjs');
const failure = code => Object.assign(new Error(code), { code });
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

// This client has no privileged knowledge of an application or provider. Only
// the Native-selected launch owner receives the private source descriptor.
function connectPlaintextSource(source, { signal } = {}) {
  if (source?.version !== 1 || source.kind !== 'plaintext' || !Array.isArray(source.protocols)
    || !Array.isArray(source.operations) || typeof source.routeBaseUrl !== 'string') throw failure('invalid_source');
  const routeBase = new URL(source.routeBaseUrl);
  if (routeBase.protocol !== 'http:' || routeBase.hostname !== '127.0.0.1' || !routeBase.port
    || routeBase.username || routeBase.password || routeBase.search || routeBase.hash || routeBase.pathname === '/') throw failure('invalid_source');
  const controller = new AbortController(), exchanges = new Map(), routes = new Set(), routeRecords = new Map();
  let closed = false, peer;
  const stop = () => close();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) throw failure('host_stopping');
  function retire(record, notify = false) {
    if (!record || !exchanges.has(record.id)) return;
    exchanges.delete(record.id);
    record.signal?.removeEventListener('abort', record.abort);
    record.controller.abort(failure('stream_retired')); record.streams.dispose();
    if (notify && !closed) peer.request('http.cancel', { exchange: record.id }, { timeoutMs: 2000 }).catch(() => {});
  }
  async function handle(method, params) {
    if (method === 'relay') {
      const streamOwner = exchanges.get(params?.lease) ?? routeRecords.get(params?.lease);
      if (!streamOwner) throw failure('stream_retired');
      return streamOwner.streams.handle(params.operation, params.payload);
    }
    const record = exchanges.get(params?.exchange);
    if (!record) throw failure('stream_retired');
    if (method === 'http.cancel') { retire(record); return { cancelled: true }; }
    if (method !== 'http.forward' || record.forwarding) throw failure('invalid_method');
    record.forwarding = true;
    try {
      const input = { ...params.request, body: record.streams.importBody(params.request.body) };
      const response = await record.forward(input, { signal: record.controller.signal });
      if (record.controller.signal.aborted) throw failure('stream_retired');
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599) throw failure('invalid_response');
      return { ...response, headers: response.headers ?? [], body: record.streams.exportBody(response.body) };
    } finally { record.forwarding = false; }
  }
  function close() {
    if (closed) return;
    closed = true; signal?.removeEventListener('abort', stop);
    for (const record of [...exchanges.values()]) retire(record);
    for (const record of routes) { record.controller.abort(); record.streams?.dispose(); }
    routeRecords.clear();
    routes.clear(); controller.abort(); peer?.close();
  }
  const ready = connectTrafficPeer(source.endpoint, { signal: controller.signal, handle,
    event(event) { if (event.event === 'closed') close(); } }).then(value => { peer = value; return true; },
    error => { close(); throw error; });
  function certificateReference(record, value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024) throw failure('invalid_ca_bundle');
    return record.streams.exportBody(value);
  }
  function closeRouteRecord(record) {
    routeRecords.delete(record.token);
    record.controller.abort(); record.streams?.dispose();
  }
  function reserveRoute({ upstreamBaseUrl, additionalCaPem } = {}) {
    if (closed) throw failure('peer_closed');
    if (routes.size >= 32) throw failure('resource_limit');
    const token = randomBytes(32).toString('base64url');
    if (!TOKEN.test(token)) throw failure('invalid_source');
    const baseUrl = `${source.routeBaseUrl}/${token}`;
    const record = { token, closed: false, registered: false, controller: new AbortController(), streams: null };
    routes.add(record);
    const reservationReady = ready.then(() => {
      if (record.closed) throw failure('route_closed');
      record.streams = createTrafficStreams(peer, token, record.controller.signal);
      routeRecords.set(token, record);
      return peer.request('route.register', { token, upstreamBaseUrl,
        additionalCaPem: certificateReference(record, additionalCaPem) }, { timeoutMs: 5000 });
    }).then(result => {
      if (result?.baseUrl !== baseUrl) throw failure('invalid_source');
      record.registered = true;
      if (record.closed) return peer.request('route.close', { token }, { timeoutMs: 2000 }).then(() => { record.registered = false; throw failure('route_closed'); });
      return record;
    }).catch(error => { routes.delete(record); closeRouteRecord(record); throw error; });
    record.pending = reservationReady;
    return Object.freeze({ baseUrl, ready: reservationReady, update({ upstreamBaseUrl, additionalCaPem } = {}) {
      if (record.closed || closed) return Promise.reject(failure('route_closed'));
      const update = record.pending.then(async () => {
        const reference = certificateReference(record, additionalCaPem);
        try { return await peer.request('route.update', { token, upstreamBaseUrl, additionalCaPem: reference }, { timeoutMs: 5000 }); }
        catch (error) {
          if (reference?.stream) await record.streams.handle('stream.cancel', { stream: reference.stream }).catch(() => {});
          throw error;
        }
      });
      record.pending = update.catch(() => {});
      return update;
    }, async close() {
      if (record.closed) return;
      record.closed = true; routes.delete(record);
      try {
        await record.pending;
        if (record.registered && !closed) await peer.request('route.close', { token }, { timeoutMs: 2000 });
      } catch {} finally { closeRouteRecord(record); }
    } });
  }
  async function registerRoute(options) {
    const reservation = reserveRoute(options);
    await reservation.ready;
    return reservation;
  }
  async function interceptHttp(input, { forward, signal: requestSignal } = {}) {
    if (closed || typeof forward !== 'function') throw failure('invalid_source');
    await ready;
    const id = randomBytes(32).toString('base64url'), requestController = new AbortController();
    const abort = () => retire(record, true);
    const record = { id, forward, controller: requestController, signal: requestSignal, abort, forwarding: false,
      streams: createTrafficStreams(peer, id, requestController.signal) };
    exchanges.set(id, record);
    requestSignal?.addEventListener('abort', abort, { once: true });
    if (requestSignal?.aborted) { abort(); throw failure('request_cancelled'); }
    let result;
    try {
      result = await peer.request('http.intercept', { exchange: id,
        request: { url: input.url, method: input.method ?? 'GET', headers: input.headers ?? [], body: record.streams.exportBody(input.body) } },
      { signal: requestController.signal, timeoutMs: 300000 });
      if (requestController.signal.aborted) throw failure('request_cancelled');
      const body = record.streams.importBody(result.body);
      if (!body) { await peer.request('http.release', { exchange: id }, { timeoutMs: 2000 }).catch(() => {}); retire(record); return { ...result, body: null }; }
      let consumed = false;
      const finish = async () => {
        if (consumed) return;
        consumed = true;
        await peer.request('http.release', { exchange: id }, { timeoutMs: 2000 }).catch(() => {});
        retire(record);
      };
      // Retire the exchange before disposing its streams. A downstream
      // stream.cancel can close a Native handler lease, which otherwise races
      // this release and turns an ordinary redirect into http.cancel.
      const wrapped = Object.freeze({ async cancel() { await finish(); },
        [Symbol.asyncIterator]() {
          const iterator = body[Symbol.asyncIterator]();
          return {
            async next() {
              try { const item = await iterator.next(); if (item.done) await finish(); return item; }
              catch (error) { await finish(); throw error; }
            },
            async return() { try { return await iterator.return?.() ?? { done: true }; } finally { await finish(); } },
          };
        },
      });
      return { ...result, body: wrapped };
    } catch (error) { retire(record, true); throw error; }
  }
  return Object.freeze({ ready, reserveRoute, registerRoute, interceptHttp, close,
    status: () => ({ open: !closed, routes: routes.size, exchanges: exchanges.size }) });
}
module.exports = { connectPlaintextSource };
