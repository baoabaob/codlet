'use strict';
// Serialized into the pinned Node helper. Only bounded routing metadata leaves
// the helper; all child requests are read-only and use the selected executable.
function runConfigProbe() {
  const fs = require('node:fs'), { spawn } = require('node:child_process'), { randomBytes } = require('node:crypto');
  const fail = code => Object.assign(new Error(code), { code });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const until = Date.now() + 3500;
  let liveChild;
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
    if (Date.now() >= until) throw fail('backend_config_timeout');
    const child = spawn(plan.executable, [...plan.configArguments, ...overrides,
      '-c', 'analytics.enabled=false', '-c', 'features.code_mode_host=false', '-c', 'features.remote_plugin=false',
      'app-server', '--stdio'], { env: plan.environment, cwd: plan.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChild = child;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false, buffer = '', count = 0, expected = 1, config;
        const timer = setTimeout(() => finish(fail('backend_config_timeout')), Math.max(1, until - Date.now()));
        function finish(error, result) {
          if (settled) return;
          settled = true; clearTimeout(timer); error ? reject(error) : resolve(result);
        }
        const send = message => child.stdin.write(JSON.stringify(message) + '\n');
        child.stderr.on('data', () => {});
        child.on('error', () => finish(fail('backend_config_unavailable')));
        child.stdin.on('error', () => finish(fail('backend_config_unavailable')));
        child.once('exit', () => finish(fail('backend_config_unavailable')));
        child.stdout.on('data', chunk => {
          if (settled) return;
          count += chunk.length;
          if (count > 2 * 1024 * 1024) { finish(fail('backend_config_too_large')); return; }
          buffer += chunk.toString(); let at;
          while (!settled && (at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            let message; try { message = JSON.parse(line); } catch { continue; }
            if (!object(message) || message.id !== expected) continue;
            if (message.error || !object(message.result)) { finish(fail('backend_contract_unavailable')); return; }
            if (expected === 1) {
              if (typeof message.result.userAgent !== 'string' || !message.result.userAgent || message.result.userAgent.length > 4096) {
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
  (async () => {
    const bytes = fs.readFileSync(0);
    if (bytes.length > 256 * 1024) throw fail('backend_config_unavailable');
    const plan = JSON.parse(bytes);
    if (!object(plan) || typeof plan.executable !== 'string' || typeof plan.cwd !== 'string'
      || !object(plan.environment) || !Array.isArray(plan.configArguments) || plan.configArguments.length > 256
      || plan.configArguments.some(value => typeof value !== 'string')) throw fail('backend_config_unavailable');
    const { config, accountType } = await read(plan, [], true);
    if (config.model_providers != null && !object(config.model_providers)
      || config.model_provider != null && typeof config.model_provider !== 'string'
      || config.openai_base_url != null && typeof config.openai_base_url !== 'string') throw fail('backend_contract_unavailable');
    const providers = {};
    for (const [name, provider] of Object.entries(config.model_providers ?? {})) {
      if (typeof provider?.base_url !== 'string' || provider.wire_api !== 'responses') continue;
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name) || Object.keys(providers).length >= 16) throw fail('backend_provider_unsupported');
      providers[name] = provider.base_url;
    }
    const settings = ['openai_base_url', ...Object.keys(providers).map(name => `model_providers.${name}.base_url`)];
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
      accountType: accountType == null || ['chatgpt', 'apiKey'].includes(accountType) ? accountType : 'unknown',
      contract: { api: 1, initialize: true, configRead: true, accountRead: true, routing: plan.recordedRouting === true ? 'recorded' : 'runtime', providerOverrides: settings } };
  })().catch(async error => {
    try { await stop(liveChild); } catch { return { error: 'backend_probe_cleanup_failed' }; }
    return { error: /^backend_[a-z_]+$/u.test(error?.code) ? error.code : 'backend_config_unavailable' };
  }).then(value => {
    process.stdout.write(JSON.stringify(value), () => {
      if (!liveChild || liveChild.exitCode !== null || liveChild.signalCode !== null) process.exit(0);
    });
  });
}
module.exports = { runConfigProbe };
