'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { prepareBackendLaunch, verifyBackend, supportsBackendContract, providerSetting, providerName } = require('./backend-launch.cjs');
const { runConfigProbeInWorker } = require('./backend-config-probe.cjs');
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
  if (!info.isFile() || info.size < 1) throw fail('backend_provider_trust_unsupported');
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
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw fail('backend_provider_unsupported');
  if ((policy.modelProvider ?? 'openai') !== 'openai' && !Object.hasOwn(configured, policy.modelProvider)) throw fail('backend_provider_unsupported');
  for (const [name, url] of Object.entries(configured)) {
    const authDefault = policy.providerAuthDefaults?.[name];
    if (url === null && typeof authDefault === 'boolean') {
      if (authDefault && ![null, 'chatgpt', 'apiKey'].includes(policy.accountType)) throw fail('backend_auth_mode_unsupported');
      routes.set(providerSetting(name), authDefault && policy.accountType === 'chatgpt' ? DEFAULT_CHATGPT : DEFAULT_OPENAI);
    } else if (typeof url === 'string') routes.set(providerSetting(name), url);
    else throw fail('backend_provider_unsupported');
  }
  return routes;
}

// Node's spawn entry must return its pipes immediately. Prepare unknown launch
// policies asynchronously, let Native start unchanged, then admit a verified
// idle reconnect through the normal connection owner.
function installBackendSpawn(configuration, dependencies = {}) {
  const prototype = dependencies.prototype ?? childProcess.ChildProcess.prototype;
  const originalSpawn = prototype.spawn;
  const prepare = dependencies.prepare ?? prepareBackendLaunch;
  const verify = dependencies.verify ?? verifyBackend;
  const controller = new AbortController();
  const probe = dependencies.probe ?? (plan => runConfigProbeInWorker(plan, {
    signal: controller.signal,
  }));
  if (!configuration?.source?.reserveRoute || !Number.isSafeInteger(configuration.deadlineUnixMs)) throw fail('invalid_launch_configuration');
  let closed = false, prepared = 0, declined = 0, reason = null, probeDiagnostic = null;
  const state=dependencies.state??{owned:new WeakSet(),trust:new WeakMap(),accounts:new WeakMap(),providers:new WeakMap(),records:new Set(),pending:new Set(),prepared:0};
  const shared=!!dependencies.state;
  const active = new Set(), pending = state.pending, owned = state.owned, trustByProcess = state.trust, accountByProcess = state.accounts, providersByProcess = state.providers;
  const launchPlans = state.launchPlans ??= new WeakMap();
  const policies = new Map(), preparing = new Set(), childPlans = new WeakMap(), waitingChildren = new Set();
  const releasePolicy = entry => { for (const route of entry?.reservations ?? []) closeRoute(route); };
  function forgetWaiting(child) {
    const key = childPlans.get(child);
    waitingChildren.delete(child); childPlans.delete(child);
    if (key && ![...waitingChildren].some(value => childPlans.get(value) === key)) {
      releasePolicy(policies.get(key)); policies.delete(key);
    }
  }
  function trackWaiting(child, key) {
    if (childPlans.get(child) !== key) forgetWaiting(child);
    childPlans.set(child, key);
    if (waitingChildren.has(child)) return;
    waitingChildren.add(child);
    child.once('exit', () => forgetWaiting(child));
    child.once('error', () => forgetWaiting(child));
  }
  async function prepareRoutes(entry, plan, policy) {
    if (closed || policies.get(entry.key) !== entry) throw fail('backend_owner_closed');
    policy = { ...policy };
    const direct = lastStringOverride(plan.configArguments, 'openai_base_url');
    if (direct !== undefined) policy.openaiBaseUrl = direct;
    const providers = effectiveProviders(policy);
    if (!supportsBackendContract(policy.contract, [...providers.keys()])) throw fail('backend_contract_unavailable');
    entry.additionalCaPem = providerTrust(plan.environment, plan.cwd);
    entry.providerRoutes = Object.create(null);
    entry.providers = providers;
    entry.reservations = [];
    for (const [setting, upstreamBaseUrl] of providers) {
      const url = new URL(upstreamBaseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('backend_provider_unsupported');
      const route = configuration.source.reserveRoute({ upstreamBaseUrl,
        ...(entry.additionalCaPem === undefined ? {} : { additionalCaPem: entry.additionalCaPem }) });
      entry.reservations.push(route);
      entry.providerRoutes[setting] = route.baseUrl;
    }
    await Promise.all(entry.reservations.map(route => route.ready));
    if (closed || policies.get(entry.key) !== entry) throw fail('backend_owner_closed');
    entry.value = policy;
    entry.checkedAt = Date.now();
    probeDiagnostic = null;
  }
  const canRecover = child => {
    const entry = policies.get(childPlans.get(child));
    return !closed && !!entry?.value && Date.now() - entry.checkedAt < 10000;
  };
  function preparePolicy(plan, { retryFailed = false } = {}) {
    // Keys never leave this generation; credentials/environment are not logged.
    const environment = Object.entries(plan.environment).map(([name, value]) => [
      process.platform === 'win32' ? name.toUpperCase() : name, value,
    ]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const key = createHash('sha256').update(JSON.stringify([
      plan.executable, plan.binarySha256, plan.configArguments, plan.cwd, plan.recordedRouting, environment,
    ])).digest('hex');
    let entry = policies.get(key);
    if(entry?.error&&retryFailed){releasePolicy(entry);policies.delete(key);entry=null;}
    if (entry?.value && Date.now() - entry.checkedAt >= 10000) { releasePolicy(entry);policies.delete(key); entry = null; }
    if (!entry) {
      entry = { key }; policies.set(key, entry);
      let result;
      try { result = probe(plan); } catch (error) { result = Promise.reject(error); }
      const work = Promise.resolve(result).then(value => prepareRoutes(entry, plan, value)).catch(error => {
          releasePolicy(entry);
          entry.error = error;
          if (!closed) probeDiagnostic = error.probeDiagnostic ?? null;
          if (!closed) reason = /^backend_[a-z_]+$/u.test(error?.code) ? error.code : 'backend_config_unavailable';
        }).finally(() => preparing.delete(work));
      preparing.add(work);
      entry.work = work;
    }
    if (entry.error) throw entry.error;
    return { key, policy: entry.value, work: entry.work, entry };
  }
  prepared=state.prepared;
  function wrapped(options) {
    const args = options?.args, file = options?.file;
    if (closed || !Array.isArray(args) || !args.includes('app-server') || typeof file !== 'string' || !path.isAbsolute(file) || !/^codex(?:\.exe)?$/iu.test(path.basename(file))) return originalSpawn.call(this, options);
    let reservations = [], dispatched = false, verified = false;
    try {
      const identity = verify(file, process.platform);
      verified = true;
      const actualArgs = args.slice(1), environment = environmentFromPairs(options.envPairs);
      const cwd = options.cwd ?? process.cwd();
      const plan = { executable: file, binarySha256: identity.binarySha256,
        configArguments: configArguments(actualArgs), environment, cwd, recordedRouting: identity.recorded === true };
      launchPlans.set(this, plan);
      const preparedPolicy = preparePolicy(plan);
      if (!preparedPolicy.policy) {
        reason = 'backend_config_pending';
        trackWaiting(this, preparedPolicy.key);
        dispatched = true;
        const result=originalSpawn.call(this, options);
        try { if(Number.isInteger(this.pid)&&this.pid>0)dependencies.observeBackend?.(this,{fresh:true}); }catch{/* Passive observation cannot change a Native spawn result. */}
        return result;
      }
      const policy = preparedPolicy.policy;
      const { additionalCaPem, providers, providerRoutes } = preparedPolicy.entry;
      reservations = preparedPolicy.entry.reservations;
      // Claim this exact prepared set. It belongs to this child from dispatch;
      // later policy replacement/retirement cannot close another child's routes.
      policies.delete(preparedPolicy.key);
      const launch = prepare({ executable: file, arguments: actualArgs, originalEnvironment: environment, providerRoutes, platform: process.platform,
        compatibility: { ...identity, contract: policy.contract } });
      const next = { ...options, args: [args[0], ...launch.arguments] };
      dispatched = true;
      const result = originalSpawn.call(this, next);
      try { if(verified&&Number.isInteger(this.pid)&&this.pid>0)dependencies.observeBackend?.(this,{fresh:true}); }catch{/* Passive observation cannot change a Native spawn result. */}
      reason = null;
      owned.add(this); trustByProcess.set(this, additionalCaPem);
      providersByProcess.set(this, new Set(['openai', ...Object.keys(policy.providerBaseUrls ?? {})]));
      const authRoutes = [...providers.keys()].flatMap((setting,index) => setting === 'openai_base_url'
        ? policy.openaiBaseUrl == null ? [reservations[index]] : []
        : policy.providerAuthDefaults?.[providerName(setting)] === true ? [reservations[index]] : []);
      const accountRoute = Object.freeze({
        update: value => Promise.all(authRoutes.map(route => route.update(value))),
        close: () => Promise.all(authRoutes.map(route => Promise.resolve(route.close()).catch(()=>{}))),
      });
      accountByProcess.set(this, { route: accountRoute, explicit: authRoutes.length === 0,
        current: policy.accountType === 'chatgpt' ? DEFAULT_CHATGPT : DEFAULT_OPENAI, pending: null });
      prepared++;state.prepared=prepared;
      const ready = Promise.all(reservations.map(item => item.ready));
      ready.catch(() => { reason = 'route_unavailable'; }); pending.add(ready); ready.finally(() => pending.delete(ready)).catch(() => {});
      const record={child:this,reservations,compatibility:{binarySha256:identity.binarySha256,contract:policy.contract}};state.records.add(record);
      if(shared&&dependencies.trackBackend) dependencies.trackBackend(record,{methodKey:'method',method:'account/updated',paramsKey:'params',modeKey:'authMode',targets:{chatgpt:DEFAULT_CHATGPT,apiKey:DEFAULT_OPENAI}});
      else {const release = () => { for (const item of reservations) closeRoute(item); active.delete(release);state.records.delete(record); };
        active.add(release); this.once('exit', release); this.once('error', release);}
      return result;
    } catch (error) {
      for (const item of reservations) closeRoute(item);
      declined++; reason = ['backend_identity_unavailable', 'backend_identity_changed', 'backend_contract_unavailable', 'backend_routing_contract_unavailable',
        'backend_config_unavailable', 'backend_config_timeout', 'backend_config_too_large', 'backend_probe_cleanup_failed', 'backend_provider_unsupported',
        'backend_auth_mode_unsupported', 'backend_provider_trust_unsupported', 'backend_route_unavailable'].includes(error.code) ? error.code : 'route_unavailable';
      if (dispatched) throw error;
      const result=originalSpawn.call(this, options);
      try { if(verified&&Number.isInteger(this.pid)&&this.pid>0)dependencies.observeBackend?.(this,{fresh:true}); }catch{/* Passive observation cannot change a Native spawn result. */}
      return result;
    }
  }
  prototype.spawn = wrapped;
  return Object.freeze({
    async ready() {
      // These are already-dispatched managed policy/route operations. Readiness
      // observes their original completion; it never closes a Native child.
      await Promise.allSettled([...preparing,...pending]);
      return this.inspect();
    },
    close() {
      if (closed) return Promise.allSettled([...preparing]);
      closed = true; controller.abort(); for (const entry of policies.values()) releasePolicy(entry); policies.clear(); waitingChildren.clear();
      if (prototype.spawn === wrapped) prototype.spawn = originalSpawn;
      if (!shared) for (const release of active) release();
      return Promise.allSettled([...preparing]);
    },
    ownsProcess: child => !closed && !!child && owned.has(child),
    canRecover,
    async prepareConnection(transport, { forRestart = false } = {}) {
      const child = transport?.proc;
      if (closed || !child || owned.has(child) && !forRestart) return;
      try { dependencies.observeBackend?.(child); }catch{/* A late owner remains explicitly unobserved. */}
      let plan = launchPlans.get(child);
      if (!plan) {
        const options = transport.options, file = child.spawnfile;
        if (typeof file !== 'string' || !path.isAbsolute(file) || !/^codex(?:\.exe)?$/iu.test(path.basename(file)) ||
          !Array.isArray(child.spawnargs) || !options?.env || typeof options.env !== 'object' ||
          Object.values(options.env).some(value => typeof value !== 'string')) return;
        const identity = verify(file, process.platform);
        plan = { executable: file, binarySha256: identity.binarySha256,
          configArguments: configArguments(child.spawnargs.slice(1)), environment: options.env,
          cwd: options.cwd ?? process.cwd(), recordedRouting: identity.recorded === true };
        launchPlans.set(child, plan);
      }
      const preparedPolicy = preparePolicy(plan, { retryFailed: forRestart });
      trackWaiting(child, preparedPolicy.key);
      if (preparedPolicy.work) await preparedPolicy.work;
      if(closed)throw fail('backend_owner_closed');
      const entry=policies.get(preparedPolicy.key);
      if(entry?.error)throw entry.error;
      if(!entry?.value)throw fail('backend_config_unavailable');
    },
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
    inspect: () => ({ installed: !closed, backendRootsPrepared: prepared, backendRootsDeclined: declined, probeDiagnostic,policyPending:preparing.size,
      policyReady: [...waitingChildren].some(canRecover),
      available: state.records.size > 0 && !reason, reason: reason ?? (state.records.size ? null : 'child_unavailable') }),
  });
}
module.exports = { installBackendSpawn, effectiveProviders, configArguments, lastStringOverride, environmentFromPairs, providerTrust };
