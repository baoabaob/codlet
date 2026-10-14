'use strict';
const WORKSPACE = { name: 'codex.ui.workspace', api: 1, scope: 'target' }, METADATA = { name: 'workspace.audit.metadata', api: 1, scope: 'target' };
const symbol = Symbol.for('codlet.workspace.audit');
let audit;
module.exports = {
  activate(context) {
    const cleanups = new Set(), errors = [], marks = {};
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const frame = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const timed = async (name, fn) => { audit.phase = name; const start = performance.now(); try { return await fn(); } finally { marks[name] = performance.now() - start; } };
    audit = { result: null, running: false, phase: 'initial', transcriptStates: [], async inspect() {
      const descriptor = await context.rpc.request(WORKSPACE, 'getApi', {}), session = globalThis[Symbol.for(descriptor.symbol)].connect(context, descriptor.ticket);
      const snapshot = session.getSnapshot(); session.dispose(); return { available: snapshot.available, auxiliary: snapshot.auxiliary, diagnostic: snapshot.diagnostic, visibilityState: document.visibilityState };
    }, async run() {
      if (audit.running || audit.result) return audit.result ?? { running: true };
      audit.running = true;
      let session, shortcut;
      const dispose = () => { for (const cleanup of [...cleanups]) { try { cleanup(); } catch {} } cleanups.clear(); };
      try {
        const descriptor = await context.rpc.request(WORKSPACE, 'getApi', {}); session = globalThis[Symbol.for(descriptor.symbol)].connect(context, descriptor.ticket); cleanups.add(() => session.dispose());
        const initial = session.getSnapshot();
        if (!initial.available) return audit.result = { status: 'unavailable', diagnostic: initial.diagnostic, auxiliary: initial.auxiliary };
        const surface = session.getSurface(), nativeFooter = surface.footer.element, originalInert = nativeFooter.getAttribute('inert'), originalAria = nativeFooter.getAttribute('aria-hidden');
        const slot = session.createSlot('activity.before'); cleanups.add(() => slot.dispose());
        // Core-owned background pages throttle animation frames. This one
        // explicit window event makes a semantic refresh observable in the probe.
        window.dispatchEvent(new Event('resize')); await timed('activitySlotMs', frame);
        const slotMounted = slot.container.isConnected;
        const lease = session.acquireSurface({ hideBody: true, hideHeader: true, composerEnabled: false, rightPanelEnabled: false });
        const suppression = nativeFooter.hasAttribute('inert'); lease.dispose();
        const restoration = nativeFooter.getAttribute('inert') === originalInert && nativeFooter.getAttribute('aria-hidden') === originalAria;
        const loaded = await context.rpc.request(METADATA, 'loaded', { limit: 100 });
        const loadedMetadataOnly = loaded.threads.every(thread => !('turns' in thread) && !('items' in thread) && thread.hostId === 'local');
        const boxes = [], transcripts = [];
        for (let i = 0; i < 3; i++) {
          const box = document.createElement('div'); box.style.cssText = 'position:fixed;left:-5000px;top:0;width:480px;height:260px;display:flex;'; document.body.append(box); boxes.push(box); cleanups.add(() => box.remove());
          const handle = session.mountTranscript(box, { threadId: initial.threadId, readOnly: true, onState: state => { audit.transcriptStates[i] = state.phase; if (state.phase === 'error') errors.push(state.diagnostic); } }); transcripts.push(handle); cleanups.add(() => handle.dispose());
        }
        await timed('mountThreeMs', () => Promise.all(transcripts.map(handle => handle.ready)));
        const renderedBodyCharacters = boxes.map(box => box.querySelector('[data-thread-find-target="conversation"]')?.textContent.length ?? 0);
        const nativeScroll = boxes[0].querySelector('.thread-scroll-container'), scrollGeometry = nativeScroll && { height: nativeScroll.scrollHeight, clientHeight: nativeScroll.clientHeight, overflowY: getComputedStyle(nativeScroll).overflowY, flexDirection: getComputedStyle(nativeScroll).flexDirection };
        transcripts[0].setScrollPosition({ top: 41, left: 0 }); const scroll = transcripts[0].getScrollPosition();
        transcripts[0].setScrollPosition({ top: -41, left: 0 }); const reverseScroll = transcripts[0].getScrollPosition();
        const updateTimes = []; audit.phase = 'flagUpdates';
        const committed = (box, action) => new Promise((resolve, reject) => {
          const node = box.querySelector('[data-codlet-workspace-commit]'), before = node?.dataset.codletWorkspaceCommit;
          const observer = new MutationObserver(() => { if (node?.dataset.codletWorkspaceCommit !== before) { observer.disconnect(); resolve(); } });
          observer.observe(box, { attributes: true, subtree: true, attributeFilter: ['data-codlet-workspace-commit'] });
          try { action(); } catch (error) { observer.disconnect(); reject(error); }
        });
        const enqueueTimes = [];
        for (let i = 0; i < 8; i++) {
          const start = performance.now(); await committed(boxes[0], () => { const begin = performance.now(); transcripts[0].update({ readOnly: i % 2 !== 0, trackReadState: false }); enqueueTimes.push(performance.now() - begin); }); updateTimes.push(performance.now() - start);
        }
        const other = loaded.threads.find(thread => thread.id !== initial.threadId && thread.runtimeStatus === 'idle');
        if (other) await timed('threadRebindMs', () => new Promise(resolve => {
          transcripts[0].update({ threadId: other.id, readOnly: true, onState: state => { audit.transcriptStates[0] = state.phase; if (state.phase === 'error') errors.push(state.diagnostic); if (state.phase === 'ready') resolve(); } });
        }));
        for (const handle of transcripts) handle.dispose();
        const warm = session.mountTranscript(boxes[0], { threadId: initial.threadId, readOnly: true }); cleanups.add(() => warm.dispose()); await timed('warmMountMs', () => warm.ready); warm.dispose();
        try {
          shortcut = session.registerShortcut({ id: 'acceptance', label: 'Workspace adapter acceptance', description: 'Temporary verification shortcut', accelerator: null, defaultAccelerator: 'Ctrl+Alt+Shift+F12', onInvoke() {} }); cleanups.add(() => shortcut.dispose());
          await timed('shortcutReadyMs', () => shortcut.ready); shortcut.update({ accelerator: 'Ctrl+Alt+Shift+F12' }); shortcut.update({ accelerator: null });
          audit.phase = 'shortcutSettings'; await context.rpc.request(METADATA, 'settings', { open: true }); cleanups.add(() => context.rpc.request(METADATA, 'settings', { open: false }));
          await new Promise(resolve => setTimeout(resolve, 800));
          marks.settingsRowPresent = [...document.querySelectorAll('[data-codlet-workspace-owned="shortcut-settings"]')].some(node => node.textContent.includes('Workspace adapter acceptance'));
          await context.rpc.request(METADATA, 'settings', { open: false });
        } catch (error) { errors.push({ code: error.code, message: error.message }); }
        const shortcutReady = !!shortcut && (() => { try { return shortcut.getSnapshot().accelerator === null; } catch { return false; } })();
        const discoveryMetrics = await context.rpc.request(METADATA, 'metrics', {});
        const stable = session.getSnapshot(); await timed('idleObservationMs', () => new Promise(resolve => setTimeout(resolve, 1000))); const idleRevisionChanges = session.getSnapshot().revision - stable.revision;
        const start = performance.now(); for (let i = 0; i < 10000; i++) session.getSnapshot(); marks.tenThousandSnapshotReadsMs = performance.now() - start;
        dispose(); await frame();
        const clean = boxes.every(box => !box.isConnected) && !slot.container.isConnected && nativeFooter.getAttribute('inert') === originalInert && nativeFooter.getAttribute('aria-hidden') === originalAria;
        return audit.result = { status: errors.length || !marks.settingsRowPresent || !slotMounted || !clean || !restoration ? 'failed' : 'passed', slotMounted, suppression, restoration, loadedMetadataOnly, loadedCount: loaded.threads.length, shortcutReady, scroll, clean,
          updateTimesMs: updateTimes, enqueueTimesMs: enqueueTimes, renderedBodyCharacters, scrollGeometry, reverseScroll, idleRevisionChanges, visibilityState: document.visibilityState, platform: navigator.platform, discoveryMetrics, timings: marks, errors };
      } catch (error) { return audit.result = { status: 'failed', timings: marks, errors: [...errors, { code: error.code, message: String(error.message).slice(0, 400), stack: String(error.stack).slice(0, 2200) }] }; }
      finally { dispose(); audit.running = false; }
    } };
    globalThis[symbol] = audit; context.onDeactivate(() => { for (const cleanup of cleanups) cleanup(); cleanups.clear(); if (globalThis[symbol] === audit) delete globalThis[symbol]; });
  },
  deactivate() { if (globalThis[symbol] === audit) delete globalThis[symbol]; audit = null; },
};
