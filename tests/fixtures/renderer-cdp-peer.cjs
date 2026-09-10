'use strict';

// A deliberately small CDP test peer. It executes actual renderer JavaScript in
// Node VM worlds; it does not model Chromium layout, DOM, permissions or networking.
const vm = require('node:vm');
const { TextDecoder } = require('node:util');
const { performance } = require('node:perf_hooks');
const MAX_FRAME = 1024 * 1024;
const MAX_TARGETS = 4;
const MAX_CONTEXTS = 64;
const MAX_SESSIONS = 16;
let sessionLimit = MAX_SESSIONS;
const MAX_SCRIPTS = 64;
const MAX_BINDINGS = 64;
const MAX_EVALUATIONS = 32;
const MAX_TIMERS = 64;
const MAX_TRACE = 128;
const EVALUATION_TIMEOUT = 8000;
const targets = new Map();
const sessions = new Map();
const contexts = new Map();
const evaluations = new Map();
const heldAttachments = new Map();
let holdNextAttachment = false;
const trace = [];
const methods = new Map();
let nextContext = 1, nextSession = 1, nextScript = 1;
let partial = Buffer.alloc(0), queuedFrames = 0, writtenLog = 0;
let discover = false, shuttingDown = false;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const failure = message => Object.assign(new Error(message), { code: -32000 });

function log(...values) {
  if (writtenLog >= 65536) return;
  const line = values.map(value => typeof value === 'string' ? value : String(value)).join(' ').slice(0, 4096) + '\n';
  const bytes = Buffer.from(line).subarray(0, 65536 - writtenLog);
  writtenLog += bytes.length;
  process.stderr.write(bytes);
}
const console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });

function send(message) {
  if (shuttingDown) return;
  const bytes = Buffer.from(JSON.stringify(message) + '\0');
  if (bytes.length > MAX_FRAME || queuedFrames >= 64) throw failure('fixture output bound exceeded');
  queuedFrames++;
  process.stdout.write(bytes, error => {
    queuedFrames--;
    if (error) fatal(error);
  });
}
function response(request, result, error) {
  send({ id: request.id, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(error ? { error: { code: -32000, message: String(error.message ?? error).slice(0, 4096) } } : { result }) });
}
function event(method, params, sessionId) {
  send({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
}
function targetInfo(target) {
  return { targetId: target.id, type: 'page', url: target.url, title: `VM ${target.id}`, attached: [...sessions.values()].some(session => session.target === target) };
}
function requireTarget(id) {
  const target = targets.get(id);
  if (!target) throw failure(`unknown target ${id}`);
  return target;
}
function requireSession(request) {
  const session = sessions.get(request.sessionId);
  if (!session) throw failure(`unknown session ${request.sessionId}`);
  return session;
}
function contextDescription(context) {
  return { id: context.id, uniqueId: `vm-${context.target.id}-${context.target.epoch}-${context.id}`,
    origin: 'app://-', name: context.name,
    auxData: { isDefault: context.name === '', type: context.name === '' ? 'default' : 'isolated', frameId: context.target.frameId } };
}
function emitContext(context) {
  for (const session of sessions.values()) {
    if (session.target === context.target && session.runtime) event('Runtime.executionContextCreated', { context: contextDescription(context) }, session.id);
  }
}
function createContext(target, name = '') {
  const existing = [...contexts.values()].find(context => context.target === target && context.name === name && context.live);
  if (existing) return existing;
  if (contexts.size >= MAX_CONTEXTS) throw failure('fixture context limit exceeded');
  const context = { id: nextContext++, target, name, live: true, timers: new Map(), bindings: new Map(), sandbox: null };
  const schedule = (callback, delay, repeat, args) => {
    if (!context.live) throw failure('execution context destroyed');
    if (typeof callback !== 'function' || !Number.isFinite(delay) || delay < 0 || delay > 15000) throw failure('fixture timer arguments unsupported');
    if (context.timers.size >= MAX_TIMERS) throw failure('fixture timer limit exceeded');
    const invoke = () => {
      if (!repeat) context.timers.delete(timer);
      if (context.live) { try { callback(...args); } catch (error) { log(error.stack ?? error); } }
    };
    const timer = repeat ? setInterval(invoke, Math.max(1, delay)) : setTimeout(invoke, delay);
    context.timers.set(timer, repeat);
    return timer;
  };
  const clear = timer => {
    if (!context.timers.has(timer)) return;
    clearTimeout(timer); clearInterval(timer); context.timers.delete(timer);
  };
  context.sandbox = vm.createContext({
    console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    performance: Object.freeze({ now: () => performance.now() }),
    location: Object.freeze({ href: target.url }),
    document: Object.freeze({ URL: target.url, readyState: 'complete' }),
    setTimeout: (callback, delay = 0, ...args) => schedule(callback, delay, false, args),
    clearTimeout: clear,
    setInterval: (callback, delay = 0, ...args) => schedule(callback, delay, true, args),
    clearInterval: clear,
    queueMicrotask: callback => queueMicrotask(() => { if (context.live) callback(); }),
  }, { name: `${target.id}:${name || 'main'}:${target.epoch}` });
  vm.runInContext('globalThis.window = globalThis; globalThis.top = globalThis; globalThis.self = globalThis;', context.sandbox, { timeout: 1000 });
  contexts.set(context.id, context);
  for (const session of sessions.values()) {
    if (session.target === target) for (const binding of session.bindings.values()) installBinding(session, context, binding);
  }
  emitContext(context);
  return context;
}
function installBinding(session, context, binding) {
  if (binding.world !== undefined && binding.world !== context.name) return;
  if (binding.contextId !== undefined && binding.contextId !== context.id) return;
  const invoke = payload => {
    if (!context.live || !sessions.has(session.id) || !session.bindings.has(binding.name)) return;
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_FRAME - 2048) throw failure('invalid fixture binding payload');
    event('Runtime.bindingCalled', { name: binding.name, payload, executionContextId: context.id }, session.id);
  };
  context.sandbox[binding.name] = invoke;
  context.bindings.set(binding.name, { sessionId: session.id, invoke });
}
function removeBinding(session, name) {
  session.bindings.delete(name);
  for (const context of contexts.values()) {
    const binding = context.bindings.get(name);
    if (binding?.sessionId === session.id) {
      if (context.sandbox[name] === binding.invoke) delete context.sandbox[name];
      context.bindings.delete(name);
    }
  }
}
function retireContext(context) {
  if (!context.live) return;
  context.live = false;
  for (const timer of context.timers.keys()) { clearTimeout(timer); clearInterval(timer); }
  context.timers.clear(); context.bindings.clear();
  for (const evaluation of [...evaluations.values()]) {
    if (evaluation.context === context) evaluation.finish(undefined, failure('execution context destroyed'));
  }
  contexts.delete(context.id);
}
function addTarget(id) {
  if (targets.size >= MAX_TARGETS || targets.has(id) || typeof id !== 'string' || id.length > 128) throw failure('invalid fixture target');
  const target = { id, url: 'app://-/index.html', frameId: `frame-${id}`, epoch: 1 };
  targets.set(id, target); createContext(target);
  if (discover) event('Target.targetCreated', { targetInfo: targetInfo(target) });
  return target;
}
function navigate(target) {
  for (const context of [...contexts.values()]) if (context.target === target) retireContext(context);
  target.epoch++;
  for (const session of sessions.values()) {
    if (session.target !== target) continue;
    event('Runtime.executionContextsCleared', {}, session.id);
    event('Page.frameNavigated', { frame: { id: target.frameId, url: target.url } }, session.id);
  }
  createContext(target);
  for (const session of sessions.values()) {
    if (session.target !== target) continue;
    for (const script of session.scripts.values()) {
      const context = createContext(target, script.world);
      try { vm.runInContext(script.source, context.sandbox, { timeout: 1000 }); }
      catch (error) { log(error.stack ?? error); }
    }
  }
}
function detach(session) {
  for (const name of [...session.bindings.keys()]) removeBinding(session, name);
  sessions.delete(session.id);
  event('Target.detachedFromTarget', { sessionId: session.id, targetId: session.target.id });
}

function beginEvaluation(request, session, params) {
  if (evaluations.size >= MAX_EVALUATIONS) throw failure('fixture pending evaluation limit exceeded');
  const context = params.contextId === undefined ? createContext(session.target) : contexts.get(params.contextId);
  if (!context?.live || context.target !== session.target) throw failure('execution context does not belong to this live target');
  if (typeof params.expression !== 'string' || Buffer.byteLength(params.expression) > MAX_FRAME - 1024) throw failure('invalid fixture evaluation source');
  const evaluation = { request, context, timer: undefined, settled: false, finish(value, error) {
    if (this.settled) return;
    this.settled = true; clearTimeout(this.timer); evaluations.delete(request.id);
    if (error) response(request, undefined, error);
    else {
      try {
        // Serialize only by-value results: no remote object emulation.
        const remote = value === undefined ? { type: 'undefined' }
          : { type: value === null ? 'object' : typeof value, value: JSON.parse(JSON.stringify(value)) };
        response(request, { result: remote });
      } catch (failure) { response(request, undefined, failure); }
    }
  } };
  evaluations.set(request.id, evaluation);
  evaluation.timer = setTimeout(() => evaluation.finish(undefined, failure('fixture asynchronous evaluation deadline expired')), EVALUATION_TIMEOUT);
  try {
    const value = vm.runInContext(params.expression, context.sandbox, { timeout: 1000, displayErrors: true });
    // Never await inline in the stdin decoder: __rpcReceive must be evaluated
    // while activate() is awaiting its real binding request.
    if (params.awaitPromise) Promise.resolve(value).then(value => evaluation.finish(value), error => evaluation.finish(undefined, error));
    else evaluation.finish(value);
  } catch (error) { evaluation.finish(undefined, error); }
}

function inspect(params) {
  const keys = params?.keys ?? [];
  if (!Array.isArray(keys) || keys.length > 16 || keys.some(key => typeof key !== 'string' || key.length > 128)) throw failure('invalid fixture inspection keys');
  return {
    targets: [...targets.values()].map(targetInfo),
    sessions: [...sessions.values()].map(session => ({ id: session.id, targetId: session.target.id, scripts: session.scripts.size, bindings: session.bindings.size })),
    contexts: [...contexts.values()].map(context => ({ id: context.id, targetId: context.target.id, name: context.name, epoch: context.target.epoch,
      globals: Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(context.sandbox, key)).map(key => [key, context.sandbox[key]])),
      plugins: vm.runInContext('globalThis.__codletRendererV1?.status() ?? []', context.sandbox, { timeout: 1000 }),
      bindings: [...context.bindings.keys()], timers: context.timers.size,
    })),
    evaluations: evaluations.size, heldAttachments: heldAttachments.size, methods: Object.fromEntries(methods), trace,
  };
}

function handle(request) {
  if (!object(request) || !positive(request.id) || typeof request.method !== 'string' || evaluations.has(request.id)) throw failure('invalid fixture CDP request');
  const params = request.params ?? {};
  if (!object(params)) throw failure('fixture CDP params must be an object');
  methods.set(request.method, (methods.get(request.method) ?? 0) + 1);
  if (methods.size > 64) throw failure('fixture method limit exceeded');
  if (trace.length === MAX_TRACE) trace.shift();
  trace.push({ method: request.method, sessionId: request.sessionId ?? null, contextId: params.contextId ?? null });
  let result;
  switch (request.method) {
    case 'Target.setDiscoverTargets': discover = params.discover === true; result = {}; break;
    case 'Target.getTargets': result = { targetInfos: [...targets.values()].map(targetInfo) }; break;
    case 'Target.attachToTarget': {
      if (params.flatten !== true || sessions.size >= sessionLimit) throw failure('fixture requires bounded flattened sessions');
      const target = requireTarget(params.targetId), id = `vm-session-${nextSession++}`;
      sessions.set(id, { id, target, runtime: false, bindings: new Map(), scripts: new Map() });
      result = { sessionId: id };
      if (holdNextAttachment) {
        holdNextAttachment = false;
        if (heldAttachments.size >= 4) throw failure('fixture delayed attachment limit exceeded');
        heldAttachments.set(request.id, { request, result });
        return;
      }
      break;
    }
    case 'Target.detachFromTarget': {
      const session = sessions.get(params.sessionId); if (!session) throw failure('unknown detached session');
      detach(session); result = {}; break;
    }
    case 'Runtime.enable': {
      const session = requireSession(request); session.runtime = true;
      for (const context of contexts.values()) if (context.target === session.target) event('Runtime.executionContextCreated', { context: contextDescription(context) }, session.id);
      result = {}; break;
    }
    case 'Page.enable': requireSession(request); result = {}; break;
    case 'Page.getFrameTree': {
      const { target } = requireSession(request); result = { frameTree: { frame: { id: target.frameId, url: target.url } } }; break;
    }
    case 'Page.createIsolatedWorld': {
      const { target } = requireSession(request);
      if (params.frameId !== target.frameId || typeof params.worldName !== 'string') throw failure('invalid fixture isolated world');
      result = { executionContextId: createContext(target, params.worldName).id }; break;
    }
    case 'Runtime.addBinding': {
      const session = requireSession(request);
      if (session.bindings.size >= MAX_BINDINGS || typeof params.name !== 'string') throw failure('fixture binding limit exceeded');
      const binding = { name: params.name, world: params.executionContextName, contextId: params.executionContextId };
      session.bindings.set(binding.name, binding);
      for (const context of contexts.values()) if (context.target === session.target) installBinding(session, context, binding);
      result = {}; break;
    }
    case 'Runtime.removeBinding': removeBinding(requireSession(request), params.name); result = {}; break;
    case 'Page.addScriptToEvaluateOnNewDocument': {
      const session = requireSession(request);
      if (session.scripts.size >= MAX_SCRIPTS || typeof params.source !== 'string') throw failure('fixture script limit exceeded');
      const identifier = `vm-script-${nextScript++}`;
      session.scripts.set(identifier, { source: params.source, world: params.worldName ?? '' });
      result = { identifier }; break;
    }
    case 'Page.removeScriptToEvaluateOnNewDocument': requireSession(request).scripts.delete(params.identifier); result = {}; break;
    case 'Runtime.evaluate': return beginEvaluation(request, requireSession(request), params);
    case 'Fixture.inspect': result = inspect(params); break;
    case 'Fixture.holdNextAttach': holdNextAttachment = true; result = {}; break;
    case 'Fixture.sessionLimit': {
      if (!Number.isInteger(params.value) || params.value < MAX_SESSIONS || params.value > 128) throw failure('invalid fixture session limit');
      sessionLimit = params.value; result = {}; break;
    }
    case 'Fixture.releaseAttaches': {
      const held = [...heldAttachments.values()]; heldAttachments.clear();
      for (const { request, result } of held) response(request, result);
      result = { released: held.length }; break;
    }
    case 'Fixture.navigate': { const target = requireTarget(params.targetId); navigate(target); result = { epoch: target.epoch }; break; }
    case 'Fixture.destroyTarget': {
      const target = requireTarget(params.targetId);
      for (const context of [...contexts.values()]) if (context.target === target) retireContext(context);
      for (const session of [...sessions.values()]) if (session.target === target) detach(session);
      targets.delete(target.id); event('Target.targetDestroyed', { targetId: target.id }); result = {}; break;
    }
    case 'Fixture.addTarget': result = targetInfo(addTarget(params.targetId)); break;
    case 'Fixture.ping': result = { alive: true }; break;
    default: throw failure(`unsupported fixture CDP method ${request.method}`);
  }
  response(request, result);
}

function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const context of [...contexts.values()]) retireContext(context);
  for (const evaluation of evaluations.values()) clearTimeout(evaluation.timer);
  evaluations.clear(); heldAttachments.clear(); sessions.clear(); targets.clear();
}
function fatal(error) { log(error.stack ?? error); stop(); process.exit(1); }

addTarget('window-a'); addTarget('window-b');
process.stdin.on('data', chunk => {
  try {
    partial = Buffer.concat([partial, chunk]);
    let end;
    while ((end = partial.indexOf(0)) !== -1) {
      if (end < 1 || end >= MAX_FRAME) throw failure('fixture input frame bound exceeded');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(partial.subarray(0, end));
      partial = partial.subarray(end + 1);
      const request = JSON.parse(source);
      try { handle(request); } catch (error) { response(request, undefined, error); }
    }
    if (partial.length >= MAX_FRAME) throw failure('fixture partial frame bound exceeded');
  } catch (error) { fatal(error); }
});
process.stdin.on('end', () => { stop(); process.exit(0); });
process.stdin.on('error', fatal); process.stdout.on('error', fatal);
process.on('uncaughtException', fatal); process.on('unhandledRejection', fatal);
