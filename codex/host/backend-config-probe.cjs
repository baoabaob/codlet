'use strict';
// Serialized into a fixed --eval helper under Codlet's pinned Node. Input and
// output use pipes, not argv; stderr from the original backend is never forwarded.
function runConfigProbe() {
  const fs = require('node:fs'), { spawn } = require('node:child_process'), { createInterface } = require('node:readline');
  let child, lines, emitted = false;
  const finish = async value => {
    if (emitted) return; emitted = true; clearTimeout(deadline); lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin?.end(); child.kill();
      let stopTimer;
      await Promise.race([exited, new Promise(resolve => { stopTimer = setTimeout(resolve, 650); })]);
      clearTimeout(stopTimer);
      if (child.exitCode === null && child.signalCode === null) value = { error: 'backend_config_unavailable' };
    }
    // The pinned Node helper may retain an inherited handle after the probe
    // child exits. Flush the bounded result, then terminate only this helper;
    // the parent remains blocked in spawnSync until that exit is observed.
    process.stdout.write(JSON.stringify(value), () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) process.exit(0);
    });
  };
  const deadline = setTimeout(() => finish({ error: 'backend_config_timeout' }), 3500);
  try {
    const bytes = fs.readFileSync(0); if (bytes.length > 256 * 1024) throw new Error();
    const plan = JSON.parse(bytes);
    child = spawn(plan.executable, [...plan.configArguments, '-c', 'analytics.enabled=false', '-c', 'features.code_mode_host=false', '-c', 'features.remote_plugin=false', 'app-server', '--stdio'], { env: plan.environment, cwd: plan.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', () => {}); child.on('error', () => finish({ error: 'backend_config_unavailable' }));
    child.stdin.on('error', () => finish({ error: 'backend_config_unavailable' }));
    child.once('exit', () => { if (!emitted) finish({ error: 'backend_config_unavailable' }); });
    let buffer = '', count = 0;
    child.stdout.on('data', chunk => {
      count += chunk.length; if (count > 2 * 1024 * 1024) { finish({ error: 'backend_config_too_large' }); return; }
      buffer += chunk.toString(); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { finish({ error: 'backend_config_unavailable' }); return; }
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'config/read', params: { cwd: plan.cwd, includeLayers: false } }) + '\n');
        } else if (message.id === 2) {
          if (message.error || !message.result?.config) { finish({ error: 'backend_config_unavailable' }); return; }
          const config = message.result.config;
          // Read the effective, layered settings from the unmodified backend.
          // The parent only receives routing metadata; credentials stay in the
          // backend's original environment and auth store.
          const providers = {};
          for (const [name, provider] of Object.entries(config.model_providers ?? {}))
            if (typeof provider?.base_url === 'string' && provider.wire_api === 'responses') providers[name] = provider.base_url;
          plan.config = { modelProvider: config.model_provider ?? 'openai', providerBaseUrls: providers,
            openaiBaseUrl: config.openai_base_url ?? null };
          child.stdin.write(JSON.stringify({ id: 3, method: 'account/read', params: { refreshToken: false } }) + '\n');
        } else if (message.id === 3) {
          // The auth mode chooses the built-in provider's default origin.
          // Account contents and credentials never leave this probe.
          if (message.error || !message.result) { finish({ error: 'backend_config_unavailable' }); return; }
          const kind = message.result.account?.type;
          finish({ ...plan.config, accountType: kind == null ? null : kind === 'chatgpt' || kind === 'apiKey' ? kind : 'unknown' });
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codlet-launch-policy', version: '1' }, capabilities: { experimentalApi: true } } }) + '\n');
  } catch { finish({ error: 'backend_config_unavailable' }); }
}
module.exports = { runConfigProbe };
