// Opt-in, fresh profile, exact-child inspector. No installed app modification.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { childAfterParent } from './process-identity.mjs';
import { fixtureRequestHandler, removeOwnedFixture, writeFixtureReport } from './owned-fixture.mjs';
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => i % 2 ? pairs : [...pairs, [value, all[i + 1]]], []));
if (process.platform === 'win32' && process.env.CODLET_TEST_DISPOSABLE_WINDOWS_HOST !== '1') throw Error('Native Windows desktop acceptance requires a disposable VM/host and CODLET_TEST_DISPOSABLE_WINDOWS_HOST=1.');
if (process.platform !== 'win32' || options['--run-owned'] !== 'yes' || ![options['--executable'], options['--backend']].every(value => path.isAbsolute(value ?? ''))) throw Error('explicit_windows_owned_paths_required');
if (createHash('sha256').update(await fs.readFile(options['--backend'])).digest('hex') !== 'bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226') throw Error('backend_build_unverified');
const executable = await fs.realpath(options['--executable']);
const powershell = path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps = (script, env = {}) => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } }).trim();
const snapshot = () => JSON.parse(ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"));
const before = snapshot(), owned = new Map();
const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'codlet-main-plaintext-'));
const reportPath = path.join(directory, 'result.json');
const report = { schema: 1, kind: 'official-desktop-plaintext', fixture: { desktop: 0, model: 0, wsAttempt: 0 }, proxyConfigured: false, certificateConfigured: false };
let child, socket, server, startupTail = '';
function capture() {
  const values = snapshot(), live = new Map(values.map(value => [value.ProcessId, value]));
  for (let changed = true; changed;) { changed = false; for (const value of values) {
    if (owned.has(value.ProcessId) || before.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)) continue;
    const parent = owned.get(value.ParentProcessId);
    if ((value.ProcessId === child?.pid && value.ExecutablePath?.toLowerCase() === executable.toLowerCase()) || (parent && live.get(parent.ProcessId)?.Created === parent.Created && childAfterParent(value.Created, parent.Created))) { owned.set(value.ProcessId, value); changed = true; }
  } }
}
const connections = new Set();
try {
  server = http.createServer(fixtureRequestHandler(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.url.startsWith('/desktop/')) {
      report.fixture.desktop++; report.fixture.desktopRequestModified = Buffer.concat(chunks).toString() === 'desktop-modified';
      response.writeHead(200, { 'content-type': 'text/plain' }); response.end('server-original'); return;
    }
    if (request.url.endsWith('/responses')) {
      report.fixture.model++;
      report.fixture.modelHasPlaintextInput = Array.isArray(JSON.parse(Buffer.concat(chunks)).input);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const item = { id: 'item-local', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'model-modified', annotations: [] }] };
      for (const event of [
        { type: 'response.created', response: { id: 'response-local', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'model-modified' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response-local', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(request.url.includes('/models') ? { models: [], data: [] } : {}));
  }, () => { report.fixtureFailure = true; }));
  server.on('connection', value => { connections.add(value); value.on('close', () => connections.delete(value)); });
  server.on('upgrade', (request, value) => { report.fixture.wsAttempt++; value.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|USERNAME|USERDOMAIN)$/iu.test(key)));
  for (const [key, relative] of Object.entries({ CODEX_HOME: 'codex-home', CODEX_ELECTRON_USER_DATA_PATH: 'user-data', CODEX_SQLITE_HOME: 'sqlite', HOME: 'home', USERPROFILE: 'home', APPDATA: 'home/roaming', LOCALAPPDATA: 'home/local', TEMP: 'temp', TMP: 'temp' })) { environment[key] = path.join(directory, relative); await fs.mkdir(environment[key], { recursive: true }); }
  Object.assign(environment, { CODEX_CLI_PATH: options['--backend'], BUILD_FLAVOR: 'dev', CODEX_SPARKLE_ENABLED: 'false', CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE: 'manual', CODEX_APP_SERVER_OPENAI_BASE_URL: endpoint + '/v1', CODEX_APP_SERVER_CHATGPT_BASE_URL: endpoint + '/backend-api/', CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES: JSON.stringify({ externalBrowserUseAllowed: false, externalBrowserUse: false, inAppBrowserUseAllowed: false, inAppBrowserUse: false, browserExtensions: false, browserPane: false, computerUse: false, computerUseAutoInstall: false, computerUseNodeRepl: false, browserUseTinysky: false, appshotsEnabled: false, quickChat: false, sites: false, autoAuthForSites: false, control: false, skysight: false, recordAndReplay: false }) });
  Object.assign(environment, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never' });
  await fs.writeFile(path.join(environment.CODEX_HOME, 'config.toml'), 'cli_auth_credentials_store="file"\nmodel="gpt-5.4"\nsandbox_mode="read-only"\n[analytics]\nenabled=false\n[mcp_servers.codex_app]\ncommand=""\nenabled=false\n');
  await fs.writeFile(path.join(environment.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'codlet-local-fixture' }));
  child = spawn(executable, ['--inspect-brk=127.0.0.1:0', `--user-data-dir=${environment.CODEX_ELECTRON_USER_DATA_PATH}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--disable-background-networking', '--no-first-run'], { env: environment, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { startupTail = (startupTail + chunk.toString()).slice(-4000); });
  const inspector = new Promise((resolve, reject) => { let text = ''; const timer = setTimeout(() => reject(Error('inspector_timeout')), 8000); child.stderr.on('data', chunk => { text = (text + chunk).slice(-8192); const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36})/u.exec(text); if (match) { clearTimeout(timer); resolve(match[1]); } }); child.once('error', reject); });
  capture(); if (!owned.has(child.pid)) throw Error('owned_identity_missing');
  socket = new WebSocket(await inspector);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0, resolvePause; const calls = new Map(), paused = new Promise(resolve => { resolvePause = resolve; });
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Debugger.paused') resolvePause(message.params); const call = calls.get(message.id); if (call) { clearTimeout(call.timer); calls.delete(message.id); message.error ? call.reject(Error('inspector_protocol_error')) : call.resolve(message.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; calls.set(id, { resolve, reject, timer: setTimeout(() => { calls.delete(id); reject(Error('inspector_timeout:' + method)); }, 5000) }); socket.send(JSON.stringify({ id, method, params })); });
  await send('Debugger.enable'); await send('Runtime.runIfWaitingForDebugger');
  const frame = (await paused).callFrames[0];
  report.pauseFrame = { url: frame.url, functionName: frame.functionName };
  const identity = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: "({pid:process.pid,path:require('node:fs').realpathSync(process.execPath),ready:require('electron').app.isReady(),type:process.type})", returnByValue: true });
  if (identity.result?.value?.pid !== child.pid || identity.result.value.path !== executable || identity.result.value.ready || identity.result.value.type !== 'browser') throw Error('main_identity_mismatch');
  report.exactChildVerified = true;
  const source = await fs.readFile(new URL('../tests/fixtures/traffic/plaintext-main.cjs', import.meta.url), 'utf8');
  const configuration = { endpoint, home: environment.HOME, reportPath, paths: { home: environment.HOME, appData: environment.APPDATA, userData: environment.CODEX_ELECTRON_USER_DATA_PATH, temp: environment.TEMP }, mainHash: 'c71bf3ffecef5fd390b4cd16d120d39dce30d30bffe3c563c8c74c1b691da018' };
  const installed = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `(()=>{const module={exports:{}};((module,exports,require)=>{${source}\n})(module,module.exports,require);return module.exports.installPlaintextProbe(require('electron'),${JSON.stringify(configuration)})})()`, returnByValue: true });
  if (installed.exceptionDetails || !installed.result?.value?.installed) { report.injectionError = installed.exceptionDetails?.exception?.description?.slice(0, 500); throw Error('fixture_injection_failed'); }
  await send('Debugger.resume'); socket.close();
  const deadline = Date.now() + 40000;
  while (true) {
    try { report.acceptance = JSON.parse(await fs.readFile(reportPath, 'utf8')); if (report.acceptance.finished) break; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (Date.now() > deadline) throw Error('fixture_timeout'); await new Promise(resolve => setTimeout(resolve, 100));
  }
} catch (error) { report.failure = error.message.slice(0, 250); }
finally {
  if (report.failure || report.acceptance?.failure) report.startupErrorKinds = [...new Set([...startupTail.matchAll(/(?:ERR_[A-Z_]+|UnhandledPromiseRejectionWarning|Failed to get 'appData' path|Failed to set path|thread\/start)/g)].map(value => value[0]))];
  socket?.close(); capture();
  for (const value of [...owned.values()]) ps("$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:CODLET_OWNED_PID); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $env:CODLET_OWNED_CREATED) { try { Stop-Process -Id ([int]$env:CODLET_OWNED_PID) -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*') { throw } } }", { CODLET_OWNED_PID: String(value.ProcessId), CODLET_OWNED_CREATED: value.Created });
  child?.stdout?.destroy(); child?.stderr?.destroy();
  for (const value of connections) value.destroy(); if (server) await new Promise(resolve => server.close(resolve));
  const after = snapshot();
  report.originalClientIdentitiesUnchanged = before.filter(value => /\\(?:ChatGPT|Codex)\.exe$/iu.test(value.ExecutablePath ?? '')).every(value => after.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created));
  report.ownedRemaining = [...owned.values()].filter(value => after.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)).length;
  if (report.ownedRemaining === 0) try {
    await removeOwnedFixture(directory, 'codlet-main-plaintext-', report.ownedRemaining); report.cleanup = true;
  } catch { report.cleanup = false; report.retainedDirectory = directory; }
  await writeFixtureReport(new URL('../../.codlet-artifacts/native-tools/request-chain/', import.meta.url), 'desktop-plaintext.json', report);
  console.log(JSON.stringify(report));
  if (report.failure || report.fixtureFailure || report.acceptance?.failure || !report.acceptance?.desktopRoundTrip || !report.acceptance?.progressRoundTrip || !report.fixture.desktopRequestModified || !report.acceptance?.modelResponseModified || report.acceptance?.modelTurnStatus !== 'completed' || !report.cleanup || report.ownedRemaining || !report.originalClientIdentitiesUnchanged) process.exitCode = 1;
}
