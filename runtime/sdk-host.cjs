'use strict';

// Trusted-plugin SDK compute realm. Only JSON crosses this membrane. Neither
// Node objects/functions nor module loaders are passed to plugin code. node:vm
// is NOT a security sandbox for malicious code; Core still checks every broker.
function createSdkHost({ source, filename }) {
  const vm = require('node:vm');
  const parse = typeof parseEmbeddedSdkHostSource === 'function' ? parseEmbeddedSdkHostSource : require('./sdk-source-parser.cjs').parse;
  // Native dynamic-import rejection can deliver a foreign Node Error to the
  // realm. Reject loader syntax before evaluation, with an actual JS parser.
  // String/comment text containing "import" remains ordinary valid source.
  const syntax = [parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })];
  while (syntax.length) {
    const node = syntax.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') throw Object.assign(new Error('SDK Host requires bundled CommonJS; dynamic and static import loaders are unavailable'), { code: 'sdk_import_denied' });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) syntax.push(...value);
      else if (value && typeof value === 'object') syntax.push(value);
    }
  }
  const hostFunctions = new Map();
  const realmFunctions = new Map();
  const hostSignals = new WeakMap();
  const localSignals = new Map();
  const hostObjects = new Map();
  const timers = new Map();
  const listeners = [];
  let sequence = 0;
  let closed = false;
  let deliver;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const failure = value => ({ code: String(value?.code || 'plugin_error'), message: String(value?.message || value || 'plugin failed') });
  const token = (kind, value) => ({ $codletSdk: kind, ...value });
  function encode(value, seen = new Set()) {
    if (value === undefined) return token('undefined', {});
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'function') {
      if (hostFunctions.size >= 4096) throw fail('sdk_handle_limit', 'SDK Host method handle limit reached');
      const id = ++sequence; hostFunctions.set(id, value);
      return token('function', { id });
    }
    if (value instanceof Uint8Array) return token('bytes', { data: Array.from(value) });
    if (value instanceof Error) return token('error', failure(value));
    if (value && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean') {
      let id = hostSignals.get(value);
      if (!id) {
        id = ++sequence; hostSignals.set(value, id);
        const onAbort = () => { if (!closed) deliver('signal', id, JSON.stringify(encode(value.reason))); };
        value.addEventListener('abort', onAbort, { once: true });
        listeners.push(() => value.removeEventListener('abort', onAbort));
      }
      return token('signal', { id, aborted: value.aborted, reason: encode(value.reason) });
    }
    if (seen.has(value)) throw fail('sdk_value_invalid', 'SDK values must not contain cycles');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => encode(item, seen));
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = encode(typeof item === 'function' ? item.bind(value) : item, seen);
      }
      if (typeof value[Symbol.asyncIterator] === 'function') {
        result.$codletIterator = encode(() => value[Symbol.asyncIterator](), seen);
      }
      if (typeof value.next === 'function') {
        result.next = encode(value.next.bind(value), seen);
        if (typeof value.return === 'function') result.return = encode(value.return.bind(value), seen);
      }
      const reference = value.kind === 'target' && typeof value.close === 'function' ? ++sequence : undefined;
      if (reference) hostObjects.set(reference, value);
      return token('object', { value: result, ...(reference ? { reference } : {}) });
    } finally { seen.delete(value); }
  }
  function decode(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decode);
    switch (value.$codletSdk) {
      case 'undefined': return undefined;
      case 'bytes': return Uint8Array.from(value.data);
      case 'error': return fail(value.code, value.message);
      case 'function': {
        if (!realmFunctions.has(value.id)) realmFunctions.set(value.id, (...args) => Promise.resolve(deliver('call', value.id, JSON.stringify(encode(args)))).then(serialized => decode(JSON.parse(serialized))));
        return realmFunctions.get(value.id);
      }
      case 'localSignal': {
        if (!localSignals.has(value.id)) localSignals.set(value.id, new AbortController());
        const controller = localSignals.get(value.id);
        if (value.aborted && !controller.signal.aborted) controller.abort(decode(value.reason));
        return controller.signal;
      }
      case 'hostObject': {
        const object = hostObjects.get(value.id);
        if (!object) throw fail('sdk_handle_invalid', 'SDK object handle has retired');
        return object;
      }
      case 'object': {
        const result = Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, decode(item)]));
        if (result.$codletIterator) {
          const openIterator = result.$codletIterator;
          result[Symbol.asyncIterator] = () => {
            const iterator = openIterator();
            return { async next() { return (await iterator).next(); }, async return() { return (await iterator).return?.() ?? { done: true }; } };
          };
          delete result.$codletIterator;
        }
        return result;
      }
      default: throw fail('sdk_value_invalid', 'invalid SDK bridge value');
    }
  }
  function bridge(serialized) {
    // Return a primitive string even on failure; a host Error must never cross.
    try {
      if (closed) throw fail('host_stopping', 'SDK compute realm has retired');
      const input = JSON.parse(serialized);
      if (input.action === 'call') {
        const fn = hostFunctions.get(input.id);
        if (!fn) throw fail('sdk_handle_invalid', 'SDK method handle has retired');
        const result = fn(...decode(input.args));
        if (result && typeof result.then === 'function') {
          result.then(value => {
            if (!closed) deliver('resolve', input.request, JSON.stringify(encode(value)));
          }, reason => {
            if (!closed) deliver('reject', input.request, JSON.stringify(failure(reason)));
          }).catch(reason => { if (!closed) deliver('reject', input.request, JSON.stringify(failure(reason))); });
          return JSON.stringify({ pending: true });
        }
        return JSON.stringify({ value: encode(result) });
      }
      if (input.action === 'timer') {
        const id = ++sequence;
        const timeout = Math.min(2147483647, Math.max(0, Number(input.delay) || 0));
        const run = () => {
          if (!input.interval) timers.delete(id);
          if (!closed) Promise.resolve(deliver('call', input.callback, JSON.stringify(input.args))).catch(() => {});
        };
        timers.set(id, input.interval ? setInterval(run, timeout) : setTimeout(run, timeout));
        return JSON.stringify({ value: id });
      }
      if (input.action === 'clearTimer') {
        clearTimeout(timers.get(input.id)); clearInterval(timers.get(input.id)); timers.delete(input.id);
        return '{}';
      }
      if (input.action === 'abortSignal') {
        localSignals.get(input.id)?.abort(decode(input.reason)); return '{}';
      }
      throw fail('sdk_value_invalid', 'unsupported SDK bridge operation');
    } catch (reason) { return JSON.stringify({ error: failure(reason) }); }
  }
  const sandbox = Object.create(null);
  sandbox.__codletBridge = bridge;
  const realm = vm.createContext(sandbox, { name: 'Codlet SDK Host', codeGeneration: { strings: false, wasm: false } });
  deliver = vm.runInContext(`(${sdkRealm.toString()})(__codletBridge)`, realm, { timeout: 1000 });
  delete sandbox.__codletBridge;
  vm.runInContext(source, realm, { filename, timeout: 1000 });
  const lifecycle = vm.runInContext('({ activate: typeof module.exports.activate, deactivate: typeof module.exports.deactivate, saveState: typeof module.exports.saveState, restoreState: typeof module.exports.restoreState })', realm, { timeout: 1000 });
  if (lifecycle.activate !== 'function' || lifecycle.deactivate !== 'function') throw fail('invalid_entry', 'SDK Host must export activate(context) and deactivate(cleanup)');
  function run(phase, context) {
    return deliver(phase, 0, JSON.stringify(encode(sanitize(context))));
  }
  const sanitize = context => ({ ...context, log: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(key => [key, context.log[key].bind(context.log)])) });
  function dispose() {
    closed = true;
    for (const timer of timers.values()) { clearTimeout(timer); clearInterval(timer); }
    timers.clear(); hostFunctions.clear(); realmFunctions.clear(); localSignals.clear(); hostObjects.clear();
    for (const remove of listeners) remove();
  }
  return {
    activate: context => run('activate', context),
    async deactivate(context) { try { return await run('deactivate', context); } finally { dispose(); } },
    ...(lifecycle.saveState === 'function' ? { saveState: context => Promise.resolve(run('saveState', context)).then(serialized => decode(JSON.parse(serialized))) } : {}),
    ...(lifecycle.restoreState === 'function' ? { restoreState: (snapshot, context) => deliver('restoreState', 0, JSON.stringify(encode({ snapshot, context: sanitize(context) }))) } : {}),
  };
}

// This whole function is evaluated in the compute realm. Captured bridge is the
// sole foreign function and is never exposed as a global/property or result.
function sdkRealm(bridge) {
  'use strict';
  const callbacks = new Map();
  const pending = new Map();
  const signals = new Map();
  const localSignals = new WeakMap();
  const hostObjects = new WeakMap();
  let next = 0;
  let restoringState = false;
  const token = (kind, value) => ({ $codletSdk: kind, ...value });
  const makeError = value => Object.assign(new Error(value.message), { code: value.code });
  function strictState(value) {
    const ancestors = new Set(); let nodes = 0;
    function validate(item, depth = 0) {
      if (++nodes > 256 * 1024 || depth > 64) throw makeError({code:'invalid_snapshot',message:'plugin state exceeds its structural bound'});
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
      if (typeof item !== 'object' || ancestors.has(item) || (!Array.isArray(item) && ![null,Object.prototype].includes(Object.getPrototypeOf(item)))) throw makeError({code:'invalid_snapshot',message:'plugin state must contain only finite acyclic plain JSON'});
      if (Array.isArray(item) && (item.length > 256*1024 || Object.keys(item).length !== item.length || Object.keys(item).some(key=>!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=item.length))) throw makeError({code:'invalid_snapshot',message:'plugin state arrays must be dense JSON arrays without extra properties'});
      ancestors.add(item);
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw makeError({code:'invalid_snapshot',message:'plugin state cannot contain accessors, symbols or hidden properties'});
        validate(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    }
    validate(value); return value;
  }
  function encode(value, seen = new Set()) {
    if (value === undefined) return token('undefined', {});
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (hostObjects.has(value)) return token('hostObject', { id: hostObjects.get(value) });
    if (typeof value === 'function') { const id = ++next; callbacks.set(id, value); return token('function', { id }); }
    if (value instanceof Uint8Array) return token('bytes', { data: Array.from(value) });
    if (value instanceof Error) return token('error', { code: value.code, message: value.message });
    if (value instanceof SdkSignal) {
      if (!localSignals.has(value)) localSignals.set(value, ++next);
      return token('localSignal', { id: localSignals.get(value), aborted: value.aborted, reason: encode(value.reason) });
    }
    if (seen.has(value)) throw makeError({ code: 'sdk_value_invalid', message: 'SDK values must not contain cycles' });
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(item => encode(item, seen));
      const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(typeof item === 'function' ? item.bind(value) : item, seen)]));
      if (typeof value[Symbol.asyncIterator] === 'function') result.$codletIterator = encode(() => value[Symbol.asyncIterator](), seen);
      if (typeof value.next === 'function') {
        result.next = encode(value.next.bind(value), seen);
        if (typeof value.return === 'function') result.return = encode(value.return.bind(value), seen);
      }
      return token('object', { value: result });
    } finally { seen.delete(value); }
  }
  function decode(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decode);
    switch (value.$codletSdk) {
      case 'undefined': return undefined;
      case 'bytes': return Uint8Array.from(value.data);
      case 'error': return makeError(value);
      case 'function': return (...args) => {
        const request = ++next;
        const result = JSON.parse(bridge(JSON.stringify({ action: 'call', id: value.id, request, args: encode(args) })));
        if (result.error) throw makeError(result.error);
        if (!result.pending) return decode(result.value);
        return new Promise((resolve, reject) => pending.set(request, { resolve, reject }));
      };
      case 'signal': {
        if (!signals.has(value.id)) signals.set(value.id, new SdkSignal());
        const signal = signals.get(value.id);
        if (value.aborted) signal.abort(decode(value.reason));
        return signal;
      }
      case 'object': {
        const result = Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, decode(item)]));
        if (value.reference) hostObjects.set(result, value.reference);
        if (result.$codletIterator) {
          const openIterator = result.$codletIterator;
          result[Symbol.asyncIterator] = () => {
            const iterator = openIterator();
            return { async next() { return (await iterator).next(); }, async return() { return (await iterator).return?.() ?? { done: true }; } };
          };
          delete result.$codletIterator;
        }
        return result;
      }
      default: throw makeError({ code: 'sdk_value_invalid', message: 'invalid SDK bridge value' });
    }
  }
  class SdkSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.listeners = new Set(); }
    addEventListener(kind, callback, options) { if (kind === 'abort' && typeof callback === 'function') this.listeners.add({ callback, once: !!options?.once }); }
    removeEventListener(kind, callback) { if (kind === 'abort') for (const item of this.listeners) if (item.callback === callback) this.listeners.delete(item); }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    abort(reason) {
      if (this.aborted) return;
      this.aborted = true; this.reason = reason;
      const id = localSignals.get(this);
      if (id) bridge(JSON.stringify({ action: 'abortSignal', id, reason: encode(reason) }));
      for (const item of this.listeners) { if (item.once) this.listeners.delete(item); item.callback.call(this, { type: 'abort', target: this }); }
    }
    static any(values) {
      const combined = new SdkSignal();
      for (const value of values) {
        if (value.aborted) { combined.abort(value.reason); break; }
        value.addEventListener('abort', () => combined.abort(value.reason), { once: true });
      }
      return combined;
    }
  }
  globalThis.AbortSignal = SdkSignal;
  globalThis.AbortController = class { constructor() { this.signal = new SdkSignal(); } abort(reason = makeError({ code: 'invocation_cancelled', message: 'operation aborted' })) { this.signal.abort(reason); } };
  globalThis.TextEncoder = class { encode(value = '') { const text = unescape(encodeURIComponent(String(value))); return Uint8Array.from(text, ch => ch.charCodeAt(0)); } };
  globalThis.TextDecoder = class { decode(bytes = new Uint8Array()) { return decodeURIComponent(escape(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))); } };
  const timer = interval => (callback, delay, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('timer callback must be a function');
    const id = ++next; callbacks.set(id, callback);
    const result = JSON.parse(bridge(JSON.stringify({ action: 'timer', callback: id, delay, args: encode(args), interval })));
    if (result.error) throw makeError(result.error); return result.value;
  };
  globalThis.setTimeout = timer(false); globalThis.setInterval = timer(true);
  globalThis.clearTimeout = globalThis.clearInterval = id => bridge(JSON.stringify({ action: 'clearTimer', id }));
  globalThis.queueMicrotask = callback => Promise.resolve().then(callback);
  globalThis.module = { exports: {} }; globalThis.exports = module.exports;
  globalThis.require = () => { throw makeError({ code: 'sdk_import_denied', message: 'SDK Host has no Node or disk module loader; distribute bundled JavaScript or choose node + host.raw' }); };
  globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(key => [key, () => {}])));
  // Every exposed SDK wrapper retains local prototypes. No foreign functions
  // or objects are reachable through the resulting context.
  return function deliver(kind, id, serialized) {
    const value = JSON.parse(serialized);
    if (kind === 'resolve' || kind === 'reject') {
      const waiter = pending.get(id); if (!waiter) return;
      pending.delete(id); kind === 'resolve' ? waiter.resolve(decode(value)) : waiter.reject(makeError(value)); return;
    }
    if (kind === 'signal') { signals.get(id)?.abort(decode(value)); return; }
    if (kind === 'call') return Promise.resolve(callbacks.get(id)?.(...decode(value))).then(result => JSON.stringify(encode(result)));
    const context = decode(value);
    const ownerContext = kind === 'restoreState' ? context.context : context;
    if (kind === 'activate') restoringState = ownerContext.restoringState === true;
    Object.defineProperty(ownerContext, 'restoringState', { get: () => restoringState, enumerable: true });
    if (kind === 'restoreState') return Promise.resolve(module.exports.restoreState(context.snapshot, ownerContext)).then(result => { restoringState = false; return result; });
    globalThis.console = context.log;
    const result = module.exports[kind](context);
    return kind === 'saveState' ? Promise.resolve(result).then(strictState).then(snapshot => JSON.stringify(encode(snapshot))) : result;
  };
}

module.exports = { createSdkHost };
