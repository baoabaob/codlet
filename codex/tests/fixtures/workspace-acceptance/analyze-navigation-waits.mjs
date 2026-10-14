// Offline scheduler experiment with the production navigation state machine.
// Synthetic verified bindings in jsdom; no Native component/backend/profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWorkspaceNavigation } from '../../../frontend/src/adapter/workspace-navigation.js';
import { createWorkspaceMetrics } from '../../../frontend/src/adapter/workspace-metrics.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../frontend/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function schedulerCase(readyAfterMs, notifyAfterMs) {
  const dom = new JSDOM('<body><div id="root"><div data-codex-composer-root><div contenteditable="true" tabindex="0"></div></div></div></body>', { pretendToBeVisual: true });
  const { document } = dom.window, input = document.querySelector('[data-codex-composer-root]'), editable = input.firstElementChild;
  const navigator = { location: { pathname: '/local/synthetic-a', search: '', hash: '' } };
  let binding = { input, editable, controller: { view: { composing: false } }, threadId: 'synthetic-a', hostId: 'local', submitDisabled: false };
  let started, readyTimer, notifyTimer, reads = 0, checks = 0, backendRequests = 0;
  const marks = {}, mark = key => { marks[key] = performance.now() - started; };
  const recorded = createWorkspaceMetrics({ enabled: true, runId: 'offline-navigation-phases' });
  const metrics = { ...recorded, end(name, started, detail) { recorded.end(name, started, detail); if (name === 'navigation.executed' || name === 'navigation.committed') mark(name); } };
  const native = { inputApi: 1, manager: { getConversation: id => ({ id, resumeState: 'resumed' }), getStreamRole: () => ({ role: 'owner' }), sendRequest() { backendRequests++; throw Error('Warm scheduler case must not read backend'); } },
    check() { checks++; }, openLocalThread(threadId) {
      navigator.location = { pathname: '/local/' + threadId, search: '', hash: '' }; mark('dispatchAccepted');
      const ready = () => { binding = { ...binding, threadId }; mark('syntheticBindingReady'); };
      if (readyAfterMs === 0) ready(); else readyTimer = setTimeout(ready, readyAfterMs);
      if (notifyAfterMs > 0) notifyTimer = setTimeout(() => { mark('syntheticDomNotification'); input.setAttribute('data-app-shell-active-page', 'true'); }, notifyAfterMs);
    } };
  const provider = createWorkspaceNavigation({ document, load: async () => native, host: () => ({ navigator }), check() {},
    readCurrentInput: () => binding, readBinding: value => { reads++; return value ?? binding; }, metrics,
    changed(value) { if (value?.input) mark('confirmedSurfaceCallback'); } });
  const session = provider.create(() => {}); await session.ready;
  try {
    started = performance.now();
    const operation = session.open({ threadId: 'synthetic-b' }); mark('openReturned');
    await operation.executed; mark('executedObserved');
    const receipt = await operation.committed; mark('committedObserved');
    assert.equal(receipt.threadId, 'synthetic-b'); assert.equal(receipt.inputConfirmed, true);
    assert.equal(session.focus({ revision: receipt.revision }), true); mark('focusCompleted');
    assert.equal(backendRequests, 0);
    const result = { readyAfterMs, notifyAfterMs, marks, bindingProjectionReads: reads, nativeChecks: checks, backendRequests,
      bindingReadyToCommitMs: marks.committedObserved - marks.syntheticBindingReady,
      focusAfterCommitMs: marks.focusCompleted - marks.committedObserved, testPoints: recorded.report() };
    session.dispose(); provider.dispose();
    assert.throws(() => session.focus({ revision: receipt.revision }), { code: 'workspace_retired' });
    return result;
  } finally { clearTimeout(readyTimer); clearTimeout(notifyTimer); provider.dispose(); dom.window.close(); }
}

const directory = path.join(repo, '.artifacts/workspace-navigation-waits', 'analysis-' + randomUUID());
fs.mkdirSync(directory, { recursive: true });
const sources = ['frontend/src/adapter/workspace-navigation.js', 'frontend/src/desktop/thread-navigation.js', 'frontend/src/adapter/workspace-dom.js', 'frontend/src/adapter/workspace-native-input.js', 'frontend/src/adapter/workspace.js', 'frontend/src/host-discovery.js'];
const report = { schema: 1, createdAt: new Date().toISOString(), scope: 'Node/jsdom scheduler with injected synthetic verified bindings', nativeClientTested: false,
  nativeBindingDiscoveryMeasured: false, nativePaintMeasured: false, nativeBackendRequests: 0, sentTurns: 0,
  sourceSha256: Object.fromEntries(sources.map(file => [file, hash(path.join(repo, file))])), cases: [] };
for (const [ready, notify] of [[0, 0], [130, 130], [130, 170]]) report.cases.push(await schedulerCase(ready, notify));
const output = path.join(directory, 'report.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, nativeClientTested: false, cases: report.cases.map(({ readyAfterMs, notifyAfterMs, marks, bindingReadyToCommitMs }) => ({ readyAfterMs, notifyAfterMs, committedMs: marks.committedObserved, bindingReadyToCommitMs })) }));
