// Opt-in research against an unmodified official backend. Synthetic local endpoints only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { childAfterParent } from './process-identity.mjs';
import { fixtureRequestHandler, removeOwnedFixture, writeFixtureReport } from './owned-fixture.mjs';
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const { probeCodexTraffic } = require('../host/codex-traffic.cjs');
if (process.argv.includes('--help')) {
  console.log('Usage: node codex/scripts/verify-plaintext-backend.mjs --run-owned yes --backend ABSOLUTE_CODEX_BINARY [--expected-sha256 LOWERCASE_SHA256] [--routing-ws-only yes]');
  console.log('Windows defaults to its reviewed backend. macOS Apple Silicon requires an explicit backend hash; this driver never changes a production allowlist.');
  console.log('The default run exercises eight synthetic local cases. --routing-ws-only runs the two-thread WebSocket and cold-resume case. Reports are written under .codlet-artifacts/native-tools/request-chain/.');
  process.exit(0);
}
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => i % 2 ? pairs : [...pairs, [value, all[i + 1]]], []));
if (process.platform === 'win32' && process.env.CODLET_TEST_DISPOSABLE_WINDOWS_HOST !== '1') {
  throw Error('Native Windows backend acceptance requires a disposable VM/host and CODLET_TEST_DISPOSABLE_WINDOWS_HOST=1.');
}
const macCandidate = process.platform === 'darwin' && process.arch === 'arm64';
// These fixtures emit synthetic text only and test transports, not shell tools.
// Windows sandbox provisioning owns global users/firewall rules across profiles.
const sandboxMode = process.platform === 'win32' ? 'danger-full-access' : 'read-only';
if (!(process.platform === 'win32' || macCandidate) || options['--run-owned'] !== 'yes' || !path.isAbsolute(options['--backend'] ?? '')
  || macCandidate && typeof options['--expected-sha256'] !== 'string') throw Error('explicit_supported_backend_required');
if (options['--routing-ws-only'] !== undefined && options['--routing-ws-only'] !== 'yes') throw Error('invalid_case_selector');
const executable = await fs.realpath(options['--backend']);
const reviewedHash = 'bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226';
const expectedHash = options['--expected-sha256'] ?? reviewedHash;
if (!/^[a-f0-9]{64}$/u.test(expectedHash)) throw Error('invalid_expected_backend_sha256');
const actualHash = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
assert.equal(actualHash, expectedHash, 'backend hash does not match the explicit fixture candidate');
const report = { schema: 1, platform: process.platform, arch: process.arch, backendSha256: actualHash, sandboxMode,
  ...(!probeCodexTraffic({ platform: process.platform, binarySha256: actualHash }).fixtureVerified ? { candidateUnreviewed: true } : {}),
  ...(options['--routing-ws-only'] === 'yes' ? { caseSelector: 'routing-ws-only' } : {}), transport: 'provider-endpoint', proxyConfigured: false, certificateConfigured: false, cases: [] };
const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'codlet-plaintext-'));
const originLog = [];
const sockets = new Set();
const threadIdsByCase = new WeakMap();
const sessionHeaderNames = ['session_id', 'x-session-id', 'x-codex-session-id', 'x-codex-thread-id', 'x-client-request-id', 'x-codex-parent-thread-id', 'conversation_id'];
function sessionHeaderMatches(headers) {
  const known = threadIdsByCase.get(activeCase);
  return Object.fromEntries(sessionHeaderNames.map(name => [name,
    known instanceof Map ? known.get(headers[name]) ?? null : typeof known === 'string' ? headers[name] === known : null]));
}
function sessionRoute(headers) {
  const tag = sessionHeaderMatches(headers)['x-client-request-id'];
  return tag === 'a' || tag === 'b' ? tag : null;
}
let sequence = 0, activeCase, expectedAuthorization;
function responseEvents(text, id) {
  const item = { id: `item-${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
}
// Separate local upstream: proves that request edits are actually dispatched.
const fixtureError = () => { report.fixtureFailure = true; };
const upstream = http.createServer(fixtureRequestHandler(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  activeCase.upstreamRequests = (activeCase.upstreamRequests ?? 0) + 1;
  activeCase.requestRewrite = (activeCase.sessionRouting
    ? body.model === `codlet-upstream-${request.url.slice('/provider-'.length)}`
    : body.model === 'codlet-upstream-fixture') && Array.isArray(body.input);
  (activeCase.destinations ??= []).push(request.url);
  if (activeCase.sessionRouting) {
    activeCase.inFlight = (activeCase.inFlight ?? 0) + 1;
    activeCase.peakInFlight = Math.max(activeCase.peakInFlight ?? 0, activeCase.inFlight);
    await new Promise(resolve => setTimeout(resolve, 80));
    activeCase.inFlight--;
  }
  if (!activeCase.sessionRouting && activeCase.completedTurns === 1) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'synthetic-upstream-error' })); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(responseEvents(activeCase.sessionRouting ? `upstream-plaintext-${request.url.slice('/provider-'.length)}` : 'upstream-plaintext', `response-${++sequence}`)));
}, fixtureError));
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
async function dispatch(body, routeTag = null) {
  const suffix = activeCase.sessionRouting ? routeTag : activeCase.completedTurns % 2 ? 'b' : 'a';
  if (!['a', 'b'].includes(suffix)) throw Error('session_route_missing');
  const response = await fetch(`http://127.0.0.1:${upstream.address().port}/provider-${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: activeCase.sessionRouting ? `codlet-upstream-${suffix}` : 'codlet-upstream-fixture' }), signal: AbortSignal.timeout(3000),
  });
  if (response.status === 503) { activeCase.errorResponseRepaired = true; await response.body.cancel(); return responseEvents('upstream-plaintext', `repaired-${++sequence}`); }
  return response.json();
}
const server = http.createServer(fixtureRequestHandler(async (request, response) => {
  const chunks = []; let size = 0;
  for await (const chunk of request) { chunks.push(chunk); size += chunk.length; if (size > 4 * 1024 * 1024) { request.destroy(); return; } }
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.endsWith('/responses')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(url.pathname.endsWith('/models') ? { models: [], data: [] } : {})); return;
  }
  let bytes = Buffer.concat(chunks);
  const encoding = request.headers['content-encoding'] ?? 'identity';
  if (encoding === 'zstd') bytes = zstdDecompressSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
  if (encoding === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
  const body = JSON.parse(bytes.toString('utf8'));
  (activeCase.requestEncodings ??= []).push(encoding);
  const routeTag = activeCase.sessionRouting ? sessionRoute(request.headers) : null;
  originLog.push({ protocol: 'http', path: url.pathname, model: body.model, inputPresent: Array.isArray(body.input), inputItems: body.input?.length, previousResponseIdPresent: typeof body.previous_response_id === 'string', expectedAuthentication: request.headers.authorization === expectedAuthorization, sessionHeaderMatches: sessionHeaderMatches(request.headers), ...(activeCase.sessionRouting ? { routeTag } : {}) });
  const current = activeCase;
  current.httpRequests++;
  if (current.sessionRouting && !routeTag) { current.unmatched = (current.unmatched ?? 0) + 1; response.writeHead(409); response.end(); return; }
  // An endpoint adapter sees the final wire request before dispatching a
  // modified copy to the separate local upstream above.
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (current.hold) {
    response.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'held', status: 'in_progress', output: [] } }) + '\n\n');
    response.on('close', () => { current.cancelClosed = true; }); return;
  }
  const events = await dispatch(body, routeTag);
  for (const event of events) {
    const encoded = JSON.stringify(event).replaceAll('upstream-plaintext', 'codlet-response-modified');
    const frame = `event: ${event.type}\ndata: ${encoded}\n\n`;
    // Deliberately split SSE frames across writes; the backend must reassemble.
    const cut = Math.floor(frame.length / 2);
    response.write(frame.slice(0, cut));
    await new Promise(resolve => setTimeout(resolve, 5));
    response.write(frame.slice(cut));
  }
  response.end();
}, fixtureError));
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const websocket = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  activeCase.wsHandshakes++;
  const routeTag = activeCase.sessionRouting ? sessionRoute(request.headers) : null;
  originLog.push({ protocol: 'websocket-handshake', path: new URL(request.url, 'http://localhost').pathname, expectedAuthentication: request.headers.authorization === expectedAuthorization, sessionHeaderMatches: sessionHeaderMatches(request.headers), ...(activeCase.sessionRouting ? { routeTag, phase: activeCase.phase, threadHeaderPresent: typeof request.headers['x-client-request-id']==='string' } : {}) });
  if (activeCase.sessionRouting && !routeTag) {
    // New backends may warm a socket while thread/start RPCs are still pending.
    // No user turn has been submitted in these phases. Reject the unidentified
    // handshake; do not invent a thread mapping or forward it to any provider.
    const counter = ['initializing', 'before_thread_start', 'starting_threads'].includes(activeCase.phase) ? 'blockedPreThreadProbes' : 'unmatched';
    activeCase[counter] = (activeCase[counter] ?? 0) + 1;
    socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
  }
  if (!activeCase.websockets) { socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  websocket.handleUpgrade(request, socket, head, connection => websocket.emit('connection', connection, request));
});
websocket.on('connection', (socket, request) => {
  const routeTag = activeCase.sessionRouting ? sessionRoute(request.headers) : null;
  socket.on('message', data => { Promise.resolve().then(async () => {
    const body = JSON.parse(data.toString());
    const current = activeCase;
    current.wsFrames++;
    originLog.push({ protocol: 'websocket', path: new URL(request.url, 'http://localhost').pathname, model: body.model, inputPresent: Array.isArray(body.input), inputItems: body.input?.length, previousResponseIdPresent: typeof body.previous_response_id === 'string', type: body.type, prewarm: body.generate === false, expectedAuthentication: request.headers.authorization === expectedAuthorization, sessionHeaderMatches: sessionHeaderMatches(request.headers), ...(current.sessionRouting ? { routeTag } : {}) });
    if (current.hold) { socket.send(JSON.stringify({ type: 'response.created', response: { id: 'held', status: 'in_progress', output: [] } })); socket.on('close', () => { current.cancelClosed = true; }); return; }
    for (const event of await dispatch(body, routeTag)) socket.send(JSON.stringify(event).replaceAll('upstream-plaintext', 'codlet-response-modified'));
  }).catch(() => { fixtureError(); socket.terminate(); }); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/iu.test(key)));
let child, lines;
const pending = new Map(), notifications = [];
const powershell = process.platform === 'win32' ? path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;
const owned = new Map();
function ps(script, env = {}) { return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim(); }
function snapshot() {
  if (process.platform === 'win32') return JSON.parse(ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"));
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 10000 });
  return rows.split('\n').flatMap(row => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/u.exec(row);
    return match ? [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Created: match[3], ExecutablePath: match[4] }] : [];
  });
}
const original = snapshot();
function capture() {
  const values = snapshot(), live = new Map(values.map(value => [value.ProcessId, value]));
  for (let changed = true; changed;) { changed = false; for (const value of values) {
    if (owned.has(value.ProcessId) || original.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)) continue;
    const parent = owned.get(value.ParentProcessId);
    if ((value.ProcessId === child?.pid && (macCandidate || value.ExecutablePath?.toLowerCase() === executable.toLowerCase()))
      || (parent && live.get(parent.ProcessId)?.Created === parent.Created && childAfterParent(value.Created, parent.Created))) { owned.set(value.ProcessId, value); changed = true; }
  } }
}
async function closeChild() {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('fixture_closed')); }
  pending.clear(); lines?.close();
  capture();
  for (const value of [...owned.values()].reverse()) {
    if (process.platform === 'win32') ps("$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:CODLET_OWNED_PID); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $env:CODLET_OWNED_CREATED) { try { Stop-Process -Id ([int]$env:CODLET_OWNED_PID) -ErrorAction Stop } catch { $still=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:CODLET_OWNED_PID); if($still -and $still.CreationDate.ToUniversalTime().ToString('o') -eq $env:CODLET_OWNED_CREATED) { throw } } }", { CODLET_OWNED_PID: String(value.ProcessId), CODLET_OWNED_CREATED: value.Created });
    else if (snapshot().some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)) {
      try { process.kill(value.ProcessId, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (macCandidate) {
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const value of [...owned.values()].reverse()) if (snapshot().some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)) {
      try { process.kill(value.ProcessId, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
  child = undefined;
}
async function waitFor(predicate, label, timeout = 12000) {
  const until = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= until) throw Error(`fixture_timeout:${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function run(kind, websockets, sessionRouting = false) {
  const state = { kind, websockets, ...(sessionRouting ? { sessionRouting: true, phase: 'initializing' } : {}), httpRequests: 0, wsHandshakes: 0, wsFrames: 0, requestRewrite: false, responseRewrite: false, completedTurns: 0, cancelled: false };
  activeCase = state; report.cases.push(state); notifications.length = 0;
  const home = path.join(directory, `${kind}-${websockets}${sessionRouting ? '-sessions' : ''}`); await fs.mkdir(home);
  const config = [
    'cli_auth_credentials_store="file"', `sandbox_mode=${JSON.stringify(sandboxMode)}`, 'approval_policy="never"', 'model="gpt-5.4"',
    `chatgpt_base_url=${JSON.stringify(endpoint + '/backend-api/')}`, `openai_base_url=${JSON.stringify(endpoint + '/v1')}`,
    'model_provider="' + (kind === 'custom' ? 'codlet_fixture' : 'openai') + '"',
    '[analytics]', 'enabled=false', '[features]', 'plugins=false', 'code_mode_host=false', 'remote_models=false', 'remote_plugin=false',
    'responses_websockets=' + websockets, 'responses_websockets_v2=' + websockets,
    '[mcp_servers.codex_app]', 'command=""', 'enabled=false',
    ...(kind !== 'custom' ? [] : ['[model_providers.codlet_fixture]', 'name="Fixture"', 'wire_api="responses"', 'supports_websockets=' + websockets, 'request_max_retries=0', 'stream_max_retries=0', `base_url=${JSON.stringify(endpoint + '/v1')}`, 'requires_openai_auth=false']),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(home, 'config.toml'), config);
  const jwt = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 3600, email: 'synthetic@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'codlet-fixture', chatgpt_user_id: 'codlet-fixture', chatgpt_plan_type: 'plus' } })).toString('base64url') + '.fixture';
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(kind === 'chatgpt' ? { auth_mode: 'chatgpt', tokens: { id_token: jwt, access_token: jwt, refresh_token: 'never-use-this-synthetic-token', account_id: 'codlet-fixture' }, last_refresh: new Date().toISOString() } : { OPENAI_API_KEY: 'codlet-local-fixture' }));
  expectedAuthorization = kind === 'custom' ? undefined : 'Bearer ' + (kind === 'chatgpt' ? jwt : 'codlet-local-fixture');
  const env = { ...environment, CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never' };
  let requestId = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { method, resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(Error(`rpc_timeout:${method}`)); }, 12000) });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  async function startNative() {
    child = spawn(executable, ['app-server', '--stdio', '-c', `sqlite_home=${JSON.stringify(home)}`], { env, cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => {
      state.failure = 'backend_spawn_failed';
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('backend_spawn_failed')); }
      pending.clear();
    });
    capture();
    child.stderr.on('data', chunk => { const text = chunk.toString(); for (const tag of ['401 Unauthorized', 'error sending request', 'invalid configuration']) if (text.includes(tag)) (state.errorKinds ??= []).push(tag); });
    lines = createInterface({ input: child.stdout });
    lines.on('line', text => {
      let message; try { message = JSON.parse(text); } catch { return; }
      const call = pending.get(message.id);
      if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(Error(`rpc_failed:${call.method}:${message.error.code}:${message.error.message}`)) : call.resolve(message.result); }
      else if (message.method && notifications.length < 1000) notifications.push(message);
    });
    await rpc('initialize', { clientInfo: { name: 'codlet-plaintext-fixture', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  try {
    await startNative();
    if (sessionRouting) {
      state.phase = 'before_thread_start';
      const observedStart = originLog.length;
      const tags = ['a', 'b'];
      state.phase = 'starting_threads';
      const started = await Promise.all(tags.map(() => rpc('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: sandboxMode, baseInstructions: 'This is a local synthetic session routing fixture.', ephemeral: false })));
      assert.notEqual(started[0].thread.id, started[1].thread.id);
      const ids = new Map(tags.map((tag, index) => [tag, started[index].thread.id]));
      threadIdsByCase.set(state, new Map([...ids].map(([tag, id]) => [id, tag])));
      state.phase = 'active_threads';
      state.threadProvider = started.map(value => value.modelProvider);
      const runBoth = async label => {
        const turns = await Promise.all(tags.map(tag => rpc('turn/start', { threadId: ids.get(tag), input: [{ type: 'text', text: `local ${label} ${tag}`, text_elements: [] }] })));
        await waitFor(() => turns.every((turn, index) => notifications.some(value => value.method === 'turn/completed' && value.params.threadId === ids.get(tags[index]) && value.params.turn.id === turn.turn.id)), `${label}_turns`, 20000);
        for (const [index, tag] of tags.entries()) {
          const completion = notifications.find(value => value.method === 'turn/completed' && value.params.threadId === ids.get(tag) && value.params.turn.id === turns[index].turn.id);
          assert.equal(completion.params.turn.status, 'completed', `${label} ${tag} failed`);
          assert(notifications.some(value => value.method === 'item/agentMessage/delta' && value.params.threadId === ids.get(tag) && value.params.delta.includes(`codlet-response-modified-${tag}`)), `${label} ${tag} response crossed sessions`);
        }
        state.completedTurns += 2;
      };
      await runBoth('initial');
      state.phase = 'closing_for_resume';
      await closeChild();
      notifications.length = 0;
      state.phase = 'reinitializing';
      await startNative();
      state.phase = 'resuming_threads';
      const resumed = await Promise.all(tags.map(tag => rpc('thread/resume', { threadId: ids.get(tag), cwd: home, approvalPolicy: 'never', sandbox: sandboxMode })));
      assert(resumed.every((value, index) => value.thread.id === ids.get(tags[index])));
      state.phase = 'active_threads';
      state.coldResumed = true;
      await runBoth('resumed');
      // Reconfigure a loaded idle task without restarting its backend. The
      // native unsubscribe/resume path must really replace the provider.
      state.phase = 'reconfiguring';
      const switching = ids.get('a');
      const stopped = await rpc('thread/unsubscribe', { threadId: switching });
      assert.equal(stopped.status, 'unsubscribed');
      const changed = await rpc('thread/resume', { threadId: switching, modelProvider: 'codlet_switched', model: 'gpt-5.4',
        config: { 'model_providers.codlet_switched': { name: 'Switched fixture', wire_api: 'responses', base_url: endpoint + '/switched', supports_websockets: websockets, requires_openai_auth: false } } });
      assert.equal(changed.modelProvider, 'codlet_switched');
      assert.equal(changed.thread.id, switching);
      const beforeSwitch = originLog.length;
      state.phase = 'active_threads'; await runBoth('reconfigured');
      assert(originLog.slice(beforeSwitch).some(value => value.path === '/switched/responses' && (value.routeTag === 'a' || value.sessionHeaderMatches['x-client-request-id'] === 'a')));
      state.providerReconfigured = true;
      const observed = originLog.slice(observedStart);
      state.httpMatched = Object.fromEntries(tags.map(tag => [tag, observed.filter(value => value.protocol === 'http' && value.routeTag === tag).length]));
      state.wsHandshakeMatched = Object.fromEntries(tags.map(tag => [tag, observed.filter(value => value.protocol === 'websocket-handshake' && value.routeTag === tag).length]));
      state.wsPrewarmMatched = Object.fromEntries(tags.map(tag => [tag, observed.filter(value => value.protocol === 'websocket' && value.prewarm && value.routeTag === tag).length]));
      state.wsFramesMatched = Object.fromEntries(tags.map(tag => [tag, observed.filter(value => value.protocol === 'websocket' && !value.prewarm && value.routeTag === tag).length]));
      assert.equal(state.unmatched ?? 0, 0);
      assert(state.requestRewrite && state.coldResumed && state.destinations.includes('/provider-a') && state.destinations.includes('/provider-b'));
      assert(tags.every(tag => websockets ? state.wsHandshakeMatched[tag] >= 2 && state.wsFramesMatched[tag] >= 2 : state.httpMatched[tag] >= 2));
      state.passed = true;
      return;
    }
    const started = await rpc('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: sandboxMode, baseInstructions: 'This is a local synthetic transport fixture.', ephemeral: true });
    threadIdsByCase.set(state, started.thread.id);
    state.threadProvider = started.modelProvider;
    for (let index = 0; index < 2; index++) {
      const turn = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'local synthetic request', text_elements: [] }] });
      await waitFor(() => notifications.some(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id), 'turn_completed');
      const completion = notifications.find(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id);
      if (completion.params.turn.status !== 'completed') { state.turnError = completion.params.turn.error; throw Error('turn_not_completed'); }
      state.completedTurns++;
    }
    state.responseRewrite = notifications.some(value => value.method === 'item/agentMessage/delta' && value.params.delta === 'codlet-response-modified');
    {
      state.hold = true;
      const before = state.httpRequests + state.wsFrames;
      const turn = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'local cancel fixture', text_elements: [] }] });
      await waitFor(() => state.httpRequests + state.wsFrames > before, 'held_response');
      await rpc('turn/interrupt', { threadId: started.thread.id, turnId: turn.turn.id });
      await waitFor(() => notifications.some(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id && value.params.turn.status === 'interrupted'), 'cancel_completed');
      await waitFor(() => state.cancelClosed === true, 'cancel_closed');
      state.cancelled = true;
      delete state.hold;
      const resumed = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'local post-cancel fixture', text_elements: [] }] });
      await waitFor(() => notifications.some(value => value.method === 'turn/completed' && value.params.turn.id === resumed.turn.id), 'post_cancel_turn');
      assert.equal(notifications.find(value => value.method === 'turn/completed' && value.params.turn.id === resumed.turn.id).params.turn.status, 'completed');
      state.completedTurns++;
      state.continuedAfterCancel = true;
    }
    assert(state.requestRewrite && state.responseRewrite && state.errorResponseRepaired && state.continuedAfterCancel);
    assert(state.destinations.includes('/provider-a') && state.destinations.includes('/provider-b'));
    assert(websockets ? state.wsFrames > 0 : state.httpRequests >= 2);
    state.passed = true;
  } catch (error) { state.passed = false; state.failure = error.message.slice(0, 500); }
  finally { await closeChild(); for (const socket of websocket.clients) socket.terminate(); console.log(JSON.stringify(state)); }
}
try {
  if (options['--routing-ws-only'] === 'yes') await run('custom', true, true);
  else if (options['--routing-only'] === 'yes') for (const websockets of [false, true]) await run('custom', websockets, true);
  else {
    for (const kind of ['custom', 'builtin', 'chatgpt']) for (const websockets of [false, true]) await run(kind, websockets);
    for (const websockets of [false, true]) await run('custom', websockets, true);
  }
} finally {
  await closeChild(); websocket.close(); for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  const after = snapshot();
  report.originalClientIdentitiesUnchanged = original.filter(value => process.platform === 'win32'
    ? /\\(?:ChatGPT|Codex)\.exe$/iu.test(value.ExecutablePath ?? '')
    : /\/(?:ChatGPT|Codex)$/u.test(value.ExecutablePath ?? '')).every(value => after.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created));
  report.ownedRemaining = [...owned.values()].filter(value => after.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)).length;
  try {
    await removeOwnedFixture(directory, 'codlet-plaintext-', report.ownedRemaining);
    report.cleanup = true;
  } catch { report.cleanup = false; report.retainedDirectory = directory; }
  report.observed = originLog;
  report.authenticationPreserved = originLog.every(value => value.expectedAuthentication);
  const reportName = `${macCandidate ? 'macos-' : ''}${options['--routing-ws-only'] === 'yes' ? 'backend-plaintext-routing-ws.json' : 'backend-plaintext.json'}`;
  await writeFixtureReport(new URL('../../.codlet-artifacts/native-tools/request-chain/', import.meta.url), reportName, report);
  console.log(JSON.stringify(report));
  if (report.fixtureFailure || report.cases.some(value => !value.passed) || !report.cleanup || report.ownedRemaining || !report.originalClientIdentitiesUnchanged || !report.authenticationPreserved) process.exitCode = 1;
}
