// Opt-in acceptance of Core's embedded Desktop provider on one isolated official
// Desktop child. Every service and network destination is loopback-only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childAfterParent } from './process-identity.mjs';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const defaultBackendHash = '97d4d67419d0ac2f71342f9a5e850f9468aa622618de8ea823223edb9a91926a';
const originalRequest = 'codlet-original-request';
const modifiedRequest = 'codlet-modified-request';
const originalResponse = 'codlet-original-response';
const modifiedResponse = 'codlet-modified-response';
const routedModel = 'codlet-routed-model';
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--run-owned', '--executable', '--backend', '--backend-sha256', '--core', '--protocol', '--bootstrap-bundle', '--main-bundle', '--app-server-module', '--fetch-wrapper-symbol', '--application-network-factory'].includes(key) || value == null || options[key] !== undefined) {
    process.stdout.write(JSON.stringify({ failure: 'invalid_arguments' }) + '\n');
    process.exitCode = 1;
    process.exit();
  }
  options[key] = value;
}

const codeOf = error => typeof error?.code === 'string' && /^[a-z_]{1,80}$/u.test(error.code) ? error.code : 'owned_acceptance_failed';
const failure = code => Object.assign(new Error(code), { code });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const macRunner = process.platform === 'darwin' && process.arch === 'arm64';
const canonicalPath = value => process.platform === 'win32'
  ? path.win32.normalize(value).replace(/^\\\\\?\\/u, '').toLowerCase() : path.posix.normalize(value);
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeBundleName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,180}\.js$/u.test(value);
const expectedBackendHash = options['--backend-sha256'] ?? defaultBackendHash;
const normalizeOrigin = value => {
  const url = new URL(value);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.origin;
};

function parseModel(value) {
  try { return JSON.parse(value); } catch { return null; }
}
function rewriteModel(value) {
  let changed = false;
  function visit(item, depth) {
    if (!item || typeof item !== 'object' || depth > 32) return;
    for (const key of Object.keys(item).slice(0, 2000)) {
      if (key === 'model' && typeof item[key] === 'string' && item[key] !== routedModel) { item[key] = routedModel; changed = true; }
      else visit(item[key], depth + 1);
    }
  }
  visit(value, 0);
  return changed;
}
function hasModel(value, expected) {
  if (!value || typeof value !== 'object') return false;
  if (value.model === expected) return true;
  return Object.values(value).slice(0, 2000).some(item => hasModel(item, expected));
}
async function bodyBuffer(body, maximum = 8 * 1024 * 1024) {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const reader = body?.getReader?.();
  const chunks = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const value = Buffer.from(item.value); size += value.length;
        if (size > maximum) throw failure('fixture_body_limit');
        chunks.push(value);
      }
    } finally { reader.releaseLock?.(); }
    return Buffer.concat(chunks);
  }
  if (typeof body[Symbol.asyncIterator] !== 'function' && typeof body[Symbol.iterator] !== 'function') throw failure('fixture_body_invalid');
  for await (const chunk of body) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maximum) throw failure('fixture_body_limit');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function bodyText(body, maximum = 8 * 1024 * 1024) { return (await bodyBuffer(body, maximum)).toString('utf8'); }
async function collectRequest(request, maximum = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw failure('fixture_body_limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function decodeContent(bytes, encoding) {
  if (encoding === 'gzip') return gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  if (encoding === 'zstd') return zstdDecompressSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  return bytes;
}
function encodeContent(bytes, encoding) {
  if (encoding === 'gzip') return gzipSync(bytes);
  if (encoding === 'zstd') return zstdCompressSync(bytes);
  return bytes;
}
function headerValue(headers, name) { return headers?.find?.(([key]) => key.toLowerCase() === name)?.[1] ?? 'identity'; }
function responseEvents(id) {
  const item = { id: `item-${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: originalResponse, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: originalResponse },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: originalResponse },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
}

function compactAcceptance(value) {
  if (!value || typeof value !== 'object') return undefined;
  const desktop = value.desktop ?? {}, backend = value.backend ?? {};
  const item = value => value && typeof value === 'object' ? { status: safeInteger(value.status), changed: value.changed === true } : undefined;
  const turnCompletions = Array.isArray(backend.turnCompletions) ? backend.turnCompletions.slice(0, 4).map(value => ({
    status: ['completed', 'failed', 'interrupted', 'cancelled', 'in_progress', 'other'].includes(value?.status) ? value.status : 'other',
    ...(typeof value?.errorCode === 'string' && /^[a-z0-9_]{1,80}$/u.test(value.errorCode) ? { errorCode: value.errorCode } : {}),
  })) : [];
  return {
    finished: value.finished === true,
    ...(typeof value.stage === 'string' && ['app_ready', 'app_server', 'production_attached', 'application_network', 'desktop_requests', 'same_origin_redirect', 'backend_turns'].includes(value.stage) ? { stage: value.stage } : {}),
    ...(typeof value.failure === 'string' && /^[a-z_]{1,100}$/u.test(value.failure) ? { failure: value.failure } : {}),
    ...(typeof value.failureStage === 'string' && ['app_ready', 'app_server', 'production_attached', 'application_network', 'desktop_requests', 'same_origin_redirect', 'backend_turns'].includes(value.failureStage) ? { failureStage: value.failureStage } : {}),
    ...(value.dialogAction === 'cancel_error' || value.dialogAction === 'acknowledge_information' ? { dialogAction: value.dialogAction } : {}),
    desktop: { fetch: item(desktop.fetch), progress: item(desktop.progress), redirect: item(desktop.redirect), emptyRedirect: item(desktop.emptyRedirect), crossOriginRedirect: desktop.crossOriginRedirect ? {
      status: safeInteger(desktop.crossOriginRedirect.status), unchanged: desktop.crossOriginRedirect.unchanged === true,
    } : undefined },
    cookieDiagnostics: value.cookieDiagnostics && typeof value.cookieDiagnostics === 'object' ? Object.fromEntries([
      'cookieInstalled', 'rawSameOriginSent', 'bridgeSameOriginSent', 'rawCrossOriginInitialSent', 'rawCrossOriginFinalSent',
      'bridgeCrossOriginInitialSent', 'bridgeCrossOriginFinalSent',
    ].map(key => [key, value.cookieDiagnostics[key] === true])) : undefined,
    backend: {
      turns: safeInteger(backend.turns), modified: backend.modified === true,
      config: backend.config && typeof backend.config === 'object' ? {
        openAiBaseUrlPrivateRoute: backend.config.openAiBaseUrlPrivateRoute === true,
        modelProviderOpenAi: backend.config.modelProviderOpenAi === true,
      } : undefined,
      accountType: ['chatgpt', 'apiKey', 'none', 'other'].includes(backend.accountType) ? backend.accountType : undefined,
      childRouteOverride: backend.childRouteOverride && typeof backend.childRouteOverride === 'object' ? {
        processObserved: backend.childRouteOverride.processObserved === true,
        lastOpenAiOverridePresent: backend.childRouteOverride.lastOpenAiOverridePresent === true,
        lastOpenAiOverridePrivateRoute: backend.childRouteOverride.lastOpenAiOverridePrivateRoute === true,
      } : undefined,
      turnCompletions,
      ...(typeof backend.requestErrorCode === 'string' && /^[a-z0-9_]{1,80}$/u.test(backend.requestErrorCode) ? { requestErrorCode: backend.requestErrorCode } : {}),
    },
    dialogs: safeInteger(value.dialogs),
    dialog: value.dialog && typeof value.dialog === 'object' ? {
      type: ['none', 'info', 'error', 'question', 'warning'].includes(value.dialog.type) ? value.dialog.type : 'unknown',
      classification: ['authentication', 'update', 'network', 'configuration', 'app_server', 'workspace', 'error', 'information'].includes(value.dialog.classification) ? value.dialog.classification : 'unknown',
      buttonCount: safeInteger(value.dialog.buttonCount),
      buttonKinds: Array.isArray(value.dialog.buttonKinds) ? value.dialog.buttonKinds.filter(item => ['cancel', 'authentication', 'retry', 'acknowledge', 'other'].includes(item)).slice(0, 8) : [],
      cancelIdPresent: value.dialog.cancelIdPresent === true,
      defaultIdPresent: value.dialog.defaultIdPresent === true,
    } : undefined,
    observer: value.observer && typeof value.observer === 'object' ? Object.fromEntries(['mainBundleSeen', 'appServerModuleSeen', 'appServerManagerCandidates', 'appServerManagerInstances'].map(key => [key, safeInteger(value.observer[key])])) : {},
    adapterState: value.adapterState && typeof value.adapterState === 'object' ? {
      installed: value.adapterState.installed === true,
      source: { connected: value.adapterState.source?.connected === true, ...(typeof value.adapterState.source?.reason === 'string' && /^[a-z_]{1,80}$/u.test(value.adapterState.source.reason) ? { reason: value.adapterState.source.reason } : {}) },
      desktop: { available: value.adapterState.desktop?.available === true, taskConfigurationAvailable: value.adapterState.desktop?.taskConfigurationAvailable === true,
        modules: Object.fromEntries(['bootstrap', 'main', 'src', 'stdio', 'connection'].map(key => [key, value.adapterState.desktop?.modules?.[key] === true])),
        ...(typeof value.adapterState.desktop?.reason === 'string' && /^[a-z_]{1,80}$/u.test(value.adapterState.desktop.reason) ? { reason: value.adapterState.desktop.reason } : {}) },
      backend: { available: value.adapterState.backend?.available === true, prepared: safeInteger(value.adapterState.backend?.prepared), declined: safeInteger(value.adapterState.backend?.declined),
        ...(typeof value.adapterState.backend?.reason === 'string' && /^[a-z_]{1,80}$/u.test(value.adapterState.backend.reason) ? { reason: value.adapterState.backend.reason } : {}) },
    } : undefined,
  };
}
function activationHas(handshake, id, coverage) {
  const source = handshake?.activatedSources?.find(value => value.id === id);
  return !!source && coverage.every(item => source.coverage?.includes(item));
}

async function main() {
  const protocol = options['--protocol'] ?? 'ws';
  const artifactRelativeDirectory = macRunner ? '../.codlet-artifacts/native-tools/request-chain/macos-product/owned-acceptance'
    : '../.codlet-artifacts/native-tools/request-chain/current/owned-acceptance';
  const report = {
    schema: 1,
    kind: 'official-main-owned-plaintext-acceptance',
    platform: process.platform, architecture: process.arch,
    protocol,
    backendSha256: /^[0-9a-f]{64}$/iu.test(expectedBackendHash) ? expectedBackendHash.toLowerCase() : undefined,
    build: { bootstrapBundle: options['--bootstrap-bundle'], mainBundle: options['--main-bundle'], appServerModule: options['--app-server-module'],
      fetchWrapperSymbol: options['--fetch-wrapper-symbol'], applicationNetworkFactory: options['--application-network-factory'] },
    nativeAuthorizationFixtureOnly: true,
    proxyConfigured: false,
    certificateConfigured: false,
    exactChildVerified: false,
    installed: false,
    activatedSources: [],
    fixture: { desktopRequests: 0, desktopBodiesModified: 0, redirectStarts: 0, redirectFinals: 0,
      emptyRedirectStarts: 0, emptyRedirectFinals: 0,
      crossOriginRedirects: 0, crossOriginFinals: 0, crossOriginBodyObservedByOrigin1: 0,
      cookieRawSameOriginSent: false, cookieBridgeSameOriginSent: false,
      cookieRawCrossOriginInitialSent: false, cookieRawCrossOriginFinalSent: false,
      cookieBridgeCrossOriginInitialSent: false, cookieBridgeCrossOriginFinalSent: false,
      httpModelRequests: 0, httpModelRouted: 0, sseResponses: 0, webSocketAttempts: 0,
      webSocketRejected426: 0, webSocketFrames: 0, webSocketModelRouted: 0, webSocketModifiedResponses: 0,
      fakeAuthorizationSeen: false, unauthorizedForwardAttempts: 0 },
  };
  let lifetime, registry, owner, source, runtime, child, directory, server, crossServer, webSockets, observer, inspectorUrl, crossOriginEndpoint;
  let receiptPath, fixtureGo, executable, backend, originalProcesses, owned = new Map(), rootIdentity;
  const serverSockets = new Set(), crossServerSockets = new Set();
  const powershell = process.platform === 'win32' ? path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;
  const powershellCall = (script, env = {}) => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 10000,
  }).trim();
  function snapshot() {
    if (macRunner) {
      const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', timeout: 10000 });
      return rows.split('\n').flatMap(row => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/u.exec(row);
        return match ? [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Created: match[3], ExecutablePath: match[4] }] : [];
      });
    }
    const output = powershellCall("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress");
    if (!output) return [];
    const values = JSON.parse(output);
    return (Array.isArray(values) ? values : [values]).filter(value => Number.isSafeInteger(value.ProcessId) && typeof value.Created === 'string');
  }
  function capture() {
    if (!child?.pid) return;
    const values = snapshot(), live = new Map(values.map(value => [value.ProcessId, value]));
    for (let changed = true; changed;) {
      changed = false;
      for (const value of values) {
        if (owned.has(value.ProcessId) || originalProcesses.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)) continue;
        if (value.ProcessId === child.pid) {
          if (!macRunner && value.ExecutablePath && canonicalPath(value.ExecutablePath) !== canonicalPath(executable)) continue;
          owned.set(value.ProcessId, value); changed = true; continue;
        }
        const parent = owned.get(value.ParentProcessId);
        if (parent && live.get(parent.ProcessId)?.Created === parent.Created && childAfterParent(value.Created, parent.Created)) { owned.set(value.ProcessId, value); changed = true; }
      }
    }
    return values;
  }
  async function waitFor(predicate, code, timeoutMs, captureProcesses = false) {
    const deadline = Date.now() + timeoutMs;
    let nextCapture = 0;
    while (true) {
      if (predicate()) return;
      if (captureProcesses && Date.now() >= nextCapture) { capture(); nextCapture = Date.now() + 750; }
      if (Date.now() >= deadline) throw failure(code);
      await sleep(100);
    }
  }
  async function openObserver(url) {
    const socket = new WebSocket(url);
    const calls = new Map(), resumedWaiters = []; let sequence = 0, pausedResolve, resumedCount = 0;
    const paused = new Promise(resolve => { pausedResolve = resolve; });
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.method === 'Debugger.paused') pausedResolve(message.params);
      if (message.method === 'Debugger.resumed') {
        resumedCount++;
        for (const waiter of [...resumedWaiters]) if (resumedCount > waiter.after) {
          clearTimeout(waiter.timer); resumedWaiters.splice(resumedWaiters.indexOf(waiter), 1); waiter.resolve();
        }
      }
      const call = calls.get(message.id);
      if (!call) return;
      calls.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(failure('inspector_protocol_failed'));
      else call.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(failure('inspector_connect_failed')), { once: true });
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { calls.delete(id); reject(failure('inspector_timeout')); }, 8000);
      calls.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const waitForResumedAfter = (after, timeoutMs) => new Promise((resolve, reject) => {
      if (resumedCount > after) { resolve(); return; }
      const waiter = { after, resolve, timer: setTimeout(() => {
        resumedWaiters.splice(resumedWaiters.indexOf(waiter), 1); reject(failure('inspector_resume_timeout'));
      }, timeoutMs) };
      resumedWaiters.push(waiter);
    });
    return { socket, paused, send, waitForResumedAfter, get resumedCount() { return resumedCount; } };
  }
  async function closeObserver() {
    if (!observer?.socket) return;
    const socket = observer.socket;
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => {
      const timer = setTimeout(resolve, 1200);
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    try { socket.close(); } catch {}
    await closed;
  }
  async function writeJson(file, value) {
    await fs.writeFile(file + '.tmp', JSON.stringify(value));
    await fs.rename(file + '.tmp', file);
  }
  async function readReceiptUntilFinished() {
    const deadline = Date.now() + 40000;
    let last;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        last = value;
        if (value?.finished === true) return value;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw failure('fixture_receipt_invalid');
      }
      await sleep(100);
    }
    if (last) report.acceptance = compactAcceptance(last);
    throw failure('fixture_timeout');
  }
  async function stopOwnedTree() {
    if (!child?.pid) return;
    capture();
    for (const processInfo of [...owned.values()].reverse()) {
      if (macRunner) {
        if (snapshot().some(item => item.ProcessId === processInfo.ProcessId && item.Created === processInfo.Created)) {
          try { process.kill(processInfo.ProcessId, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      } else powershellCall("$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:CODLET_OWNED_PID); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $env:CODLET_OWNED_CREATED) { try { Stop-Process -Id ([int]$env:CODLET_OWNED_PID) -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*') { throw } } }", {
        CODLET_OWNED_PID: String(processInfo.ProcessId), CODLET_OWNED_CREATED: processInfo.Created,
      });
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const live = snapshot(), ids = new Set(live.map(value => `${value.ProcessId}:${value.Created}`));
      if (![...owned.values()].some(value => ids.has(`${value.ProcessId}:${value.Created}`))) return;
      await sleep(100);
    }
    if (macRunner) for (const processInfo of [...owned.values()].reverse()) {
      if (snapshot().some(item => item.ProcessId === processInfo.ProcessId && item.Created === processInfo.Created)) {
        try { process.kill(processInfo.ProcessId, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }

  try {
    if (process.platform === 'win32' && process.env.CODLET_TEST_DISPOSABLE_WINDOWS_HOST !== '1') throw failure('disposable_windows_host_required');
    if (!(process.platform === 'win32' && process.versions.node.split('.')[0] === '24' || macRunner && process.version === 'v22.23.2')
      || options['--run-owned'] !== 'yes'
      || macRunner && options['--backend-sha256'] === undefined
      || !path.isAbsolute(options['--executable'] ?? '') || !path.isAbsolute(options['--backend'] ?? '')
      || !['ws', 'http'].includes(protocol) || !safeBundleName(options['--bootstrap-bundle'])
      || !safeBundleName(options['--main-bundle']) || !safeBundleName(options['--app-server-module'])
      || !/^[0-9a-f]{64}$/iu.test(expectedBackendHash) || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(options['--application-network-factory'] ?? '')
      || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(options['--fetch-wrapper-symbol'] ?? '')) throw failure('explicit_owned_paths_required');
    const corePath = options['--core'] ?? process.env.CODLET_CORE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
    if (!path.isAbsolute(corePath)) throw failure('core_root_invalid');
    const coreRoot = await fs.realpath(corePath);
    executable = await fs.realpath(options['--executable']);
    backend = await fs.realpath(options['--backend']);
    if (createHash('sha256').update(await fs.readFile(backend)).digest('hex') !== expectedBackendHash) throw failure('backend_build_unverified');
    if (macRunner) {
      const reviewed = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/traffic/mac-plaintext-reviewed.json'), 'utf8'));
      const resources = path.resolve(path.dirname(executable), '..', 'Resources');
      if (reviewed.status !== 'native-plaintext-reviewed' || backend !== path.join(resources, 'codex') || expectedBackendHash !== reviewed.backend.sha256
        || createHash('sha256').update(await fs.readFile(path.join(resources, 'app.asar'))).digest('hex') !== reviewed.asarSha256)
        throw failure('mac_reviewed_artifact_mismatch');
    }
    const [{ nativeTraffic }, { verifyOwnedMainHandshake }] = [
      await import(pathToFileURL(path.join(coreRoot, 'tests/support/native-traffic.mjs')).href),
      await import('./verify-owned-main-handshake.mjs'),
    ];
    const { WebSocketServer } = require('ws');
    originalProcesses = snapshot();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codlet-official-main-'));
    lifetime = new AbortController();
    receiptPath = path.join(directory, 'receipt.json');
    fixtureGo = path.join(directory, 'attached.go');
    const fixture = report.fixture;
    const crossOriginResponse = 'codlet-cross-origin-response';
    const cookieName = 'codlet-owned-fixture-cookie';
    const cookieValue = 'codlet-synthetic-cookie-only';
    const cookiePair = `${cookieName}=${cookieValue}`;
    let cookieSameOriginCalls = 0, cookieCrossInitialCalls = 0, cookieCrossFinalCalls = 0;
    const cookieCrossInitialByCall = [];
    const hasSyntheticCookie = request => typeof request.headers?.cookie === 'string'
      && request.headers.cookie.split(';').some(value => value.trim() === cookiePair);
    const rawDiagnosticRedirectBody = 'codlet-electron-raw-redirect';
    const rawDiagnosticSameFinal = 'codlet-electron-same-final';
    const secondServer = http.createServer(async (request, response) => {
      try { await collectRequest(request); } catch { response.writeHead(413); response.end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/desktop/cookie-cross-final') {
        const sent = hasSyntheticCookie(request), index = cookieCrossFinalCalls++;
        if (index === 0) fixture.cookieRawCrossOriginFinalSent = sent;
        else if (index === 1) fixture.cookieBridgeCrossOriginFinalSent = sent;
        const initial = cookieCrossInitialByCall[index] === true;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(`${initial ? '1' : '0'}${sent ? '1' : '0'}`); return;
      }
      if (request.method === 'GET' && url.pathname === '/desktop/cross-origin-final') {
        fixture.crossOriginFinals++;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(crossOriginResponse); return;
      }
      if (request.method === 'GET' && new URL(request.url, 'http://127.0.0.1').pathname === '/desktop/diagnostic-cross-final') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(crossOriginResponse); return;
      }
      response.writeHead(404); response.end();
    });
    secondServer.on('connection', socket => { crossServerSockets.add(socket); socket.on('close', () => crossServerSockets.delete(socket)); });
    await new Promise(resolve => secondServer.listen(0, '127.0.0.1', resolve));
    crossServer = secondServer;
    crossOriginEndpoint = `http://127.0.0.1:${crossServer.address().port}`;
    const upstream = http.createServer(async (request, response) => {
      let requestBody;
      try { requestBody = await collectRequest(request); } catch { response.writeHead(413); response.end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/desktop/cookie-direct') {
        const sent = hasSyntheticCookie(request), index = cookieSameOriginCalls++;
        if (index === 0) fixture.cookieRawSameOriginSent = sent;
        else if (index === 1) fixture.cookieBridgeSameOriginSent = sent;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(sent ? '1' : '0'); return;
      }
      if (request.method === 'GET' && url.pathname === '/desktop/cookie-cross-redirect') {
        const sent = hasSyntheticCookie(request), index = cookieCrossInitialCalls++;
        cookieCrossInitialByCall[index] = sent;
        if (index === 0) fixture.cookieRawCrossOriginInitialSent = sent;
        else if (index === 1) fixture.cookieBridgeCrossOriginInitialSent = sent;
        response.writeHead(302, { location: `${crossOriginEndpoint}/desktop/cookie-cross-final`, 'content-length': '0' }); response.end(); return;
      }
      if (request.method === 'GET' && url.pathname === '/desktop/diagnostic-302') {
        response.writeHead(302, { location: '/desktop/diagnostic-final', 'content-type': 'text/plain; charset=utf-8' }); response.end(rawDiagnosticRedirectBody); return;
      }
      if (request.method === 'GET' && url.pathname === '/desktop/diagnostic-cross-302') {
        response.writeHead(302, { location: crossOriginEndpoint + '/desktop/diagnostic-cross-final', 'content-type': 'text/plain; charset=utf-8' }); response.end(rawDiagnosticRedirectBody); return;
      }
      if (request.method === 'GET' && url.pathname === '/desktop/diagnostic-final') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(rawDiagnosticSameFinal); return;
      }
      if (url.pathname.startsWith('/desktop/')) {
        fixture.desktopRequests++;
        if (request.method === 'GET' && url.pathname === '/desktop/redirect') {
          fixture.redirectStarts++;
          response.writeHead(302, { location: '/desktop/fetch', 'content-type': 'text/plain; charset=utf-8' }); response.end(originalResponse); return;
        }
        if (request.method === 'GET' && url.pathname === '/desktop/redirect-empty') {
          fixture.emptyRedirectStarts++;
          response.writeHead(302, { location: '/desktop/empty-final', 'content-length': '0' }); response.end(); return;
        }
        if (request.method === 'GET' && url.pathname === '/desktop/cross-origin-redirect') {
          fixture.crossOriginRedirects++;
          response.writeHead(302, { location: crossOriginEndpoint + '/desktop/cross-origin-final', 'content-type': 'text/plain; charset=utf-8' }); response.end(originalResponse); return;
        }
        if (request.method === 'GET' && url.pathname === '/desktop/fetch') fixture.redirectFinals++;
        if (request.method === 'GET' && url.pathname === '/desktop/empty-final') fixture.emptyRedirectFinals++;
        if (requestBody.toString('utf8') === modifiedRequest) fixture.desktopBodiesModified++;
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(originalResponse); return;
      }
      if (url.pathname === '/v1/models' || url.pathname.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ models: [], data: [] })); return;
      }
      if (url.pathname === '/v1/responses' || url.pathname.endsWith('/responses')) {
        fixture.httpModelRequests++;
        let body = null;
        try { body = parseModel(decodeContent(requestBody, String(request.headers['content-encoding'] ?? 'identity').toLowerCase()).toString('utf8')); } catch {}
        if (body && hasModel(body, routedModel)) fixture.httpModelRouted++;
        if (request.headers.authorization === 'Bearer codlet-local-fixture') fixture.fakeAuthorizationSeen = true;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const event of responseEvents(`http-${fixture.sseResponses + 1}`)) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        fixture.sseResponses++;
        response.end(); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
    });
    upstream.on('connection', socket => { serverSockets.add(socket); socket.on('close', () => serverSockets.delete(socket)); });
    upstream.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
    upstream.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      fixture.webSocketAttempts++;
      if (request.headers.authorization === 'Bearer codlet-local-fixture') fixture.fakeAuthorizationSeen = true;
      if (url.pathname !== '/v1/responses' || protocol === 'http') {
        if (protocol === 'http' && url.pathname === '/v1/responses') fixture.webSocketRejected426++;
        socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      webSockets.handleUpgrade(request, socket, head, connection => webSockets.emit('connection', connection, request));
    });
      webSockets.on('connection', connection => connection.on('message', data => {
      fixture.webSocketFrames++;
      const message = parseModel(data.toString());
      if (message && hasModel(message, routedModel)) fixture.webSocketModelRouted++;
      if (!message || message.type !== 'response.create' || !hasModel(message, routedModel)) return;
      for (const event of responseEvents(`ws-${fixture.webSocketFrames}`)) connection.send(JSON.stringify(event));
    }));
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    server = upstream;
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const origin = new URL(endpoint).origin;
    source = await nativeTraffic(null, { origins: [origin] });
    runtime = source.runtime();
    registry = await runtime.api.registerInterceptor({
      id: 'synthetic-local-production-acceptance', origins: [origin], priority: 0, timeoutMs: 1800,
    }, {
      async request(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith('/desktop/')) {
          if (request.body == null) return null;
          const text = await bodyText(request.body);
          if (text === originalRequest) return { request: { body: modifiedRequest } };
          return null;
        }
        if (pathname === '/v1/responses' || pathname.endsWith('/responses')) {
          const encoding = headerValue(request.headers, 'content-encoding').toLowerCase();
          const encoded = await bodyBuffer(request.body);
          let body;
          try { body = parseModel(decodeContent(encoded, encoding).toString('utf8')); } catch { return null; }
          if (!body || !rewriteModel(body)) return null;
          return { request: { body: encodeContent(Buffer.from(JSON.stringify(body)), encoding) } };
        }
        return null;
      },
      async response(response, context) {
        if (response.body == null) return;
        if (normalizeOrigin(context.request.url) !== origin) { fixture.crossOriginBodyObservedByOrigin1++; return; }
        if (new URL(context.request.url).pathname.startsWith('/desktop/cookie-')) return;
        const text = await bodyText(response.body);
        if (text.includes(crossOriginResponse)) fixture.crossOriginBodyObservedByOrigin1++;
        if (!text.includes(originalResponse)) return;
        return { body: text.replaceAll(originalResponse, modifiedResponse) };
      },
      webSocket() {
        return {
          clientToServer(frame) {
            if (frame.binary || typeof frame.data !== 'string') return frame;
            const body = parseModel(frame.data);
            if (!body || !rewriteModel(body)) return frame;
            return { data: JSON.stringify(body), binary: false };
          },
          serverToClient(frame) {
            if (frame.binary || typeof frame.data !== 'string' || !frame.data.includes(originalResponse)) return frame;
            fixture.webSocketModifiedResponses++;
            return { data: frame.data.replaceAll(originalResponse, modifiedResponse), binary: false };
          },
        };
      },
    });
    const traffic = { source: source.descriptor, environmentPatch: { set: {}, removeCaseInsensitive: [] } };
    const adapterPath = path.join(root, 'bundled/codex-desktop-adapter/host.cjs');
    const { prepareClientLaunch } = require(adapterPath);
    const prepared = await prepareClientLaunch({ traffic, signal: lifetime.signal });
    if (!Array.isArray(prepared?.arguments) || !prepared.arguments.every(value => typeof value === 'string')) throw failure('adapter_prepare_failed');
    const appData = macRunner ? path.join(directory, 'home', 'Library', 'Application Support') : path.join(directory, 'home', 'AppData', 'Roaming');
    const localAppData = macRunner ? path.join(directory, 'home', 'Library', 'Caches') : path.join(directory, 'home', 'AppData', 'Local');
    const paths = {
      home: path.join(directory, 'home'), appData, userData: path.join(directory, 'user-data'),
      temp: path.join(directory, 'temp'), codexHome: path.join(directory, 'codex-home'),
      sqlite: path.join(directory, 'sqlite'),
    };
    for (const value of Object.values(paths)) await fs.mkdir(value, { recursive: true });
    const config = [
      'cli_auth_credentials_store="file"',
      'sandbox_mode="read-only"',
      'approval_policy="never"',
      'model="gpt-5.4"',
      `openai_base_url=${JSON.stringify(endpoint + '/v1')}`,
      `chatgpt_base_url=${JSON.stringify(endpoint + '/backend-api')}`,
      'responses_websockets=true',
      'responses_websockets_v2=true',
      '[analytics]', 'enabled=false',
      '[features]', 'plugins=false', 'remote_models=false', 'remote_plugin=false', 'code_mode_host=false',
      '[mcp_servers.codex_app]', 'command=""', 'enabled=false',
    ].join('\n') + '\n';
    await fs.writeFile(path.join(paths.codexHome, 'config.toml'), config);
    await fs.writeFile(path.join(paths.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'codlet-local-fixture' }));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|USERNAME|USERDOMAIN|SHELL|LANG|LC_ALL)$/iu.test(name)));
    Object.assign(environment, {
      CODEX_HOME: paths.codexHome, CODEX_SQLITE_HOME: paths.sqlite,
      CODEX_ELECTRON_USER_DATA_PATH: paths.userData, CODEX_CLI_PATH: backend,
      HOME: paths.home, USERPROFILE: paths.home, APPDATA: appData, LOCALAPPDATA: localAppData,
      TEMP: paths.temp, TMP: paths.temp, CODEX_SPARKLE_ENABLED: 'false',
      CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE: 'manual',
      CODEX_APP_SERVER_OPENAI_BASE_URL: endpoint + '/v1',
      CODEX_APP_SERVER_CHATGPT_BASE_URL: endpoint + '/backend-api',
      CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES: JSON.stringify({ externalBrowserUseAllowed: false, externalBrowserUse: false,
        inAppBrowserUseAllowed: false, inAppBrowserUse: false, browserExtensions: false, browserPane: false,
        computerUse: false, computerUseAutoInstall: false, browserUseTinysky: false,
        appshotsEnabled: false, quickChat: false, sites: false, autoAuthForSites: false, control: false,
        skysight: false, recordAndReplay: false }),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'never',
    });
    if (macRunner) {
      delete environment.USERPROFILE; delete environment.APPDATA; delete environment.LOCALAPPDATA;
      delete environment.TEMP; delete environment.TMP;
      environment.TMPDIR = paths.temp;
    } else {
      // The reviewed Windows fixture uses Dev; Mac must honor the signed app's
      // prod package metadata or its internal build path requires bundled Git.
      environment.BUILD_FLAVOR = 'dev';
    }
    for (const [name, value] of Object.entries(traffic.environmentPatch.set)) environment[name] = value;
    for (const name of traffic.environmentPatch.removeCaseInsensitive) for (const key of Object.keys(environment)) if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
    child = spawn(executable, [...prepared.arguments, `--user-data-dir=${paths.userData}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--disable-background-networking', '--no-first-run', '--disable-default-apps'], {
      env: environment, cwd: directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrTail = '';
    child.stderr.on('data', chunk => {
      const text = chunk.toString(); stderrTail = (stderrTail + text).slice(-8192);
      const kinds = ['ERR_[A-Z_]+', 'SyntaxError', 'ReferenceError', 'TypeError', 'backend_launch_not_observed', 'backend_tool_environment_unsupported'];
      for (const pattern of kinds) for (const match of text.matchAll(new RegExp(pattern, 'gu'))) {
        const kind = match[0];
        if (kind.length <= 80) (report.startupErrorKinds ??= new Set()).add(kind);
      }
      if (!inspectorUrl) {
        const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36})/u.exec(stderrTail);
        if (match) inspectorUrl = match[1];
      }
    });
    child.once('error', () => { (report.spawnError = 'owned_client_spawn_failed'); });
    capture();
    await waitFor(() => owned.has(child.pid), 'owned_identity_missing', 8000, true);
    rootIdentity = owned.get(child.pid);
    if (!rootIdentity || !macRunner && canonicalPath(rootIdentity.ExecutablePath ?? '') !== canonicalPath(executable)) throw failure('spawn_identity_mismatch');
    await waitFor(() => !!inspectorUrl || child.exitCode != null, child.exitCode != null ? 'owned_client_exited' : 'inspector_timeout', 10000);
    if (!inspectorUrl) throw failure(child.exitCode != null ? 'owned_client_exited' : 'inspector_timeout');
    report.inspectorListening = true;
    observer = await openObserver(inspectorUrl);
    await observer.send('Debugger.enable');
    await observer.send('Runtime.runIfWaitingForDebugger');
    const paused = await Promise.race([observer.paused, sleep(8000).then(() => { throw failure('main_pause_timeout'); })]);
    const frame = paused?.callFrames?.[0];
    if (!frame?.callFrameId) throw failure('main_first_frame_missing');
    const identity = await observer.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
      expression: "({pid:process.pid,path:require('node:fs').realpathSync(process.execPath),ready:require('electron').app.isReady(),type:process.type})", returnByValue: true });
    const childIdentity = identity?.result?.value;
    if (childIdentity?.pid !== child.pid || canonicalPath(childIdentity.path ?? '') !== canonicalPath(executable)
      || childIdentity.ready !== false || childIdentity.type !== 'browser') throw failure('main_identity_mismatch');
    report.exactChildVerified = true;
    const observerSource = await fs.readFile(path.join(root, 'tests/fixtures/traffic/production-owned-main.cjs'), 'utf8');
    const diagnosticDirectory = path.join(root, artifactRelativeDirectory);
    await fs.mkdir(diagnosticDirectory, { recursive: true });
    const dialogDiagnosticPath = path.join(diagnosticDirectory, `${protocol}-dialog.json`);
    const runErrorDiagnosticPath = path.join(diagnosticDirectory, `${protocol}-observer-error.json`);
    const rawDiagnosticPath = path.join(diagnosticDirectory, `${protocol}-electron-network-diagnostics.json`);
    const fixtureConfiguration = { upstream: endpoint, crossOrigin: crossOriginEndpoint, crossOriginResponse, protocol,
      trafficRouteBaseUrl: source.descriptor.routeBaseUrl, receipt: receiptPath, go: fixtureGo, paths,
      bootstrapBundle: options['--bootstrap-bundle'], mainBundle: options['--main-bundle'], appServerModule: options['--app-server-module'],
      fetchWrapperSymbol: options['--fetch-wrapper-symbol'], applicationNetworkFactory: options['--application-network-factory'],
      dialogDiagnosticPath, runErrorDiagnosticPath, rawDiagnosticPath };
    const expression = `(()=>{const module={exports:{}};((module,exports,require)=>{${observerSource}\n})(module,module.exports,require);return module.exports.installOwnedAcceptance(require('electron'),${JSON.stringify(fixtureConfiguration)})})()`;
    const injected = await observer.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true });
    if (injected.exceptionDetails || injected?.result?.value !== true) throw failure('observer_fixture_injection_failed');
    const resumeCount = observer.resumedCount;
    const handshakePromise = verifyOwnedMainHandshake({ inspectorUrl, expectedPid: child.pid, executable, traffic, signal: lifetime.signal });
    handshakePromise.catch(() => {});
    const handshakeEvent = observer.waitForResumedAfter(resumeCount, 10500).then(() => 'resumed', () => 'resume_wait_finished');
    await Promise.race([handshakeEvent, handshakePromise.then(() => 'attached', () => 'attach_failed')]);
    await closeObserver();
    const handshake = await handshakePromise;
    report.installed = handshake.installed;
    report.exactChildVerified = report.exactChildVerified && handshake.exactChildVerified;
    report.activatedSources = handshake.activatedSources;
    report.unsupportedSources = handshake.unsupportedSources;
    await writeJson(fixtureGo, { go: true });
    const acceptance = await readReceiptUntilFinished();
    report.acceptance = compactAcceptance(acceptance);
    report.networkDiagnosticArtifact = `${artifactRelativeDirectory}/${protocol}-electron-network-diagnostics.json`;
    try {
      const trafficStatus = await runtime.api.inspect();
      report.trafficInspect = { registered: safeInteger(trafficStatus?.registered), active: safeInteger(trafficStatus?.active), pending: safeInteger(trafficStatus?.pending),
        activatedSourceIds: report.activatedSources.map(value => value.id).filter(value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value)).slice(0, 8) };
    } catch {}
    if (acceptance.failure) report.fixtureFailure = acceptance.failure;
  } catch (error) {
    report.failure = codeOf(error);
    const stages = new Set(['connect', 'pause', 'identity', 'install', 'resume', 'ready', 'detach']);
    const methods = new Set(['Debugger.enable', 'Runtime.runIfWaitingForDebugger', 'Debugger.evaluateOnCallFrame', 'Debugger.resume', 'Runtime.evaluate']);
    const errorDetails = error?.details ?? {};
    const details = {
      ...(stages.has(errorDetails.stage) ? { stage: errorDetails.stage } : {}),
      ...(methods.has(errorDetails.method) ? { method: errorDetails.method } : {}),
    };
    if (errorDetails.runtime && typeof errorDetails.runtime === 'object') details.runtime = errorDetails.runtime;
    if (errorDetails.owned && typeof errorDetails.owned === 'object') details.owned = errorDetails.owned;
    if (Number.isSafeInteger(errorDetails.pauseReasonCount)) details.pauseReasonCount = errorDetails.pauseReasonCount;
    if (Array.isArray(errorDetails.timings)) details.timings = errorDetails.timings.slice(-12);
    if (Object.keys(details).length) report.failureDetails = details;
  } finally {
    try { await stopOwnedTree(); } catch { report.ownedTreeCleanupFailed = true; }
    child?.stdout?.destroy(); child?.stderr?.destroy();
    lifetime?.abort(failure('acceptance_finished'));
    try { owner?.abort(); } catch {}
    try { await registry?.close(); } catch {}
    try { runtime?.closeAll(); } catch {}
    try { await source?.close(); } catch {}
    try { await closeObserver(); } catch {}
    if (webSockets) for (const connection of webSockets.clients) connection.terminate();
    if (server) {
      for (const socket of serverSockets) socket.destroy();
      try { await new Promise(resolve => server.close(resolve)); } catch {}
    }
    if (crossServer) {
      for (const socket of crossServerSockets) socket.destroy();
      try { await new Promise(resolve => crossServer.close(resolve)); } catch {}
    }
    if (webSockets) try { await new Promise(resolve => webSockets.close(resolve)); } catch {}
    if (originalProcesses) {
      const after = snapshot();
      report.originalClientIdentitiesUnchanged = originalProcesses.filter(value => macRunner
        ? /\/(?:ChatGPT|Codex)$/u.test(value.ExecutablePath ?? '')
        : /\\(?:ChatGPT|Codex)\.exe$/iu.test(value.ExecutablePath ?? '')).every(value => after.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created));
      report.ownedRemaining = [...owned.values()].filter(value => after.some(item => item.ProcessId === value.ProcessId && item.Created === value.Created)).length;
      if (directory && report.ownedRemaining === 0) {
        try {
          if (macRunner) {
            const resolved = await fs.realpath(directory), temporary = await fs.realpath(os.tmpdir());
            if (path.dirname(resolved) !== temporary || !path.basename(resolved).startsWith('codlet-official-main-')) throw failure('bad_fixture_path');
            await fs.rm(resolved, { recursive: true });
          } else powershellCall("$p=[IO.Path]::GetFullPath($env:CODLET_FIXTURE_DIRECTORY); $parent=[IO.Path]::GetDirectoryName($p).TrimEnd('\\'); $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\'); if(-not [string]::Equals($parent,$temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($p) -notlike 'codlet-official-main-*') { throw 'bad_fixture_path' }; $long='\\\\?\\'+$p; $items=@(Get-Item -LiteralPath $long -Force -ErrorAction Stop)+@(Get-ChildItem -LiteralPath $long -Recurse -Force -ErrorAction Stop); if(@($items | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count) { throw 'fixture_reparse' }; foreach($item in $items) { $item.Attributes=$item.Attributes -band (-bnot ([IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden)) }; $removed=$false; for($attempt=0;$attempt -lt 40;$attempt++) { try { Remove-Item -LiteralPath $long -Recurse -ErrorAction Stop; $removed=$true; break } catch { if($attempt -eq 39) { throw }; Start-Sleep -Milliseconds 100 } }; if(-not $removed -and (Test-Path -LiteralPath $long)) { throw 'fixture_cleanup_failed' }", { CODLET_FIXTURE_DIRECTORY: directory });
          report.cleanup = true;
        } catch { report.cleanup = false; report.retainedDirectory = true; }
      } else if (directory) { report.cleanup = false; report.retainedDirectory = true; }
    }
    if (report.startupErrorKinds instanceof Set) report.startupErrorKinds = [...report.startupErrorKinds].slice(0, 20);
    const artifactDirectory = path.join(root, artifactRelativeDirectory);
    const artifactName = report.failure && !report.exactChildVerified ? `${protocol}-preflight-failure.json` : `${protocol}.json`;
    const artifactPath = path.join(artifactDirectory, artifactName);
    report.artifact = `${artifactRelativeDirectory}/${artifactName}`;
    const desktopCoverage = activationHas({ activatedSources: report.activatedSources }, 'desktop-main-http', ['desktop-main-fetch', 'desktop-main-upload-progress']);
    const backendCoverage = activationHas({ activatedSources: report.activatedSources }, 'owned-backend-provider', ['owned-local-app-server-model-provider']);
    const acceptedTransport = protocol === 'http'
      ? report.fixture.webSocketRejected426 > 0 && report.fixture.httpModelRequests >= 2 && report.fixture.httpModelRouted >= 2
        && report.fixture.sseResponses >= 2 && report.fixture.webSocketFrames === 0
      : report.fixture.webSocketFrames > 0 && report.fixture.webSocketModelRouted > 0 && report.fixture.webSocketModifiedResponses > 0;
    report.accepted = !report.failure && report.installed && report.exactChildVerified && desktopCoverage && backendCoverage
      && report.acceptance?.finished && !report.acceptance?.failure && report.acceptance.desktop?.fetch?.changed
      && report.acceptance.desktop?.progress?.changed && report.acceptance.desktop?.redirect?.status === 200
      && report.acceptance.desktop?.redirect?.changed && report.acceptance.desktop?.emptyRedirect?.status === 200
      && report.acceptance.desktop?.emptyRedirect?.changed && report.acceptance.desktop?.crossOriginRedirect?.status === 200
      && report.acceptance.desktop?.crossOriginRedirect?.unchanged && report.acceptance.backend?.turns === 2
      && report.acceptance.backend?.modified && report.fixture.desktopBodiesModified >= 2
      && report.fixture.redirectStarts === 1 && report.fixture.redirectFinals >= 1
      && report.fixture.emptyRedirectStarts === 1 && report.fixture.emptyRedirectFinals === 1
      && report.fixture.crossOriginRedirects === 1 && report.fixture.crossOriginFinals === 1
      && report.fixture.crossOriginBodyObservedByOrigin1 === 0
      && report.acceptance.cookieDiagnostics?.cookieInstalled === true
      && report.acceptance.cookieDiagnostics?.bridgeSameOriginSent === report.acceptance.cookieDiagnostics?.rawSameOriginSent
      && report.acceptance.cookieDiagnostics?.rawCrossOriginInitialSent === report.acceptance.cookieDiagnostics?.bridgeCrossOriginInitialSent
      && report.acceptance.cookieDiagnostics?.bridgeCrossOriginFinalSent === report.acceptance.cookieDiagnostics?.rawCrossOriginFinalSent
      && report.fixture.cookieRawSameOriginSent === report.acceptance.cookieDiagnostics?.rawSameOriginSent
      && report.fixture.cookieBridgeSameOriginSent === report.acceptance.cookieDiagnostics?.bridgeSameOriginSent
      && report.fixture.cookieRawCrossOriginInitialSent === report.acceptance.cookieDiagnostics?.rawCrossOriginInitialSent
      && report.fixture.cookieRawCrossOriginFinalSent === report.acceptance.cookieDiagnostics?.rawCrossOriginFinalSent
      && report.fixture.cookieBridgeCrossOriginInitialSent === report.acceptance.cookieDiagnostics?.bridgeCrossOriginInitialSent
      && report.fixture.cookieBridgeCrossOriginFinalSent === report.acceptance.cookieDiagnostics?.bridgeCrossOriginFinalSent
      && report.fixture.unauthorizedForwardAttempts === 0 && report.fixture.fakeAuthorizationSeen && acceptedTransport
      && report.cleanup && report.ownedRemaining === 0 && report.originalClientIdentitiesUnchanged;
    try {
      await fs.mkdir(artifactDirectory, { recursive: true });
      await fs.writeFile(artifactPath, JSON.stringify(report, null, 2) + '\n');
    } catch { report.artifactWriteFailed = true; report.accepted = false; }
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.accepted) process.exitCode = 1;
  }
}

await main();
