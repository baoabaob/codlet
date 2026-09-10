'use strict';

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
let provides = [];
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

function request(method, params, timeoutMs = MAX_TIMEOUT, prepareResult, cleanup = false) {
  if (cleanup ? state !== 'stopping' || !cleanupOpen : state !== 'starting' && state !== 'active') return Promise.reject(error('host_stopping', 'host no longer admits this phase of Core requests'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) return Promise.reject(error('invalid_timeout', 'timeoutMs must be 1..15000'));
  if (cleanup) {
    timeoutMs = Math.min(timeoutMs, Math.floor(cleanupDeadline - performance.now()));
    if (timeoutMs < 1) return Promise.reject(error('cleanup_timeout', 'the total Core cleanup budget expired'));
  }
  const invocation = cleanup ? undefined : invocationContext.getStore();
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(error(cleanup ? 'cleanup_timeout' : 'request_timeout', 'Core request deadline expired'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, prepareResult, invocation });
    try { send({ type: 'request', id, method, params }); }
    catch (failure) { clearTimeout(timer); pending.delete(id); reject(failure); }
  });
}

function retire() {
  for (const invocation of invocations.values()) closeInvocation(invocation, error('host_stopping', 'Codlet is stopping this generation'));
  endpoints.clear();
  if (!abort.signal.aborted) abort.abort(error('host_stopping', 'Codlet is stopping this generation'));
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error('host_stopping', 'Codlet is stopping this generation')); }
  pending.clear();
  subscriptions.clear();
}

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
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure ?? error('host_stopping', 'cleanup has completed')); }
    pending.clear();
    reply(message.id, null, failure, () => { exiting = true; process.exit(failure ? 1 : 0); });
  };
  const timer = setTimeout(() => finish(error('cleanup_timeout', 'the total Core cleanup budget expired')), budget);
  // Cancelling activation retires its requests and signal. Its unresolved Promise
  // cannot prevent deactivate from using the finite cleanup phase.
  Promise.resolve(activation).catch(() => {});
  deactivate(cleanup).then(() => finish(), finish).catch(fatal);
}

function context(params) {
  if (!Array.isArray(params.provides ?? [])) throw error('protocol_error', 'Core host provides must be an array');
  provides = (params.provides ?? []).map(capability => {
    if (capabilityKey(capability) === null) throw error('protocol_error', 'invalid Core host capability declaration');
    return Object.freeze({ name: capability.name, api: capability.api, scope: capability.scope });
  });
  const cdp = Object.freeze({
    request(method, params = {}, options = {}) {
      return request('cdp.request', { method, params, ...options }, options.timeoutMs ?? MAX_TIMEOUT);
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
  return Object.freeze({
    plugin: Object.freeze({ id: identity.pluginId, generation: identity.generation, version: params.pluginVersion }),
    root: process.cwd(), signal: abort.signal, cdp,
    core: Object.freeze({ request(method, params, timeoutMs = MAX_TIMEOUT) {
      return request(method, params, timeoutMs);
    } }), log: console,
    rpc: Object.freeze({ provide }),
  });
}

function capabilityKey(capability) {
  if (!object(capability) || Object.keys(capability).some(key => !['name','api','scope'].includes(key))
    || typeof capability.name !== 'string' || !positive(capability.api) || capability.api > 0xffffffff
    || capability.scope !== 'target') return null;
  return `${capability.name}@${capability.api}[${capability.scope}]`;
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
      pending.delete(id); clearTimeout(item.timer); item.reject(reason);
    }
  }
}

function invokeCapability(message) {
  const input = message.params;
  if (state !== 'active') return reply(message.id, null, error('host_stopping', 'this provider generation is not active'));
  if (!object(input) || Object.keys(input).some(key => !['capability','method','params','caller','remainingMs'].includes(key))
    || capabilityKey(input.capability) === null || typeof input.method !== 'string'
    || !Number.isInteger(input.remainingMs) || input.remainingMs < 1 || input.remainingMs > MAX_TIMEOUT
    || !object(input.caller) || Object.keys(input.caller).some(key => !['pluginId','generation','targetId','documentEpoch'].includes(key))
    || typeof input.caller.pluginId !== 'string' || !positive(input.caller.generation)
    || typeof input.caller.targetId !== 'string' || !positive(input.caller.documentEpoch)) {
    throw error('protocol_error', 'invalid Core capability invocation');
  }
  const endpoint = endpoints.get(`${capabilityKey(input.capability)}\u0000${input.method}`);
  if (!endpoint) return reply(message.id, null, error('method_not_found', 'the declared Host capability has no registered method'));
  if (invocations.size >= MAX_INVOCATIONS) return reply(message.id, null, error('request_limit', 'this Host has four active capability invocations'));
  const invocation = { id: message.id, deadline: performance.now() + input.remainingMs, abort: new AbortController(), closed: false, timer: undefined };
  invocations.set(message.id, invocation);
  const caller = Object.freeze({ pluginId: input.caller.pluginId, generation: input.caller.generation, targetId: input.caller.targetId, documentEpoch: input.caller.documentEpoch });
  const context = Object.freeze({
    pluginId: identity.pluginId, generation: identity.generation, capability: endpoint.capability,
    method: input.method, caller, signal: invocation.abort.signal,
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

function loadPlugin() {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(snapshot));
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

function handle(message) {
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
    const item = pending.get(message.id);
    if (!item) return; // expired response cannot revive an old request
    pending.delete(message.id); clearTimeout(item.timer);
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
    state = 'starting';
    activation = Promise.resolve().then(() => {
      if (state !== 'starting') return;
      loaded = loadPlugin();
      pluginContext = context(message.params);
      return loaded.activate(pluginContext);
    });
    activation.then(() => {
      if (state !== 'starting') return;
      state = 'active'; reply(message.id, { ready: true });
    }, failure => {
      if (state !== 'starting') return;
      state = 'failed'; retire(); reply(message.id, null, failure);
    }).catch(fatal);
  } else if (message.method === 'shutdown' && state !== 'stopping') {
    shutdown(message);
  } else if (message.method === 'capability.invoke') {
    invokeCapability(message);
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
