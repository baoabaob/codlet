'use strict';
const { connectTrafficPeer, createTrafficStreams } = require('./traffic-wire.cjs');
const { createTrafficInterceptors } = require('./traffic-interceptors.cjs');
const failure = code => Object.assign(new Error(code), { code });

// Trusted Core worker only. Endpoint identity is issued by the Native launch
// owner; plugin options cannot create a gateway or select an owner generation.
async function connectTrafficGateway(endpoint, { signal, networkProfile, onOrigins = () => {}, onSources = () => {}, onUnavailable = () => {}, connect = connectTrafficPeer }) {
  const hooks = new Map(), leases = new Map(), exchanges = new WeakMap();
  const controller = new AbortController();
  const stop = () => controller.abort(failure('traffic_unavailable'));
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  let peer, refreshing, dirty = true, retired = false;
  const registry = createTrafficInterceptors({ rootSignal: controller.signal, networkProfile, maxActiveWebSocket: 32,
    authorize: async (owner, action, url, requestSignal) => {
      const result = await peer.request('authorize', { registration: owner.registration, action, url }, { signal: requestSignal, timeoutMs: 2000 });
      return result.allowed === true;
    },
  });
  function closeLease(id, cancelExchange = false) {
    const lease = leases.get(id); if (!lease) return;
    leases.delete(id); lease.exchange.leases.delete(lease.key);
    lease.controller.abort(); lease.streams.dispose();
    if (cancelExchange) lease.exchange.cancel();
  }
  function event(message) {
    if (message.event === 'closed') stop();
    else if (message.event === 'leaseClosed') closeLease(message.lease, true);
    else if (message.event === 'changed') { dirty = true; refresh().catch(stop); }
  }
  function handle(method, params) {
    const lease = leases.get(params?.lease);
    if (!lease || lease.controller.signal.aborted) throw failure('stream_retired');
    return lease.streams.handle(method, params.payload);
  }
  function close() {
    if (retired) return; retired = true;
    signal.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', close);
    registry.close();
    for (const id of [...leases.keys()]) closeLease(id, true);
    for (const hook of hooks.values()) hook.controller.abort();
    hooks.clear(); peer?.close();
    onUnavailable();
  }
  controller.signal.addEventListener('abort', close, { once: true });
  async function refresh() {
    if (!peer || retired) return;
    dirty = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      while (dirty && !retired) {
        dirty = false;
        const snapshot = await peer.request('snapshot', {}, { signal: controller.signal, timeoutMs: 2000 });
        const present = new Set(snapshot.registrations.map(item => item.registration));
        for (const [key, hook] of hooks) if (!present.has(key)) { hook.controller.abort(); hooks.delete(key); }
        for (const item of snapshot.registrations) {
          if (hooks.has(item.registration)) continue;
          const ownerController = new AbortController();
          const callbacks = {};
          for (const kind of item.options.handlers) callbacks[kind] = (value, context) => invoke(item, kind, value, context);
          const { handlers: ignored, ...options } = item.options;
          registry.register({ pluginId: item.pluginId, generation: item.generation, registration: item.registration, signal: ownerController.signal }, options, callbacks);
          hooks.set(item.registration, { controller: ownerController, origins: item.options.origins });
        }
        await onOrigins([...new Set([...hooks.values()].flatMap(hook => hook.origins))]);
        await onSources(snapshot.sources ?? []);
        await peer.request('applied', { revision: snapshot.revision }, { signal: controller.signal, timeoutMs: 2000 });
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function leaseFor(item, url, context) {
    const exchange = exchanges.get(context.signal);
    if (!exchange || context.signal.aborted) throw failure('stream_retired');
    const existing = exchange.leases.get(item.registration); if (existing) return existing;
    let installed;
    await peer.request('open', { registration: item.registration, url }, {
      signal: context.signal, timeoutMs: 2000, cancelOpen: true,
      // Install before processing a coalesced leaseClosed notification.
      prepareResult(result) {
        const id = result.lease;
        const leaseController = new AbortController();
        installed = { id, key: item.registration, exchange, controller: leaseController, streams: createTrafficStreams(peer, id, leaseController.signal) };
        leases.set(id, installed); exchange.leases.set(item.registration, installed);
        if (context.signal.aborted) { closeLease(id); peer.request('release', { lease: id }).catch(() => {}); }
      },
    });
    if (!installed || installed.controller.signal.aborted) throw failure('stream_retired');
    return installed;
  }
  const pack = (value, streams) => ({ ...value, ...(Object.hasOwn(value, 'body') ? { body: streams.exportBody(value.body) } : {}) });
  const unpack = (value, streams) => ({ ...value, ...(Object.hasOwn(value, 'body') ? { body: streams.importBody(value.body) } : {}) });
  async function invoke(item, kind, value, context) {
    const lease = await leaseFor(item, kind === 'response' ? context.request.url : value.url, context);
    const call = payload => peer.request('relay', { lease: lease.id, operation: 'invoke', payload }, { signal: lease.controller.signal, timeoutMs: Math.min(item.options.timeoutMs + 100, 30000) });
    const result = await call({ kind, value: kind === 'webSocket' ? value : pack(value, lease.streams), context: kind === 'response' ? { source: context.source, request: context.request } : {} });
    if (result == null) return null;
    if (kind === 'request') return { ...result, ...(result.request ? { request: unpack(result.request, lease.streams) } : {}), ...(result.respond ? { respond: unpack(result.respond, lease.streams) } : {}) };
    if (kind === 'response') return unpack(result, lease.streams);
    const { transforms, ...decision } = result;
    for (const direction of ['clientToServer', 'serverToClient']) if (transforms?.[direction]) decision[direction] = async frame => {
      const changed = await call({ kind: 'frame', direction, value: lease.streams.exportFrame(frame) });
      return changed == null ? null : lease.streams.importFrame(changed);
    };
    return decision;
  }
  async function dispatch(kind, request, exchange) {
    await refresh();
    if (controller.signal.aborted || exchange.signal.aborted) throw failure('traffic_unavailable');
    const record = { cancel: exchange.cancel, leases: new Map() };
    exchanges.set(exchange.signal, record);
    const done = () => {
      exchange.signal.removeEventListener('abort', done); exchanges.delete(exchange.signal);
      for (const lease of [...record.leases.values()]) { closeLease(lease.id); peer.request('release', { lease: lease.id }).catch(() => {}); }
    };
    exchange.signal.addEventListener('abort', done, { once: true });
    try { return await registry.handlers[kind](request, exchange); }
    catch (error) { done(); throw error; }
  }
  try {
    peer = await connect(endpoint, { signal: controller.signal, handle, event });
    if (controller.signal.aborted) { peer.close(); throw failure('traffic_unavailable'); }
    await peer.request('ready', {}, { signal: controller.signal, timeoutMs: 2000 });
    await refresh();
  } catch (error) { stop(); throw error; }
  return Object.freeze({ handlers: Object.freeze({ http: (request, exchange) => dispatch('http', request, exchange), webSocket: (request, exchange) => dispatch('webSocket', request, exchange) }),
    refresh, close: stop, native: (method, params = {}, requestSignal = controller.signal) => peer.request(method, params, { signal: requestSignal, timeoutMs: 10000 }),
    status: () => ({ ...registry.status(), leases: leases.size, data: peer.status() }) });
}
module.exports = { connectTrafficGateway };
