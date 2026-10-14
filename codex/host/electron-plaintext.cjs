'use strict';
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');

// Private symbols are specific to source-reviewed Owl builds. The hashes
// guard every append; a new build needs a new inspected profile.
const PROFILES = Object.freeze({
  'bootstrap-D2PJMYEh.js': { hash: '0d62d7be4491d5ef84d93ea9b753c270096de217f2e49064e5f8f701af53e9ed', kind: 'bootstrap', symbol: 'He' },
  'main-DAwJoFgo.js': { hash: '18beea7d7e46866168528ff5dab5108ffe6d39fc13433367ce8dee7b187044f8', kind: 'main', symbol: 'kEe' },
  'application-network-startup-CY4ZWOz-.js': { hash: '7936a5b6373be818c7cce78cad7c18e4e156c8400d3b16f5b440d2626a1cc661', kind: 'stdio', symbol: '$s' },
  'src-BSSLXJxP.js': { hash: '50c7cf9c144594cfa6f33298e977f0b144976cc70c579f59fdc7242615c4af98', kind: 'connection', symbol: 'Yh' },
  'bootstrap-CiIGnI3y.js': { hash: '119bb54ee12ed5d2b0d3b98dd068a4322232a4aa342323eb9cb5dfa6575ca158', kind: 'bootstrap', symbol: 'Nt' },
  'main-BR_2NHW6.js': { hash: '1f2b91cf92fc023fb2fa41e1c1d03698fa6e37354ecd07dd0cebd21337607b08', kind: 'main', symbol: 'ZTe' },
  'bootstrap-DK4EfNwt.js': { hash: 'dbdbdd3ef5dde93dd196a59846edf244dc653341213e0fd45eebb133b5df10ba', kind: 'bootstrap', symbol: 'Pt' },
  'main-LM8MUIFp.js': { hash: 'c71bf3ffecef5fd390b4cd16d120d39dce30d30bffe3c563c8c74c1b691da018', kind: 'main', symbol: 'wEe' },
  'src-C3YaUE83.js': { hash: '14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472', kind: 'src', symbol: 'mQ', managerExport: 'un' },
  'bootstrap-DwqRMhlU.js': { hash: '79ad86bda1f6171d43bab09b1b4a5d379afefc07a13d6f4f58470a823f6f575f', kind: 'bootstrap', symbol: 'Nt' },
  'main-Bx5zswAj.js': { hash: '610ea8b045f207360ac50fcccfe43ca896c6298fa75562f323f1a45ed2364a1b', kind: 'main', symbol: 'ZTe' },
  'src-mOb8On4V.js': { hash: '0639e87d51c132a7440bfa06624fb8e99031a3bb331ae11577278ce4a515cbb4', kind: 'src', symbol: 'Pq', managerExport: 'un' },
  'bootstrap-C4dRql4x.js': { hash: '0757af0981f4552ca79ed1a364eafa6a73e71a92e65ea4fce747c7b6c715ed4a', kind: 'bootstrap', symbol: 'Nt' },
  'main-C-Mhak1n.js': { hash: '457c79be69620d4489e94c14ac665f81731d869635606dcf175b7b4cc2e8b467', kind: 'main', symbol: 'ZTe' },
  'src-DldfpmrL.js': { hash: '88ec69722b5d87a7081edf2e2d6a2e21c3f25300cee587363d74b8b87969a412', kind: 'src', symbol: 'WQ', managerExport: 'un' },
  'bootstrap-CYu4H4X5.js': { hash: '9b9d3c9e8312dba970daf31fd3950b3f2bd760a89e1d7bf480c4efefb3d2b102', kind: 'bootstrap', symbol: 'yY', connectionSymbol: 'ON' },
  'main-Dn18kdv3.js': { hash: '447e4900075d8cb41f5c55f1728c20147ea23ab761bb4377348eea8c8f3d4a48', kind: 'main', symbol: 'Dce' },
  'application-network-startup-DN7Ktmlk.js': { hash: '3c2ebf430f24e55975f81e95b33e0f71470d04886f229b935939a7e32c587cf0', kind: 'stdio', symbol: 'Hs' },
  'bootstrap-CZlEGA2m.js': { hash: '343072f02e604fe06f7864a72b1cbcc6004a8a318c66982995a188ee97430a3b', kind: 'bootstrap', symbol: 'vY', connectionSymbol: 'DN' },
  'main-C_jM0dPl.js': { hash: 'd940b7ba89557a640cf23967c60555fa2a2344d6899807478c69ffc304314302', kind: 'main', symbol: 'kce' },
  'application-network-startup-ouXbhtc5.js': { hash: 'e92e5333cc38b06c6e94242d5bb680321f044bc9355013739d059a2d3e2f5b8d', kind: 'stdio', symbol: 'Hs' },
  // Windows 26.930.7945.0 / frontend 26.930.61225: reviewed native methods
  // retain the ApplicationNetwork, final fetch, stdio and notification contracts.
  'bootstrap-C8gUBg5L.js': { hash: '1f726d0e3103d81501551546d3b6e70f1fc10646f9326e00fe68605f144c5f4f', kind: 'bootstrap', symbol: 'yY', connectionSymbol: 'ON' },
  'main-gtVueRkt.js': { hash: 'a4b72dcd241e8ee360aa960442cc585aa822685a42efd056c760937d9f8b623e', kind: 'main', symbol: 'kce' },
  'application-network-startup-BEAX-hka.js': { hash: '634382c7af55d0ff57eb028aa4dd904130215c44fb559ea90a4f4035a5419f6e', kind: 'stdio', symbol: 'Hs' },
  // Windows 26.1002.7124.0 / frontend 26.1002.52244 / build 13536:
  // reviewed live bindings retain policy checks, final fetch, stdio and account notifications.
  'bootstrap-Dz9A8y86.js': { hash: 'a70497f5ffa764fe74f4de7ac05a5f73aff8d1e2f44de4476d1d9a684af43ddd', kind: 'bootstrap', symbol: 'jY', connectionSymbol: 'hN' },
  'main-p91kJShj.js': { hash: 'aafd6a750458cb39b6202f9be00231482122d32ac14017b79d544c4ab741e889', kind: 'main', symbol: 'Hb' },
  'application-network-startup-Bt0a8E1L.js': { hash: 'aa5478e31c8a623632dfedffcecfbe40d5033d38a8504649716657681a0840b4', kind: 'stdio', symbol: 'Hs' },
  // Windows package 26.1007.9446.0 / frontend 26.1007.71326 / build 20398.
  // Exact source review and local extracted-method probes are recorded in
  // docs/native-source-26.1007.9446.0.json; Native acceptance is separate.
  'bootstrap-iULMfRBf.js': { hash: '385e3885eda6a2852d8e0b75d1d0b579ac06e27eb9b9300fa7e92d9b5216c869', kind: 'bootstrap', symbol: 'tr' },
  'main-Bgi5Xaw-.js': { hash: 'e8923725ad6357380ac7bb25818f78eb4d97e522ebbde2ddf6ff5a2a93032e54', kind: 'main', symbol: 'ple' },
  'application-network-startup-YSC7OAs0.js': { hash: '52f0be375fb08281e88ad41be64220fb73f85210523e53e7d7acf094fda6344e', kind: 'stdio', symbol: 'Gs' },
  'src-DCNiwad_.js': { hash: '86fb2066bbc2f7428864b76b46ef570b09eb1e92e81e9d6f089f5b048a66df25', kind: 'connection', symbol: 'mB' },
});
const HASHES = Object.freeze(Object.fromEntries(Object.entries(PROFILES).map(([name, profile]) => [name, profile.hash])));
const fail = code => Object.assign(new Error(code), { code });
const closeRoute = route => { try { Promise.resolve(route.close()).catch(() => {}); } catch {} };
function headers(value) {
  if (Array.isArray(value)) return value.flatMap(([name, item]) => (Array.isArray(item) ? item : [item]).map(part => [name, String(part)]));
  if (value && !(value instanceof Headers) && typeof value === 'object') return Object.entries(value).flatMap(([name, item]) => (Array.isArray(item) ? item : [item]).map(part => [name, String(part)]));
  const source = new Headers(value ?? {}), result = [...source.entries()].filter(([name]) => name.toLowerCase() !== 'set-cookie');
  for (const cookie of source.getSetCookie?.() ?? []) result.push(['set-cookie', cookie]);
  return result;
}
const sameOrigin = (left, right) => new URL(left).origin === new URL(right).origin;
const withoutCredentials = values => headers(values).filter(([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()));
function headerObject(values) {
  const result = Object.create(null);
  for (const [name, value] of values) {
    const key = Object.keys(result).find(existing => existing.toLowerCase() === name.toLowerCase()) ?? name;
    result[key] = result[key] === undefined ? value : Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
  }
  return result;
}
const requestBody = value => value == null ? undefined : typeof value === 'string' ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value;
const asUrl = value => typeof value === 'string' ? value : value instanceof URL ? value.href : value?.url;

async function bytes(body, signal) {
  if (body == null || typeof body === 'string' || body instanceof Uint8Array) return body;
  const chunks = []; let size = 0;
  for await (const chunk of body) { signal?.throwIfAborted(); size += chunk.length; if (size > 64 * 1024 * 1024) throw fail('desktop_body_too_large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function stream(body) {
  if (body == null || typeof body === 'string' || body instanceof Uint8Array) return body;
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) { try { const item = await iterator.next(); item.done ? controller.close() : controller.enqueue(item.value); } catch (error) { controller.error(error); } },
    cancel() { body.cancel?.(); iterator.return?.(); },
  });
}
const bodyless = (status, method) => [204, 205, 304].includes(status) || method?.toUpperCase() === 'HEAD';
async function response(result, method) {
  const options = { status: result.status, headers: result.headers };
  if (bodyless(result.status, method)) {
    await result.body?.cancel?.();
    return new Response(null, options);
  }
  return new Response(stream(result.body), options);
}
function providerUrl(value) {
  if (typeof value !== 'string') throw fail('backend_provider_unsupported');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('backend_provider_unsupported');
  return url.href;
}
function routedThreadMessage(message, reserve, isProviderSupported = () => true) {
  let payload; try { payload = JSON.parse(message); } catch { return message; }
  if (!['thread/start', 'thread/resume'].includes(payload?.method)) return message;
  const inputConfig = payload.params?.config;
  const selected = payload.params?.modelProvider ?? inputConfig?.model_provider;
  const inline = typeof selected === 'string' ? inputConfig?.[`model_providers.${selected}`] ?? inputConfig?.model_providers?.[selected] : null;
  if (typeof selected === 'string' && !isProviderSupported(selected) && typeof inline?.base_url !== 'string') throw fail('backend_provider_unsupported');
  if (!inputConfig || typeof inputConfig !== 'object' || Array.isArray(inputConfig)) return message;
  const config = { ...inputConfig }; let changed = false;
  for (const [key, value] of Object.entries(config)) {
    if (key === 'model_providers' && value && typeof value === 'object' && !Array.isArray(value)) {
      const mapped = { ...value };
      for (const [name, provider] of Object.entries(mapped)) if (provider && typeof provider === 'object' && typeof provider.base_url === 'string') {
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw fail('backend_provider_unsupported');
        mapped[name] = { ...provider, base_url: reserve(providerUrl(provider.base_url)) }; changed = true;
      }
      config[key] = mapped;
    } else if (/^model_providers\..*\.base_url$/u.test(key) && !/^model_providers\.[A-Za-z0-9_-]{1,64}\.base_url$/u.test(key)) throw fail('backend_provider_unsupported');
    else if (/^model_providers\..+$/u.test(key) && value && typeof value === 'object' && typeof value.base_url === 'string'
      && !/^model_providers\.[A-Za-z0-9_-]{1,64}$/u.test(key)) throw fail('backend_provider_unsupported');
    if (key === 'openai_base_url' || /^model_providers\.[A-Za-z0-9_-]{1,64}\.base_url$/u.test(key)) {
      config[key] = reserve(providerUrl(value)); changed = true;
    } else if (/^model_providers\.[A-Za-z0-9_-]{1,64}$/u.test(key) && value && typeof value === 'object' && typeof value.base_url === 'string') {
      config[key] = { ...value, base_url: reserve(providerUrl(value.base_url)) }; changed = true;
    }
  }
  return changed ? JSON.stringify({ ...payload, params: { ...payload.params, config } }) : message;
}

// Scope final ApplicationNetwork calls to the reviewed performDesktopFetch
// classes, after their auth, workspace policy and cancellation decisions.
function installDesktopPlaintext({ app }, { source, deadlineUnixMs, ownsBackendProcess = () => false, isProviderSupported = () => true,
  providerTrustForProcess = () => undefined,
  pendingAccountUpdate = () => null, updateAccountMode = () => {}, moduleRegistry, state, onlineUpdates }, { expectedHashes = HASHES } = {}) {
  if ((!moduleRegistry && app.isReady()) || !source?.interceptHttp) throw fail('desktop_bootstrap_too_late');
  const scope = state?.scope??new AsyncLocalStorage();
  if(state&&!state.scope)state.scope=scope;
  const symbol = Symbol('codlet.private.plaintext');
  const originalCompile = Module.prototype._compile;
  const deferredModules = new Set();
  let bootstrapVerified = false, mainVerified = false, srcVerified = false, fetchInstalled = false, requestInstalled = false,
    stdioVerified = false, connectionVerified = false, stdioInstalled = false, connectionInstalled = false, desktopReason = null, taskReason = null, mismatch = null, closed = false;
  const bindingErrors = Object.create(null);
  const restores = [];
  const taskRoutes = state?.taskRoutes??new Set(), routesByProcess = state?.routesByProcess??new WeakMap(), sendQueues = state?.sendQueues??new WeakMap();
  const tracked = (method, operation) => onlineUpdates ? onlineUpdates.run(method, operation) : operation();
  function reserve(url, proc) {
    let routes = routesByProcess.get(proc);
    if (!routes) {
      routes = new Map(); routesByProcess.set(proc, routes);
      proc.once('exit', () => { for (const route of routes.values()) { closeRoute(route); taskRoutes.delete(route); } routes.clear(); });
    }
    if (routes.has(url)) return routes.get(url);
    if (taskRoutes.size >= 64) throw fail('backend_route_limit');
    const additionalCaPem = providerTrustForProcess(proc);
    const route = source.reserveRoute({ upstreamBaseUrl: url, ...(additionalCaPem === undefined ? {} : { additionalCaPem }) });
    route.ready.catch(() => { routes.delete(url); taskRoutes.delete(route); closeRoute(route); });
    routes.set(url, route); taskRoutes.add(route);
    return route;
  }
  function failOutbound(connection, message) {
    let id; try { id = JSON.parse(message).id; } catch {}
    if (typeof id === 'string' || typeof id === 'number') queueMicrotask(() => connection.onmessage?.({ type: 'message',
      data: JSON.stringify({ id, error: { code: -32000, message: 'Provider route unavailable' } }) }));
    else connection.onerror?.(fail('backend_route_unavailable'));
  }
  function hookStdio(Stdio) {
    if (stdioInstalled || typeof Stdio !== 'function' || typeof Stdio.prototype.send !== 'function') { if (!stdioInstalled) taskReason = 'hook_unavailable'; return; }
    const original = Stdio.prototype.send;
    Stdio.prototype.send = function(message) {
      if (closed || !ownsBackendProcess(this.proc) || typeof message !== 'string') return original.call(this, message);
      if(onlineUpdates&&!onlineUpdates.accepting()) {
        onlineUpdates.whenAccepting().then(()=>Stdio.prototype.send.call(this,message)).catch(()=>failOutbound(this,message));return;
      }
      const waits = []; let routed;
      try { routed = routedThreadMessage(message, url => { const route = reserve(url, this.proc); waits.push(route.ready); return route.baseUrl; },
        provider => isProviderSupported(this.proc, provider)); }
      catch { failOutbound(this, message); return; }
      const account = pendingAccountUpdate(this.proc);
      const previous = sendQueues.get(this);
      const dispatch=()=>tracked('backend.send',()=>original.call(this,routed));
      if (!waits.length && !account && !previous) {
        if(!onlineUpdates)return original.call(this,routed);
        dispatch().catch(()=>failOutbound(this,message));return;
      }
      const operation = tracked('backend.send',async()=>{
        await (previous??Promise.resolve());await Promise.all([...waits,...(account?[account]:[])]);
        if (!closed && ownsBackendProcess(this.proc)) return original.call(this,routed);
        throw Object.assign(fail('core_write_owner_closed'),{outcome:'not_applied'});
      }).catch(() => failOutbound(this, message));
      sendQueues.set(this, operation);
      operation.finally(() => { if (sendQueues.get(this) === operation) sendQueues.delete(this); }).catch(() => {});
    };
    stdioInstalled = true;
    restores.push(() => { Stdio.prototype.send = original; });
  }
  function hookConnection(Connection) {
    if (connectionInstalled || typeof Connection !== 'function' || typeof Connection.prototype.routeIncomingMessage !== 'function') { if (!connectionInstalled) taskReason = 'hook_unavailable'; return; }
    const original = Connection.prototype.routeIncomingMessage;
    Connection.prototype.routeIncomingMessage = function(message, ...rest) {
      if (!closed && message?.method === 'account/updated' && ownsBackendProcess(this.connection?.proc)) updateAccountMode(this.connection.proc, message.params?.authMode);
      return original.call(this, message, ...rest);
    };
    connectionInstalled = true;
    restores.push(() => { Connection.prototype.routeIncomingMessage = original; });
  }
  function hookNetwork(Network) {
    if (typeof Network !== 'function' || typeof Network.prototype.fetch !== 'function' || typeof Network.prototype.request !== 'function') { desktopReason = 'hook_unavailable'; return; }
    const originalFetch = Network.prototype.fetch, originalRequest = Network.prototype.request;
    function nativeForward(network, request, options, signal, onRequest) {
      return new Promise((resolve, reject) => {
        let settled = false, finalUrl = request.url, redirects = 0, live;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve(value);
        };
        const abort = () => { finish(fail('desktop_request_aborted')); live?.abort(); };
        try {
          signal?.throwIfAborted();
          live = originalRequest.call(network, { ...options, url: request.url, method: request.method,
            headers: headerObject(headers(request.headers)) });
          onRequest?.(live);
          signal?.addEventListener('abort', abort, { once: true });
          live.on('redirect', (_status, _method, destination) => {
            try {
              if (options.redirect === 'error') throw fail('desktop_redirect_disallowed');
              if (options.redirect === 'manual') throw fail('desktop_manual_redirect_unavailable');
              if (++redirects > 20 || !['http:', 'https:'].includes(new URL(destination).protocol)) throw fail('desktop_redirect_disallowed');
              network.assertAllowed(destination);
              finalUrl = destination;
              // Electron requires this call during the event. The intermediate
              // response body is unavailable through ClientRequest.
              live.followRedirect();
            } catch (error) { finish(error); live.abort(); }
          });
          live.once('error', error => { signal?.removeEventListener('abort', abort); finish(error); });
          live.once('response', incoming => {
            incoming.once('end', () => signal?.removeEventListener('abort', abort));
            incoming.once('close', () => signal?.removeEventListener('abort', abort));
            finish(null, { status: incoming.statusCode, headers: headers(incoming.headers), body: incoming, finalUrl });
          });
          live.end(request.body == null || typeof request.body === 'string' ? request.body : Buffer.from(request.body));
        } catch (error) { signal?.removeEventListener('abort', abort); finish(error); live?.abort(); }
      });
    }
    Network.prototype.fetch = async function(input, init = {}) {
      if (closed || !scope.getStore()) return originalFetch.call(this, input, init);
      if(onlineUpdates&&!onlineUpdates.accepting()) {
        await onlineUpdates.whenAccepting(init.signal);
        return Network.prototype.fetch.call(this,input,init);
      }
      const url = asUrl(input); this.assertAllowed(url);
      const signal = init.signal;
      const current = { url, method: init.method ?? 'GET', headers: headers(init.headers), body: requestBody(init.body) };
      const result = await tracked('desktop.fetch',()=>source.interceptHttp(current, { signal, forward: async (next, control) => {
        const body = await bytes(next.body, control.signal);
        const omit = next.credentialMode === 'omit' || !sameOrigin(url, next.url);
        return nativeForward(this, { ...next, body, headers: omit ? withoutCredentials(next.headers) : next.headers }, { redirect: init.redirect ?? 'follow',
          credentials: omit ? 'omit' : init.credentials, cache: init.cache, referrerPolicy: init.referrerPolicy,
          priority: init.priority, ...(init.credentials === 'same-origin' && !omit ? { origin: new URL(url).origin } : {}) }, control.signal);
      } }));
      return response(result, current.method);
    };
    Network.prototype.request = function(options) {
      if (closed || !scope.getStore()) return originalRequest.call(this, options);
      this.assertAllowed(options.url);
      const network = this;
      const proxy = new EventEmitter();
      const controller = new AbortController();
      let liveRequest, upload = { started: false, current: 0, total: 0 }, ended = false;
      proxy.getUploadProgress = () => liveRequest?.getUploadProgress?.() ?? upload;
      proxy.abort = () => { controller.abort(); liveRequest?.abort?.(); };
      proxy.end = function(body) {
        if (ended) throw fail('desktop_request_already_ended'); ended = true;
        const send = async () => {
          if(onlineUpdates&&!onlineUpdates.accepting()) {
            await onlineUpdates.whenAccepting(controller.signal);
            if(closed) {
              const next=network.request(options);next.once('error',error=>proxy.emit('error',error));next.once('response',output=>proxy.emit('response',output));
              controller.signal.addEventListener('abort',()=>next.abort(),{once:true});liveRequest=next;next.end(body);return;
            }
          }
          const current = { url: options.url, method: options.method ?? 'GET', headers: headers(options.headers), body: requestBody(body) };
          const result = await tracked('desktop.request',()=>source.interceptHttp(current, { signal: controller.signal, forward: async (next, control) => {
            const forwardBody = await bytes(next.body, control.signal);
            const omit = next.credentialMode === 'omit' || !sameOrigin(options.url, next.url);
            return nativeForward(network, { ...next, body: forwardBody, headers: omit ? withoutCredentials(next.headers) : next.headers }, { ...options, redirect: options.redirect ?? 'follow',
              credentials: omit ? 'omit' : options.credentials,
              useSessionCookies: !omit && options.useSessionCookies === true }, control.signal,
            request => { liveRequest = request; upload = request.getUploadProgress?.() ?? upload; });
          } }));
          if (bodyless(result.status, current.method)) await result.body?.cancel?.();
          const output = Readable.from(bodyless(result.status, current.method) ? [] : result.body ?? []);
          output.statusCode = result.status; output.statusMessage = ''; output.headers = headerObject(result.headers);
          proxy.emit('response', output);
        };
        send().catch(error => proxy.emit('error', error));
      };
      requestInstalled = true;
      return proxy;
    };
    fetchInstalled = true; requestInstalled = true;
    restores.push(() => { Network.prototype.fetch = originalFetch; Network.prototype.request = originalRequest; });
  }
  function hookFetchWrapper(FetchWrapper) {
    if (typeof FetchWrapper !== 'function' || typeof FetchWrapper.prototype.performDesktopFetch !== 'function') { desktopReason = 'hook_unavailable'; return; }
    const original = FetchWrapper.prototype.performDesktopFetch;
    FetchWrapper.prototype.performDesktopFetch = function(...args) { return scope.run(true, () => original.apply(this, args)); };
    restores.push(() => { FetchWrapper.prototype.performDesktopFetch = original; });
  }
  function applyRecord(record) {
    const {name, hash: observedSha256, exported}=record;
    if (!Object.hasOwn(expectedHashes, name)) {
      if (moduleRegistry && /^(bootstrap-|main-|application-network-startup-)/.test(name)) { if(name.startsWith('application-network-startup-'))taskReason='unsupported_build';else desktopReason='unsupported_build'; mismatch={name,observedSha256}; }
      return;
    }
    const profile = PROFILES[name] ?? { kind: name.startsWith('bootstrap-') ? 'bootstrap' : name.startsWith('main-') ? 'main' : 'src',
      symbol: name.startsWith('bootstrap-') ? 'Pt' : name.startsWith('main-') ? 'wEe' : 'mQ' };
    if (observedSha256 !== expectedHashes[name]) {
      if (['src', 'stdio', 'connection'].includes(profile.kind)) taskReason = 'unsupported_build'; else desktopReason = 'unsupported_build';
      mismatch = { name, observedSha256 }; return;
    }
    const expression = profile.connectionSymbol ? `({primary:${profile.symbol},connection:${profile.connectionSymbol}})` : profile.symbol;
    const read = () => record.evaluate(expression);
    // Some reviewed bundles declare classes in lazy native initializers. Capture
    // their live bindings and wait for Native to initialize them; do not invoke
    // a native factory or turn an uninitialized class into a permanent failure.
    const apply = () => {
      const captured = read(); let pending = false;
      if (profile.kind === 'bootstrap') {
        const primary = profile.connectionSymbol ? captured.primary : captured;
        if (!bootstrapVerified) { if (primary == null) pending = true; else { bootstrapVerified = true; hookNetwork(primary); } }
        if (profile.connectionSymbol && !connectionVerified) { if (captured.connection == null) pending = true; else { connectionVerified = true; hookConnection(captured.connection); } }
      }
      else if (profile.kind === 'main') { if (!mainVerified) { if (captured == null) pending = true; else { mainVerified = true; hookFetchWrapper(captured); } } }
      else if (profile.kind === 'stdio') { if (!stdioVerified) { if (captured == null) pending = true; else { stdioVerified = true; hookStdio(captured); } } }
      else if (profile.kind === 'connection') { if (!connectionVerified) { if (captured == null) pending = true; else { connectionVerified = true; hookConnection(captured); } } }
      else { stdioVerified = true; connectionVerified = true; hookStdio(captured); hookConnection(exported[profile.managerExport ?? 'un']); }
      srcVerified = stdioVerified && connectionVerified;
      return !pending;
    };
    const attempt = () => {
      try { const result=apply();delete bindingErrors[profile.kind];return result; }
      catch (error) {
        bindingErrors[profile.kind]=['ReferenceError','TypeError'].includes(error?.name)?error.name:'binding_error';
        if(error?.name==='ReferenceError')return false;
        if(['bootstrap','main'].includes(profile.kind))desktopReason='hook_unavailable';else taskReason='hook_unavailable';
        return true;
      }
    };
    if (!attempt()) deferredModules.add(attempt);
  }
  Module.prototype._compile = function(code, filename) {
    const name=path.basename(filename);
    if (!Object.hasOwn(expectedHashes,name)) return originalCompile.call(this,code,filename);
    const profile=PROFILES[name]??{symbol:name.startsWith('bootstrap-')?'Pt':name.startsWith('main-')?'wEe':'mQ'};
    const expression=profile.connectionSymbol?`({primary:${profile.symbol},connection:${profile.connectionSymbol}})`:profile.symbol;
    const hash=createHash('sha256').update(code).digest('hex');
    if(hash!==expectedHashes[name]) {applyRecord({name,hash});return originalCompile.call(this,code,filename);}
    const result=originalCompile.call(this,`${code}\n;Object.defineProperty(module.exports,Symbol.for(${JSON.stringify(String(symbol))}),{value:()=>${expression},configurable:true});`,filename);
    const read=this.exports[Symbol.for(String(symbol))],exported=this.exports;delete this.exports[Symbol.for(String(symbol))];
    applyRecord({name,hash,exported,evaluate:()=>read()});
    return result;
  };
  restores.push(() => { if (Module.prototype._compile === wrappedCompile) Module.prototype._compile = originalCompile; });
  const wrappedCompile = Module.prototype._compile;
  if(moduleRegistry) {
    Module.prototype._compile=originalCompile;
    const unsubscribe=moduleRegistry.subscribe(applyRecord);
    restores.push(unsubscribe);
  }
  const desktopDone = () => desktopReason || bootstrapVerified && mainVerified && fetchInstalled && requestInstalled;
  const needsTaskSources = Object.keys(expectedHashes).some(name => ['src', 'stdio', 'connection'].includes(PROFILES[name]?.kind) || name.startsWith('src-'));
  const taskDone = () => taskReason || !needsTaskSources || srcVerified && stdioInstalled && connectionInstalled;
  return Object.freeze({
    async ready({ deadlineUnixMs: readinessDeadlineUnixMs = deadlineUnixMs } = {}) {
      while (!closed && !(desktopDone() && taskDone()) && Date.now() < readinessDeadlineUnixMs - 500) {
        for (const apply of deferredModules) if (apply()) deferredModules.delete(apply);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // A busy native event loop can initialize bindings after the last poll
      // while exhausting the wait budget. Check those verified bindings once
      // more before deciding that their hooks are unavailable.
      if(!closed)for(const apply of deferredModules)if(apply())deferredModules.delete(apply);
      return this.inspect();
    },
    inspect: () => ({ installed: !closed, available: !desktopReason && bootstrapVerified && mainVerified && fetchInstalled && requestInstalled,
      taskConfigurationAvailable: !taskReason && srcVerified && stdioInstalled && connectionInstalled,
      modules: { bootstrap: bootstrapVerified, main: mainVerified, src: srcVerified, stdio: stdioInstalled, connection: connectionInstalled },
      mismatch,
      bindingErrors:{...bindingErrors},deferredBindings:deferredModules.size,
      reason: desktopReason ?? (bootstrapVerified && mainVerified ? null : 'hook_unavailable'),
      taskConfigurationReason: taskReason ?? (srcVerified && stdioInstalled && connectionInstalled ? null : 'hook_unavailable') }),
    suspend() { if (closed) return; closed = true; deferredModules.clear(); for (const restore of restores.splice(0).reverse()) restore(); },
    close() { this.suspend(); if(!state){for (const route of taskRoutes) closeRoute(route); taskRoutes.clear();scope.disable();} },
  });
}
module.exports = { installDesktopPlaintext, routedThreadMessage, reviewedSourceProfiles: PROFILES };
