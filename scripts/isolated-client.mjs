// Local launcher for the explicitly audited Windows test client.
// Never attaches to an existing Desktop or backend. Account responses are reduced to booleans.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const [action, configPath, ...pluginArguments] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const root = path.resolve(config.labRoot);
const directory = path.dirname(path.resolve(configPath));
const labBinary = path.resolve(directory, config.labBinary);
const officialCli = path.resolve(config.officialCli);
const statePath = path.join(root, 'logs', 'manual-client.json');
const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const inherited = /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATH|PATHEXT|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432|PROCESSOR_IDENTIFIER|PROCESSOR_LEVEL|PROCESSOR_REVISION|NUMBER_OF_PROCESSORS|USERNAME|USERDOMAIN|USERDNSDOMAIN|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432)$/i;

function plain(file, isDirectory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('Expected a plain local file/directory: ' + file);
  return stat;
}
function validateRoot() {
  if (!/^[a-z]:[\\/]/i.test(config.labRoot) || config.labRoot.startsWith('\\\\') || config.labRoot.split(/[\\/]/).some(x => x === '..' || x === '.')) throw new Error('Lab root must be an explicit absolute local directory');
  let current = root;
  while (true) {
    plain(current, true);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const marker = path.join(root, '.codlet-lab-owner.json');
  if (plain(marker).size > 4096) throw new Error('Invalid lab marker');
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (value.schema_version !== 1 || value.experimental !== true) throw new Error('Not a marked experimental lab');
}
function verifyHash(file, hash) {
  if (plain(file).size > 512 * 1024 * 1024) throw new Error('Executable exceeds the verification size limit: ' + file);
  const digest = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  if (digest.digest('hex') !== hash.toLowerCase()) throw new Error('Executable identity changed: ' + file);
}
function environment(pluginCli = false) {
  const result = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.test(key)));
  for (const [key, relative] of Object.entries({
    CODEX_HOME: 'codex-home', CODEX_SQLITE_HOME: 'sqlite', CODEX_ELECTRON_USER_DATA_PATH: 'user-data',
    USERPROFILE: 'home', HOME: 'home', APPDATA: 'home/AppData/Roaming', LOCALAPPDATA: 'home/AppData/Local',
    TEMP: 'temp', TMP: 'temp',
  })) result[key] = path.join(root, relative);
  if (pluginCli) result.LOCALAPPDATA = root;
  result.SHELL = powershell;
  result.PSModulePath = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules');
  return result;
}
async function ps(source, extra = {}) {
  const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    windowsHide: true, env: { ...environment(), ...extra }, timeout: 20000, maxBuffer: 512 * 1024,
  });
  return JSON.parse(stdout.trim() || 'null');
}
async function snapshot() {
  return (await ps("Get-CimInstance Win32_Process -Filter \"name = 'Codex.exe' OR name = 'ChatGPT.exe'\" | Where-Object { $_.CommandLine -notmatch '--type[= ]' } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');image=$_.ExecutablePath} } | ConvertTo-Json -Compress")) ?? [];
}
function array(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function latestReport() {
  const logs = path.join(root, 'logs');
  const candidates = [path.join(logs, 'report.jsonl')];
  for (const entry of fs.readdirSync(logs, { withFileTypes: true })) if (entry.name.startsWith('run-')) {
    plain(path.join(logs, entry.name), true);
    candidates.push(path.join(logs, entry.name, 'report.jsonl'));
  }
  const reports = candidates.filter(file => fs.existsSync(file)).map(file => ({ file, born: plain(file).birthtimeMs })).sort((a, b) => b.born - a.born);
  if (!reports.length || (reports[1] && reports[0].born === reports[1].born)) throw new Error('No unambiguous latest lab report');
  return reports[0].file;
}
function atomicJson(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temporary, file);
}
function pumpLines(stream, onLine, log) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    log?.write(chunk);
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Lab output exceeded the line limit');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.once('end', () => log?.end());
  stream.once('error', () => log?.end());
}
function exited(child) {
  return new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function verifyListener(port, pid) {
  const facts = await ps(
    "$ErrorActionPreference='Stop'; $labDeadline=[DateTime]::UtcNow.AddSeconds(12); do { $labListeners=@(Get-NetTCPConnection -LocalPort ([int]$env:CODLET_CHECK_PORT) -State Listen -ErrorAction SilentlyContinue); if ($labListeners.Count -gt 0) { break }; Start-Sleep -Milliseconds 150 } while ([DateTime]::UtcNow -lt $labDeadline); $labListeners | ForEach-Object { $labOwner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess); [pscustomobject]@{pid=$_.OwningProcess;address=$_.LocalAddress;image=$labOwner.ExecutablePath;created=$labOwner.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress",
    { CODLET_CHECK_PORT: String(port) });
  const rows = array(facts);
  if (rows.length !== 1 || rows[0].pid !== pid || rows[0].address !== '127.0.0.1' || !rows[0].image || path.resolve(rows[0].image).toLowerCase() !== officialCli.toLowerCase()) throw new Error('Dedicated backend listener identity did not match the created process');
  return rows[0];
}
async function originCheck(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Origin check timed out')); });
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      'GET / HTTP/1.1', 'Host: 127.0.0.1:' + port, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + randomBytes(16).toString('base64'),
      'Origin: https://codlet-lab.invalid', '', '',
    ].join('\r\n')));
    socket.on('data', chunk => {
      response += chunk.toString('latin1');
      if (response.length > 16384) { socket.destroy(); reject(new Error('Origin response too large')); }
      if (response.includes('\r\n\r\n')) { socket.destroy(); resolve(/^HTTP\/1\.1 403\b/.test(response)); }
    });
  });
}
async function probe(endpoint, port) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', event => {
    if (String(event.data).length > 4 * 1024 * 1024) { socket.close(); return; }
    const message = JSON.parse(String(event.data));
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new Error('Backend ' + call.method + ' failed (' + message.error.code + ')'));
    else call.resolve(message.result);
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const ticket = ++id;
      const timer = setTimeout(() => { pending.delete(ticket); reject(new Error('Backend ' + method + ' timed out')); }, 10000);
      pending.set(ticket, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id: ticket, method, params }));
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend connect timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Backend connection failed')); }, { once: true });
    });
    await request('initialize', { clientInfo: { name: 'codlet-isolated-manual-test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const authenticated = (await request('account/read', { refreshToken: false })).account != null;
    const { config: effective } = await request('config/read', { cwd: path.join(root, 'project'), includeLayers: false });
    const fileCredentialStore = effective?.cli_auth_credentials_store === 'file';
    const readOnlyBackend = effective?.sandbox_mode === 'read-only';
    const desktopAppToolsDisabled = effective?.mcp_servers?.codex_app?.enabled === false && effective.mcp_servers.codex_app.command === '';
    const readiness = (await request('windowsSandbox/readiness', {}))?.status;
    const plugins = await request('plugin/installed', { cwds: [path.join(root, 'project')], installSuggestionPluginNames: [] });
    if (!Array.isArray(plugins.marketplaces) || plugins.marketplaceLoadErrors?.length) throw new Error('Installed plugin state could not be verified');
    const chromeInstalled = plugins.marketplaces.flatMap(market => market.plugins).some(plugin => plugin.installed && /^chrome(?:-|$)/i.test(plugin.name));
    const originRejected = await originCheck(port);
    const result = { initialized: true, authenticated, fileCredentialStore, readOnlyBackend, desktopAppToolsDisabled, windowsReadiness: readiness, chromeInstalled, originRejected };
    if (!authenticated || !fileCredentialStore || !readOnlyBackend || !desktopAppToolsDisabled || readiness !== 'ready' || chromeInstalled || !originRejected) throw new Error('Backend isolation/readiness checks failed: ' + JSON.stringify(result));
    return result;
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    socket.close();
  }
}

async function start(recoverInterrupted = false) {
  if(pluginArguments.length && !(pluginArguments.length===1 && pluginArguments[0]==='--safe-mode'))throw new Error('Start accepts only --safe-mode');
  const safeMode=pluginArguments[0]==='--safe-mode';
  verifyHash(officialCli, config.officialCliSha256);
  const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  if (previous?.state === 'ready') {
    const live = await ps("$labProcess=Get-Process -Id ([int]$env:CODLET_CHECK_PID) -ErrorAction SilentlyContinue; if ($labProcess) { [pscustomobject]@{pid=$labProcess.Id;created=$labProcess.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress } else { ConvertTo-Json -InputObject $null -Compress }",
      { CODLET_CHECK_PID: String(previous.managerPid) });
    if (live?.created === previous.managerCreated) throw new Error('The test client is already running; use Stop-TestClient before starting another');
  }
  const before = array(await snapshot());
  const report = latestReport();
  const runId = Date.now() + '-' + process.pid;
  const logs = path.join(root, 'logs', 'coordinator-' + runId);
  fs.mkdirSync(logs);
  const quitFile = path.join(logs, 'quit.request');
  const managerFacts = await ps("$codletStarted=(Get-Process -Id ([int]$env:CODLET_CHECK_PID)).StartTime.ToUniversalTime(); [pscustomobject]@{created=$codletStarted.ToString('o');filetime=$codletStarted.ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress", { CODLET_CHECK_PID: String(process.pid) });
  const managerIdentity = managerFacts.created;
  let state = { schema: 1, runId, state: 'preparing', safeMode, labRoot: root, managerPid: process.pid, managerCreated: managerIdentity, logs, quitFile, before };
  atomicJson(path.join(logs, 'state.json'), state);
  let backend, backendExit, lab, labExit, labOutputEnded, prepared, deadline, wroteState = false;
  let startupVerified = false, pluginReady = false;
  let labFailure = null;
  let restartAfterUpdate = false;
  const rows = [];
  function publish() { atomicJson(path.join(logs, 'state.json'), state); if (prepared) { atomicJson(statePath, state); wroteState = true; } }
  try {
    const port = await freePort();
    const endpoint = 'ws://127.0.0.1:' + port;
    lab = spawn(labBinary, ['--experimental-isolated-client', '--root', root, '--expected-package-version', config.expectedPackageVersion,
      '--app-server-url', endpoint, '--resume-from', report, ...(recoverInterrupted ? ['--recover-interrupted'] : []), ...(safeMode ? ['--safe-mode'] : [])],
      { cwd: path.join(root, 'project'), env: { ...environment(), CODLET_UPDATE_OWNER_PID: String(process.pid), CODLET_UPDATE_OWNER_CREATED: managerFacts.filetime }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    labExit = exited(lab);
    labOutputEnded = new Promise(resolve => { lab.stdout.once('end',resolve);lab.stdout.once('close',resolve);lab.stdout.once('error',resolve); });
    lab.stdin.on('error', () => {});
    const hostOutput = fs.createWriteStream(path.join(logs, 'lab-stdout.jsonl'), { flags: 'wx' });
    const hostErrors = fs.createWriteStream(path.join(logs, 'lab-stderr.log'), { flags: 'wx' });
    lab.stderr.pipe(hostErrors);
    pumpLines(lab.stdout, line => {
      let row; try {
        row = JSON.parse(line, (_key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) ? context.source : value);
      } catch { return; }
      rows.push(row); if (rows.length > 1000) rows.shift();
      if (row.event === 'prepared') prepared = row.detail;
      if (row.event === 'startup_verified') startupVerified = true;
      if (row.event === (safeMode ? 'safe_mode_ready' : 'plugin_runtime_ready')) pluginReady = true;
      if (['startup_failed', 'plugin_startup_failed', 'renderer_pump_failed', 'quit_timed_out'].includes(row.event)) labFailure = row.event;
      if (row.event === 'child_created') { state.desktopPid = row.child_pid; state.desktopCreated = row.detail.creation_time_windows_100ns; publish(); }
      if (row.event === 'official_update_restart') { restartAfterUpdate = row.detail.rehearsal === true; state.updateRestart = row.detail; publish(); }
    }, hostOutput);
    deadline = Date.now() + 120000;
    while (!prepared) {
      if (lab.exitCode !== null || lab.signalCode !== null) throw new Error('Lab preparation failed; see ' + path.join(logs, 'lab-stderr.log'));
      if (Date.now() > deadline) throw new Error('Lab preparation timed out');
      await delay(100);
    }
    if (prepared.root.toLowerCase() !== root.toLowerCase() || prepared.requested_app_server_url !== endpoint || prepared.resumed_profile !== true) throw new Error('Unexpected prepared lab identity');
    const manifest = path.resolve(prepared.environment_manifest);
    if (!manifest.toLowerCase().startsWith((path.join(root, 'logs') + path.sep).toLowerCase())) throw new Error('Environment manifest is outside lab logs');
    const backendEnvironment = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const key of Object.keys(backendEnvironment)) if (key === 'BUILD_FLAVOR' || key === 'CODEX_APP_SERVER_WS_URL' || key === 'CODEX_SPARKLE_ENABLED' || key.startsWith('CODEX_ELECTRON_')) delete backendEnvironment[key];
    if (path.resolve(backendEnvironment.CODEX_HOME).toLowerCase() !== path.join(root, 'codex-home').toLowerCase()) throw new Error('Backend home differs from lab profile');
    const output = fs.openSync(path.join(logs, 'backend-stdout.log'), 'wx');
    const errors = fs.openSync(path.join(logs, 'backend-stderr.log'), 'wx');
    // Match Desktop's normal config parsing. --strict-config also rejects
    // forward-compatible feature overrides sent by the bundled frontend.
    // Isolation requirements are checked against effective config in probe().
    // The reviewed Desktop uses this same disabled transport when its app-tools
    // bridge is unavailable. Per-thread enabled_tools overlays still require a
    // valid base transport; the lab must never bind the daily Desktop IPC router.
    backend = spawn(officialCli, ['app-server', '--listen', endpoint, '-c', 'sandbox_mode="read-only"', '-c', 'analytics.enabled=false', '-c', 'mcp_servers.codex_app={command="",enabled=false}'],
      { cwd: path.join(root, 'project'), env: backendEnvironment, windowsHide: true, stdio: ['ignore', output, errors] });
    fs.closeSync(output); fs.closeSync(errors);
    backendExit = exited(backend);
    state = { ...state, endpoint, hostPid: lab.pid, report: path.join(prepared.run_logs ?? path.dirname(manifest), 'report.jsonl'), backendPid: backend.pid };
    state.backendIdentity = await verifyListener(port, backend.pid);
    state.backendProbe = await probe(endpoint, port);
    state.state = 'starting'; publish();
    lab.stdin.write('start\n');
    deadline = Date.now() + 45000;
    while (!startupVerified || !pluginReady) {
      if (labFailure || lab.exitCode !== null || backend.exitCode !== null) throw new Error('Test client startup failed: ' + (labFailure ?? 'owned process exited'));
      if (Date.now() > deadline) throw new Error('Test client did not publish startup and plugin readiness');
      await delay(100);
    }
    const after = array(await snapshot());
    state.originalProcessesUnchanged = before.every(a => after.some(b => a.pid === b.pid && a.created === b.created && a.image === b.image));
    if (!state.originalProcessesUnchanged) throw new Error('An original client process identity changed during startup');
    state.state = 'ready'; state.readyAt = new Date().toISOString(); publish();
    console.log(JSON.stringify({ state: 'ready', labRoot: root, desktopPid: state.desktopPid, report: state.report, localPluginsSupported: true, originalProcessesUnchanged: true }));
    let quitRequested = false;
    let rehearsalRequested = false;
    while (lab.exitCode === null && lab.signalCode === null) {
      if (!quitRequested && (fs.existsSync(quitFile) || backend.exitCode !== null || backend.signalCode !== null || labFailure)) {
        lab.stdin.write('quit\n'); quitRequested = true;
        state.state = 'stopping'; publish();
      }
      const rehearsalFile = path.join(logs, 'update-rehearsal.request');
      if (!quitRequested && !rehearsalRequested && fs.existsSync(rehearsalFile)) {
        const info = fs.lstatSync(rehearsalFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 || fs.readFileSync(rehearsalFile, 'utf8') !== runId) throw new Error('Invalid update rehearsal request');
        rehearsalRequested = true;
        lab.stdin.write('rehearse-update\n');
      }
      await delay(250);
    }
    state.hostExit = await labExit;
    await labOutputEnded;
    state.state = state.hostExit.code === 0 ? 'closed' : 'failed';
    if (state.hostExit.code !== 0) process.exitCode = 1;
  } catch (error) {
    state.state = 'failed'; state.error = error.message; process.exitCode = 1;
    console.error(error.message);
    if (lab && lab.exitCode === null && lab.signalCode === null) {
      lab.stdin.write('quit\n');
      await Promise.race([labExit, delay(20000)]);
      if (lab.exitCode === null && lab.signalCode === null) {
        state.state = 'needs_attention'; state.error += '; the owned Desktop did not exit; its backend is retained';
        publish();
        console.error('Owned test Desktop still running. Backend retained. Close this test client through its Quit menu.');
        // Keep the same owned handles and services until the user closes the test Desktop.
        await labExit;
      }
    }
  } finally {
    if (lab && lab.exitCode !== null && !state.hostExit) state.hostExit = await labExit;
    if (lab && (lab.exitCode !== null || lab.signalCode !== null)) await labOutputEnded;
    if (backend && backend.exitCode === null && backend.signalCode === null) {
      backend.kill('SIGTERM'); // Windows: terminate only this retained, newly created backend handle.
      await backendExit;
      state.backendStop = 'owned backend process stopped after lab Desktop exit';
    }
    state.endedAt = new Date().toISOString();
    if (wroteState || prepared) publish(); else atomicJson(path.join(logs, 'state.json'), state);
    console.log(JSON.stringify({ state: state.state, logs, error: state.error ?? null }));
  }
  // Keep the known coordinator while replacing its retired child. A detached
  // PowerShell child can disappear during parent teardown on Windows.
  // Combined Codlet replacement deliberately returns false so its checked
  // external helper can wait for this coordinator and replace the binary.
  return restartAfterUpdate && state.state === 'closed' && state.hostExit?.code === 0;
}
async function rehearseUpdate() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.state !== 'ready' || !/^\d+-\d+$/.test(state.runId)) throw new Error('Start the test client before rehearsing an update restart');
  const logs = path.join(root, 'logs', 'coordinator-' + state.runId);
  if (path.resolve(state.logs).toLowerCase() !== logs.toLowerCase()) throw new Error('Invalid rehearsal owner');
  fs.writeFileSync(path.join(logs, 'update-rehearsal.request'), state.runId, {flag:'wx'});
  console.log('Update restart rehearsal requested. No official package will be downloaded or installed.');
}
async function stop() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!['ready', 'starting', 'stopping'].includes(state.state)) { console.log('Test client is not running.'); return; }
  const expected = path.join(root, 'logs', 'coordinator-' + state.runId, 'quit.request');
  if (path.resolve(state.quitFile).toLowerCase() !== expected.toLowerCase()) throw new Error('Invalid lab quit location');
  fs.writeFileSync(expected, 'quit\n', { flag: 'w' });
  console.log('Test client quit requested.');
}
async function plugins() {
  if (!pluginArguments.length) throw new Error('Use Test-Plugins list, preview, add, github, enable, disable, reload, permissions, revoke, remove or operation');
  const child = spawn(labBinary, ['--experimental-isolated-client', '--root', root, 'plugin', ...pluginArguments], {
    cwd: process.cwd(), env: environment(true), windowsHide: true, stdio: 'inherit',
  });
  const result = await exited(child);
  process.exitCode = result.code ?? 1;
}

async function doctor(command = 'doctor') {
  const child = spawn(labBinary, ['--experimental-isolated-client', '--root', root, command, ...pluginArguments], {
    cwd: process.cwd(), env: environment(true), windowsHide: true, stdio: 'inherit',
  });
  const result = await exited(child);
  process.exitCode = result.code ?? 1;
}

validateRoot();
verifyHash(labBinary, config.labBinarySha256);
if (action === 'start') { while(await start()) {} }
else if (action === 'recover') { if(await start(true))while(await start()) {} }
else if (action === 'stop') await stop();
else if (action === 'plugins') await plugins();
else if (action === 'doctor') await doctor();
else if (action === 'diagnostics') await doctor('diagnostics');
else if (action === 'rehearse-update') await rehearseUpdate();
else throw new Error('Expected start, recover, stop, plugins, doctor or diagnostics');
