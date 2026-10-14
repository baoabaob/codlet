'use strict';

const { createTrafficRuntime: createEmbeddedTrafficRuntime } = module.exports;

// Codlet owns this adapter; plugin entrypoints export activate/deactivate just
// like renderer entrypoints. A separate process is a lifetime boundary, no sandbox.
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { Console } = require('node:console');
const { TextDecoder } = require('node:util');
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const entry = process.argv[1];
const snapshot = process.argv[2];
const hostMode = process.argv[3] === 'sdk' ? 'sdk' : 'node';
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 16;
const MAX_TIMEOUT = 15000;
const MAX_CLEANUP = 1500;
const MAX_PAYLOAD = MAX_FRAME - 4096;
const MAX_INVOCATIONS = 4;
const MAX_ENDPOINTS = 256;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const error = (code, message, data) => Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
const rpcError = value => ({ code: String(value?.code || 'plugin_error').slice(0, 256), message: String(value?.message || value || 'plugin failed').slice(0, 4096) });
const abort = new AbortController();
const pending = new Map();
const subscriptions = new Map();
const endpoints = new Map();
const invocations = new Map();
const invocationContext = new AsyncLocalStorage();
const lifecycleContext = new AsyncLocalStorage();
let provides = [];
let requires = [];
const scopeHandles = new WeakMap();
let identity;
let state = 'waiting';
let nextId = 1;
let lastCoreId = 0;
let loaded;
let activation;
let deactivation;
let pluginContext;
let cleanupOpen = false;
let cleanupDeadline = 0;
let partial = Buffer.alloc(0);
let outboundFrames = 0;
let exiting = false;
let stateTransition = false;
let restoringState = false;
let sdkPaused = false;
let coreAdmission = null;
const pausedNotifications = [];
let drainingNotifications = false;
const MAX_STATE_BYTES = 256 * 1024;

// Keep plugin logging outside the protocol. Writing directly to stdout is an
// unsupported protocol violation, not a mechanism for plugin communication.
global.console = new Console({ stdout: process.stderr, stderr: process.stderr });

function fatal(reason) {
  if (exiting) return;
  if (state === 'stopping' && reason?.code === 'host_stopping') return;
  exiting = true;
  process.stderr.write(`Codlet JS host: ${rpcError(reason).message}\n`);
  process.exit(1);
}

function ordinaryCallbackFailed(failure) {
  // Shutdown rejects ordinary Core waiters. A retired event/end callback may
  // consequently reject too; it must not abort the separate deactivate phase.
  if (coreAdmission !== null && failure?.code === 'core_updating') return;
  if (state === 'starting' || state === 'active') fatal(failure);
}

function send(fields, done) {
  if (exiting) return;
  const line = JSON.stringify({ v: 1, ...identity, ...fields });
  if (Buffer.byteLength(line) > MAX_FRAME) throw error('frame_too_large', 'host JSONL frame exceeds 1 MiB');
  if (outboundFrames >= 4) throw error('outgoing_queue_full', 'host JSONL output queue is full');
  outboundFrames++;
  process.stdout.write(line + '\n', failure => {
    outboundFrames--;
    if (failure) fatal(failure);
    else done?.();
  });
}

function reply(id, result, failure, done) {
  const fields = failure
    ? { type: 'response', id, ok: false, error: rpcError(failure) }
    : { type: 'response', id, ok: true, result: result ?? null };
  send(fields, done);
}

function request(method, params, timeoutMs = MAX_TIMEOUT, prepareResult, cleanup = false, signal) {
  if (cleanup ? state !== 'stopping' || !cleanupOpen : state !== 'starting' && state !== 'active') return Promise.reject(error('host_stopping', 'host no longer admits this phase of Core requests'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) return Promise.reject(error('invalid_timeout', 'timeoutMs must be 1..15000'));
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean')) return Promise.reject(error('invalid_signal', 'signal must be an AbortSignal'));
  if (signal?.aborted) return Promise.reject(error('invocation_cancelled', 'the caller already cancelled this request'));
  if (cleanup) {
    timeoutMs = Math.min(timeoutMs, Math.floor(cleanupDeadline - performance.now()));
    if (timeoutMs < 1) return Promise.reject(error('cleanup_timeout', 'the total Core cleanup budget expired'));
  }
  const invocation = cleanup ? undefined : invocationContext.getStore();
  const trafficContinuation = method === 'traffic.closeChannel' || method === 'rpc.request' && params?.capability?.name === 'codlet.core.services' && params.capability.api === 1 && params.capability.scope === 'runtime' && ['traffic.unregister','traffic.closeSource','traffic.sourceStatus','traffic.status'].includes(params.method);
  if (!cleanup && (sdkPaused || coreAdmission !== null && !trafficContinuation) && !invocation && !lifecycleContext.getStore()?.open) return Promise.reject(error('core_updating', 'this Host has paused new SDK requests for a Core update'));
  if (invocation) {
    if (invocation.closed) return Promise.reject(error('invocation_cancelled', 'the parent capability invocation has retired'));
    timeoutMs = Math.min(timeoutMs, Math.floor(invocation.deadline - performance.now()));
    if (timeoutMs < 1) return Promise.reject(error('request_timeout', 'the original capability invocation deadline expired'));
    params = { invocationId: invocation.id, method, params };
    method = 'capability.request';
  }
  if (pending.size >= MAX_PENDING) return Promise.reject(error('request_limit', 'too many pending Core requests'));
  if (!positive(nextId)) return Promise.reject(error('request_ids_exhausted', 'this generation has exhausted request IDs'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const cancel = failure => {
      const item = takePending(id);
      if (!item) return;
      if (!cleanup) { try { send({ type: 'notification', method: 'request.cancel', params: { id } }); } catch {} }
      item.reject(failure);
    };
    const timer = setTimeout(() => {
      cancel(error(cleanup ? 'cleanup_timeout' : 'request_timeout', 'Core request deadline expired'));
    }, timeoutMs);
    const onAbort = () => cancel(error('invocation_cancelled', 'the caller cancelled this request'));
    pending.set(id, { resolve, reject, timer, prepareResult, invocation, signal, onAbort });
    signal?.addEventListener('abort', onAbort, { once: true });
    try { send({ type: 'request', id, method, params, timeoutMs }); }
    catch (failure) { takePending(id); reject(failure); }
  });
}

function takePending(id) {
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id); clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.onAbort);
  return item;
}

function retire() {
  trafficRuntime.closeAll(error('host_stopping', 'Codlet is stopping this generation'));
  for (const invocation of invocations.values()) closeInvocation(invocation, error('host_stopping', 'Codlet is stopping this generation'));
  endpoints.clear();
  if (!abort.signal.aborted) abort.abort(error('host_stopping', 'Codlet is stopping this generation'));
  for (const id of pending.keys()) takePending(id)?.reject(error('host_stopping', 'Codlet is stopping this generation'));
  subscriptions.clear();
}

const trafficRuntime = createEmbeddedTrafficRuntime({
  beforeRequest(_method, _params, continuation) {
    if (!continuation && (sdkPaused || coreAdmission !== null) && !invocationContext.getStore() && !lifecycleContext.getStore()?.open) throw error('core_updating', 'Core holds new Host traffic requests until admission resumes');
  },
  detach: callback => invocationContext.run(undefined, callback),
  rootSignal: abort.signal,
  makeError: error,
  reportState(channels) {
    if (!requires.some(value => value.name === 'codlet.core.services' && value.api === 1 && value.scope === 'runtime')) return;
    return invocationContext.run(undefined, () => rpcRequest({ name: 'codlet.core.services', api: 1, scope: 'runtime' }, 'resources.reportTraffic', { channels }));
  },
  coreRequest(method, params, signal) {
    // A channel is generation-owned, not a continuation of the capability call
    // that happened to create it. Future socket callbacks get fresh Core deadlines.
    // These are SDK channel lifecycle operations. Like the former native
    // channel authorization calls they require Host grants, not a declared
    // dependency on the public Core service capability.
    if (['services.traffic.connectPeer', 'services.traffic.openChannel', 'services.traffic.closeChannel'].includes(method)) {
      return invocationContext.run(undefined, () => request(method.slice(9), params, MAX_TIMEOUT, undefined, false, signal));
    }
    return invocationContext.run(undefined, () => method.startsWith('services.')
      ? rpcRequest({ name: 'codlet.core.services', api: 1, scope: 'runtime' }, method.slice(9), params, { signal })
      : request(method, params, MAX_TIMEOUT, undefined, false, signal));
  },
});

function deactivate(cleanup) {
  if (!deactivation) deactivation = invocationContext.run(undefined, () => Promise.resolve().then(() => loaded?.deactivate?.(cleanup)));
  return deactivation;
}

function shutdown(message) {
  const supplied = message.params?.cleanupBudgetMs;
  if (message.params !== null && (!object(message.params) || !Number.isInteger(supplied) || supplied < 1 || supplied > MAX_CLEANUP)) throw error('protocol_error', 'invalid Core cleanup budget');
  const budget = supplied ?? MAX_CLEANUP;
  cleanupDeadline = performance.now() + budget;
  state = 'stopping'; retire();
  cleanupOpen = supplied !== undefined;
  const signal = new AbortController();
  const core = Object.freeze({ request(method, params, timeoutMs = MAX_TIMEOUT) {
    return request('cleanup.request', { method, params }, timeoutMs, undefined, true);
  } });
  const cleanup = Object.freeze({
    plugin: pluginContext?.plugin, root: process.cwd(), signal: signal.signal, log: console,
    remainingMs: () => Math.max(0, Math.floor(cleanupDeadline - performance.now())), core,
    cdp: Object.freeze({ request(method, params = {}, options = {}) {
      return core.request('cdp.request', { method, params, ...options }, options.timeoutMs ?? MAX_TIMEOUT);
    } }),
  });
  let settled = false;
  const finish = failure => {
    if (settled) return;
    settled = true; cleanupOpen = false; clearTimeout(timer);
    signal.abort(failure ?? error('host_stopping', 'cleanup has completed'));
    for (const id of pending.keys()) takePending(id)?.reject(failure ?? error('host_stopping', 'cleanup has completed'));
    reply(message.id, null, failure, () => { exiting = true; process.exit(failure ? 1 : 0); });
  };
  const timer = setTimeout(() => finish(error('cleanup_timeout', 'the total Core cleanup budget expired')), budget);
  // Cancelling activation retires its requests and signal. Its unresolved Promise
  // cannot prevent deactivate from using the finite cleanup phase.
  Promise.resolve(activation).catch(() => {});
  deactivate(cleanup).then(() => finish(), finish).catch(fatal);
}

function context(params) {
  restoringState = params.initialState != null;
  if (!Array.isArray(params.provides ?? [])) throw error('protocol_error', 'Core host provides must be an array');
  provides = (params.provides ?? []).map(capability => {
    if (capabilityKey(capability) === null) throw error('protocol_error', 'invalid Core host capability declaration');
    return Object.freeze({ name: capability.name, api: capability.api, scope: capability.scope });
  });
  if (!Array.isArray(params.requires ?? [])) throw error('protocol_error', 'Core host requires must be an array');
  requires = (params.requires ?? []).map(capability => {
    if (capabilityKey(capability) === null) throw error('protocol_error', 'invalid Core host requirement');
    return Object.freeze({ name: capability.name, api: capability.api, scope: capability.scope });
  });
  const cdp = Object.freeze({
    request(method, params = {}, options = {}) {
      return request('cdp.request', { method, params, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, options.timeoutMs ?? MAX_TIMEOUT, undefined, false, options.signal);
    },
    async subscribe(filter, onEvent, onEnd) {
      if (typeof onEvent !== 'function') throw error('invalid_handler', 'onEvent must be a function');
      const result = await request('cdp.subscribe', filter, MAX_TIMEOUT, result => {
        const id = result?.subscriptionId;
        if (!positive(id)) throw error('protocol_error', 'Core returned an invalid subscription id');
        // Install synchronously with the response, before a coalesced next frame
        // can deliver this subscription's first event.
        subscriptions.set(id, { onEvent, onEnd, inFlight: 0 });
      });
      const id = result.subscriptionId;
      return Object.freeze({
        id,
        async unsubscribe() {
          if (!subscriptions.has(id)) return { unsubscribed: false };
          subscriptions.delete(id);
          return request('cdp.unsubscribe', { subscriptionId: id });
        },
      });
    },
  });
  const result = {
    get restoringState() { return restoringState; },
    plugin: Object.freeze({ id: identity.pluginId, generation: identity.generation, version: params.pluginVersion }),
    root: process.cwd(), signal: abort.signal, cdp,
    core: Object.freeze({ request(method, params, timeoutMs = MAX_TIMEOUT) {
      return request(method, params, timeoutMs);
    } }), log: console,
    rpc: Object.freeze({ provide, request: rpcRequest, notify: rpcNotify, target: rpcTarget }),
    fs: Object.freeze({ readText: osMethod('host.fs.readText'), readDir: osMethod('host.fs.readDir'), stat: osMethod('host.fs.stat') }),
    network: Object.freeze({ fetch: osMethod('host.network.fetch') }),
    process: Object.freeze({ run: osMethod('host.process.run') }),
    system: Object.freeze({ info: (options = {}) => osMethod('host.system.info')({}, options) }),
    traffic: trafficRuntime.api,
    services: createEmbeddedServicesRuntime({
      rootSignal: abort.signal,
      detach: callback => invocationContext.run(undefined, callback),
      request: (method, params, options) => rpcRequest({ name: 'codlet.core.services', api: 1, scope: 'runtime' }, method, params, options),
    }),
  };
  result.codex = createEmbeddedCodexHost(result);
  return Object.freeze(result);
}

function capabilityKey(capability) {
  if (!object(capability) || Object.keys(capability).some(key => !['name','api','scope'].includes(key))
    || typeof capability.name !== 'string' || !positive(capability.api) || capability.api > 0xffffffff
    || !['target', 'runtime'].includes(capability.scope)) return null;
  return `${capability.name}@${capability.api}[${capability.scope}]`;
}

function osMethod(method) {
  return (params, options = {}) => request(method, params, options.timeoutMs ?? MAX_TIMEOUT, undefined, false, options.signal);
}

function rpcCall(kind, capability, method, params = null, options = {}) {
  const key = capabilityKey(capability);
  if (key === null || !requires.some(requirement => capabilityKey(requirement) === key)) return Promise.reject(error('undeclared_capability', 'this Host entry did not declare that exact requirement'));
  if (typeof method !== 'string' || method.length === 0 || Buffer.byteLength(method) > 256) return Promise.reject(error('invalid_params', 'RPC method must be a non-empty string of at most 256 bytes'));
  if (!object(options)) return Promise.reject(error('invalid_params', 'RPC options must be an object'));
  let scope;
  if (options.scope !== undefined) {
    const handle = scopeHandles.get(options.scope);
    if (!handle || handle.closed) return Promise.reject(error('scope_denied', 'scope must be a live handle returned by context.rpc.target'));
    scope = handle.id;
  }
  return request(kind, { capability, method, params, ...(scope === undefined ? {} : { scope }), timeoutMs: options.timeoutMs ?? MAX_TIMEOUT }, options.timeoutMs ?? MAX_TIMEOUT, undefined, false, options.signal);
}

function rpcRequest(capability, method, params = null, options = {}) { return rpcCall('rpc.request', capability, method, params, options); }
function rpcNotify(capability, method, params = null, options = {}) { return rpcCall('rpc.notify', capability, method, params, options).then(() => undefined); }

async function rpcTarget(input, options = {}) {
  if (!object(input) || Object.keys(input).some(key => key !== 'sessionId') || typeof input.sessionId !== 'string' || input.sessionId.length === 0) throw error('invalid_params', 'rpc.target expects a Core-owned raw sessionId');
  const result = await request('rpc.target', input, options.timeoutMs ?? MAX_TIMEOUT, undefined, false, options.signal);
  if (!object(result) || result.kind !== 'target' || typeof result.handleId !== 'string') throw error('protocol_error', 'Core returned an invalid Target scope handle');
  const state = { id: result.handleId, closed: false };
  const handle = Object.freeze({ kind: 'target', async close() {
    if (state.closed) return { closed: false };
    const result = await request('rpc.close', { handleId: state.id });
    state.closed = true; return result;
  } });
  scopeHandles.set(handle, state);
  return handle;
}

function provide(capability, method, handler) {
  if (state !== 'starting' && state !== 'active') throw error('host_stopping', 'this generation no longer accepts capability endpoints');
  if (typeof method !== 'string' || method.length < 1 || Buffer.byteLength(method) > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(method) || typeof handler !== 'function') {
    throw error('invalid_provider', 'Host endpoint requires a valid method and function');
  }
  const key = capabilityKey(capability);
  const declared = provides.find(provided => capabilityKey(provided) === key);
  if (key === null || !declared) throw error('invalid_provider', 'Host endpoint is not declared by the plugin');
  const endpointKey = `${key}\u0000${method}`;
  if (endpoints.has(endpointKey)) throw error('invalid_provider', `Host endpoint ${method} is already registered`);
  if (endpoints.size >= MAX_ENDPOINTS) throw error('request_limit', 'Host endpoint registration limit reached');
  endpoints.set(endpointKey, { capability: declared, handler });
  return Object.freeze({ ok: true });
}

function closeInvocation(invocation, reason) {
  if (invocation.closed) return;
  invocation.closed = true;
  invocations.delete(invocation.id);
  clearTimeout(invocation.timer);
  invocation.abort.abort(reason);
  for (const [id, item] of pending) {
    if (item.invocation === invocation) {
      takePending(id)?.reject(reason);
    }
  }
}

function invokeCapability(message) {
  const input = message.params;
  if (state !== 'active') return reply(message.id, null, error('host_stopping', 'this provider generation is not active'));
  if (!object(input) || Object.keys(input).some(key => !['capability','method','params','caller','remainingMs','scope','depth','cleanup','admitted'].includes(key))
    || capabilityKey(input.capability) === null || typeof input.method !== 'string'
    || !Number.isInteger(input.remainingMs) || input.remainingMs < 1 || input.remainingMs > MAX_TIMEOUT
    || !object(input.caller) || Object.keys(input.caller).some(key => !['pluginId','generation','targetId','documentEpoch'].includes(key))
    || typeof input.caller.pluginId !== 'string' || !positive(input.caller.generation)
    || typeof input.caller.targetId !== 'string' || !(positive(input.caller.documentEpoch) || (input.caller.targetId === '' && input.caller.documentEpoch === 0 && input.capability.scope === 'runtime'))
    || (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 8))
    || (input.cleanup !== undefined && typeof input.cleanup !== 'boolean')
    || (input.admitted !== undefined && typeof input.admitted !== 'boolean')) {
    throw error('protocol_error', 'invalid Core capability invocation');
  }
  if (sdkPaused && input.cleanup !== true) return reply(message.id, null, error('core_updating', 'this Host has paused new capability invocations for a Core update'));
  if (coreAdmission !== null && input.cleanup !== true && input.admitted !== true) return reply(message.id, null, error('core_updating', 'Core holds new capability admission until the transaction settles'));
  const endpoint = endpoints.get(`${capabilityKey(input.capability)}\u0000${input.method}`);
  if (!endpoint) return reply(message.id, null, error('method_not_found', 'the declared Host capability has no registered method'));
  if (invocations.size >= MAX_INVOCATIONS) return reply(message.id, null, error('request_limit', 'this Host has four active capability invocations'));
  const invocation = { id: message.id, deadline: performance.now() + input.remainingMs, abort: new AbortController(), closed: false, timer: undefined };
  invocations.set(message.id, invocation);
  const caller = Object.freeze({ pluginId: input.caller.pluginId, generation: input.caller.generation, targetId: input.caller.targetId, documentEpoch: input.caller.documentEpoch });
  const context = Object.freeze({
    pluginId: identity.pluginId, generation: identity.generation, capability: endpoint.capability,
    method: input.method, caller, signal: invocation.abort.signal,
    scope: Object.freeze(input.scope ?? (caller.targetId ? { kind: 'target', targetId: caller.targetId, epoch: caller.documentEpoch } : { kind: 'runtime' })), depth: input.depth ?? 1,
    rpc: pluginContext.rpc,
    remainingMs: () => Math.max(0, Math.floor(invocation.deadline - performance.now())),
  });
  const finish = (result, failure) => {
    if (invocation.closed) return;
    closeInvocation(invocation, failure ?? error('invocation_cancelled', 'the capability handler has completed'));
    if (!failure) {
      try {
        const encoded = JSON.stringify(result ?? null);
        if (encoded === undefined || Buffer.byteLength(encoded) > MAX_PAYLOAD) throw error('response_too_large', 'Host capability result exceeds the payload limit');
      } catch (reason) { failure = reason; }
    }
    reply(message.id, result, failure);
  };
  invocation.timer = setTimeout(() => finish(null, error('request_timeout', 'the original capability invocation deadline expired')), input.remainingMs);
  invocationContext.run(invocation, () => Promise.resolve().then(() => {
    if (invocation.closed) throw error('invocation_cancelled', 'the capability invocation has retired');
    return endpoint.handler(input.params, context);
  })).then(result => finish(result), failure => finish(null, failure)).catch(fatal);
}

function stateSnapshot(value) {
  if (!object(value) || Object.keys(value).some(key => !['schema', 'value'].includes(key))
    || !Number.isInteger(value.schema) || value.schema < 1 || value.schema > 0xffffffff || !own(value, 'value')) {
    throw error('invalid_snapshot', 'plugin state must be {schema:positive uint32,value:JSON}');
  }
  const ancestors = new Set();
  let nodes = 0;
  function validate(item, depth = 0) {
    if (++nodes > MAX_STATE_BYTES || depth > 64) throw error('invalid_snapshot', 'plugin state exceeds its structural bound');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)
      || (!Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item)))) {
      throw error('invalid_snapshot', 'plugin state must contain only finite, acyclic JSON; closures/DOM/Promises/processes are not state');
    }
    if (Array.isArray(item) && (item.length > MAX_STATE_BYTES || Object.keys(item).length !== item.length
      || Object.keys(item).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) throw error('invalid_snapshot', 'plugin state arrays must be dense JSON arrays without extra properties');
    ancestors.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value')) throw error('invalid_snapshot', 'plugin state cannot contain symbols, accessors or hidden properties');
      validate(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  validate(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw error('snapshot_too_large', 'plugin state exceeds 256 KiB');
  return JSON.parse(serialized);
}

function snapshotState(message) {
  if (state !== 'active' || stateTransition || sdkPaused) return reply(message.id, null, error('state_transition_busy', 'snapshot requires an active Host without another state transition'));
  if (coreAdmission !== null && Object.values(trafficRuntime.activity()).some(count => count > 0)) return reply(message.id, null, error('core_admission_traffic_busy', 'Live plugin-owned traffic cannot transfer; retain this Host and activate Core on the next start'));
  sdkPaused = true;
  const operation = {}; stateTransition = operation;
  const finish = (snapshot, failure) => {
    if (stateTransition !== operation) return;
    stateTransition = false; clearTimeout(operation.timer);
    if (state === 'active') reply(message.id, snapshot, failure);
  };
  operation.finish = finish;
  operation.timer = setTimeout(() => finish(null, error('snapshot_timeout', 'plugin state snapshot exceeded its 1400 ms budget; old owner retained')), 1400);
  const settle = () => {
    if (stateTransition !== operation || state !== 'active') return;
    if (invocations.size || pending.size || [...subscriptions.values()].some(subscription => subscription.inFlight)) { setTimeout(settle, 5); return; }
    // Legacy entries without hooks remain reloadable; null explicitly means no
    // plugin state is declared. Hooks must return a valid envelope, never null.
    if (typeof loaded.saveState !== 'function') { finish(null); return; }
    if (typeof loaded.restoreState !== 'function') { finish(null, error('state_restore_unsupported', 'saveState requires a paired restoreState hook before the old Host may retire')); return; }
    Promise.resolve().then(() => loaded.saveState(pluginContext)).then(stateSnapshot).then(
      snapshot => finish(snapshot), failure => finish(null, failure),
    ).catch(fatal);
  };
  settle();
}

function resumeState(message) {
  if (state !== 'active') return reply(message.id, null, error('host_stopping', 'Host is not active'));
  stateTransition?.finish?.(null, error('snapshot_cancelled', 'Core resumed the old owner before snapshot completion'));
  sdkPaused = false;
  reply(message.id, { resumed: true });
  drainNotifications();
}

function coreAdmissionState(message, resume) {
  const operation = message.params?.operationId;
  if (state !== 'active' || !object(message.params) || Object.keys(message.params).some(key => !['operationId','rehold'].includes(key)) || (message.params.rehold !== undefined && typeof message.params.rehold !== 'boolean') || typeof operation !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(operation))
    return reply(message.id, null, error('core_admission_invalid', 'Core admission requires an active Host and an exact transaction identity'));
  if (coreAdmission !== null && coreAdmission !== operation) return reply(message.id, null, error('core_admission_stale', 'Another Core operation holds this Host'));
  if (!resume && message.params.rehold !== true && Object.values(trafficRuntime.activity()).some(count => count > 0)) return reply(message.id, null, error('core_admission_traffic_busy', 'Live plugin-owned traffic requires next-start activation; its current Host is retained'));
  coreAdmission = resume ? null : operation;
  reply(message.id, {operationId:operation,held:!resume,resumed:resume});
  if (resume) drainNotifications();
}

function drainNotifications() {
  if (sdkPaused || state !== 'active' || !pausedNotifications.length) { drainingNotifications = false; return; }
  drainingNotifications = true;
  const message = pausedNotifications[0], subscription = subscriptions.get(message.params?.subscriptionId);
  if (message.method === 'cdp.event' && subscription?.inFlight >= 4) { setTimeout(drainNotifications, 5); return; }
  pausedNotifications.shift(); handle(message, true);
  queueMicrotask(drainNotifications);
}

function loadPlugin() {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(snapshot));
  if (hostMode === 'sdk') return createEmbeddedSdkHost({ source, filename: entry });
  let filename = entry;
  try { filename = createRequire(entry).resolve(entry); }
  catch (failure) { if (failure.code !== 'MODULE_NOT_FOUND') throw failure; }
  const plugin = new Module(filename, module);
  plugin.filename = filename;
  plugin.paths = Module._nodeModulePaths(path.dirname(filename));
  // The snapshot is compiled at the original JS filename, so __dirname and
  // relative JS/resources stay package-relative. No runtime TypeScript loader.
  // Populate the normal CommonJS cache before evaluating. A dependency that
  // imports this entry must see the same partial exports, not execute disk code.
  Module._cache[filename] = plugin;
  try { plugin._compile(source, filename); }
  catch (failure) { delete Module._cache[filename]; throw failure; }
  plugin.loaded = true;
  const api = plugin.exports;
  if (!object(api) || typeof api.activate !== 'function' || typeof api.deactivate !== 'function') {
    throw error('invalid_entry', 'host JS must export activate(context) and deactivate(), matching the renderer lifecycle');
  }
  return api;
}

function handle(message, replayNotification = false) {
  if (!object(message) || message.v !== 1 || !['request', 'response', 'notification'].includes(message.type)) throw error('protocol_error', 'invalid Core JSONL envelope');
  const keys = message.type === 'request' ? ['v','type','pluginId','generation','id','method','params']
    : message.type === 'notification' ? ['v','type','pluginId','generation','method','params']
    : ['v','type','pluginId','generation','id','ok','result','error'];
  if (Object.keys(message).some(key => !keys.includes(key))) throw error('protocol_error', 'unknown Core envelope field');
  if (!identity) {
    if (message.type !== 'request' || message.method !== 'initialize' || typeof message.pluginId !== 'string' || !positive(message.generation)) throw error('protocol_error', 'expected initialize');
    identity = { pluginId: message.pluginId, generation: message.generation };
  }
  if (message.pluginId !== identity.pluginId || message.generation !== identity.generation) throw error('protocol_error', 'message belongs to another plugin generation');
  if (message.type === 'response') {
    if (!positive(message.id) || message.id >= nextId || typeof message.ok !== 'boolean'
      || (message.ok ? !own(message, 'result') || own(message, 'error') : own(message, 'result') || !object(message.error))) throw error('protocol_error', 'invalid Core response');
    const item = takePending(message.id);
    if (!item) return; // expired response cannot revive an old request
    if (message.ok) {
      try { item.prepareResult?.(message.result); item.resolve(message.result); }
      catch (failure) { item.reject(failure); }
    }
    else item.reject(error(message.error.code, message.error.message, message.error.data));
    return;
  }
  if (message.type === 'notification') {
    if (message.method === 'capability.cancel') {
      if (!object(message.params) || !positive(message.params.invocationId)) throw error('protocol_error', 'invalid Core capability cancellation');
      const invocation = invocations.get(message.params.invocationId);
      if (invocation) closeInvocation(invocation, error(message.params.code, message.params.message));
      return;
    }
    if (!replayNotification && (sdkPaused || drainingNotifications) && ['cdp.event', 'cdp.subscriptionEnded'].includes(message.method)) {
      if (pausedNotifications.length >= 64) {
        // Resume before overflowing: failed preflight cannot silently drop the
        // old owner's stream. The snapshot receipt fails and is never applied.
        stateTransition?.finish?.(null, error('snapshot_pause_overflow', 'Host event pause queue filled; old owner resumed'));
        sdkPaused = false;
        drainNotifications();
        if (pausedNotifications.length >= 64) throw error('event_handler_limit', 'Host event callbacks cannot drain their bounded paused stream');
        pausedNotifications.push(message); return;
      } else { pausedNotifications.push(message); return; }
    }
    const id = message.params?.subscriptionId;
    const subscription = subscriptions.get(id);
    if (!subscription) return;
    if (message.method === 'cdp.event') {
      if (subscription.inFlight >= 4) throw error('event_handler_limit', 'host event handlers are not keeping up with the bounded stream');
      subscription.inFlight++;
      Promise.resolve().then(() => {
        if ((state === 'starting' || state === 'active') && subscriptions.has(id)) return subscription.onEvent(message.params.event);
      }).finally(() => { subscription.inFlight--; }).catch(ordinaryCallbackFailed);
    } else if (message.method === 'cdp.subscriptionEnded') {
      subscriptions.delete(id);
      Promise.resolve().then(() => {
        if (state === 'starting' || state === 'active') return subscription.onEnd?.(message.params.reason);
      }).catch(ordinaryCallbackFailed);
    }
    return;
  }
  if (!positive(message.id) || message.id <= lastCoreId) throw error('protocol_error', 'Core request ids must increase');
  lastCoreId = message.id;
  if (message.method === 'initialize' && state === 'waiting') {
    if (!object(message.params) || message.params.protocolVersion !== 1) throw error('protocol_error', 'unsupported Core initialization');
    if (message.params.coreAdmission != null && (typeof message.params.coreAdmission !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(message.params.coreAdmission))) throw error('protocol_error', 'invalid initial Core admission identity');
    coreAdmission = message.params.coreAdmission ?? null;
    const lifecycle = {open:true};
    state = 'starting';
    activation = lifecycleContext.run(lifecycle, () => Promise.resolve().then(() => {
      if (state !== 'starting') return;
      loaded = loadPlugin();
      pluginContext = context(message.params);
      return loaded.activate(pluginContext);
    }).then(async () => {
      if (message.params.initialState != null) {
        if (typeof loaded.restoreState !== 'function') throw error('state_restore_unsupported', 'plugin must export restoreState for compatible online transfer');
        await loaded.restoreState(stateSnapshot(message.params.initialState), pluginContext);
      }
      restoringState = false;
    }));
    activation.then(() => {
      if (state !== 'starting') return;
      lifecycle.open = false;
      state = 'active'; reply(message.id, { ready: true });
    }, failure => {
      lifecycle.open = false;
      if (state !== 'starting') return;
      state = 'failed'; retire(); reply(message.id, null, failure);
    }).catch(fatal);
  } else if (message.method === 'shutdown' && state !== 'stopping') {
    shutdown(message);
  } else if (message.method === 'capability.invoke') {
    invokeCapability(message);
  } else if (message.method === 'host.snapshot' || message.method === 'state.snapshot') {
    snapshotState(message);
  } else if (message.method === 'host.resume') {
    resumeState(message);
  } else if (message.method === 'host.corePause' || message.method === 'host.coreResume') {
    coreAdmissionState(message, message.method === 'host.coreResume');
  } else reply(message.id, null, error('method_not_found', 'unsupported lifecycle request'));
}

if (!entry || !snapshot || !path.isAbsolute(entry) || !path.isAbsolute(snapshot)
  || !process.execArgv.includes('--no-addons') || !process.execArgv.includes('--no-experimental-strip-types')) {
  fatal(error('executor_configuration', 'use Codlet to run a plugin with the managed JS executor'));
} else {
  process.stdin.on('data', chunk => {
    try {
      partial = Buffer.concat([partial, chunk]);
      let newline;
      while ((newline = partial.indexOf(10)) >= 0) {
        if (newline < 1 || newline > MAX_FRAME) throw error('protocol_error', 'invalid Core frame size');
        const line = new TextDecoder('utf-8', { fatal: true }).decode(partial.subarray(0, newline));
        partial = partial.subarray(newline + 1);
        handle(JSON.parse(line));
      }
      if (partial.length > MAX_FRAME) throw error('protocol_error', 'Core frame exceeds its limit');
    } catch (failure) { fatal(failure); }
  });
  process.stdin.on('end', () => { state = 'stopping'; retire(); process.exit(0); });
  process.stdin.on('error', fatal);
  process.stdout.on('error', fatal);
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}
