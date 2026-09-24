'use strict';
const { connectTrafficPeer, createTrafficStreams } = require('./traffic-wire.cjs');
const fail = code => Object.assign(new Error(code), { code });

function createHostedInterceptors({ coreRequest, rootSignal, detach = fn => fn() }) {
  const registrations = new Map(), leases = new Map(), sources = new Set();
  let peer, connecting, retired = false, connectionEpoch = 0;
  const check = () => { if (retired || rootSignal.aborted) throw fail('host_stopping'); };
  function closeLease(id) {
    const lease = leases.get(id); if (!lease) return;
    leases.delete(id); lease.controller.abort(fail('stream_retired')); lease.streams.dispose();
  }
  function event(message) {
    if (message.event === 'leaseClosed') closeLease(message.lease);
    if (message.event === 'closed') {
      connectionEpoch++;
      for (const id of [...leases.keys()]) closeLease(id);
      for (const registration of registrations.values()) registration.closed = true;
      registrations.clear(); peer = null; connecting = null;
      for (const source of sources) source.retired = true;
      sources.clear();
    }
  }
  function leaseFor(params) {
    check();
    const registration = registrations.get(params.registration);
    if (!registration || registration.closed || !registration.enabled) throw fail('interceptor_retired');
    let lease = leases.get(params.lease);
    if (lease && lease.registration !== registration) throw fail('invalid_lease');
    if (!lease) {
      if (leases.size >= 128 || typeof params.lease !== 'string' || params.lease.length > 128) throw fail('resource_limit');
      const controller = new AbortController();
      lease = { registration, controller, streams: createTrafficStreams(peer, params.lease, controller.signal), transforms: {} };
      leases.set(params.lease, lease);
    }
    return lease;
  }
  async function handle(method, params) {
    // Runs synchronously up to the first await, before a coalesced leaseClosed
    // event can overtake initialization of this lease's cancellation signal.
    const lease = method === 'invoke' ? leaseFor(params) : leases.get(params?.lease);
    if (!lease || lease.controller.signal.aborted) throw fail('stream_retired');
    if (method !== 'invoke') return lease.streams.handle(method, params.payload);
    const { kind, value, context } = params.payload ?? {};
    const signal = lease.controller.signal;
    let result;
    if (kind === 'request' || kind === 'response') {
      const callback = lease.registration.handlers[kind];
      if (!callback) return null;
      const input = Object.freeze({ ...value, headers: Object.freeze((value.headers ?? []).map(pair => Object.freeze([...pair]))), body: lease.streams.importBody(value.body) });
      result = await callback(input, Object.freeze({ ...(context ?? {}), signal }));
      if (signal.aborted) throw fail('stream_retired');
      if (result == null) return null;
      if (kind === 'request') {
        const output = { ...result };
        if (result.request) output.request = packBody(result.request, lease.streams);
        if (result.respond) output.respond = packBody(result.respond, lease.streams);
        return output;
      }
      return packBody(result, lease.streams);
    }
    if (kind === 'webSocket') {
      result = await lease.registration.handlers.webSocket?.(Object.freeze({ ...value, headers: Object.freeze((value.headers ?? []).map(pair => Object.freeze([...pair]))), protocols: Object.freeze([...(value.protocols ?? [])]) }), Object.freeze({ signal }));
      if (signal.aborted) throw fail('stream_retired');
      if (result == null) return null;
      const { clientToServer, serverToClient, ...decision } = result;
      for (const callback of [clientToServer, serverToClient]) if (callback !== undefined && typeof callback !== 'function') throw fail('invalid_decision');
      lease.transforms = { clientToServer, serverToClient };
      return { ...decision, transforms: { clientToServer: !!clientToServer, serverToClient: !!serverToClient } };
    }
    if (kind === 'frame') {
      const direction = params.payload.direction;
      if (!['clientToServer', 'serverToClient'].includes(direction)) throw fail('invalid_frame');
      const frame = await lease.streams.importFrame(value);
      result = lease.transforms[direction] ? await lease.transforms[direction](frame, Object.freeze({ signal, direction })) : frame;
      if (signal.aborted) throw fail('stream_retired');
      return lease.streams.exportFrame(result);
    }
    throw fail('invalid_frame');
  }
  function packBody(value, streams) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('invalid_decision');
    return { ...value, ...(Object.hasOwn(value, 'body') ? { body: streams.exportBody(value.body) } : {}) };
  }
  function getPeer() {
    check();
    if (!connecting) {
    const epoch = ++connectionEpoch;
    connecting = detach(async () => {
      const endpoint = await coreRequest('services.traffic.connect', {}, rootSignal);
      const connected = await connectTrafficPeer(endpoint, { signal: rootSignal, handle, event: message => { if (connectionEpoch === epoch) event(message); }, detach });
      if (retired || connectionEpoch !== epoch) { connected.close(); throw fail('host_stopping'); }
      peer = connected; return connected;
    }).catch(error => { if (connectionEpoch === epoch) connecting = null; throw error; });
    }
    return connecting;
  }
  async function registerInterceptor(options, handlers) {
    check();
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers) || !Object.keys(handlers).length || Object.entries(handlers).some(([name, value]) => !['request', 'response', 'webSocket'].includes(name) || typeof value !== 'function')) throw fail('invalid_handler');
    const connected = await getPeer();
    const result = await coreRequest('services.traffic.register', { ...options, handlers: Object.keys(handlers) }, rootSignal);
    const key = result?.registration;
    if (typeof key !== 'string') throw fail('invalid_registration');
    const registration = { key, handlers: { ...handlers }, enabled: true, closed: false, operation: 0 };
    registrations.set(key, registration);
    async function synchronized(result) {
      const deadline = Date.now() + 2000;
      while (true) {
        check(); if (registration.closed) throw fail('interceptor_retired');
        const remaining = deadline - Date.now(); if (remaining <= 0) throw fail('traffic_timeout');
        const state = await connected.request('synchronized', { registration: key, revision: result.revision }, { signal: rootSignal, timeoutMs: remaining });
        if (state.applied === true) return;
        await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining)));
      }
    }
    async function close() {
      if (registration.closed) return;
      registration.closed = true; registrations.delete(key);
      for (const [id, lease] of leases) if (lease.registration === registration) closeLease(id);
      try { await coreRequest('services.traffic.unregister', { registration: key }, rootSignal); }
      catch (error) { if (!['host_stopping', 'stale_generation', 'authorization_revoked', 'traffic_unavailable'].includes(error.code)) throw error; }
    }
    try {
      check(); await synchronized(await connected.request('activate', { registration: key }, { signal: rootSignal, timeoutMs: 2000 })); check(); if (registration.closed) throw fail('interceptor_retired');
    } catch (error) { await close().catch(() => {}); throw error; }
    return Object.freeze({ id: key, close, dispose: close,
      async setEnabled(enabled) {
        check(); if (registration.closed || typeof enabled !== 'boolean') throw fail('interceptor_retired');
        const previous = registration.enabled, operation = ++registration.operation;
        registration.enabled = enabled;
        if (!enabled) for (const [id, lease] of leases) if (lease.registration === registration) closeLease(id);
        try { const result = await connected.request('setEnabled', { registration: key, enabled }, { signal: rootSignal, timeoutMs: 2000 }); if (enabled) await synchronized(result); }
        catch (error) { if (registration.operation === operation && !registration.closed) registration.enabled = previous; throw error; }
      },
      inspect: () => Object.freeze({ registered: !registration.closed, enabled: !registration.closed && registration.enabled, exchanges: [...leases.values()].filter(lease => lease.registration === registration).length }),
    });
  }
  async function openSource(options) {
    check(); await getPeer();
    const value = await coreRequest('services.traffic.openSource', options, rootSignal);
    const record = { retired: false }; sources.add(record);
    const finish = async () => {
      if (record.retired) return;
      record.retired = true; sources.delete(record);
      try {
        const result = await coreRequest('services.traffic.closeSource', { source: value.source }, rootSignal);
        await synchronized(result.revision, false);
      } catch (error) {
        if (!['host_stopping', 'stale_generation', 'authorization_revoked', 'traffic_unavailable'].includes(error.code)) throw error;
      }
    };
    async function synchronized(revision, expectedOpen) {
      const deadline = Date.now() + 2000;
      while (true) {
        check();
        const state = await coreRequest('services.traffic.sourceStatus', { source: value.source, revision }, rootSignal);
        if (state.applied && state.open === expectedOpen) return;
        if (expectedOpen && !state.open) throw fail('source_retired');
        if (Date.now() >= deadline) throw fail('traffic_timeout');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { await synchronized(value.revision, true); check(); if (record.retired) throw fail('source_retired'); }
    catch (error) { await finish().catch(() => {}); throw error; }
    return Object.freeze({ endpoint: value.endpoint, close: finish, dispose: finish });
  }
  function closeAll() {
    if (retired) return; retired = true;
    rootSignal.removeEventListener('abort', closeAll);
    for (const id of [...leases.keys()]) closeLease(id);
    for (const registration of registrations.values()) registration.closed = true;
    registrations.clear(); peer?.close();
    for (const source of sources) source.retired = true;
    sources.clear();
  }
  rootSignal.addEventListener('abort', closeAll, { once: true });
  return Object.freeze({ registerInterceptor: (options, handlers) => detach(() => registerInterceptor(options, handlers)),
    openSource: options => detach(() => openSource(options)),
    inspect: () => coreRequest('services.traffic.status', {}, rootSignal), closeAll });
}
module.exports = { createHostedInterceptors };
