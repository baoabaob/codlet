'use strict';
// Serialized into the metadata worker. Only routing metadata leaves
// the worker; all protocol requests are read-only and use the selected executable.
// App Server initialization writes SQLite state, so probes own a disposable state
// directory while preserving the actual configuration and account context.
function runConfigProbe(input, dependencies = {}) {
  const fs = require('node:fs'), spawn = dependencies.spawn ?? require('node:child_process').spawn, { randomBytes } = require('node:crypto');
  const path = require('node:path'), os = require('node:os');
  const fail = code => Object.assign(new Error(code), { code });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const started = Date.now(), until = dependencies.deadlineUnixMs ?? started + 3500;
  const signal = dependencies.signal;
  let liveChild, probeDiagnostic = null, stateRoot;
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin?.end();
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 150); })]);
    clearTimeout(timer);
    if(child.exitCode!==null||child.signalCode!==null)return;
    child.kill();
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 650); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) throw fail('backend_probe_cleanup_failed');
  }
  async function read(plan, overrides, includeAccount) {
    if (signal?.aborted) throw fail('backend_probe_cancelled');
    if (Date.now() >= until) throw fail('backend_config_timeout');
    const environment = Object.fromEntries(Object.entries(plan.environment).filter(([name]) => name.toUpperCase() !== 'CODEX_SQLITE_HOME'));
    environment.CODEX_SQLITE_HOME = stateRoot;
    const child = spawn(plan.executable, [...plan.configArguments, ...overrides, '-c', `sqlite_home=${JSON.stringify(stateRoot)}`,
      '-c', 'analytics.enabled=false', '-c', 'features.code_mode_host=false', '-c', 'features.remote_plugin=false',
      'app-server', '--stdio'], { env: environment, cwd: plan.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChild = child;
    try {
      return await new Promise((resolve, reject) => {
        const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
        let settled = false, buffer = '', expected = 1, config;
        const abort = () => finish(fail('backend_probe_cancelled'));
        const timer = setTimeout(() => finish(fail('backend_config_timeout'),undefined,{outcome:'timeout'}), Math.max(1, until - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
        function finish(error, result, detail = {}) {
          if (settled) return;
          if(error)probeDiagnostic={phase:expected===1?'initialize':expected===2?'config':'account',outcome:detail.outcome??'reply_error',
            exitCode:Number.isInteger(detail.exitCode)?detail.exitCode:null,
            systemCode:typeof detail.systemCode==='string'&&/^[A-Z_0-9]{1,40}$/.test(detail.systemCode)?detail.systemCode:null};
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result);
        }
        const send = message => child.stdin.write(JSON.stringify(message) + '\n');
        child.stderr.on('data', () => {});
        child.on('error', error => finish(fail('backend_config_unavailable'),undefined,{outcome:'spawn_error',systemCode:error.code}));
        child.stdin.on('error', error => finish(fail('backend_config_unavailable'),undefined,{outcome:'stdin_error',systemCode:error.code}));
        child.once('exit', code => finish(fail('backend_config_unavailable'),undefined,{outcome:'child_exit',exitCode:code}));
        child.stdout.on('data', chunk => {
          if (settled) return;
          buffer += decoder.write(chunk); let at;
          while (!settled && (at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            let message; try { message = JSON.parse(line); } catch { continue; }
            if (!object(message) || message.id !== expected) continue;
            if (message.error || !object(message.result)) { finish(fail('backend_contract_unavailable')); return; }
            if (expected === 1) {
              if (typeof message.result.userAgent !== 'string' || !message.result.userAgent) {
                finish(fail('backend_contract_unavailable')); return;
              }
              expected = 2;
              send({ method: 'initialized', params: {} });
              send({ id: 2, method: 'config/read', params: { cwd: plan.cwd, includeLayers: false } });
            } else if (expected === 2) {
              config = message.result.config;
              if (!object(config)) { finish(fail('backend_contract_unavailable')); return; }
              if (!includeAccount) { finish(null, { config }); return; }
              expected = 3;
              send({ id: 3, method: 'account/read', params: { refreshToken: false } });
            } else {
              const account = message.result.account;
              if (account !== null && (!object(account) || typeof account.type !== 'string')) { finish(fail('backend_contract_unavailable')); return; }
              finish(null, { config, accountType: account?.type ?? null });
            }
          }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codlet-launch-policy', version: '1' }, capabilities: { experimentalApi: true } } });
      });
    } finally { await stop(child); liveChild = null; }
  }
  const work = (async () => {
    if (!Number.isSafeInteger(until) || until > started + 30000) throw fail('backend_config_unavailable');
    let plan = input;
    if (plan === undefined) {
      const bytes = fs.readFileSync(0);
      plan = JSON.parse(bytes);
    }
    if (!object(plan) || typeof plan.executable !== 'string' || typeof plan.cwd !== 'string'
      || !object(plan.environment) || !Array.isArray(plan.configArguments)
      || plan.configArguments.some(value => typeof value !== 'string')) throw fail('backend_config_unavailable');
    stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'codlet-config-probe-'));
    const { config, accountType } = await read(plan, [], true);
    if (config.model_providers != null && !object(config.model_providers)
      || config.model_provider != null && typeof config.model_provider !== 'string'
      || config.openai_base_url != null && typeof config.openai_base_url !== 'string') throw fail('backend_contract_unavailable');
    const providers = Object.create(null), providerAuthDefaults = Object.create(null);
    for (const [name, provider] of Object.entries(config.model_providers ?? {})) {
      if (provider?.wire_api !== 'responses') continue;
      const defaultEndpoint = provider.base_url == null && provider.auth == null && provider.gateway_oauth == null && provider.aws == null;
      if (typeof provider.base_url !== 'string' && !defaultEndpoint) continue;
      providers[name] = defaultEndpoint ? null : provider.base_url;
      if (defaultEndpoint) providerAuthDefaults[name] = provider.requires_openai_auth === true;
    }
    const settings = ['openai_base_url', ...Object.keys(providers).map(name => `model_providers.${/^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name)}.base_url`)];
    // Recorded implementations already have routing evidence. A new file must
    // accept and return every required override in a second read-only process.
    if (plan.recordedRouting !== true) {
      const marker = `http://127.0.0.1:9/codlet-capability-${randomBytes(12).toString('hex')}/`;
      const overrides = settings.flatMap(setting => ['-c', `${setting}=${JSON.stringify(marker)}`]);
      const observed = (await read(plan, overrides, false)).config;
      if (observed.openai_base_url !== marker || Object.keys(providers).some(name => observed.model_providers?.[name]?.base_url !== marker
        || observed.model_providers[name].wire_api !== 'responses')) throw fail('backend_routing_contract_unavailable');
    }
    return { modelProvider: config.model_provider ?? 'openai', providerBaseUrls: providers, openaiBaseUrl: config.openai_base_url ?? null,
      ...(Object.keys(providerAuthDefaults).length ? { providerAuthDefaults } : {}),
      accountType: accountType == null || ['chatgpt', 'apiKey'].includes(accountType) ? accountType : 'unknown',
      contract: { api: 1, initialize: true, configRead: true, accountRead: true, routing: plan.recordedRouting === true ? 'recorded' : 'runtime', providerOverrides: settings } };
  })().catch(async error => {
    try { await stop(liveChild); } catch { return { error: 'backend_probe_cleanup_failed' }; }
    return { error: /^backend_[a-z_]+$/u.test(error?.code) ? error.code : 'backend_config_unavailable' };
  }).then(value => {
    if (stateRoot) {
      try {
        if (liveChild && liveChild.exitCode === null && liveChild.signalCode === null) throw fail('backend_probe_cleanup_failed');
        const inspect = directory => {
          if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw fail('backend_probe_cleanup_failed');
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw fail('backend_probe_cleanup_failed');
            if (entry.isDirectory()) inspect(path.join(directory, entry.name));
          }
        };
        inspect(stateRoot);
        fs.rmSync(stateRoot, { recursive: true });
      } catch { return { error: 'backend_probe_cleanup_failed' }; }
    }
    return value;
  });
  if (input !== undefined) return work.then(value => {
    if (value.error) throw Object.assign(fail(value.error),{probeDiagnostic:probeDiagnostic??{phase:'setup',outcome:'validation',exitCode:null,systemCode:null}});
    return value;
  });
  work.then(value => {
    process.stdout.write(JSON.stringify(value), () => {
      if (!liveChild || liveChild.exitCode !== null || liveChild.signalCode !== null) process.exit(0);
    });
  });
}
function runConfigProbeInWorker(plan, { signal, deadlineUnixMs } = {}) {
  const { Worker } = require('node:worker_threads');
  const fail = code => Object.assign(new Error(code), { code });
  if (signal?.aborted) return Promise.reject(fail('backend_probe_cancelled'));
  // Native can synchronously provision runtimes during startup. The probe's
  // timers, pipe reads and child retirement must continue independently of that
  // event loop. The worker publishes a result only after its children retire.
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    const controller = new AbortController();
    parentPort.on('message', value => { if (value === 'cancel') controller.abort(); });
    (${runConfigProbe.toString()})(workerData.plan, {signal: controller.signal, deadlineUnixMs: workerData.deadlineUnixMs})
      .then(value => parentPort.postMessage({value}), error => parentPort.postMessage({
        error: /^backend_[a-z_]+$/.test(error?.code) ? error.code : 'backend_config_unavailable',
        probeDiagnostic: error?.probeDiagnostic ?? null
      })).finally(() => parentPort.close());`;
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(source, { eval: true, execArgv: [], workerData: { plan, deadlineUnixMs }, name: 'codlet-config-probe' }); }
    catch { reject(fail('backend_config_unavailable')); return; }
    let result, failed = false, retiring = false;
    const cancel = () => worker.postMessage('cancel');
    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', value => {
      result = value;
      // The receipt follows child retirement and directory cleanup. Explicitly
      // retire this owned worker instead of waiting for embedding-owned handles.
      // A failed child cleanup must retain its owner until it actually exits.
      if (value.error !== 'backend_probe_cleanup_failed') {
        retiring = true;
        worker.terminate().catch(() => { failed = true; });
      }
    });
    worker.once('error', () => { failed = true; });
    worker.once('exit', code => {
      signal?.removeEventListener('abort', cancel);
      if (failed || code !== 0 && !(retiring && code === 1) || !result) reject(fail('backend_config_unavailable'));
      else if (result.error) reject(Object.assign(fail(result.error), { probeDiagnostic: result.probeDiagnostic }));
      else if (signal?.aborted) reject(fail('backend_probe_cancelled'));
      else resolve(result.value);
    });
    if (signal?.aborted) cancel();
  });
}
module.exports = { runConfigProbe, runConfigProbeInWorker };
