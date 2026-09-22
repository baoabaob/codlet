// Explicit, isolated live verification. All diagnostics are counters/booleans.
// Never imports user config/history, persists raw traffic, or uses fixture keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const core = require('../runtime/host-traffic-bundle.cjs');
const [cli, authSource, adapterPath, consent] = process.argv.slice(2);
const httpOnly = process.argv.includes('--http-only'), resume = process.argv.includes('--resume');
const rewriteResponse = process.argv.includes('--rewrite-response'), marker = '[Codlet verified] ';
const appServer = process.argv.includes('--app-server');
const markedItems = new Set();
if (consent !== '--run-live' || ![cli, authSource, adapterPath].every(value => value && path.isAbsolute(value))) throw new Error('Pass absolute CLI, auth source, Adapter paths and --run-live');
if (process.platform !== 'win32') throw new Error('This live harness has only a Windows upstream resolver');
const adapter = require(adapterPath);
const base = fileURLToPath(new URL('../.codlet-artifacts/transparent-traffic/', import.meta.url));
await fs.mkdir(base, { recursive: true });
const directory = await fs.mkdtemp(path.join(base, 'live-'));
const home = path.join(directory, 'home'); await fs.mkdir(home, { mode: 0o700 });
assert.equal(path.dirname(directory), path.resolve(base));
assert.equal(path.dirname(home), directory);
const origin = 'https://chatgpt.com';
const root = new AbortController();
const counts = { requests: 0, responseHeaders: 0, responseBytes: 0, clientFrames: 0, serverFrames: 0, modifiedRequests: 0, authenticatedRequests: 0, modelRequests: 0, modelLists: 0, upstreamCompleted: 0, otherBlocked: 0, blockedWebsocketAttempts: 0, turnCompleted: false, turnsCompleted: 0, resumedAfterEnablingInterceptor: false, toolEvents: 0, childExit: null, timedOut: false };
counts.modifiedResponseFrames = 0; counts.clientSawResponseMarker = false;
const responseStatuses = {};
const upstreamHttpStatuses = {};
const upstreamErrorKinds = {}, nativeErrorKinds = {};
const requestEncodings = {}, requestDecodeFailures = {};
let availableModels = [], selectedModel = null;
function classifyError(error, destination) {
  const text = String(error?.message ?? error ?? '');
  const kind = /tool_choice|tool choice/i.test(text) ? 'tool_choice' : /parallel_tool_calls/i.test(text) ? 'parallel_tool_calls' : /model.*(not found|not supported|does not exist|access)|unsupported.*model/i.test(text) ? 'model_unavailable' : /usage.limit|quota|rate.limit/i.test(text) ? 'quota_or_rate_limit' : /unauthorized|authentication|401|invalid.token/i.test(text) ? 'authentication' : /invalid|unsupported|unknown.*field/i.test(text) ? 'invalid_request' : 'unclassified';
  destination[kind] = (destination[kind] ?? 0) + 1;
}
let ingress, prepared, child, runtime, registry, route, diagnostic = 'not_started';
const files = ['ca-key.pem', 'leaf-key.pem', 'ca.pem', 'leaf.pem', 'leaf.csr', 'leaf.cnf'];
try {
  // Snapshot the original upstream BEFORE configuring the child proxy. PAC is
  // resolved by the OS for this exact destination; errors never fall back direct.
  const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const explicit = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.all_proxy ?? process.env.ALL_PROXY;
  const resolved = explicit ?? JSON.parse((await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $trafficTarget=[Uri]'https://chatgpt.com/backend-api/codex/responses'; $trafficProxy=[System.Net.WebRequest]::GetSystemWebProxy(); if ($trafficProxy.IsBypassed($trafficTarget)) { ConvertTo-Json -InputObject $null -Compress } else { $trafficProxy.GetProxy($trafficTarget).AbsoluteUri | ConvertTo-Json -Compress }"], { windowsHide: true, timeout: 10000 })).stdout);
  let proxySecret;
  if (resolved) {
    const proxy = new URL(resolved);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('unsupported_upstream_proxy');
    if (proxy.username || proxy.password) { proxySecret = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`; proxy.username = ''; proxy.password = ''; }
    route = { proxyUrl: proxy.href, ...(proxySecret ? { proxyCredentialRef: 'inherited-proxy' } : {}) };
  } else route = { proxyUrl: null };
  const inheritedCa = process.env.CODEX_CA_CERTIFICATE ?? process.env.SSL_CERT_FILE;
  if (inheritedCa) route.caPem = await fs.readFile(inheritedCa, 'utf8');
  // Refuse a stale login snapshot. Refresh is intentionally excluded so this
  // experiment cannot rotate the credentials used by the user's live client.
  const auth = JSON.parse(await fs.readFile(authSource, 'utf8'));
  const claims = JSON.parse(Buffer.from(auth.tokens?.access_token?.split('.')[1] ?? '', 'base64url'));
  if (auth.auth_mode !== 'chatgpt' || typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000 + 600) throw new Error('fresh_official_login_required');
  auth.tokens.refresh_token = ''; // Current access token only; no refresh flow.
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
  const openssl = 'C:/Program Files/Git/usr/bin/openssl.exe';
  const ssl = args => exec(openssl, args, { cwd: directory, windowsHide: true, timeout: 15000, maxBuffer: 32768 });
  await ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Codlet ephemeral verification CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await ssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf-key.pem', '-out', 'leaf.csr', '-subj', '/CN=chatgpt.com']);
  await fs.writeFile(path.join(directory, 'leaf.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:chatgpt.com\n');
  await ssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca-key.pem', '-set_serial', String(Date.now()), '-days', '2', '-out', 'leaf.pem', '-extfile', 'leaf.cnf']);
  const cert = await fs.readFile(path.join(directory, 'leaf.pem')), key = await fs.readFile(path.join(directory, 'leaf-key.pem'));
  runtime = core.createTrafficRuntime({ rootSignal: root.signal, makeError: (code, message, data) => Object.assign(new Error(message), { code, data }), async coreRequest(method, value) {
    if (method === 'host.network.authorizeChannel') return {};
    if (method === 'services.credentials.resolve' && value.reference === 'inherited-proxy') return { secret: proxySecret };
    const url = new URL(value.url); if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.origin !== origin) throw new Error('origin_denied');
    if (method === 'host.network.authorizeForward') return { url: value.url };
    if (method === 'services.network.resolve') return route;
    throw new Error('method_denied');
  } });
  registry = core.createTrafficInterceptors({ rootSignal: root.signal, networkProfile: 'saved-upstream', authorize: async (_owner, action, url) => action !== 'redirect' && new URL(url).hostname === 'chatgpt.com' });
  function noTools(value) {
    if (value && typeof value === 'object' && (value.type === undefined || value.type === 'response.create')) {
      value.instructions = (typeof value.instructions === 'string' ? value.instructions : '') + '\nReply with exactly OK. Do not call any tools.';
      value.tools = []; value.tool_choice = 'none'; counts.modifiedRequests++;
      if (typeof value.model === 'string' && availableModels.length) { selectedModel = availableModels.includes(value.model) ? value.model : availableModels[0]; value.model = selectedModel; }
    }
    return value;
  }
  const registration = registry.register({ pluginId: 'live-verification', generation: 1, signal: root.signal }, { id: 'model', origins: [origin], timeoutMs: 2000 }, {
    async request(request) {
      counts.requests++;
      if (request.headers.some(([name]) => name.toLowerCase() === 'authorization')) counts.authenticatedRequests++;
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith('/models')) { counts.modelLists++; return null; }
      if (!pathname.endsWith('/responses')) { counts.otherBlocked++; return { block: true }; }
      counts.modelRequests++;
      const encoding = request.headers.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1] ?? 'identity';
      const category = ['gzip', 'br', 'deflate', 'zstd', 'identity'].includes(encoding) ? encoding : 'other'; requestEncodings[category] = (requestEncodings[category] ?? 0) + 1;
      try { return { request: adapter.rewrittenCodexJsonBody(request, noTools(await adapter.readCodexJsonBody(request))) }; }
      catch (error) { const code = ['codex_body_too_large', 'codex_encoding_unsupported', 'codex_body_invalid'].includes(error.code) ? error.code : 'probe_decode_failed'; requestDecodeFailures[code] = (requestDecodeFailures[code] ?? 0) + 1; return { respond: { status: 400, body: 'probe_decode_failed' } }; }
    },
    response(response, context) {
      counts.responseHeaders++; responseStatuses[response.status] = (responseStatuses[response.status] ?? 0) + 1;
      if (context.source === 'upstream') upstreamHttpStatuses[response.status] = (upstreamHttpStatuses[response.status] ?? 0) + 1;
      const models = new URL(context.request.url).pathname.endsWith('/models');
      return { body: (async function* () {
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) { counts.responseBytes += chunk.length; if (models) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('model_catalog_limit'); chunks.push(Buffer.from(chunk)); } else yield chunk; }
        if (models) {
          const raw = Buffer.concat(chunks), encoding = response.headers.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1];
          const decode = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[encoding];
          const json = JSON.parse(decode ? decode(raw, { maxOutputLength: 4 * 1024 * 1024 }) : raw);
          availableModels = (json.models ?? []).map(value => value.slug).filter(value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,80}$/u.test(value));
          yield raw;
        }
      })() };
    },
    webSocket(request) {
      counts.requests++; counts.modelRequests++;
      if (request.headers.some(([name]) => name.toLowerCase() === 'authorization')) counts.authenticatedRequests++;
      if (httpOnly) { counts.blockedWebsocketAttempts++; return { block: true }; }
      return { clientToServer(frame) { counts.clientFrames++; if (frame.binary) return frame; return { binary: false, data: JSON.stringify(noTools(JSON.parse(frame.data))) }; },
        serverToClient(frame) {
          counts.serverFrames++; counts.responseBytes += Buffer.byteLength(frame.data);
          if (frame.binary) return frame;
          const event = JSON.parse(frame.data);
          if (event.type === 'response.completed') counts.upstreamCompleted++;
          if (event.error || event.response?.error) classifyError(event.error ?? event.response.error, upstreamErrorKinds);
          if (!rewriteResponse) return frame;
          let changed = false;
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && !markedItems.has(event.item_id)) { markedItems.add(event.item_id); event.delta = marker + event.delta; changed = true; }
          if (event.type === 'response.output_text.done' && typeof event.text === 'string') { event.text = marker + event.text; changed = true; }
          for (const item of [event.item, ...(event.response?.output ?? [])]) if (item?.type === 'message') for (const part of item.content ?? []) if (part.type === 'output_text' && typeof part.text === 'string') { part.text = marker + part.text; changed = true; }
          if (changed) { counts.modifiedResponseFrames++; return { binary: false, data: JSON.stringify(event) }; }
          return frame;
        } };
    },
  });
  ingress = await runtime.openProcessIngress({ handlerTimeoutMs: 15000 }, registry.handlers, { origins: [origin], certificateFor: async () => ({ key, cert }), lifetimeMs: 60000 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|https?_proxy|all_proxy|no_proxy|CODEX_CA_CERTIFICATE|SSL_CERT_FILE)$/i.test(name)));
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home });
  prepared = await adapter.prepareCodexBackendTraffic({ core, executable: cli, environment: env, directory, proxyUrl: ingress.proxyUrl, additionalCaPem: await fs.readFile(path.join(directory, 'ca.pem'), 'utf8') });
  const settings = ['model="gpt-6-astra"', 'cli_auth_credentials_store="file"', 'analytics.enabled=false', 'check_for_update_on_startup=false', 'features.apps=false'];
  if (resume) registration.setEnabled(false);
  if (appServer) {
    child = spawn(cli, [...settings.flatMap(value => ['-c', value]), 'app-server'], { cwd: home, env: prepared.environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); let sequence = 0, buffer = '', finishedTurn;
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    exited.catch(() => {});
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      buffer += chunk; if (buffer.length > 4 * 1024 * 1024) { child.kill(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line), call = pending.get(event.id);
          if (call) { pending.delete(event.id); clearTimeout(call.timer); event.error ? call.reject(new Error('backend_rpc_failed')) : call.resolve(event.result); }
          if (event.method === 'item/completed' && event.params?.item?.type === 'agentMessage' && event.params.item.text?.startsWith(marker)) counts.clientSawResponseMarker = true;
          if (event.method === 'item/started' && event.params?.item?.type === 'commandExecution') { counts.toolEvents++; child.kill(); }
          if (event.method === 'turn/completed') { counts.turnCompleted = event.params?.turn?.status === 'completed'; if (counts.turnCompleted) counts.turnsCompleted++; if (event.params?.turn?.error) classifyError(event.params.turn.error, nativeErrorKinds); finishedTurn?.(); }
        } catch {}
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('backend_rpc_timeout')); }, 15000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const deadline = setTimeout(() => { counts.timedOut = true; child.kill(); finishedTurn?.(); }, 45000);
    try {
      await rpc('initialize', { clientInfo: { name: 'codlet-traffic-verification', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      const account = await rpc('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') throw new Error('fresh_official_login_required');
      const configured = await rpc('config/read', { cwd: home, includeLayers: false });
      counts.effectiveSystemProxyFeature = configured.config?.features?.respect_system_proxy ?? null;
      const started = await rpc('thread/start', { cwd: home, model: 'gpt-6-astra', approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: false });
      counts.builtinProviderPreserved = started.modelProvider === 'openai';
      if (!counts.builtinProviderPreserved) throw new Error('unexpected_provider');
      for (let index = 0; index < (resume ? 2 : 1); index++) {
        if (index) { registration.setEnabled(true); ingress.disconnect(); counts.connectionsReopenedOnEnable = true; }
        counts.turnCompleted = false;
        const finished = new Promise(resolve => { finishedTurn = resolve; });
        await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Reply with exactly OK. Do not call any tools.', text_elements: [] }] });
        await finished; finishedTurn = undefined;
        if (!counts.turnCompleted) break;
        if (index) counts.resumedAfterEnablingInterceptor = true;
      }
      child.stdin.end();
      const stop = setTimeout(() => child.kill(), 3000);
      try { counts.childExit = await exited; } finally { clearTimeout(stop); }
    } finally {
      clearTimeout(deadline);
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('backend_stopped')); }
      pending.clear();
    }
  } else {
  async function turn(isResume) {
  counts.turnCompleted = false;
  const options = ['--skip-git-repo-check', ...(!resume ? ['--ephemeral'] : []), '--ignore-user-config', '--ignore-rules', '--json', ...settings.flatMap(value => ['-c', value])];
  const args = isResume ? ['exec', 'resume', '--last', ...options, 'Reply with exactly OK again. Do not call any tools.'] : ['exec', ...options, '--sandbox', 'read-only', 'Reply with exactly OK. Do not call any tools.'];
  child = spawn(cli, args, { cwd: home, env: prepared.environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk; if (buffer.length > 1024 * 1024) { diagnostic = 'output_limit'; child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const event = JSON.parse(line); if (event.type === 'turn.completed') { counts.turnCompleted = true; counts.turnsCompleted++; } if (event.item?.type === 'agent_message' && event.item.text?.startsWith(marker)) counts.clientSawResponseMarker = true; if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') classifyError(event.error ?? event.item ?? event, nativeErrorKinds); if (event.item?.type === 'command_execution') { counts.toolEvents++; child.kill(); } } catch {} }
  });
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => { counts.timedOut = true; child.kill(); }, 45000);
  try { counts.childExit = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); }
  finally { clearTimeout(timer); }
  }
  await turn(false);
  if (resume && counts.turnCompleted && counts.childExit === 0) { registration.setEnabled(true); await turn(true); counts.resumedAfterEnablingInterceptor = counts.turnCompleted && counts.childExit === 0; }
  }
  diagnostic = counts.turnCompleted && counts.childExit === 0 && counts.authenticatedRequests > 0 && counts.modifiedRequests > 0 && counts.responseBytes > 0 && (!rewriteResponse || counts.clientSawResponseMarker) ? 'completed' : 'backend_failed';
} catch (error) {
  const known = new Set(['fresh_official_login_required', 'unsupported_upstream_proxy', 'backend_build_unverified', 'invalid_existing_trust', 'invalid_ca_bundle']);
  diagnostic = known.has(error.code) ? error.code : known.has(error.message) ? error.message : 'verification_failed';
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    let timer;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    try { await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); } finally { clearTimeout(timer); }
    if (child.exitCode === null && child.signalCode === null) throw new Error('owned_backend_cleanup_pending');
  }
  root.abort(); if (ingress) await ingress.close(); await prepared?.close();
  await fs.rm(path.join(home, 'auth.json'), { force: true });
  // `home` was checked against the newly created absolute run directory above.
  await fs.rm(home, { recursive: true, force: true });
  for (const file of files) await fs.rm(path.join(directory, file), { force: true });
  const report = { date: new Date().toISOString(), scope: 'isolated-official-backend-live-access-token-no-refresh-no-desktop', backendMode: appServer ? 'app-server-stdio' : 'exec', historyMode: resume ? appServer ? 'same-loaded-thread' : 'resume-from-disk' : 'new-thread', httpFallbackForced: httpOnly, diagnostic, inheritedProxy: !!route?.proxyUrl, tlsValidationDisabled: false, providerOverridden: false, credentialsRemoved: true, selectedModel, modelCandidates: availableModels.length, requestEncodings, requestDecodeFailures, responseStatuses, upstreamHttpStatuses, upstreamErrorKinds, nativeErrorKinds, ...counts, resourcesAfterClose: registry?.status() ?? null };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
assert.equal(diagnostic, 'completed', 'Live verification did not complete; see counters only report');
