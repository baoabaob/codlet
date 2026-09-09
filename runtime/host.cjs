'use strict';

// Codlet owns this adapter; plugin entrypoints export activate/deactivate just
// like renderer entrypoints. A separate process is a lifetime boundary, no sandbox.
const fs = require('node:fs');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { Console } = require('node:console');
const { TextDecoder } = require('node:util');
const entry = process.argv[1];
const snapshot = process.argv[2];
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 16;
const MAX_TIMEOUT = 15000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const error = (code, message, data) => Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
const rpcError = value => ({ code: String(value?.code || 'plugin_error').slice(0, 256), message: String(value?.message || value || 'plugin failed').slice(0, 4096) });
const abort = new AbortController();
const pending = new Map();
const subscriptions = new Map();
let identity;
let state = 'waiting';
let nextId = 1;
let lastCoreId = 0;
let loaded;
let activation;
let deactivation;
let partial = Buffer.alloc(0);
let outboundFrames = 0;
let exiting = false;

// Keep plugin logging outside the protocol. Writing directly to stdout is an
// unsupported protocol violation, not a mechanism for plugin communication.
global.console = new Console({ stdout: process.stderr, stderr: process.stderr });

function fatal(reason) {
  if (exiting) return;
  exiting = true;
  process.stderr.write(`Codlet JS host: ${rpcError(reason).message}\n`);
  process.exit(1);
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

function request(method, params, timeoutMs = MAX_TIMEOUT, prepareResult) {
  if (state !== 'starting' && state !== 'active') return Promise.reject(error('host_stopping', 'host no longer admits Core requests'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) return Promise.reject(error('invalid_timeout', 'timeoutMs must be 1..15000'));
  if (pending.size >= MAX_PENDING) return Promise.reject(error('request_limit', 'too many pending Core requests'));
  if (!positive(nextId)) return Promise.reject(error('request_ids_exhausted', 'this generation has exhausted request IDs'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(error('request_timeout', 'Core request deadline expired'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, prepareResult });
    try { send({ type: 'request', id, method, params }); }
    catch (failure) { clearTimeout(timer); pending.delete(id); reject(failure); }
  });
}

function retire() {
  if (!abort.signal.aborted) abort.abort(error('host_stopping', 'Codlet is stopping this generation'));
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error('host_stopping', 'Codlet is stopping this generation')); }
  pending.clear();
  subscriptions.clear();
}

function deactivate() {
  if (!deactivation) deactivation = Promise.resolve().then(() => loaded?.deactivate?.());
  return deactivation;
}

function context(params) {
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
    core: Object.freeze({ request }), log: console,
  });
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
    const id = message.params?.subscriptionId;
    const subscription = subscriptions.get(id);
    if (!subscription) return;
    if (message.method === 'cdp.event') {
      if (subscription.inFlight >= 4) throw error('event_handler_limit', 'host event handlers are not keeping up with the bounded stream');
      subscription.inFlight++;
      Promise.resolve().then(() => {
        if ((state === 'starting' || state === 'active') && subscriptions.has(id)) return subscription.onEvent(message.params.event);
      }).finally(() => { subscription.inFlight--; }).catch(fatal);
    } else if (message.method === 'cdp.subscriptionEnded') {
      subscriptions.delete(id);
      Promise.resolve().then(() => subscription.onEnd?.(message.params.reason)).catch(fatal);
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
      return loaded.activate(context(message.params));
    });
    activation.then(() => {
      if (state !== 'starting') return;
      state = 'active'; reply(message.id, { ready: true });
    }, failure => {
      if (state !== 'starting') return;
      state = 'failed'; retire(); reply(message.id, null, failure);
    }).catch(fatal);
  } else if (message.method === 'shutdown' && state !== 'stopping') {
    state = 'stopping'; retire();
    // If activate ignores abort or JS blocks the event loop, the parent owns
    // the finite stop deadline and reaps this process and its descendants.
    Promise.resolve(activation).catch(() => {}).then(deactivate).then(
      () => reply(message.id, null, null, () => { exiting = true; process.exit(0); }),
      failure => reply(message.id, null, failure, () => { exiting = true; process.exit(1); }),
    ).catch(fatal);
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
