'use strict';
// Research only. Evaluated in a new, identity-checked official main process.
// Does not load from or write to the installed application archive.
function installPlaintextProbe(electron, config) {
  const Module = require('node:module');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  // The fork's native Known Folder lookup fails for an artificial USERPROFILE.
  // Supply only these owned paths to its JS bootstrap. Native Chromium profile
  // isolation is separately established by the explicit --user-data-dir.
  const getPath = electron.app.getPath;
  electron.app.getPath = function(name) { return config.paths[name] ?? getPath.call(this, name); };
  const setPath = electron.app.setPath;
  electron.app.setPath = function(name, value) {
    if (name in config.paths && value === config.paths[name]) return;
    return setPath.call(this, name, value);
  };
  const key = Symbol.for('codlet.research.plaintext');
  const state = { managers: new Set(), FetchWrapper: null, report: { runtime: { node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome }, stages: [], modelRequestsThroughElectron: 0, compiled: [], loaded: [] } };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const compile = Module.prototype._compile, load = Module._load;
  const restore = [];
  const showMessageBox = electron.dialog.showMessageBox;
  electron.dialog.showMessageBox = function(...args) { const value = args.at(-1); state.report.dialog = { message: value?.message, detail: value?.detail?.slice(0, 700) }; save(); return new Promise(() => {}); };
  restore.push(() => { electron.dialog.showMessageBox = showMessageBox; });
  Module.prototype._compile = function(source, filename) {
    if (filename.includes('.vite') && state.report.compiled.length < 30) state.report.compiled.push(require('node:path').basename(filename));
    const expected = { 'src-C3YaUE83.js': '14c8c23e8b8dfa874d3fb5a50d54fb28eccf55fb83232c3ab29cb7c0ef0a0472', 'bootstrap-DK4EfNwt.js': 'dbdbdd3ef5dde93dd196a59846edf244dc653341213e0fd45eebb133b5df10ba' }[require('node:path').basename(filename)];
    if (expected && crypto.createHash('sha256').update(source).digest('hex') !== expected) throw Error('desktop_source_changed');
    if (filename.endsWith('main-LM8MUIFp.js')) {
      if (crypto.createHash('sha256').update(source).digest('hex') !== config.mainHash) throw Error('main_source_changed');
      source += '\n;globalThis[Symbol.for("codlet.research.plaintext")].FetchWrapper=wEe;';
      state.report.mainSourceVerified = true;
    }
    return compile.call(this, source, filename);
  };
  Module._load = function(request, parent, isMain) {
    const result = load.apply(this, arguments);
    if (request.includes('main-') && state.report.loaded.length < 20) state.report.loaded.push(request);
    if (request.endsWith('src-C3YaUE83.js')) {
      for (const [name, value] of Object.entries(result)) {
        const proto = typeof value === 'function' ? value.prototype : null;
        if (!proto?.ensureReady || !proto.sendInternalRequest || !proto.registerInternalNotificationHandler || proto.__codletResearch) continue;
        const original = proto.ensureReady;
        proto.ensureReady = function(...args) { state.managers.add(this); return original.apply(this, args); };
        Object.defineProperty(proto, '__codletResearch', { value: true, configurable: true });
        restore.push(() => { proto.ensureReady = original; delete proto.__codletResearch; });
        state.report.managerExport = name;
      }
    }
    return result;
  };
  // Keep this accountless acceptance instance invisible.
  for (const name of ['show', 'showInactive', 'focus']) {
    const original = electron.BrowserWindow.prototype[name];
    electron.BrowserWindow.prototype[name] = function() {};
    restore.push(() => { electron.BrowserWindow.prototype[name] = original; });
  }
  const originalFetch = electron.net.fetch;
  electron.net.fetch = async function(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/responses')) state.report.modelRequestsThroughElectron++;
    if (url.origin !== config.endpoint || !url.pathname.startsWith('/desktop/')) return originalFetch.call(this, input, init);
    state.report.desktopRequestPlaintext = init.body === 'desktop-original';
    const response = await originalFetch.call(this, input, { ...init, body: 'desktop-modified' });
    state.report.desktopResponsePlaintext = true;
    return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      controller.enqueue(Buffer.from(Buffer.from(chunk).toString('utf8').replace('server-original', 'server-modified')));
    } })), { status: response.status, headers: response.headers });
  };
  restore.push(() => { electron.net.fetch = originalFetch; });
  const originalRequest = electron.net.request;
  electron.net.request = function(options) {
    const request = originalRequest.apply(this, arguments);
    if (new URL(typeof options === 'string' ? options : options.url).origin !== config.endpoint) return request;
    const end = request.end, emit = request.emit;
    request.end = function(body, ...args) { state.report.progressRequestPlaintext = body?.toString() === 'desktop-original'; return end.call(this, Buffer.from('desktop-modified'), ...args); };
    request.emit = function(name, ...args) {
      if (name === 'response') {
        const response = args[0], responseEmit = response.emit;
        response.emit = function(event, ...values) {
          if (event === 'data') { state.report.progressResponsePlaintext = true; values[0] = Buffer.from(values[0].toString().replace('server-original', 'server-modified')); }
          return responseEmit.call(this, event, ...values);
        };
      }
      return emit.call(this, name, ...args);
    };
    return request;
  };
  restore.push(() => { electron.net.request = originalRequest; });
  function save() { fs.writeFileSync(config.reportPath + '.tmp', JSON.stringify(state.report)); fs.renameSync(config.reportPath + '.tmp', config.reportPath); }
  async function until(predicate, label) {
    const deadline = Date.now() + 20000;
    while (!predicate()) { if (Date.now() > deadline) throw Error('timeout_' + label); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  async function run() {
    try {
      await electron.app.whenReady();
      await until(() => state.FetchWrapper && [...state.managers].some(value => value.initialized), 'manager');
      const manager = [...state.managers].find(value => value.initialized && value.isLocal);
      if (!manager) throw Error('local_manager_missing');
      state.report.stages.push('actual_desktop_manager'); save();
      const bootstrap = require(process.resourcesPath + '/app.asar/.vite/build/bootstrap-DK4EfNwt.js').b();
      await bootstrap.applicationNetwork.whenReady();
      const wrapper = new state.FetchWrapper(null, { applicationNetwork: bootstrap.applicationNetwork, appServerConnectionRegistry: { getConnection: () => manager }, desktopOriginator: 'Codex Desktop', prodApiBaseUrl: 'https://chatgpt.com/backend-api', devApiBaseUrl: 'http://localhost:8000/api' });
      for (const progress of [false, true]) {
        const { response } = await wrapper.performDesktopFetch({ body: 'desktop-original', headers: { 'content-type': 'text/plain' }, method: 'POST', resolvedUrl: config.endpoint + '/desktop/' + (progress ? 'progress' : 'fetch'), signal: AbortSignal.timeout(5000), ...(progress ? { onUploadProgress() {} } : {}) });
        state.report[progress ? 'progressRoundTrip' : 'desktopRoundTrip'] = await response.text() === 'server-modified'; save();
      }
      const notices = [];
      const unsubscribe = manager.registerInternalNotificationHandler(value => { if (notices.length < 500) notices.push(value); });
      try {
        const rpc = async (method, params) => {
          const response = await manager.sendInternalRequest({ id: 'codlet-fixture:' + crypto.randomUUID(), method, params }, { timeoutMs: 12000 });
          if (response.error) throw Error(response.error.message);
          return response.result;
        };
        const started = await rpc('thread/start', { cwd: config.home, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'Local synthetic request chain fixture.' });
        const turn = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'local fixture request', text_elements: [] }] });
        await until(() => notices.some(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id), 'model_turn');
        const completion = notices.find(value => value.method === 'turn/completed' && value.params.turn.id === turn.turn.id);
        state.report.modelTurnStatus = completion.params.turn.status;
        state.report.modelResponseModified = notices.some(value => value.method === 'item/agentMessage/delta' && value.params.delta === 'model-modified');
      } finally { unsubscribe(); }
      state.report.finished = true;
    } catch (error) { state.report.failure = String(error.message).slice(0, 250); state.report.managers = [...state.managers].map(value => ({ initialized: value.initialized, isLocal: value.isLocal, kind: value.options?.hostConfig?.kind, state: value.connectionState })); state.report.finished = true; }
    finally { save(); Module.prototype._compile = compile; Module._load = load; for (const action of restore.reverse()) action(); }
  }
  setImmediate(run);
  return { installed: true };
}
module.exports = { installPlaintextProbe };
