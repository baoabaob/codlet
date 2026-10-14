'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { prepareBackendLaunch, verifyBackend } = require('./backend-launch.cjs');
const { runConfigProbe } = require('./backend-config-probe.cjs');
const fail = code => Object.assign(new Error(code), { code });
const closeRoute = route => { try { Promise.resolve(route.close()).catch(() => {}); } catch {} };
const DEFAULT_OPENAI = 'https://api.openai.com/v1';
const DEFAULT_CHATGPT = 'https://chatgpt.com/backend-api/codex';

function configArguments(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    if (['-c', '--config', '--enable', '--disable', '-p', '--profile'].includes(args[index])) result.push(args[index], args[++index]);
    else if (/^--(?:config|enable|disable|profile)=/u.test(args[index])) result.push(args[index]);
  }
  return result;
}
function lastStringOverride(args, setting) {
  let found;
  for (let index = 0; index < args.length; index++) {
    const current = args[index];
    const entry = current === '-c' || current === '--config' ? args[++index] : current.startsWith('--config=') ? current.slice('--config='.length) : null;
    if (typeof entry !== 'string') continue;
    const at = entry.indexOf('=');
    if (at < 0 || entry.slice(0, at).trim() !== setting) continue;
    const raw = entry.slice(at + 1).trim();
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    if (typeof value === 'string') found = value;
  }
  return found;
}
function environmentFromPairs(pairs) {
  const result = {};
  for (const pair of pairs ?? []) { const at = pair.indexOf('=', pair.startsWith('=') ? 1 : 0); if (at > 0) result[pair.slice(0, at)] = pair.slice(at + 1); }
  return result;
}
function providerTrust(environment, cwd) {
  const get = name => Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
  const configured = get('CODEX_CA_CERTIFICATE') ?? get('SSL_CERT_FILE');
  if (configured === undefined) return undefined;
  if (typeof configured !== 'string' || !configured) throw fail('backend_provider_trust_unsupported');
  const target = path.resolve(cwd, configured);
  let info; try { info = fs.statSync(target); } catch { throw fail('backend_provider_trust_unsupported'); }
  if (!info.isFile() || info.size < 1 || info.size > 128 * 1024) throw fail('backend_provider_trust_unsupported');
  let pem; try { pem = fs.readFileSync(target, 'utf8'); } catch { throw fail('backend_provider_trust_unsupported'); }
  if (!/^(?:\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/u.test(pem)) throw fail('backend_provider_trust_unsupported');
  return pem;
}
function effectiveProviders(policy) {
  if (!policy || typeof policy !== 'object') throw fail('backend_config_unavailable');
  const routes = new Map();
  if (policy.openaiBaseUrl == null && ![null, 'chatgpt', 'apiKey'].includes(policy.accountType)) throw fail('backend_auth_mode_unsupported');
  const builtIn = policy.openaiBaseUrl ?? (policy.accountType === 'chatgpt' ? DEFAULT_CHATGPT : DEFAULT_OPENAI);
  if (typeof builtIn !== 'string') throw fail('backend_config_unavailable');
  routes.set('openai_base_url', builtIn);
  const configured = policy.providerBaseUrls ?? {};
  if (!configured || typeof configured !== 'object' || Object.keys(configured).length > 16) throw fail('backend_provider_unsupported');
  if ((policy.modelProvider ?? 'openai') !== 'openai' && !Object.hasOwn(configured, policy.modelProvider)) throw fail('backend_provider_unsupported');
  for (const [name, url] of Object.entries(configured)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name) || typeof url !== 'string') throw fail('backend_provider_unsupported');
    routes.set(`model_providers.${name}.base_url`, url);
  }
  return routes;
}

// Intercept only an exact, verified local app-server child. Node's spawn entry is
// synchronous, so reserveRoute supplies a URL immediately and completes its
// authenticated registration before launch readiness is reported.
function installBackendSpawn(configuration, dependencies = {}) {
  const prototype = dependencies.prototype ?? childProcess.ChildProcess.prototype;
  const originalSpawn = prototype.spawn;
  const prepare = dependencies.prepare ?? prepareBackendLaunch;
  const verify = dependencies.verify ?? verifyBackend;
  const probe = dependencies.probe ?? (plan => {
    const result = childProcess.spawnSync(configuration.runtimeExecutable, ['--no-addons', '--no-global-search-paths', '--eval', `(${runConfigProbe.toString()})()`], {
      input: JSON.stringify(plan), env: plan.environment, cwd: plan.cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: 4500,
    });
    if (result.error || result.status !== 0) throw fail('backend_config_unavailable');
    let value; try { value = JSON.parse(result.stdout); } catch { throw fail('backend_config_unavailable'); }
    if (value.error) throw fail(value.error); return value;
  });
  if (!configuration?.source?.reserveRoute || !Number.isSafeInteger(configuration.deadlineUnixMs)) throw fail('invalid_launch_configuration');
  let closed = false, prepared = 0, declined = 0, reason = null;
  const state=dependencies.state??{owned:new WeakSet(),trust:new WeakMap(),accounts:new WeakMap(),providers:new WeakMap(),records:new Set(),pending:new Set(),prepared:0};
  const shared=!!dependencies.state;
  const active = new Set(), pending = state.pending, owned = state.owned, trustByProcess = state.trust, accountByProcess = state.accounts, providersByProcess = state.providers;
  prepared=state.prepared;
  function wrapped(options) {
    const args = options?.args, file = options?.file;
    if (closed || !Array.isArray(args) || !args.includes('app-server') || typeof file !== 'string' || !path.isAbsolute(file) || !/^codex(?:\.exe)?$/iu.test(path.basename(file))) return originalSpawn.call(this, options);
    let reservations = [], dispatched = false;
    try {
      verify(file, process.platform);
      const actualArgs = args.slice(1), environment = environmentFromPairs(options.envPairs);
      const cwd = options.cwd ?? process.cwd();
      const policy = probe({ executable: file, configArguments: configArguments(actualArgs), environment, cwd });
      const directOpenaiBaseUrl = lastStringOverride(actualArgs, 'openai_base_url');
      if (directOpenaiBaseUrl !== undefined) policy.openaiBaseUrl = directOpenaiBaseUrl;
      const additionalCaPem = providerTrust(environment, cwd);
      const providerRoutes = {};
      for (const [setting, upstreamBaseUrl] of effectiveProviders(policy)) {
        const url = new URL(upstreamBaseUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('backend_provider_unsupported');
        const reservation = configuration.source.reserveRoute({ upstreamBaseUrl, ...(additionalCaPem === undefined ? {} : { additionalCaPem }) });
        reservations.push(reservation); providerRoutes[setting] = reservation.baseUrl;
      }
      const launch = prepare({ executable: file, arguments: actualArgs, originalEnvironment: environment, providerRoutes, platform: process.platform });
      const next = { ...options, args: [args[0], ...launch.arguments] };
      dispatched = true;
      const result = originalSpawn.call(this, next);
      owned.add(this); trustByProcess.set(this, additionalCaPem);
      providersByProcess.set(this, new Set(['openai', ...Object.keys(policy.providerBaseUrls ?? {})]));
      accountByProcess.set(this, { route: reservations[0], explicit: policy.openaiBaseUrl != null,
        current: effectiveProviders(policy).get('openai_base_url'), pending: null });
      prepared++;state.prepared=prepared;
      const ready = Promise.all(reservations.map(item => item.ready));
      ready.catch(() => { reason = 'route_unavailable'; }); pending.add(ready); ready.finally(() => pending.delete(ready)).catch(() => {});
      const record={child:this,reservations};state.records.add(record);
      if(shared&&dependencies.trackBackend) dependencies.trackBackend(record,{methodKey:'method',method:'account/updated',paramsKey:'params',modeKey:'authMode',targets:{chatgpt:DEFAULT_CHATGPT,apiKey:DEFAULT_OPENAI}});
      else {const release = () => { for (const item of reservations) closeRoute(item); active.delete(release);state.records.delete(record); };
        active.add(release); this.once('exit', release); this.once('error', release);}
      return result;
    } catch (error) {
      for (const item of reservations) closeRoute(item);
      declined++; reason = ['backend_build_unverified', 'backend_config_unavailable', 'backend_provider_unsupported', 'backend_auth_mode_unsupported', 'backend_provider_trust_unsupported', 'backend_route_unavailable'].includes(error.code) ? error.code : 'route_unavailable';
      if (dispatched) throw error;
      return originalSpawn.call(this, options);
    }
  }
  prototype.spawn = wrapped;
  return Object.freeze({
    async ready({ deadlineUnixMs = configuration.deadlineUnixMs } = {}) {
      while (!prepared && !declined && !closed && Date.now() < deadlineUnixMs - 500) await new Promise(resolve => setTimeout(resolve, 20));
      if (prepared && pending.size > 0) {
        const limit = deadlineUnixMs - 500 - Date.now();
        if (limit <= 0) throw fail('backend_route_timeout');
        let timer;
        try { await Promise.race([Promise.all([...pending]), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('backend_route_timeout')), limit); })]); }
        finally { clearTimeout(timer); }
      }
      return this.inspect();
    },
    close() { if (closed) return; closed = true; if (prototype.spawn === wrapped) prototype.spawn = originalSpawn; if(!shared)for (const release of active) release(); },
    ownsProcess: child => !closed && !!child && owned.has(child),
    providerTrustForProcess: child => owned.has(child) ? trustByProcess.get(child) : undefined,
    isProviderSupported: (child, provider) => owned.has(child) && providersByProcess.get(child)?.has(provider) === true,
    pendingAccountUpdate: child => accountByProcess.get(child)?.pending ?? null,
    updateAccountMode(child, mode) {
      const state = accountByProcess.get(child);
      if (!state || state.explicit || mode == null) return;
      if (mode !== 'chatgpt' && mode !== 'apiKey') { reason = 'backend_auth_mode_unsupported'; closeRoute(state.route); return; }
      const upstreamBaseUrl = mode === 'chatgpt' ? DEFAULT_CHATGPT : DEFAULT_OPENAI;
      if (state.current === upstreamBaseUrl) return;
      const update = (state.pending ?? Promise.resolve()).then(() => state.route.update({ upstreamBaseUrl })).then(() => { state.current = upstreamBaseUrl; }, error => {
        reason = 'route_unavailable'; closeRoute(state.route); throw error;
      });
      update.catch(() => {});
      state.pending = update;
      update.finally(() => { if (state.pending === update) state.pending = null; }).catch(() => {});
    },
    inspect: () => ({ installed: !closed, backendRootsPrepared: prepared, backendRootsDeclined: declined,
      available: state.records.size > 0 && !reason, reason: reason ?? (state.records.size ? null : 'child_unavailable') }),
  });
}
module.exports = { installBackendSpawn, effectiveProviders, configArguments, lastStringOverride, environmentFromPairs, providerTrust };
