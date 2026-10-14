import { discoverNative } from '../../../frontend/src/adapter/discovery.js';
import { createWorkspaceDiscovery } from '../../../frontend/src/adapter/workspace-discovery.js';
import { locateHost } from '../../../frontend/src/adapter/navigation.js';
import { createWorkspaceNavigation } from '../../../frontend/src/adapter/workspace-navigation.js';
import { nativeMainInput, nativeInputBinding } from '../../../frontend/src/adapter/workspace-dom.js';

export async function run(spec) {
  const control = globalThis[Symbol.for(spec.controlKey)], signal = control.abort.signal;
  const report = { status: 'failed', sentTurns: 0, additionalEditors: 0, nativePaintMeasured: false, operations: [], errors: [] };
  let discovery, provider, navigation, router, original, active;
  const wait = ms => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(Error('Owned timeline cancelled')); return; }
    const timer = setTimeout(finish, ms), abort = () => finish(Error('Owned timeline cancelled'));
    function finish(error) { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
  const relative = () => active ? performance.now() - active.started : null;
  function measured(name, work) {
    const start = performance.now();
    try { return work(); }
    finally { if (active) { const record = active.calls[name] ??= { count: 0, totalMs: 0, maxMs: 0 };
      const elapsed = performance.now() - start; record.count++; record.totalMs += elapsed; record.maxMs = Math.max(record.maxMs, elapsed); } }
  }
  try {
    const base = await discoverNative(); discovery = createWorkspaceDiscovery(() => base);
    const N = await discovery.navigation(), host = locateHost(); router = host.navigator; original = { ...router.location };
    function readInput() {
      const value = measured('inputInspection', () => nativeMainInput(document, N));
      if (active && value?.scope.value.conversationId === active.threadId) { active.actualModelControllerObservedMs ??= relative();
        active.controllerReused = value.controller === active.previousController; active.inputRootReused = value.input === active.previousInput; }
      return value;
    }
    function readBinding(checked) {
      const value = checked===undefined?readInput():checked, binding = measured('canonicalBindingValidation', () => nativeInputBinding(value, N));
      if (active && binding?.threadId === active.threadId) active.canonicalBindingObservedMs ??= relative();
      return binding;
    }
    const pin = { ...host, navigator: { get location() { return router.location; }, push(to) {
      if (active) active.routeDispatchStartMs = relative();
      const start = performance.now(), result = router.push(to);
      if (active) { active.routeDispatchReturnMs = relative(); active.routeDispatchSynchronousMs = performance.now() - start;
        const owner = active; Promise.resolve(result).then(() => owner.routerPromiseResolvedMs = performance.now() - owner.started,
          error => owner.routerPromiseError = error.message);
        queueMicrotask(() => { if (owner.started != null) owner.afterDispatchMicrotaskMs = performance.now() - owner.started; });
        owner.zeroTimer = setTimeout(() => { if (owner.started != null) owner.zeroDelayTimerMs = performance.now() - owner.started; }, 0);
      }
      return result;
    } } };
    const native = { ...N, check: () => measured('nativeConnectionCheck', () => N.check()) };
    provider = createWorkspaceNavigation({ document, load: async () => native, host: () => pin,
      check: () => measured('ownerConnectionCheck', () => discovery.connection()), changed() {}, readCurrentInput: readInput, readBinding });
    navigation = provider.create(() => {}); await navigation.ready;
    for (const fixture of spec.threads.slice(0, 2)) { await navigation.open({ threadId: fixture.id }, { signal }).committed; await wait(250); }

    async function sample(mode, fixture, round) {
      await navigation.open({ threadId: spec.threads[1 - fixture.index].id }, { signal }).committed; await wait(250);
      const root = document.getElementById('root'), previousInput = readInput(), before = previousInput?.input;
      const domInput = () => {
        const inputs = [...root.querySelectorAll('[data-codex-composer-root]')].filter(input => !input.closest('[data-codlet-workspace-owned],[data-app-shell-active-page="false"]'));
        const main = inputs.filter(input => input.closest('main[data-app-shell-main-surface]'));
        return (main.length === 1 ? main[0] : inputs.length === 1 ? inputs[0] : null);
      };
      const entry = { round, mode, fixture: fixture.index, threadId: fixture.id, started: performance.now(), calls: {},
        actualModelControllerObservedMs: null, canonicalBindingObservedMs: null, firstDifferentInputDomMs: null,
        firstEditableInDifferentInputMs: null, firstDomMutationMs: null, domCallbacks: 0,
        previousInput: previousInput?.input, previousController: previousInput?.controller };
      active = entry; control.phase = mode + '-' + round;
      let observer, deadline, settled = false, resolve, reject;
      const ready = new Promise((yes, no) => { resolve = yes; reject = no; }); ready.catch(() => {});
      const finish = error => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolve(); };
      const abort = () => finish(Error('Owned timeline cancelled'));
      function inspectDom(records) {
        entry.domCallbacks++;
        if (records?.length && entry.routeDispatchStartMs != null) entry.firstDomMutationMs ??= relative();
        const input = domInput();
        if (input && input !== before) {
          entry.firstDifferentInputDomMs ??= relative();
          if (input.querySelector('[contenteditable="true"]')) entry.firstEditableInDifferentInputMs ??= relative();
        }
        if (mode === 'native-strict') try {
          if (router.location.pathname === '/local/' + fixture.id && readBinding()?.threadId === fixture.id) finish();
        } catch (error) { if (!['workspace_host_pending', 'ui_host_pending'].includes(error.code)) finish(error); }
        if (mode === 'native-dom-only' && entry.firstDomMutationMs != null && router.location.pathname === '/local/' + fixture.id) finish();
      }
      try {
        observer = new MutationObserver(inspectDom);
        signal.addEventListener('abort', abort, { once: true });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'contenteditable'] });
        deadline = setTimeout(() => finish(Error('Owned timeline readiness deadline')), 5000);
        if (mode === 'adapter') {
          const operation = navigation.open({ threadId: fixture.id }, { signal }); entry.openReturnedMs = relative();
          await operation.executed; entry.executedReceiptMs = relative();
          await operation.committed; entry.committedReceiptMs = relative(); finish();
        } else {
          pin.navigator.push('/local/' + fixture.id); queueMicrotask(inspectDom); await ready; entry.observedReadyMs = relative();
          if (mode === 'native-dom-only') {
            // Diagnostic comparison only: DOM timing does not certify ownership.
            // Confirm the actual model once after settling; never use this mode
            // to relax the production navigation guard.
            await wait(250); entry.postSettleInspectionStartMs = relative();
            if (readBinding()?.threadId !== fixture.id) throw Error('Post-settle Native input did not confirm the owned target');
            entry.postSettleBindingConfirmedMs = relative();
          }
        }
        if (readBinding()?.threadId !== fixture.id) throw Error('Timeline target input differs');
        entry.status = 'passed';
      } catch (error) { entry.status = 'failed'; entry.code = error.code ?? null; entry.error = error.message; throw error; }
      finally {
        observer?.disconnect(); clearTimeout(deadline); clearTimeout(entry.zeroTimer); signal.removeEventListener('abort', abort); entry.completedMs = relative();
        delete entry.zeroTimer;
        delete entry.threadId; delete entry.started; delete entry.previousInput; delete entry.previousController;
        report.operations.push(entry); active = null;
      }
    }
    for (let round = 0; round < 4; round++) {
      const modes = round % 2 ? ['native-dom-only', 'adapter', 'native-strict'] : ['native-strict', 'adapter', 'native-dom-only'];
      for (const mode of modes) await sample(mode, spec.threads[round % 2], round);
    }
    report.status = 'passed';
  } catch (error) { report.error = error.message; report.code = error.code ?? null; }
  finally {
    active = null; navigation?.dispose(); provider?.dispose();
    try { if (original && spec.threads.some(thread => router.location.pathname === '/local/' + thread.id)) router.replace(original, original.state); }
    catch (error) { report.restoreError = error.message; report.status = 'failed'; }
    discovery?.dispose(); report.finalOwnedRoots = document.querySelectorAll('[data-codlet-workspace-owned]').length;
  }
  return report;
}
