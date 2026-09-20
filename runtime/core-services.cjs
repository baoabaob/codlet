'use strict';

// Shared Host/renderer SDK facade. The caller supplies the authenticated Core
// request transport; this module does not grant permissions or retain secrets.
function createCoreServicesRuntime({ request, rootSignal, detach }) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  if (!rootSignal || typeof rootSignal.addEventListener !== 'function'
    || typeof rootSignal.removeEventListener !== 'function'
    || typeof rootSignal.aborted !== 'boolean') {
    throw new TypeError('rootSignal must be an AbortSignal');
  }
  if (typeof detach !== 'function') throw new TypeError('detach must be a function');

  const runners = new Map();
  let closed = false;

  function combinedOptions(options) {
    options ??= {};
    if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('request options must be an object');
    const signal = options.signal;
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      throw new TypeError('signal must be an AbortSignal');
    }
    return { ...options, signal: signal ? AbortSignal.any([rootSignal, signal]) : rootSignal };
  }

  function call(method, params, options) {
    if (closed || rootSignal.aborted) {
      return Promise.reject(rootSignal.reason ?? Object.assign(new Error('Core services are closed'), { code: 'resource_closed' }));
    }
    return Promise.resolve().then(() => request(method, params, combinedOptions(options)));
  }

  const nullary = method => options => call(method, null, options);
  const unary = method => (params, options) => call(method, params, options);
  const optional = (method, fallback) => (params = fallback, options) => call(method, params, options);

  const storage = Object.freeze({
    snapshot: nullary('storage.snapshot'),
    get: unary('storage.get'),
    transaction: unary('storage.transaction'),
    changes: unary('storage.changes'),
    directories: nullary('storage.directories'),
    clearCache: nullary('storage.clearCache'),
  });
  const credentials = Object.freeze({
    list: optional('credentials.list', null),
    metadata: unary('credentials.metadata'),
    put: unary('credentials.put'),
    remove: unary('credentials.remove'),
  });
  const events = Object.freeze({
    createTopic: unary('events.createTopic'),
    publish: unary('events.publish'),
    subscribe: unary('events.subscribe'),
    read: unary('events.read'),
    ack: unary('events.ack'),
    close: unary('events.close'),
  });
  const files = Object.freeze({
    openDialog: optional('files.openDialog', {}),
    saveDialog: optional('files.saveDialog', {}),
    dialogStatus: unary('files.dialogStatus'),
    cancelDialog: unary('files.cancelDialog'),
    release: unary('files.release'),
    read: unary('files.read'),
    stat: unary('files.stat'),
    readDir: unary('files.readDir'),
    writeAtomic: unary('files.writeAtomic'),
    mkdir: unary('files.mkdir'),
    remove: unary('files.remove'),
    watch: unary('files.watch'),
    changes: unary('files.changes'),
    unwatch: unary('files.unwatch'),
  });
  const network = Object.freeze({
    profiles: optional('network.profiles', {}),
    createProfile: unary('network.createProfile'),
    resolve: unary('network.resolve'),
    closeProfile: unary('network.closeProfile'),
    status: optional('network.status', {}),
    fetch: unary('network.fetch'),
  });
  const desktop = Object.freeze({
    notify: unary('desktop.notify'),
    dismissNotification: unary('desktop.dismissNotification'),
    notificationEvents: optional('desktop.notificationEvents', {}),
    clipboardRead: optional('desktop.clipboardRead', {}),
    clipboardWrite: unary('desktop.clipboardWrite'),
    registerShortcut: unary('desktop.registerShortcut'),
    unregisterShortcut: unary('desktop.unregisterShortcut'),
    shortcutEvents: optional('desktop.shortcutEvents', {}),
  });
  const resources = Object.freeze({ list: optional('resources.list', {}) });
  const diagnostics = Object.freeze({ read: optional('diagnostics.read', {}) });

  function byteArray(value) {
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return [...value];
    if (typeof value === 'string') {
      let binary;
      if (typeof Buffer === 'function') {
        const bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) throw new TypeError('bytes is not canonical base64');
        return Array.from(bytes);
      }
      try { binary = atob(value); } catch { throw new TypeError('bytes is not valid base64'); }
      return Array.from(binary, character => character.charCodeAt(0));
    }
    throw new TypeError('bytes must be Uint8Array, a byte array, or base64 text');
  }

  const processApi = {
    start: unary('processes.spawn'),
    status: unary('processes.status'),
    read: unary('processes.read'),
    write(params, options) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('process write parameters must be an object');
      return call('processes.write', { ...params, bytes: byteArray(params.bytes) }, options);
    },
    endInput: unary('processes.endInput'),
    terminate: unary('processes.terminate'),
    wait: unary('processes.wait'),
    close: unary('processes.close'),
  };

  function callbackFailure(reason) {
    return {
      code: String(reason?.code || 'task_callback_failed').slice(0, 256),
      message: String(reason?.message || reason || 'task callback failed').slice(0, 4096),
    };
  }

  function detached(callback) {
    try { return Promise.resolve(detach(callback)); }
    catch (failure) { return Promise.reject(failure); }
  }

  async function finishClaim(state, claimed, outcome) {
    if (state.stopped || rootSignal.aborted) return;
    try {
      await call('tasks.finish', { task: claimed.task, claim: claimed.claim, ...outcome });
    } catch {
      // Core owns the immutable terminal state. A late finish can legitimately
      // lose to timeout, cancellation, unregister, revoke or generation retire.
    }
  }

  function acknowledgedCancellation(active, failure) {
    return active.cancellation
      && (failure === active.controller.signal.reason || failure?.name === 'AbortError');
  }

  async function executeClaim(state, claimed) {
    const controller = new AbortController();
    const active = { controller, cancellation: false, finished: false };
    state.active.set(claimed.task, active);
    const remaining = Math.max(0, Math.min(Number(claimed.remainingMs) || 0, 24 * 60 * 60 * 1000));
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('task deadline elapsed'), { code: 'task_timeout' })), remaining);
    const invocation = Object.freeze({
      task: claimed.task,
      signal: controller.signal,
      remainingMs: () => Math.max(0, Number(claimed.deadlineAt) - Date.now()),
      progress(value) {
        if (active.finished || controller.signal.aborted) return Promise.reject(controller.signal.reason ?? new Error('task callback ended'));
        return call('tasks.progress', { task: claimed.task, claim: claimed.claim, progress: value });
      },
    });
    try {
      const result = await state.callback(claimed.input, invocation);
      // Cancellation is cooperative. A callback that observes the signal but
      // still completes may already have committed its work, so preserve its
      // successful outcome and let Core reject a late terminal transition.
      await finishClaim(state, claimed, { state: 'succeeded', result });
    } catch (failure) {
      if (acknowledgedCancellation(active, failure)) {
        await finishClaim(state, claimed, { state: 'cancelled', error: { code: 'cancelled' } });
      } else {
        await finishClaim(state, claimed, { state: 'failed', error: callbackFailure(failure) });
      }
    } finally {
      active.finished = true;
      clearTimeout(timer);
      state.active.delete(claimed.task);
    }
  }

  async function runnerLoop(state) {
    let failures = 0;
    while (!state.stopped && !closed && !rootSignal.aborted) {
      let batch;
      try {
        batch = await call('tasks.claim', { runner: state.runner, limit: 4, waitMs: 1000 });
        failures = 0;
      } catch {
        if (++failures >= 3 || state.stopped || closed || rootSignal.aborted) break;
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      for (const cancellation of batch?.cancellations ?? []) {
        const active = state.active.get(cancellation.task);
        if (active && !active.finished) {
          active.cancellation = true;
          if (!active.controller.signal.aborted) active.controller.abort(Object.assign(new Error('task was cancelled'), { code: 'task_cancelled' }));
        }
      }
      for (const claimed of batch?.tasks ?? []) {
        if (state.stopped || closed || rootSignal.aborted) break;
        detached(() => executeClaim(state, claimed)).catch(() => {});
      }
    }
    if (!state.stopped && !closed && !rootSignal.aborted) await closeRunner(state);
  }

  async function closeRunner(state, unregister = true) {
    if (state.stopped) return { unregistered: true };
    state.stopped = true;
    runners.delete(state.runner);
    for (const active of state.active.values()) {
      if (!active.controller.signal.aborted) active.controller.abort(Object.assign(new Error('task runner closed'), { code: 'runner_retired' }));
    }
    if (!unregister) return { unregistered: true };
    try { return await call('tasks.unregister', { runner: state.runner }); }
    catch { return { unregistered: false }; }
  }

  const tasks = Object.freeze({
    async register(name, callback, options) {
      if (typeof name !== 'string' || typeof callback !== 'function') throw new TypeError('task runner name and callback are required');
      const registered = await call('tasks.register', { name }, options);
      const state = { runner: registered.runner, callback, active: new Map(), stopped: false };
      runners.set(state.runner, state);
      detached(() => runnerLoop(state)).catch(() => {});
      return Object.freeze({
        runner: state.runner,
        start(params, startOptions) {
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('task start parameters must be an object');
          return call('tasks.start', { ...params, runner: state.runner }, startOptions);
        },
        close: () => closeRunner(state),
      });
    },
    start: unary('tasks.start'),
    get: unary('tasks.get'),
    result: unary('tasks.result'),
    cancel: unary('tasks.cancel'),
    list: optional('tasks.list', {}),
  });

  async function close() {
    if (closed) return { closed: true };
    const states = [...runners.values()];
    await Promise.allSettled(states.map(state => closeRunner(state)));
    closed = true;
    rootSignal.removeEventListener('abort', onRootAbort);
    return { closed: true };
  }
  function onRootAbort() {
    // The transport may already be shutting down. Abort callbacks immediately,
    // then issue best-effort unregistration without creating unhandled rejections.
    for (const state of [...runners.values()]) {
      state.stopped = true;
      runners.delete(state.runner);
      for (const active of state.active.values()) {
        if (!active.controller.signal.aborted) active.controller.abort(rootSignal.reason);
      }
      try {
        Promise.resolve(request('tasks.unregister', { runner: state.runner }, { timeoutMs: 1000 })).catch(() => {});
      } catch {}
    }
    closed = true;
  }
  rootSignal.addEventListener('abort', onRootAbort, { once: true });
  if (rootSignal.aborted) onRootAbort();

  return Object.freeze({
    storage, credentials, events, files, tasks,
    processes: Object.freeze(processApi),
    network, desktop, resources, diagnostics, close,
  });
}

module.exports = { createCoreServicesRuntime };
