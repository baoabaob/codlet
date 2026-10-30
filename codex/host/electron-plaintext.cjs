'use strict';
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { sourceCandidates, supportsRole } = require('./source-contracts.cjs');
const { providerSetting, providerName } = require('./backend-launch.cjs');

// Exact source mappings are a fast path. Core's generic module inventory also
// discovers unlisted classes through the contracts of the methods we wrap.
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
const unavailableSource = error => ['invalid_source','peer_closed','traffic_connect_timeout','traffic_backpressure','resource_limit','host_stopping'].includes(error?.code);
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
  const inline = typeof selected === 'string' ? inputConfig?.[providerSetting(selected).slice(0,-'.base_url'.length)] ?? inputConfig?.model_providers?.[selected] : null;
  if (typeof selected === 'string' && !isProviderSupported(selected) && typeof inline?.base_url !== 'string') throw fail('backend_provider_unsupported');
  if (!inputConfig || typeof inputConfig !== 'object' || Array.isArray(inputConfig)) return message;
  const config = { ...inputConfig }; let changed = false;
  for (const [key, value] of Object.entries(config)) {
    if (key === 'model_providers' && value && typeof value === 'object' && !Array.isArray(value)) {
      const mapped = { ...value };
      for (const [name, provider] of Object.entries(mapped)) if (provider && typeof provider === 'object' && typeof provider.base_url === 'string') {
        mapped[name] = { ...provider, base_url: reserve(providerUrl(provider.base_url)) }; changed = true;
      }
      config[key] = mapped;
    } else if (/^model_providers\..*\.base_url$/u.test(key) && providerName(key)===null) throw fail('backend_provider_unsupported');
    else if (/^model_providers\..+$/u.test(key) && value && typeof value === 'object' && typeof value.base_url === 'string'
      && providerName(key+'.base_url')===null) throw fail('backend_provider_unsupported');
    if (key === 'openai_base_url' || providerName(key)!==null) {
      config[key] = reserve(providerUrl(value)); changed = true;
    } else if (providerName(key+'.base_url')!==null && value && typeof value === 'object' && typeof value.base_url === 'string') {
      config[key] = { ...value, base_url: reserve(providerUrl(value.base_url)) }; changed = true;
    }
  }
  return changed ? JSON.stringify({ ...payload, params: { ...payload.params, config } }) : message;
}

// Scope final ApplicationNetwork calls to the reviewed performDesktopFetch
// classes, after their auth, workspace policy and cancellation decisions.
function installDesktopPlaintext({ app }, { source, deadlineUnixMs, ownsBackendProcess = () => false, isProviderSupported = () => true,
  providerTrustForProcess = () => undefined, prepareBackendRestart,
  pendingAccountUpdate = () => null, updateAccountMode = () => {}, moduleRegistry, state, observeBackendOwner, registerBackendOwners }, { expectedHashes = HASHES } = {}) {
  if ((!moduleRegistry && app.isReady()) || !source?.interceptHttp) throw fail('desktop_bootstrap_too_late');
  const scope = state?.scope??new AsyncLocalStorage();
  if(state&&!state.scope)state.scope=scope;
  const symbol = Symbol('codlet.private.plaintext');
  const originalCompile = Module.prototype._compile;
  let bootstrapVerified = false, mainVerified = false, srcVerified = false, fetchInstalled = false, requestInstalled = false,
    stdioVerified = false, connectionVerified = false, stdioInstalled = false, connectionInstalled = false, desktopReason = null, taskReason = null, mismatch = null, closed = false;
  const bindingErrors = Object.create(null);
  const restores = [];
  const observed = new Map(), rejectedRoles = new Map(), roleBindings = new Map(), roleReasons = new Map(), driftedRoles = new Set();
  const hasContract=role=>[...observed.values()].flat().some(candidate=>candidate.role===role)||[...rejectedRoles.values()].some(roles=>roles.includes(role));
  const wrappedMethods={network:['fetch','request'],fetch:['performDesktopFetch'],stdio:['send'],connection:['routeIncomingMessage',...(typeof prepareBackendRestart==='function'?['restart']:[])]};
  const taskRoutes = state?.taskRoutes??new Set(), routesByProcess = state?.routesByProcess??new WeakMap(), sendQueues = state?.sendQueues??new WeakMap();
  const pendingSends = state?.pendingSends ?? new Set();
  if (state) state.pendingSends = pendingSends;
  function reserve(url, proc) {
    let routes = routesByProcess.get(proc);
    if (!routes) {
      routes = new Map(); routesByProcess.set(proc, routes);
      proc.once('exit', () => { for (const route of routes.values()) { closeRoute(route); taskRoutes.delete(route); } routes.clear(); });
    }
    if (routes.has(url)) return routes.get(url);
    const additionalCaPem = providerTrustForProcess(proc);
    const route = source.reserveRoute({ upstreamBaseUrl: url, ...(additionalCaPem === undefined ? {} : { additionalCaPem }) });
    route.ready.catch(() => { routes.delete(url); taskRoutes.delete(route); closeRoute(route); });
    routes.set(url, route); taskRoutes.add(route);
    return route;
  }
  function hookStdio(Stdio) {
    if (stdioInstalled || typeof Stdio !== 'function' || typeof Stdio.prototype.send !== 'function') { if (!stdioInstalled) taskReason = 'hook_unavailable'; return; }
    const original = Stdio.prototype.send;
    Stdio.prototype.send = function(message) {
      if (closed || !roleLive('stdio',Stdio) || !ownsBackendProcess(this.proc) || typeof message !== 'string') return original.call(this, message);
      const previous = sendQueues.get(this), waits = []; let routed, account;
      try { routed = routedThreadMessage(message, url => { const route = reserve(url, this.proc); waits.push(route.ready); return route.baseUrl; },
        provider => isProviderSupported(this.proc, provider)); account = pendingAccountUpdate(this.proc); }
      // Route preparation has not dispatched anything. A Core failure must leave
      // Native's provider choice and its own validation in charge.
      catch { routed = message; account = null; waits.length = 0; }
      if (!waits.length && !account && !previous) return original.call(this,routed);
      const proc=this.proc;let retire;
      const retired=new Promise((_,reject)=>{retire=()=>reject(fail('backend_owner_retired'));proc.once('exit',retire);proc.once('error',retire);});
      const prepared = Promise.all([...waits,...(account?[account]:[])]).then(()=>routed,()=>message);
      // Accepted Native sends survive hook retirement. Only preparation can
      // fall back; an actual Native send is never retried after an error.
      const operation = Promise.race([Promise.resolve(previous).catch(()=>{}).then(()=>prepared),retired])
        .then(next=>{if(this.proc!==proc||proc.killed===true||proc.exitCode!=null||proc.signalCode!=null)throw fail('backend_owner_retired');return original.call(this,next);}).catch(error=>this.onerror?.(error))
        .finally(()=>{proc.off('exit',retire);proc.off('error',retire);});
      sendQueues.set(this, operation);
      pendingSends.add(operation);
      operation.finally(() => { pendingSends.delete(operation); if (sendQueues.get(this) === operation) sendQueues.delete(this); }).catch(() => {});
    };
    stdioInstalled = true;
    const wrapped=Stdio.prototype.send;
    restores.push(() => { if(Stdio.prototype.send===wrapped)Stdio.prototype.send = original; });
  }
  function hookConnection(Connection) {
    if (connectionInstalled || typeof Connection !== 'function' || typeof Connection.prototype.routeIncomingMessage !== 'function') { if (!connectionInstalled) taskReason = 'hook_unavailable'; return; }
    const original = Connection.prototype.routeIncomingMessage;
    Connection.prototype.routeIncomingMessage = function(message, ...rest) {
      if (!closed && roleLive('connection',Connection)) {
        // A connection can predate constructor observation. Its verified native
        // method provides the live receiver without constructing or replaying it.
        try { if(this instanceof Connection)moduleRegistry?.instance?.(this); } catch { /* Observation cannot interrupt a native message. */ }
        try { if(this instanceof Connection&&this.connection?.proc)observeBackendOwner?.(this.connection.proc,this); }catch{/* The actual connection receiver is the only owner association. */}
        try { if(message?.method === 'account/updated' && ownsBackendProcess(this.connection?.proc))updateAccountMode(this.connection.proc, message.params?.authMode); }
        catch { /* Core observation must not interrupt Native notification delivery. */ }
      }
      return original.call(this, message, ...rest);
    };
    connectionInstalled = true;
    if(registerBackendOwners&&typeof moduleRegistry?.instances==='function')restores.push(registerBackendOwners(()=>roleLive('connection',Connection)?moduleRegistry.instances(Connection):[]));
    const wrapped=Connection.prototype.routeIncomingMessage;
    restores.push(() => { if(Connection.prototype.routeIncomingMessage===wrapped)Connection.prototype.routeIncomingMessage = original; });
    const originalRestart=Connection.prototype.restart;
    if(typeof originalRestart==='function'&&typeof prepareBackendRestart==='function') {
      const restart=async function(...args) {
        if(closed||!roleLive('connection',Connection))return originalRestart.apply(this,args);
        const transport=this.connection;
        // Prepare before Native closes its current child, so the replacement
        // spawn can acquire routes synchronously with its original launch plan.
        try { await prepareBackendRestart(transport); }
        catch { /* Native must still perform its requested restart. */ }
        return originalRestart.apply(this,args);
      };
      Connection.prototype.restart=restart;
      restores.push(()=>{if(Connection.prototype.restart===restart)Connection.prototype.restart=originalRestart;});
    }
  }
  function hookNetwork(Network) {
    if (typeof Network !== 'function' || typeof Network.prototype.fetch !== 'function' || typeof Network.prototype.request !== 'function') { desktopReason = 'hook_unavailable'; return; }
    const originalFetch = Network.prototype.fetch, originalRequest = Network.prototype.request;
    function nativeForward(network, request, options, signal, onRequest) {
      return new Promise((resolve, reject) => {
        let settled = false, finalUrl = request.url, live;
        const uploadController=new AbortController();
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          uploadController.abort();
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
              if (!['http:', 'https:'].includes(new URL(destination).protocol)) throw fail('desktop_redirect_disallowed');
              network.assertAllowed(destination);
              finalUrl = destination;
              // Electron requires this call during the event. The intermediate
              // response body is unavailable through ClientRequest.
              live.followRedirect();
            } catch (error) { finish(error); live.abort(); }
          });
          live.once('error', error => { signal?.removeEventListener('abort', abort); finish(error); });
          // Electron closes its Writable upload after end(), before the HTTP
          // response arrives. Only its request error/abort events terminate the
          // transaction; upload close is not a network failure.
          live.once('abort',()=>{signal?.removeEventListener('abort',abort);finish(fail('desktop_request_aborted'));});
          live.once('response', incoming => {
            incoming.once('end', () => signal?.removeEventListener('abort', abort));
            incoming.once('close', () => signal?.removeEventListener('abort', abort));
            finish(null, { status: incoming.statusCode, headers: headers(incoming.headers), body: incoming, finalUrl });
          });
          const body=request.body;
          if(body==null||typeof body==='string'||body instanceof Uint8Array)live.end(body==null||typeof body==='string'?body:Buffer.from(body));
          else {
            if(typeof live.write!=='function')throw fail('desktop_upload_contract_invalid');
            const iterator=body[Symbol.asyncIterator]?.()??body[Symbol.iterator]?.();
            if(!iterator)throw fail('desktop_upload_contract_invalid');
            const stopped=Symbol('upload stopped');
            const next=()=>new Promise((resolve,reject)=>{
              const abort=()=>{uploadController.signal.removeEventListener('abort',abort);resolve(stopped);};
              if(uploadController.signal.aborted){abort();return;}
              uploadController.signal.addEventListener('abort',abort,{once:true});
              Promise.resolve().then(()=>iterator.next()).then(value=>{uploadController.signal.removeEventListener('abort',abort);resolve(value);},error=>{uploadController.signal.removeEventListener('abort',abort);reject(error);});
            });
            const pump=(async()=>{
              try {
                while(!settled) {
                  const item=await next();
                  if(item===stopped||settled)return;
                  signal?.throwIfAborted();if(item.done){live.end();return;}
                  if(typeof item.value!=='string'&&!(item.value instanceof Uint8Array))throw fail('desktop_upload_contract_invalid');
                  if(!live.write(item.value))await new Promise((resolve,reject)=>{
                    const cleanup=()=>{live.off('drain',drained);live.off('error',failed);live.off('close',ended);uploadController.signal.removeEventListener('abort',ended);};
                    const drained=()=>{cleanup();resolve();},failed=error=>{cleanup();reject(error);},ended=()=>{cleanup();resolve();};
                    live.once('drain',drained);live.once('error',failed);live.once('close',ended);uploadController.signal.addEventListener('abort',ended,{once:true});if(uploadController.signal.aborted)ended();
                  });
                }
              }finally{if(settled)try{Promise.resolve(iterator.return?.()).catch(()=>{});}catch{/* A retired producer cannot interrupt the Native response. */}}
            })();
            pump.catch(error=>{finish(error);live.abort();});
          }
        } catch (error) { signal?.removeEventListener('abort', abort); finish(error); live?.abort(); }
      });
    }
    Network.prototype.fetch = async function(input, init = {}) {
      if (closed || !roleLive('network',Network) || !scope.getStore()) return originalFetch.call(this, input, init);
      const url = asUrl(input); this.assertAllowed(url);
      const signal = init.signal;
      const current = { url, method: init.method ?? 'GET', headers: headers(init.headers), body: requestBody(init.body) };
      let dispatched = false, nativeError;
      let result;
      try { result = await source.interceptHttp(current, { signal, forward: async (next, control) => {
        const omit = next.credentialMode === 'omit' || !sameOrigin(url, next.url);
        dispatched = true;
        try { return await nativeForward(this, { ...next, headers: omit ? withoutCredentials(next.headers) : next.headers }, { redirect: init.redirect ?? 'follow',
          credentials: omit ? 'omit' : init.credentials, cache: init.cache, referrerPolicy: init.referrerPolicy,
          priority: init.priority, ...(init.credentials === 'same-origin' && !omit ? { origin: new URL(url).origin } : {}) }, control.signal);
        } catch (error) { nativeError = error; throw error; }
      } }); } catch (error) {
        if (nativeError !== undefined) throw nativeError;
        if (!dispatched && unavailableSource(error)) return originalFetch.call(this,input,init);
        throw error;
      }
      return response(result, current.method);
    };
    Network.prototype.request = function(options) {
      if (closed || !roleLive('network',Network) || !scope.getStore()) return originalRequest.call(this, options);
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
          const current = { url: options.url, method: options.method ?? 'GET', headers: headers(options.headers), body: requestBody(body) };
          let dispatched = false, nativeError, result;
          try { result = await source.interceptHttp(current, { signal: controller.signal, forward: async (next, control) => {
            const omit = next.credentialMode === 'omit' || !sameOrigin(options.url, next.url);
            dispatched = true;
            try { return await nativeForward(network, { ...next, headers: omit ? withoutCredentials(next.headers) : next.headers }, { ...options, redirect: options.redirect ?? 'follow',
              credentials: omit ? 'omit' : options.credentials,
              useSessionCookies: !omit && options.useSessionCookies === true }, control.signal,
            request => { liveRequest = request; upload = request.getUploadProgress?.() ?? upload; });
            } catch (error) { nativeError = error; throw error; }
          } }); } catch (error) {
            if (nativeError !== undefined) throw nativeError;
            if (dispatched || !unavailableSource(error)) throw error;
            // Source failure before any upstream call: Native still owns this
            // request. Once dispatched, an uncertain result can never replay it.
            controller.signal.throwIfAborted();
            liveRequest = originalRequest.call(network, options);
            liveRequest.once('error', error => proxy.emit('error', error));
            liveRequest.once('response', output => proxy.emit('response', output));
            liveRequest.end(body);return;
          }
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
    const wrappedFetch=Network.prototype.fetch,wrappedRequest=Network.prototype.request;
    restores.push(() => { if(Network.prototype.fetch===wrappedFetch)Network.prototype.fetch = originalFetch; if(Network.prototype.request===wrappedRequest)Network.prototype.request = originalRequest; });
  }
  function hookFetchWrapper(FetchWrapper) {
    if (typeof FetchWrapper !== 'function' || typeof FetchWrapper.prototype.performDesktopFetch !== 'function') { desktopReason = 'hook_unavailable'; return; }
    const original = FetchWrapper.prototype.performDesktopFetch;
    FetchWrapper.prototype.performDesktopFetch = function(...args) { return closed||!roleLive('fetch',FetchWrapper)?original.apply(this,args):scope.run(true, () => original.apply(this, args)); };
    const wrapped=FetchWrapper.prototype.performDesktopFetch;
    restores.push(() => { if(FetchWrapper.prototype.performDesktopFetch===wrapped)FetchWrapper.prototype.performDesktopFetch = original; });
  }
  function resetRole(role) {
    const binding = roleBindings.get(role);
    if (binding) for (const restore of binding.restores.reverse()) {
      restore(); const index=restores.indexOf(restore); if(index!==-1)restores.splice(index,1);
    }
    roleBindings.delete(role);
    if(role==='network'){bootstrapVerified=false;fetchInstalled=false;requestInstalled=false;}
    if(role==='fetch')mainVerified=false;
    if(role==='stdio'){stdioVerified=false;stdioInstalled=false;}
    if(role==='connection'){connectionVerified=false;connectionInstalled=false;}
  }
  function roleLive(role,Constructor) {
    const binding=roleBindings.get(role);
    if(!binding||binding.Constructor!==Constructor)return false;
    if(Object.entries(binding.installed).every(([name,method])=>Object.getOwnPropertyDescriptor(Constructor.prototype,name)?.value===method))return true;
    resetRole(role);driftedRoles.add(role);roleReasons.set(role,'binding_changed');
    if(['network','fetch'].includes(role))desktopReason='binding_changed';else taskReason='binding_changed';
    srcVerified=stdioVerified&&connectionVerified;return false;
  }
  function refreshBindings() {
    for(const role of ['network','fetch','stdio','connection']) {
      const diagnosticRole=role==='network'?'bootstrap':role==='fetch'?'main':role;
      const active=roleBindings.get(role);
      if(active&&Object.entries(active.installed).some(([name,method])=>Object.getOwnPropertyDescriptor(active.Constructor.prototype,name)?.value!==method)) {
        resetRole(role);driftedRoles.add(role);
      }
      if(driftedRoles.has(role)){roleReasons.set(role,'binding_changed');continue;}
      const candidates=[...observed.values()].flat().filter(candidate=>candidate.role===role);
      const collect=selected=>{
        const found=new Set();let pending=false;
        for(const candidate of selected)try {
          const Constructor=candidate.read();
          if(Constructor==null){pending=true;continue;}
          if(candidate.resolved===Constructor||supportsRole(Constructor,role,candidate.recorded)) {
            candidate.resolved=Constructor;found.add(Constructor);
          }
          delete bindingErrors[diagnosticRole];
        }catch(error){
          bindingErrors[diagnosticRole]=['ReferenceError','TypeError'].includes(error?.name)?error.name:'binding_error';
          if(error?.name==='ReferenceError')pending=true;
        }
        return{found,pending};
      };
      let selected=collect(candidates.filter(candidate=>candidate.recorded));
      if(!selected.found.size&&!selected.pending)selected=collect(candidates.filter(candidate=>!candidate.recorded));
      const {found,pending}=selected;
      if(found.size!==1||pending) {
        resetRole(role);
        roleReasons.set(role,found.size>1?'ambiguous_contract':pending?'initializing':'contract_unavailable');
        continue;
      }
      const Constructor=[...found][0];
      if(roleBindings.get(role)?.Constructor===Constructor){roleReasons.delete(role);continue;}
      resetRole(role);
      const at=restores.length;
      try {
        if(role==='network'){hookNetwork(Constructor);bootstrapVerified=fetchInstalled&&requestInstalled;}
        if(role==='fetch'){hookFetchWrapper(Constructor);mainVerified=true;}
        if(role==='stdio'){hookStdio(Constructor);stdioVerified=stdioInstalled;}
        if(role==='connection'){hookConnection(Constructor);connectionVerified=connectionInstalled;}
        roleBindings.set(role,{Constructor,restores:restores.slice(at),installed:Object.fromEntries(wrappedMethods[role].map(name=>[name,Object.getOwnPropertyDescriptor(Constructor.prototype,name)?.value]))});roleReasons.delete(role);
      }catch(error){
        for(const restore of restores.splice(at).reverse())restore();
        roleReasons.set(role,'contract_unavailable');
      }
    }
    srcVerified=stdioVerified&&connectionVerified;
    const terminal=roles=>roles.map(role=>({role,reason:roleReasons.get(role)})).find(({role,reason})=>['ambiguous_contract','binding_changed'].includes(reason)||reason==='contract_unavailable'&&hasContract(role))?.reason??null;
    desktopReason=bootstrapVerified&&mainVerified?null:terminal(['network','fetch']);
    taskReason=srcVerified?null:terminal(['stdio','connection']);
  }
  function applyRecord(record) {
    const {name,hash:observedSha256}=record;
    if(Object.hasOwn(expectedHashes,name)&&observedSha256!==expectedHashes[name])mismatch={name,observedSha256};
    const key=record.filename??name,candidates=sourceCandidates(record,PROFILES,expectedHashes);
    if(Object.hasOwn(expectedHashes,name)) {
      const profile=PROFILES[name],roles=profile?.kind==='bootstrap'?['network',...(profile.connectionSymbol?['connection']:[])]:profile?.kind==='main'?['fetch']:profile?.kind==='stdio'?['stdio']:profile?.kind==='connection'?['connection']:['stdio','connection'];
      rejectedRoles.set(key,roles.filter(role=>!candidates.some(candidate=>candidate.role===role)));
    }
    if(!candidates.length&&!observed.has(key)&&!rejectedRoles.has(key))return;
    if(candidates.length)observed.set(key,candidates);else observed.delete(key);
    refreshBindings();
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
    applyRecord({name,hash,exported,evaluate:binding=>{const value=read();return profile.connectionSymbol?(binding===profile.connectionSymbol?value.connection:value.primary):value;}});
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
    async ready() {
      while (!closed && !(desktopDone() || taskDone())) {
        refreshBindings();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if(!closed)refreshBindings();
      return this.inspect();
    },
    inspect: () => { if(!closed)refreshBindings();for(const [role,binding]of [...roleBindings])roleLive(role,binding.Constructor);return ({ installed: !closed, available: !desktopReason && bootstrapVerified && mainVerified && fetchInstalled && requestInstalled,
      taskConfigurationAvailable: !taskReason && srcVerified && stdioInstalled && connectionInstalled,
      modules: { bootstrap: bootstrapVerified, main: mainVerified, src: srcVerified, stdio: stdioInstalled, connection: connectionInstalled },
      mismatch,
      bindingErrors:{...bindingErrors},deferredBindings:[...roleReasons.values()].filter(reason=>reason==='initializing').length,
      observedModules:moduleRegistry?.inspect?.().modules??null,
      observedInstanceReferences:moduleRegistry?.inspect?.().instanceReferences??null,observedInstanceDrops:moduleRegistry?.inspect?.().instanceDrops??null,
      observedModuleInventory:moduleRegistry?.list?.().slice(0,64).map(record=>({name:record.name,hash:record.hash,classes:record.classes?.length??null}))??[],
      bindingCandidates:Object.fromEntries(['network','fetch','stdio','connection'].map(role=>[role,[...observed.values()].flat().filter(candidate=>candidate.role===role).length])),
      bindingReasons:Object.fromEntries(roleReasons),
      reason: desktopReason ?? (bootstrapVerified && mainVerified ? null : 'initializing'),
      taskConfigurationReason: taskReason ?? (srcVerified && stdioInstalled && connectionInstalled ? null : 'initializing') }); },
    connectionConstructors:()=>roleBindings.has('connection')?[roleBindings.get('connection').Constructor]:[],
    canSuspend: () => pendingSends.size === 0,
    suspend() { if (closed) return; closed = true; observed.clear();roleBindings.clear(); for (const restore of restores.splice(0).reverse()) restore(); },
    close() { this.suspend(); if(!state){for (const route of taskRoutes) closeRoute(route); taskRoutes.clear();scope.disable();} },
  });
}
module.exports = { installDesktopPlaintext, routedThreadMessage, reviewedSourceProfiles: PROFILES };
