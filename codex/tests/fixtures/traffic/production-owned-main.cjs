'use strict';
// Test-only observer in a new private Desktop. Production hooks are installed
// independently through the packaged Adapter's prepare/attach entry points.
function installOwnedAcceptance(electron, config) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(config.fetchWrapperSymbol ?? '')) throw Error('fixture_build_invalid');
  const state = { managers: new Set(), FetchWrapper: null };
  const key = Symbol.for('codlet.test.production-source');
  globalThis[key] = state;
  const getPath = electron.app.getPath, setPath = electron.app.setPath;
  electron.app.getPath = function(name) { return config.paths[name] ?? getPath.call(this, name); };
  electron.app.setPath = function(name, value) { if (config.paths[name] === value) return; return setPath.call(this, name, value); };
  for (const name of ['show', 'showInactive', 'focus']) electron.BrowserWindow.prototype[name] = function() {};
  const report = { finished: false, desktop: {}, backend: {}, dialogs: 0,
    observer: { mainBundleSeen: 0, appServerModuleSeen: 0, appServerManagerCandidates: 0, appServerManagerInstances: 0 }, adapterState: null };
  report.rawDiagnosticFetch = null;
  report.cookieDiagnostics = null;
  function summarizeDialog(options) {
    const content = [options?.title, options?.message, options?.detail].filter(value => typeof value === 'string').join('\n').toLowerCase();
    const classification = /sign.?in|log.?in|authentication|login|account required/.test(content) ? 'authentication'
      : /update|upgrade/.test(content) ? 'update'
      : /app.?server/.test(content) ? 'app_server'
      : /network|connect|offline|request failed|server/.test(content) ? 'network'
      : /config|settings/.test(content) ? 'configuration'
      : /folder|workspace|directory|file system/.test(content) ? 'workspace'
      : /error|failed|unable|could not/.test(content) ? 'error'
      : /success|completed|ready/.test(content) ? 'information' : 'unknown';
    const labelKind = value => /cancel|quit|no\b/iu.test(value) ? 'cancel'
      : /sign|log|account/iu.test(value) ? 'authentication'
      : /retry|try again/iu.test(value) ? 'retry'
      : /ok|got it|close|continue/iu.test(value) ? 'acknowledge' : 'other';
    const buttons = Array.isArray(options?.buttons) ? options.buttons.slice(0, 8).map(value => typeof value === 'string' ? labelKind(value) : 'other') : [];
    return { type: ['none', 'info', 'error', 'question', 'warning'].includes(options?.type) ? options.type : 'unknown', classification,
      buttonCount: buttons.length, buttonKinds: buttons, cancelIdPresent: Number.isSafeInteger(options?.cancelId), defaultIdPresent: Number.isSafeInteger(options?.defaultId) };
  }
  function redact(value) {
    if (typeof value !== 'string') return '';
    return value.slice(0, 4096)
      .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer <redacted>')
      .replace(/(OPENAI_API_KEY|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=<redacted>')
      .replaceAll('codlet-local-fixture', '<redacted>');
  }
  electron.dialog.showMessageBox = async (...args) => {
    report.dialogs++; const options = args.at(-1); report.dialog = summarizeDialog(options); save();
    try {
      fs.mkdirSync(path.dirname(config.dialogDiagnosticPath), { recursive: true });
      fs.writeFileSync(config.dialogDiagnosticPath, JSON.stringify({
        title: redact(options?.title), message: redact(options?.message), detail: redact(options?.detail),
        type: report.dialog.type, classification: report.dialog.classification, buttonCount: report.dialog.buttonCount,
        buttonKinds: report.dialog.buttonKinds, cancelId: Number.isSafeInteger(options?.cancelId) ? options.cancelId : null,
        defaultId: Number.isSafeInteger(options?.defaultId) ? options.defaultId : null,
        callerStack: redact(new Error('synthetic dialog capture').stack),
      }, null, 2) + '\n');
    } catch { report.dialogDiagnosticWriteFailed = true; save(); }
    if (report.dialog.type === 'error' && report.dialog.classification === 'error' && report.dialog.buttonCount === 1 && Number.isSafeInteger(options?.cancelId)) {
      report.dialogAction = 'cancel_error'; save(); return { response: options.cancelId, checkboxChecked: false };
    }
    if (report.dialog.type === 'info' && report.dialog.classification === 'information' && report.dialog.buttonCount === 1) {
      const selected = Number.isSafeInteger(options?.cancelId) ? options.cancelId : Number.isSafeInteger(options?.defaultId) ? options.defaultId : null;
      if (selected !== null) { report.dialogAction = 'acknowledge_information'; save(); return { response: selected, checkboxChecked: false }; }
    }
    return new Promise(() => {});
  };
  const compile = Module.prototype._compile, load = Module._load;
  Module.prototype._compile = function(source, filename) {
    if (filename.endsWith(config.mainBundle)) { report.observer.mainBundleSeen++; source += '\n;globalThis[Symbol.for("codlet.test.production-source")].FetchWrapper=' + config.fetchWrapperSymbol + ';'; }
    return compile.call(this, source, filename);
  };
  Module._load = function(request, parent, main) {
    const result = load.apply(this, arguments);
    if (request.endsWith(config.appServerModule)) { report.observer.appServerModuleSeen++; for (const value of [result, ...Object.values(result ?? {})]) {
      const proto = typeof value === 'function' ? value.prototype : null;
      if (!proto?.ensureReady || !proto?.sendInternalRequest || proto.__codletAcceptance) continue;
      report.observer.appServerManagerCandidates++;
      const original = proto.ensureReady;
      proto.ensureReady = function(...args) { state.managers.add(this); report.observer.appServerManagerInstances = state.managers.size; return original.apply(this, args); };
      Object.defineProperty(proto, '__codletAcceptance', { value: true });
    } }
    return result;
  };
  function save() {
    const temporary = config.receipt + '.tmp-' + crypto.randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(report));
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, config.receipt); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 49) {
          try { fs.unlinkSync(temporary); } catch {}
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  function adapterSnapshot() {
    const key = Object.getOwnPropertySymbols(globalThis).find(value => String(value).startsWith('Symbol(codlet.private.main-traffic.'));
    if (!key || typeof globalThis[key]?.inspect !== 'function') return null;
    const state = globalThis[key].inspect();
    const code = value => typeof value === 'string' && /^[a-z_]{1,80}$/u.test(value) ? value : undefined;
    const counters = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return {
      installed: state?.installed === true,
      source: { connected: state?.source?.connected === true, ...(code(state?.source?.reason) ? { reason: code(state.source.reason) } : {}) },
      desktop: { available: state?.desktop?.available === true, taskConfigurationAvailable: state?.desktop?.taskConfigurationAvailable === true,
        modules: Object.fromEntries(['bootstrap', 'main', 'src', 'stdio', 'connection'].map(name => [name, state?.desktop?.modules?.[name] === true])),
        ...(code(state?.desktop?.reason) ? { reason: code(state.desktop.reason) } : {}) },
      backend: { available: state?.backend?.available === true, prepared: counters(state?.backend?.backendRootsPrepared), declined: counters(state?.backend?.backendRootsDeclined),
        ...(code(state?.backend?.reason) ? { reason: code(state.backend.reason) } : {}) },
    };
  }
  async function wait(predicate, label, milliseconds = 12000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) { if (Date.now() >= deadline) throw Error('timeout_' + label); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  const text = 'codlet-original-response';
  const rawDiagnosticSameFinal = 'codlet-electron-same-final';
  function isPrivateRoute(value) {
    try {
      const candidate = new URL(value), expected = new URL(config.trafficRouteBaseUrl);
      return candidate.protocol === 'http:' && candidate.origin === expected.origin && candidate.pathname.startsWith(expected.pathname)
        && !candidate.username && !candidate.password && !candidate.search && !candidate.hash;
    } catch { return false; }
  }
  function safeRpcCode(value) {
    const code = value?.code ?? value?.error?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(code) ? code.toLowerCase() : undefined;
  }
  async function run() {
    let stage = 'app_ready';
    const entering = value => { stage = value; report.stage = value; save(); };
    entering(stage);
    try {
      await electron.app.whenReady();
      entering('app_server');
      await wait(() => state.FetchWrapper && [...state.managers].some(value => value.initialized && value.isLocal), 'app_server');
      entering('production_attached');
      await wait(() => fs.existsSync(config.go), 'production_attached', 20000);
      const manager = [...state.managers].find(value => value.initialized && value.isLocal);
      entering('application_network');
      report.adapterState = adapterSnapshot(); save();
      const network = require(process.resourcesPath + '/app.asar/.vite/build/' + config.bootstrapBundle)[config.applicationNetworkFactory]().applicationNetwork;
      await network.whenReady();
      const cookieName = 'codlet-owned-fixture-cookie', cookieValue = 'codlet-synthetic-cookie-only';
      await electron.session.defaultSession.cookies.set({ url: config.upstream + '/desktop', name: cookieName,
        value: cookieValue, path: '/desktop', secure: false, httpOnly: true, sameSite: 'lax' });
      const rawProbe = async (url, redirectMode, expectedUrl, expectedBody) => {
        const signal = AbortSignal.timeout(5000), started = Date.now();
        try {
          // This call is outside the official desktop-fetch AsyncLocalStorage scope.
          const response = await network.fetch(url, { method: 'GET', signal, ...(redirectMode ? { redirect: redirectMode } : {}) });
          const body = response.body == null ? '' : await response.text();
          return { status: Number.isSafeInteger(response.status) && response.status >= 0 && response.status <= 599 ? response.status : 0,
            type: ['default', 'basic', 'cors', 'opaque', 'opaqueredirect'].includes(response.type) ? response.type : 'other',
            redirected: response.redirected === true, urlMatchesExpected: typeof response.url === 'string' && response.url === expectedUrl,
            hasBody: response.body != null, hasLocation: !!response.headers?.get?.('location'),
            bodyBytes: Math.min(65536, Buffer.byteLength(body)), bodyMatchesExpected: body === expectedBody,
            durationMs: Math.min(60000, Math.max(0, Date.now() - started)), signalAborted: signal.aborted };
        } catch (error) {
          const message = typeof error?.message === 'string' ? error.message : '';
          return { status: 0, type: 'error', redirected: false, urlMatchesExpected: false, hasBody: false, hasLocation: false,
            bodyBytes: 0, bodyMatchesExpected: false, durationMs: Math.min(60000, Math.max(0, Date.now() - started)),
            signalAborted: signal.aborted, failure: /redirect.{0,32}cancel/iu.test(message) ? 'redirect_cancelled' : signal.aborted ? 'timeout' : 'other' };
        }
      };
      const rawRequestProbe = (url, expectedUrl, expectedBody) => new Promise(resolve => {
        const started = Date.now(); let request, timer, settled = false;
        const redirect = { eventSeen: false, redirectStatus: 0, targetOriginMatchesExpected: false, targetPathMatchesExpected: false };
        const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
        const failureKind = error => /redirect.{0,32}cancel/iu.test(typeof error?.message === 'string' ? error.message : '')
          ? 'redirect_cancelled' : 'other';
        try {
          request = network.request({ url, method: 'GET' });
          timer = setTimeout(() => { try { request.abort(); } catch {} finish({ status: 0, ...redirect, bodyBytes: 0, bodyMatchesExpected: false,
            durationMs: Math.min(60000, Date.now() - started), timedOut: true, failure: 'timeout' }); }, 5000);
          request.once('redirect', (status, _method, destination) => {
            redirect.eventSeen = true;
            redirect.redirectStatus = Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : 0;
            try { const actual = new URL(destination), expected = new URL(expectedUrl);
              redirect.targetOriginMatchesExpected = actual.origin === expected.origin;
              redirect.targetPathMatchesExpected = actual.pathname === expected.pathname;
            } catch {}
            try { request.followRedirect(); }
            catch (error) { finish({ status: 0, ...redirect, bodyBytes: 0, bodyMatchesExpected: false,
              durationMs: Math.min(60000, Date.now() - started), timedOut: false, failure: failureKind(error) }); }
          });
          request.once('response', response => {
            const chunks = []; let size = 0, tooLarge = false;
            response.on('data', chunk => { size += chunk.length; if (size <= 65536) chunks.push(Buffer.from(chunk)); else tooLarge = true; });
            response.once('error', error => finish({ status: Number.isSafeInteger(response.statusCode) ? response.statusCode : 0, ...redirect,
              bodyBytes: Math.min(65536, size), bodyMatchesExpected: false, durationMs: Math.min(60000, Date.now() - started),
              timedOut: false, failure: failureKind(error) }));
            response.once('end', () => finish({ status: Number.isSafeInteger(response.statusCode) ? response.statusCode : 0, ...redirect,
              bodyBytes: Math.min(65536, size), bodyMatchesExpected: !tooLarge && Buffer.concat(chunks).toString('utf8') === expectedBody,
              durationMs: Math.min(60000, Date.now() - started), timedOut: false, ...(tooLarge ? { failure: 'other' } : {}) }));
          });
          request.once('error', error => finish({ status: 0, ...redirect, bodyBytes: 0, bodyMatchesExpected: false,
            durationMs: Math.min(60000, Date.now() - started), timedOut: false, failure: failureKind(error) }));
          request.end();
        } catch (error) { finish({ status: 0, ...redirect, bodyBytes: 0, bodyMatchesExpected: false,
          durationMs: Math.min(60000, Date.now() - started), timedOut: false, failure: failureKind(error) }); }
      });
      const rawInitial = config.upstream + '/desktop/diagnostic-302';
      const rawSameFinal = config.upstream + '/desktop/diagnostic-final';
      const rawCrossInitial = config.upstream + '/desktop/diagnostic-cross-302';
      const rawCrossFinal = config.crossOrigin + '/desktop/diagnostic-cross-final';
      report.rawDiagnosticFetch = {
        manualSameOrigin: await rawProbe(rawInitial, 'manual', rawInitial, 'codlet-electron-raw-redirect'),
        followSameOrigin: await rawProbe(rawInitial, undefined, rawSameFinal, 'codlet-electron-same-final'),
        followCrossOrigin: await rawProbe(rawCrossInitial, undefined, rawCrossFinal, config.crossOriginResponse),
      };
      report.rawDiagnosticFetch.requestSameOrigin = await rawRequestProbe(rawInitial, rawSameFinal, rawDiagnosticSameFinal);
      report.rawDiagnosticFetch.requestCrossOrigin = await rawRequestProbe(rawCrossInitial, rawCrossFinal, config.crossOriginResponse);
      const rawCookieDirect = await network.fetch(config.upstream + '/desktop/cookie-direct', { method: 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      const rawCookieDirectBody = await rawCookieDirect.text();
      const rawCookieCross = await network.fetch(config.upstream + '/desktop/cookie-cross-redirect', { method: 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      const rawCookieCrossBody = await rawCookieCross.text();
      const storedCookies = await electron.session.defaultSession.cookies.get({ url: config.upstream + '/desktop/cookie-direct' });
      report.cookieDiagnostics = {
        cookieInstalled: storedCookies.some(cookie => cookie.name === cookieName && cookie.value === cookieValue),
        rawSameOriginSent: rawCookieDirectBody === '1', bridgeSameOriginSent: false,
        rawCrossOriginInitialSent: rawCookieCrossBody[0] === '1', rawCrossOriginFinalSent: rawCookieCrossBody[1] === '1',
        bridgeCrossOriginInitialSent: false, bridgeCrossOriginFinalSent: false,
      };
      report.rawDiagnosticFetch.cookies = {
        cookieInstalled: report.cookieDiagnostics.cookieInstalled,
        rawSameOriginSent: report.cookieDiagnostics.rawSameOriginSent,
        rawCrossOriginInitialSent: report.cookieDiagnostics.rawCrossOriginInitialSent,
        rawCrossOriginFinalSent: report.cookieDiagnostics.rawCrossOriginFinalSent,
      };
      fs.mkdirSync(path.dirname(config.rawDiagnosticPath), { recursive: true });
      fs.writeFileSync(config.rawDiagnosticPath, JSON.stringify({ schema: 1, kind: 'electron-network-diagnostics', protocol: config.protocol, probes: report.rawDiagnosticFetch }, null, 2) + '\n');
      save();
      const wrapper = new state.FetchWrapper(null, { applicationNetwork: network, appServerConnectionRegistry: { getConnection: () => manager }, desktopOriginator: 'Codex Desktop', prodApiBaseUrl: 'https://chatgpt.com/backend-api', devApiBaseUrl: 'http://localhost:8000/api' });
      entering('desktop_requests');
      for (const progress of [false, true]) {
        const { response } = await wrapper.performDesktopFetch({ body: 'codlet-original-request', headers: { 'content-type': 'text/plain' }, method: 'POST', resolvedUrl: config.upstream + '/desktop/' + (progress ? 'progress' : 'fetch'), signal: AbortSignal.timeout(5000), ...(progress ? { onUploadProgress() {} } : {}) });
        report.desktop[progress ? 'progress' : 'fetch'] = { status: response.status, changed: await response.text() === text.replace('original', 'modified') }; save();
      }
      const bridgeCookieDirect = await wrapper.performDesktopFetch({ headers: {}, method: 'GET', credentials: 'same-origin',
        resolvedUrl: config.upstream + '/desktop/cookie-direct', signal: AbortSignal.timeout(5000) });
      report.cookieDiagnostics.bridgeSameOriginSent = await bridgeCookieDirect.response.text() === '1';
      const bridgeCookieCross = await wrapper.performDesktopFetch({ headers: {}, method: 'GET', credentials: 'same-origin',
        resolvedUrl: config.upstream + '/desktop/cookie-cross-redirect', signal: AbortSignal.timeout(5000) });
      const bridgeCookieCrossBody = await bridgeCookieCross.response.text();
      report.cookieDiagnostics.bridgeCrossOriginInitialSent = bridgeCookieCrossBody[0] === '1';
      report.cookieDiagnostics.bridgeCrossOriginFinalSent = bridgeCookieCrossBody[1] === '1';
      report.rawDiagnosticFetch.cookies.bridgeSameOriginSent = report.cookieDiagnostics.bridgeSameOriginSent;
      report.rawDiagnosticFetch.cookies.bridgeCrossOriginInitialSent = report.cookieDiagnostics.bridgeCrossOriginInitialSent;
      report.rawDiagnosticFetch.cookies.bridgeCrossOriginFinalSent = report.cookieDiagnostics.bridgeCrossOriginFinalSent;
      fs.writeFileSync(config.rawDiagnosticPath, JSON.stringify({ schema: 1, kind: 'electron-network-diagnostics', protocol: config.protocol, probes: report.rawDiagnosticFetch }, null, 2) + '\n');
      save();
      entering('same_origin_redirect');
      const redirected = await wrapper.performDesktopFetch({ headers: {}, method: 'GET', resolvedUrl: config.upstream + '/desktop/redirect', signal: AbortSignal.timeout(15000), onUploadProgress() {} });
      report.desktop.redirect = { status: redirected.response.status, changed: await redirected.response.text() === text.replace('original', 'modified') }; save();
      const emptyRedirect = await wrapper.performDesktopFetch({ headers: {}, method: 'GET', resolvedUrl: config.upstream + '/desktop/redirect-empty', signal: AbortSignal.timeout(5000), onUploadProgress() {} });
      report.desktop.emptyRedirect = { status: emptyRedirect.response.status, changed: await emptyRedirect.response.text() === text.replace('original', 'modified') }; save();
      const crossOriginRedirect = await wrapper.performDesktopFetch({ headers: {}, method: 'GET', resolvedUrl: config.upstream + '/desktop/cross-origin-redirect', signal: AbortSignal.timeout(5000), onUploadProgress() {} });
      report.desktop.crossOriginRedirect = { status: crossOriginRedirect.response.status, unchanged: await crossOriginRedirect.response.text() === config.crossOriginResponse }; save();
      entering('backend_turns');
      const notifications = [];
      report.backend.turnCompletions = [];
      const off = manager.registerInternalNotificationHandler(value => {
        if (value.method === 'turn/completed' && report.backend.turnCompletions.length < 4) {
          const turn = value.params?.turn ?? {}, status = ['completed', 'failed', 'interrupted', 'cancelled', 'in_progress'].includes(turn.status) ? turn.status : 'other';
          const errorCode = safeRpcCode(turn.error);
          report.backend.turnCompletions.push({ status, ...(errorCode ? { errorCode } : {}) });
        }
        if (notifications.length < 1000) notifications.push(value);
      });
      try {
        const rpc = async (method, params) => {
          const reply = await manager.sendInternalRequest({ id: 'codlet-test:' + crypto.randomUUID(), method, params }, { timeoutMs: 12000 });
          if (reply.error) {
            const error = Error('app_server_request_failed'), code = safeRpcCode(reply.error);
            if (code) { report.backend.requestErrorCode = code; error.code = code; }
            throw error;
          }
          return reply.result;
        };
        const configResult = await rpc('config/read', { cwd: config.paths.home, includeLayers: false });
        const effectiveConfig = configResult?.config ?? {};
        report.backend.config = { openAiBaseUrlPrivateRoute: isPrivateRoute(effectiveConfig.openai_base_url), modelProviderOpenAi: (effectiveConfig.model_provider ?? 'openai') === 'openai' };
        const accountResult = await rpc('account/read', { refreshToken: false });
        const accountType = accountResult?.account?.type;
        report.backend.accountType = accountType === 'chatgpt' || accountType === 'apiKey' ? accountType : accountType == null ? 'none' : 'other';
        const backendProcess = manager.connection?.proc;
        const spawnArgs = Array.isArray(backendProcess?.spawnargs) ? backendProcess.spawnargs : null;
        let lastOpenAiOverride;
        for (let index = 0; spawnArgs && index < spawnArgs.length; index++) {
          if (spawnArgs[index] === '-c' && typeof spawnArgs[index + 1] === 'string' && spawnArgs[index + 1].startsWith('openai_base_url=')) {
            lastOpenAiOverride = spawnArgs[index + 1].slice('openai_base_url='.length).replace(/^"|"$/gu, '');
          }
        }
        report.backend.childRouteOverride = { processObserved: !!backendProcess, lastOpenAiOverridePresent: typeof lastOpenAiOverride === 'string',
          lastOpenAiOverridePrivateRoute: isPrivateRoute(lastOpenAiOverride) };
        save();
        const started = await rpc('thread/start', { cwd: config.paths.home, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'Local synthetic production transport acceptance.' });
        report.adapterState = adapterSnapshot(); save();
        report.backend.turns = 0;
        for (let index = 0; index < 2; index++) {
          const turn = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'local synthetic fixture', text_elements: [] }] });
          await wait(() => notifications.some(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id), 'model_turn');
          const completed = notifications.find(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id);
          if (completed.params.turn.status !== 'completed') throw Error('model_turn_failed');
          report.backend.turns++;
        }
        report.backend.modified = notifications.some(value => value.method === 'item/agentMessage/delta' && value.params.delta === 'codlet-modified-response');
      } finally { off(); }
      report.finished = true;
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code.toLowerCase()
        : typeof error?.message === 'string' && /^[a-z_0-9]{1,100}$/u.test(error.message) ? error.message
        : /invalid url|parse url/iu.test(error?.message ?? '') ? 'invalid_url'
        : /network|fetch|connect/iu.test(error?.message ?? '') ? 'network_failed'
        : /timeout/iu.test(error?.message ?? '') ? 'operation_timeout'
        : /not allowed|blocked|permission|denied/iu.test(error?.message ?? '') ? 'request_denied' : 'acceptance_failed';
      report.failure = code; report.failureStage = stage; report.adapterState = adapterSnapshot(); report.finished = true;
      try {
        fs.mkdirSync(path.dirname(config.runErrorDiagnosticPath), { recursive: true });
        fs.writeFileSync(config.runErrorDiagnosticPath, JSON.stringify({
          stage,
          name: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError'].includes(error?.name) ? error.name : 'Error',
          code: typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(error.code) ? error.code : null,
          message: redact(error?.message), stack: redact(error?.stack),
          observer: { fetchWrapperSeen: !!state.FetchWrapper, appServerModuleLoads: report.observer.appServerModuleSeen,
            managerCandidates: report.observer.appServerManagerCandidates, managerInstances: state.managers.size,
            initializedManagers: [...state.managers].filter(value => value.initialized).length,
            localManagers: [...state.managers].filter(value => value.isLocal).length },
          adapter: report.adapterState,
        }, null, 2) + '\n');
      } catch { report.runErrorDiagnosticWriteFailed = true; }
    }
    finally { save(); }
  }
  setImmediate(run);
  return true;
}
module.exports = { installOwnedAcceptance };
