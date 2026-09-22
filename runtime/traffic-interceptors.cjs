'use strict';

// Core-owned dispatch. Principals, their abort signals, and authorization come
// from the owner, never from renderer/plugin-supplied registration options.
// Public Host registration is authenticated by Native before reaching this layer.
function createTrafficInterceptors({ authorize, rootSignal, networkProfile }) {
  if (typeof authorize !== 'function' || !rootSignal) throw new TypeError('trusted authorization and lifecycle are required');
  const hooks = new Map(), active = new Set();
  const failure = code => Object.assign(new Error(code), { code });
  const sensitive = name => !['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-encoding', 'content-length', 'cache-control', 'user-agent'].includes(name.toLowerCase());
  const origin = value => { const url = new URL(value); if (url.protocol === 'ws:') url.protocol = 'http:'; if (url.protocol === 'wss:') url.protocol = 'https:'; return url.origin; };
  const fields = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure('invalid_decision');
  };
  const ordered = () => [...hooks.values()].sort((a, b) => a.priority - b.priority || (a.owner.pluginId < b.owner.pluginId ? -1 : a.owner.pluginId > b.owner.pluginId ? 1 : 0) || a.sequence - b.sequence);
  let sequence = 0, retired = false;
  const requireLive = () => { if (retired || rootSignal.aborted) throw failure('interceptors_retired'); };
  function register(owner, options, callbacks) {
    requireLive(); fields(options, ['id', 'origins', 'priority', 'timeoutMs']); fields(callbacks, ['request', 'response', 'webSocket']);
    if (!owner || typeof owner.pluginId !== 'string' || !Number.isSafeInteger(owner.generation) || !owner.signal || owner.signal.aborted) throw failure('invalid_owner');
    if (typeof options.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/u.test(options.id) || !Array.isArray(options.origins) || !options.origins.length || options.origins.length > 64) throw failure('invalid_registration');
    if (!Object.values(callbacks).length || Object.values(callbacks).some(value => typeof value !== 'function')) throw failure('invalid_registration');
    const origins = new Set(options.origins.map(value => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/` || url.username || url.password) throw failure('invalid_registration'); return url.origin; }));
    const priority = options.priority ?? 0, timeoutMs = options.timeoutMs ?? 1000;
    if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw failure('invalid_registration');
    const key = `${owner.pluginId}:${owner.generation}:${options.id}`;
    if (hooks.has(key) || hooks.size >= 32) throw failure('interceptor_limit');
    const hook = { owner, key, origins, priority, timeoutMs, callbacks: { ...callbacks }, sequence: ++sequence, alive: true, enabled: true };
    function dispose() {
      if (!hook.alive) return;
      hook.alive = false; hooks.delete(key); owner.signal.removeEventListener('abort', dispose);
      for (const item of active) if (item.selected.includes(hook)) item.exchange.cancel();
    }
    hook.dispose = dispose; hooks.set(key, hook); owner.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ dispose, setEnabled(value) {
      requireLive(); if (!hook.alive || typeof value !== 'boolean') throw failure('invalid_registration');
      hook.enabled = value;
      if (!value) for (const item of active) if (item.selected.includes(hook)) item.exchange.cancel();
    } });
  }
  async function bounded(hook, item, operation) {
    const signal = item.exchange.signal;
    if (!hook.alive || !hook.enabled || signal.aborted) throw failure('interceptor_retired');
    let timer, abort;
    try {
      const result = await new Promise((resolve, reject) => {
        abort = () => reject(failure('interceptor_retired'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { reject(failure('interceptor_timeout')); item.exchange.cancel(); }, hook.timeoutMs);
        Promise.resolve().then(operation).then(resolve, () => reject(failure('interceptor_failed')));
      });
      if (!hook.alive || !hook.enabled || signal.aborted) throw failure('interceptor_retired');
      return result;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async function access(hook, item, action, url) {
    return bounded(hook, item, () => authorize(hook.owner, action, url, item.exchange.signal));
  }
  async function check(hook, item, url) {
    if (!await access(hook, item, 'intercept', url)) throw failure('permission_denied');
    return !!await access(hook, item, 'sensitiveHeaders', url);
  }
  function view(value, privileged) {
    return Object.freeze({ ...value, ...(value.protocols && !privileged ? { protocols: Object.freeze([]) } : {}), headers: Object.freeze((value.headers ?? []).filter(([name]) => privileged || !sensitive(name)).map(pair => Object.freeze([...pair]))) });
  }
  function headers(value, previous, privileged) {
    if (!Array.isArray(value) || value.length > 128 || value.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== 'string'))) throw failure('invalid_decision');
    if (privileged) return value;
    if (value.some(([name]) => sensitive(name))) throw failure('permission_denied');
    return [...value, ...(previous ?? []).filter(([name]) => sensitive(name))];
  }
  function begin(request, exchange) {
    requireLive();
    if (!request.url || typeof exchange.cancel !== 'function') throw failure('ingress_required');
    if (active.size >= 4) throw failure('interceptor_busy');
    const selected = ordered().filter(hook => hook.enabled && hook.origins.has(origin(request.url)));
    const item = { selected, exchange };
    const done = () => { active.delete(item); exchange.signal.removeEventListener('abort', done); };
    active.add(item); exchange.signal.addEventListener('abort', done, { once: true });
    if (exchange.signal.aborted) { done(); throw failure('interceptor_retired'); }
    return item;
  }
  async function updateRequest(hook, item, request, update, privileged) {
    fields(update, ['url', 'method', 'headers', 'body']);
    let next = { ...request, ...update };
    if (update.headers !== undefined) next.headers = headers(update.headers, request.headers, privileged);
    if (origin(next.url) !== origin(request.url)) {
      if (!await access(hook, item, 'redirect', next.url)) throw failure('permission_denied');
      // Both registry and ingress enforce credential stripping independently.
      next.headers = (next.headers ?? []).filter(([name]) => ['accept', 'content-type', 'content-encoding'].includes(name.toLowerCase()));
    }
    const url = new URL(next.url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw failure('invalid_decision');
    if (url.protocol.startsWith('ws') !== new URL(request.url).protocol.startsWith('ws')) throw failure('invalid_decision');
    return next;
  }
  async function http(request, exchange) {
    const item = begin(request, exchange), participated = [];
    let current = request, response;
    try {
      for (const hook of item.selected) {
        // An earlier rewrite never expands a later plugin's observation scope.
        if (!hook.origins.has(origin(current.url))) continue;
        const privileged = await check(hook, item, current.url);
        participated.push({ hook, privileged, url: current.url });
        if (!hook.callbacks.request) continue;
        const decision = await bounded(hook, item, () => hook.callbacks.request(view(current, privileged), Object.freeze({ signal: exchange.signal })));
        if (decision == null) continue;
        fields(decision, ['request', 'respond', 'block']);
        if (Object.keys(decision).length !== 1) throw failure('invalid_decision');
        if (decision.block === true) { response = { status: 403, body: 'blocked_by_interceptor' }; break; }
        if (decision.respond !== undefined) {
          fields(decision.respond, ['status', 'headers', 'body']);
          response = { ...decision.respond, ...(decision.respond.headers === undefined ? {} : { headers: headers(decision.respond.headers, [], privileged) }) };
          break;
        }
        if (!decision.request) throw failure('invalid_decision');
        current = await updateRequest(hook, item, current, decision.request, privileged);
      }
      const source = response === undefined ? 'upstream' : 'synthetic';
      response ??= await exchange.forward({ url: current.url, method: current.method, headers: current.headers, body: ['GET', 'HEAD'].includes(current.method) ? undefined : current.body, ...(networkProfile ? { networkProfile } : {}) });
      for (const { hook } of participated.reverse()) {
        if (!hook.callbacks.response || !hook.origins.has(origin(current.url))) continue;
        const privileged = await check(hook, item, current.url);
        const update = await bounded(hook, item, () => hook.callbacks.response(view(response, privileged), Object.freeze({ signal: exchange.signal, source, request: Object.freeze({ id: request.id, url: current.url, method: current.method }) })));
        if (update == null) continue;
        fields(update, ['status', 'headers', 'body']);
        response = { ...response, ...update, ...(update.headers === undefined ? {} : { headers: headers(update.headers, response.headers, privileged) }) };
      }
      return response;
    } catch (error) {
      // The ingress retires the exchange after rendering the failure status.
      // Aborting here races that error and changes a denial into a generic 502.
      throw error;
    }
  }
  async function webSocket(request, exchange) {
    const item = begin(request, exchange), transforms = [];
    let current = { ...request, method: 'GET' };
    try {
      for (const hook of item.selected) {
        if (!hook.origins.has(origin(current.url)) || !hook.callbacks.webSocket) continue;
        const privileged = await check(hook, item, current.url);
        const decision = await bounded(hook, item, () => hook.callbacks.webSocket(view(current, privileged), Object.freeze({ signal: exchange.signal })));
        if (decision == null) continue;
        fields(decision, ['request', 'block', 'clientToServer', 'serverToClient']);
        if (decision.block === true) throw failure('permission_denied');
        const observedUrl = current.url;
        if (decision.request) { fields(decision.request, ['url', 'headers']); current = await updateRequest(hook, item, current, decision.request, privileged); }
        for (const direction of ['clientToServer', 'serverToClient']) if (decision[direction] != null && typeof decision[direction] !== 'function') throw failure('invalid_decision');
        transforms.push({ hook, url: observedUrl, ...decision });
      }
      const transform = direction => async (frame, context) => {
        let value = frame;
        const chain = direction === 'clientToServer' ? transforms : [...transforms].reverse();
        for (const entry of chain) if (entry[direction] && value != null && entry.hook.origins.has(origin(current.url))) {
          await check(entry.hook, item, current.url);
          value = await bounded(entry.hook, item, () => entry[direction](value, context));
          if (typeof value === 'string') value = { data: value, binary: false };
          else if (value instanceof Uint8Array) value = { data: value, binary: true };
          if (value != null && (typeof value.binary !== 'boolean' || (value.binary ? !(value.data instanceof Uint8Array) : typeof value.data !== 'string') || Buffer.byteLength(value.data) > 8 * 1024 * 1024)) throw failure('invalid_decision');
        }
        return value;
      };
      return await exchange.forward({ url: current.url, headers: current.headers, protocols: origin(current.url) === origin(request.url) ? request.protocols : [], clientToServer: transform('clientToServer'), serverToClient: transform('serverToClient'), ...(networkProfile ? { networkProfile } : {}) });
    } catch (error) { throw error; }
  }
  function close() {
    if (retired) return;
    retired = true; rootSignal.removeEventListener('abort', close);
    for (const hook of [...hooks.values()]) hook.dispose();
    for (const item of active) item.exchange.cancel();
  }
  rootSignal.addEventListener('abort', close, { once: true });
  return Object.freeze({ register, handlers: Object.freeze({ http, webSocket }), close, status: () => ({ registered: hooks.size, active: active.size, retired }) });
}
module.exports = { createTrafficInterceptors };
