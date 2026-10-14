import { discoverNative } from '../../../frontend/src/adapter/discovery.js';
import { createWorkspaceDiscovery, readWorkspaceAsset } from '../../../frontend/src/adapter/workspace-discovery.js';
import { navigationSignalExport } from '../../../frontend/src/adapter/workspace-native-navigation.js';
import { locateHost } from '../../../frontend/src/adapter/navigation.js';
import { createWorkspaceNavigation } from '../../../frontend/src/adapter/workspace-navigation.js';
import { nativeMainInput, nativeInputBinding } from '../../../frontend/src/adapter/workspace-dom.js';
import { createWorkspaceMetrics } from '../../../frontend/src/adapter/workspace-metrics.js';
import { inspectNativeInput, inspectNativeComposerScope } from '../../../frontend/src/adapter/workspace-native-input.js';
import { currentElementAncestry, loadedAsset, componentSource } from '../../../frontend/src/host-discovery.js';
import { createTranscripts } from '../../../frontend/src/adapter/workspace-transcript.js';
import { findWorkspaceSurface } from '../../../frontend/src/adapter/workspace-dom.js';

export async function run(spec) {
  const report = { status: 'failed', phases: [], sentTurns: 0, additionalEditors: 0, nativePaintMeasured: false };
  const metrics = createWorkspaceMetrics({ enabled: true, runId: spec.runId, capacity: 1024 });
  let discovery, provider, navigation, original, router, describe, transcripts, attachmentCleanup, boxes = [];
  const control = spec.controlKey ? globalThis[Symbol.for(spec.controlKey)] : null;
  const signal = control?.abort.signal;
  const assertLive = () => { if (signal?.aborted) throw Error('Owned Native probe cancelled'); };
  const wait = milliseconds => new Promise((resolve, reject) => {
    assertLive(); const timer = setTimeout(finish, milliseconds);
    function finish(error) { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); }
    const abort = () => finish(Error('Owned Native probe cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  const deadline = (promise, milliseconds) => new Promise((resolve, reject) => {
    assertLive(); const timer = setTimeout(() => finish(Error('Owned Native probe deadline')), milliseconds);
    function finish(error, value) { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); }
    const abort = () => finish(Error('Owned Native probe cancelled'));
    signal?.addEventListener('abort', abort, { once: true }); promise.then(value => finish(null, value), finish);
  });
  const phase = async (name, work) => {
    assertLive(); if (control) control.phase = name;
    const start = performance.now();
    try { const result = await work(); report.phases.push({ name, status: 'passed', ms: performance.now() - start, result }); return result; }
    catch (error) { report.phases.push({ name, status: 'failed', ms: performance.now() - start, code: error.code ?? null, message: error.message }); throw error; }
  };
  try {
    if (spec.shellOnly) {
      const root = document.getElementById('root');
      report.shell = { visibility: document.visibilityState, rootChildren: root?.childElementCount ?? null,
        navigationRails: document.querySelectorAll('nav[data-app-navigation-rail="true"]').length,
        mainSurfaces: document.querySelectorAll('main[data-app-shell-main-surface]').length,
        inputs: document.querySelectorAll('[data-codex-composer-root]').length,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent.trim().slice(0, 240)),
        errorPre: document.querySelector('pre')?.textContent.trim().slice(0, 600) ?? null };
      report.status = 'passed'; return report;
    }
    const base = await discoverNative(); discovery = createWorkspaceDiscovery(() => base);
    const N = await discovery.navigation(), nativeHost = locateHost(); router = nativeHost.navigator; original = { ...router.location };
    const main = () => nativeMainInput(document, N), binding = () => nativeInputBinding(main(), N);
    describe = () => {
      const raw = [...document.querySelectorAll('[data-codex-composer-root]')].map(input => {
        let diagnosis;
        const value = inspectNativeInput(N, input, document.getElementById('root'), undefined, value => diagnosis = value);
        const scope = value?.scope ?? inspectNativeComposerScope(N, currentElementAncestry(input) ?? []);
        return { validInput: !!value, diagnosis, kind: scope?.value.kind, placement: scope?.value.placement, entrypoint: scope?.value.entrypoint,
          modelFixture: spec.threads.findIndex(fixture => scope?.value.conversationId === fixture.id),
          editableCount: input.querySelectorAll('[contenteditable="true"]').length, composerKeys: Object.keys(scope?.value ?? {}) };
      });
      let value;try { value = main(); } catch {}
      const thread = value?.scope.chain.get(N.ThreadScope.id), route = value?.scope.chain.get(N.RouteScope.id);
      return { selectedFixture: spec.threads.findIndex(fixture => router.location.pathname === '/local/' + fixture.id),
        raw,
        kind: value?.scope.value.kind ?? null, modelFixture: spec.threads.findIndex(fixture => value?.scope.value.conversationId === fixture.id),
        inputCount: document.querySelectorAll('[data-codex-composer-root]').length, controller: !!value?.controller,
        composerKeys: Object.keys(value?.scope.value ?? {}), threadKeys: Object.keys(thread?.value ?? {}), routeKeys: Object.keys(route?.value ?? {}),
        clientThreadMatches: !!value && thread?.value.clientThreadId === value.scope.value.clientThreadId,
        routeMatches: !!value && route?.value.conversationId === value.scope.value.conversationId,
        tokens: { composer: value?.scope.chain.get(N.composerScope.id) === value?.scope.node, thread: thread?.token === N.ThreadScope, route: route?.token === N.RouteScope },
        cached: spec.threads.slice(0, 2).map(fixture => { const cached = N.manager.getConversation(fixture.id); return { index: fixture.index, exists: !!cached, resumeState: cached?.resumeState, turns: cached?.turns?.length }; }) };
    };
    const initial = main(); report.initial = { kind: initial?.scope.value.kind, placement: initial?.scope.value.placement,
      entrypoint: initial?.scope.value.entrypoint, editable: !!initial?.editable, controller: !!initial?.controller };
    report.selectedFixture = spec.threads.findIndex(thread => router.location.pathname === '/local/' + thread.id);
    report.scopeShape = initial ? { composerKeys: Object.keys(initial.scope.value),
      chain: [...initial.scope.chain.values()].map(node => ({ brand: node.token?.__scopeBrand ?? null, valueKeys: Object.keys(node.value ?? {}) })) } : null;
    if (spec.inspectOnly) { report.inspection = describe(); report.status = 'passed'; return report; }
    // Production Workspace supplies its prepared host; repeated locateHost()
    // here would charge full route discovery only to the Adapter samples.
    provider = createWorkspaceNavigation({ document, load: async () => N, host: () => nativeHost, check: () => discovery.connection(), changed() {}, metrics });
    navigation = provider.create(() => {}); await navigation.ready;
    report.inputApi = navigation.inputApi;
    if (!spec.bodyOnly && !spec.navigationBenchOnly && !spec.attachmentOnly) {
    for (const fixture of spec.threads.slice(0, 2)) await phase('cold-open-' + fixture.index, async () => {
      const op = navigation.open({ threadId: fixture.id }, { signal }), executed = await op.executed, commit = await op.committed, value = binding();
      if (value?.threadId !== fixture.id || value.controller.view.isDestroyed) throw Error('Actual Native local input differs');
      return { revision: commit.revision, submitDisabled: commit.submitDisabled, synchronousMs: executed.synchronousMs,
        actualModel: value.scope.value.kind, controller: true, canonicalScopes: true,
        focusBeforeExplicit: document.activeElement === value.editable, focused: navigation.focus({ revision: commit.revision }) };
    });
    await phase('warm-explicit-focus', async () => {
      const fixture = spec.threads[0], op = navigation.open({ threadId: fixture.id }, { signal }); await op.executed; const commit = await op.committed;
      const focused = navigation.focus({ revision: commit.revision });
      if (!focused || navigation.focus({ revision: commit.revision - 1 })) throw Error('Native focus revision check failed');
      return { focused, staleRevisionRejected: true, modelConfirmed: binding()?.threadId === fixture.id };
    });
    await phase('composition-preflight', async () => {
      const value = main(); value.editable.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'synthetic' }));
      const before = router.location.pathname; let code;
      try { navigation.open({ threadId: spec.threads[1].id }); } catch (error) { code = error.code; }
      finally { value.editable.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })); }
      if (code !== 'workspace_composer_busy' || router.location.pathname !== before) throw Error('IME preflight did not preserve Native route');
      return { busyRejected: true, routePreserved: true, syntheticEvents: true, physicalImeTested: false };
    });
    if (!spec.performanceOnly) await phase('native-draft-preservation', async () => {
      const expected = ['Adapter synthetic draft A', 'Adapter synthetic draft B'];
      for (let index = 0; index < 2; index++) {
        const op = navigation.open({ threadId: spec.threads[index].id }, { signal }); await op.committed; const value = binding();
        if (value.controller.getPersistedText() !== '') throw Error('Synthetic draft was unexpectedly nonempty');
        if (typeof value.controller.setText !== 'function') throw Error('Native text transaction method missing');
        value.controller.setText(expected[index]);
        if (value.controller.getPersistedText() !== expected[index]) throw Error('Native dictation/document did not confirm synthetic edit');
      }
      for (let index = 0; index < 2; index++) {
        await navigation.open({ threadId: spec.threads[index].id }, { signal }).committed;
        if (binding().controller.getPersistedText() !== expected[index]) throw Error('Native navigation did not preserve its synthetic draft');
      }
      return { drafts: 2, normalNativeSetText: true, preservedAcrossNavigation: true, diskAckClaimed: false };
    });
    await phase('rapid-replacement', async () => {
      const first = navigation.open({ threadId: spec.threads[0].id }, { signal }), second = navigation.open({ threadId: spec.threads[1].id }, { signal });
      const old = await first.committed.then(() => 'committed', error => error.code); const commit = await second.committed;
      if (old !== 'workspace_navigation_superseded' || binding()?.threadId !== spec.threads[1].id || !navigation.focus({ revision: commit.revision }))
        throw Error('Rapid replacement did not preserve the latest actual Native input');
      return { oldRejected: true, latestConfirmed: true };
    });
    } else await phase('body-source-main-input', async () => {
      const commit = await navigation.open({ threadId: spec.threads[0].id }, { signal }).committed;
      return { inputConfirmed: commit.inputConfirmed, fixture: 0 };
    });
    if (spec.attachmentOnly) await phase('native-selected-text-attachment', async () => {
      const url = loadedAsset('initial');
      if (!url.endsWith('/' + spec.nativeInitialPin.name)) throw Error('Synthetic attachment helper Native asset differs');
      const response = await fetch(url, { credentials: 'omit', signal });
      if (!response.ok || response.url !== url) throw Error('Native attachment helper source unavailable');
      const bytes = await response.arrayBuffer(), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== spec.nativeInitialPin.sha256) throw Error('Native attachment helper pin differs');
      const initial = await import(url), add = initial.f0t, update = initial.j2t;
      if (!componentSource(add).includes('selectedTextAttachments.push') || !componentSource(update).includes('e[t]=typeof n')) throw Error('Pinned Native attachment helper differs');
      const ownText = 'Adapter synthetic attachment ' + spec.controlKey;
      const scope = () => { const value = binding(); if (value?.threadId !== spec.threads[0].id) throw Error('Synthetic attachment input changed'); return value.scope; };
      const read = () => {
        let result;
        // Reviewed EV/SYr returns without writes when this callback returns the
        // unchanged field. Copy only scalars while the Native draft is live.
        update(scope(), 'selectedTextAttachments', current => { result = { count: current.length, ownIds: current.filter(item => item.text === ownText).map(item => item.id) }; return current; });
        return result;
      };
      const before = read(); if (before.count) throw Error('Synthetic fixture contains an unexpected selected-text attachment');
      attachmentCleanup = async () => {
        await navigation.open({ threadId: spec.threads[0].id }).committed;
        update(scope(), 'selectedTextAttachments', current => current.filter(item => item.text !== ownText));
        if (read().count !== before.count) throw Error('Own Native synthetic attachment cleanup did not confirm');
      };
      add(scope(), ownText);
      if (read().ownIds.length !== 1) throw Error('Native selected-text attachment did not confirm');
      await wait(350);
      await navigation.open({ threadId: spec.threads[1].id }, { signal }).committed;
      const other = binding(); let otherCount;
      update(other.scope, 'selectedTextAttachments', current => { otherCount = current.filter(item => item.text === ownText).length; return current; });
      if (otherCount) throw Error('Native selected-text attachment crossed thread ownership');
      await navigation.open({ threadId: spec.threads[0].id }, { signal }).committed;
      if (read().ownIds.length !== 1) throw Error('Normal Native navigation lost its selected-text attachment');
      await attachmentCleanup(); attachmentCleanup = null;
      return { selectedTextAttachment: true, nativeModelField: true, preservedAcrossNavigation: true, otherThreadUnaffected: true,
        ownAttachmentRemoved: true, fileOrImageUploadTested: false, diskAckClaimed: false, pinnedTestHelperOnly: true };
    });
    if (spec.contractOnly) {
      await phase('contract-post-idle', async () => {
        await wait(1000);
        if (binding()?.threadId !== spec.threads[1].id) throw Error('Native input disappeared after the contract sequence');
        return { actualBindingAfterIdle: true, waitRequestedMs: 1000 };
      });
      await phase('canonical-open-from-settings', async () => {
        const url = loadedAsset('shared'), shared = await import(url), connection = discovery.connection();
        const key = shared[navigationSignalExport(await readWorkspaceAsset(url, signal))];
        if (!connection.node.signalBindings.has(key)) throw Error('Owned Native bridge is not bound');
        const bridge = connection.node.store.get(key.resolve(connection.node, connection.chain));
        if (bridge.navigate('/settings') !== true) throw Error('Native declined owned settings navigation');
        await wait(1000);
        if (!router.location.pathname.startsWith('/settings')) throw Error('Native settings precondition differs');
        const commit = await navigation.open({ threadId: spec.threads[0].id }, { signal }).committed;
        return { inputConfirmed: commit.inputConfirmed, actualFixture: binding()?.threadId === spec.threads[0].id, nativeSettingsEntry: true };
      });
    }
    if (spec.performanceOnly && !spec.contractOnly) {
      if (!spec.bodyOnly) {
      if (spec.navigationBenchOnly) await phase('navigation-bench-prime', async () => {
        const expected = ['Adapter synthetic draft A', 'Adapter synthetic draft B'];
        for (let index = 0; index < 2; index++) {
          await navigation.open({ threadId: spec.threads[index].id }, { signal }).committed;
          if (binding().controller.getPersistedText() !== expected[index]) throw Error('Own synthetic draft was not retained across the owned restart');
          await wait(250);
        }
        return { fixtures: 2, draftsRetainedAfterOwnedRestart: true, diskAckClaimed: false };
      });
      await phase('paired-warm-navigation', async () => {
        const samples = report.partialPairedSamples = [];
        async function nativeOpen(fixture) {
          assertLive(); return await new Promise((resolve, reject) => {
            let timer; const observer = new MutationObserver(pulse);
            function finish(error) { observer.disconnect(); clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); }
            const abort = () => finish(Error('Owned Native probe cancelled'));
            function pulse() { try { const value = binding(); if (router.location.pathname === '/local/' + fixture.id && value?.threadId === fixture.id && !value.submitDisabled) finish(); } catch (error) { if (error.code !== 'workspace_host_pending') finish(error); } }
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'contenteditable'] });
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => finish(Error('Native baseline timed out')), 5000); router.push('/local/' + fixture.id); queueMicrotask(pulse);
          });
        }
        for (let round = 0; round < 8; round++) for (const mode of round % 2 ? ['adapter', 'native'] : ['native', 'adapter']) {
          const fixture = spec.threads[round % 2];
          // Both measured paths start on the opposite task. Counterbalance order
          // after both tasks have been resumed, rather than measuring a same-route open.
          await nativeOpen(spec.threads[1 - round % 2]); await wait(250);
          const start = performance.now(); let receipt;
          if (mode === 'adapter') receipt = await navigation.open({ threadId: fixture.id }, { signal }).committed;
          else await nativeOpen(fixture);
          samples.push({ round, mode, ms: performance.now() - start, actualFixture: spec.threads.findIndex(value => binding()?.threadId === value.id), revision: receipt?.revision });
        }
        return { samples, nativePaintMeasured: false, sameBindingInspector: true, oppositeTaskPrecondition: true, counterbalancedOrder: true };
      });
      await phase('binding-inspection-cost', async () => {
        const samples = [];
        for (let index = 0; index < 50; index++) { assertLive(); const start = performance.now(); binding(); samples.push(performance.now() - start); }
        return { samples, calls: samples.length, scope: 'stable actual local Native input' };
      });
      }
      if (!spec.navigationBenchOnly) {
      const errors = [];
      transcripts = createTranscripts({ document, load: () => discovery.transcript(), surface: () => findWorkspaceSurface(document),
        check: () => discovery.connection(), report: error => errors.push({ code: error.code, message: error.message }), metrics });
      for (const count of [0, 1, 2, 4, 5, 8]) await phase('native-transcripts-' + count, async () => {
        const handles = [], start = performance.now();
        for (let index = 0; index < count; index++) {
          const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px;pointer-events:none;'; document.body.append(box); boxes.push(box);
          handles.push(transcripts.mount(box, { threadId: spec.threads[index].id, readOnly: true, trackReadState: false }, spec.runId));
        }
        await deadline(Promise.all(handles.map(handle => handle.ready)), 15000);
        const readyMs = performance.now() - start;
        const before = boxes.map(box => box.querySelector('[data-thread-find-target="conversation"]'));
        if (count) {
          await navigation.open({ threadId: spec.threads[0].id }, { signal }).committed;
          await navigation.open({ threadId: spec.threads[1].id }, { signal }).committed;
          if (before.some((node, index) => boxes[index].querySelector('[data-thread-find-target="conversation"]') !== node)) throw Error('Main navigation rebuilt an independent Native body');
        }
        await wait(1000);
        if (control) control.phase = 'transcript-idle-' + count;
        await wait(5000);
        const cleanup = performance.now(); for (const handle of handles) handle.dispose(); for (const box of boxes) box.remove(); boxes = [];
        if (control) control.phase = 'transcript-cleaned-' + count;
        return { count, readyMs, cleanupMs: performance.now() - cleanup, bodiesPreservedAcrossNavigation: true,
          remainingOwnedRoots: document.querySelectorAll('[data-codlet-workspace-owned]').length, idleObservationMs: 5000,
          historyTurnsPerThread: 0, errors: errors.splice(0) };
      });
      await phase('transcript-retired-idle', async () => { await wait(5000); return { remainingOwnedRoots: document.querySelectorAll('[data-codlet-workspace-owned]').length }; });
      }
    }
    report.status = 'passed';
  } catch (error) { report.code = error.code ?? null; report.error = error.message; try { report.failureState = describe?.(); } catch (probeError) { report.probeError = probeError.message; } }
  finally {
    if (attachmentCleanup) try { await attachmentCleanup(); } catch (error) { report.attachmentCleanupError = error.message; report.status = 'failed'; }
    transcripts?.dispose(); for (const box of boxes) box.remove(); boxes = [];
    navigation?.dispose(); provider?.dispose();
    try { if (original && spec.threads.some(thread => router.location.pathname === '/local/' + thread.id)) router.replace(original, original.state); }
    catch (error) { report.restoreError = error.message; report.status = 'failed'; }
    discovery?.dispose(); report.metrics = metrics.report();
  }
  return report;
}
