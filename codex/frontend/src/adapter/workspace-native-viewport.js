import { componentSource, currentElementAncestry } from '../host-discovery.js';
import { OWNED, nativeMainInput, nativeInputBinding, providersFor, wrapProviders, workspaceError } from './workspace-dom.js';
import { workspaceSourceFunctions, workspaceExportName, workspaceModuleSyntax, workspaceLexicalReferences } from './workspace-source.js';

const unavailable = message => workspaceError('workspace_viewport_unsupported', message);
function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (node.type) callback(node);
  for (const [key, value] of Object.entries(node)) if (!['start', 'end'].includes(key)) {
    if (Array.isArray(value)) value.forEach(item => visit(item, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}
function exportOf(source, local) {
  return workspaceExportName(source, local, 'workspace_viewport_unsupported', 'viewport state');
}

// Decode a bounded original declaration. Minified names never form the ABI,
// source is never evaluated, and no lazy wrapper is called to guess its role.
export function viewportSignalExports(source, { optional = false } = {}) {
  const candidates = new Map();
  for (const ast of workspaceSourceFunctions(source, 'window-resize')) {
    const text = source.slice(ast.start, ast.end);
    if (!['closeReason', '.stop()', 'animate'].every(marker => text.includes(marker))) continue;
    candidates.set(ast.start, ast);
  }
  if (!candidates.size && optional) return null;
  if (candidates.size !== 1) throw unavailable('Native content viewport action is missing or ambiguous');
  const ast = [...candidates.values()][0], resolve = workspaceLexicalReferences(ast), scope = resolve(ast.params[0]), open = resolve(ast.params[1]);
  const call = (node, method) => node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
    resolve(node.callee.object) === scope && node.callee.property.name === method && node.arguments[0]?.type === 'Identifier';
  const flags = [], opened = new Set(), motions = new Set();
  visit(ast.body.body[0]?.consequent, node => { if (call(node, 'set')) flags.push(node.arguments[0].name); });
  visit(ast, node => {
    if (call(node, 'set') && resolve(node.arguments[1]) === open) opened.add(node.arguments[0].name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && call(node.init, 'get')) {
      let stops = false;
      visit(ast, child => { if (child.type === 'CallExpression' && child.callee.type === 'MemberExpression' && resolve(child.callee.object) === resolve(node.id) && child.callee.property.name === 'stop') stops = true; });
      if (stops) motions.add(node.init.arguments[0].name);
    }
  });
  if (!scope || !open || flags.length !== 2 || new Set(flags).size !== 2 || opened.size !== 1 || motions.size !== 1)
    throw unavailable('Native content viewport action contract changed');
  return Object.freeze({ setOpen: exportOf(source, ast.id.name), expanded: exportOf(source, flags[0]), fullWidth: exportOf(source, flags[1]),
    open: exportOf(source, [...opened][0]), motion: exportOf(source, [...motions][0]) });
}

export function viewportPersistenceReference(source, { optional = false } = {}) {
  const candidates = [];
  for (const ast of workspaceSourceFunctions(source, 'mainContentWidth')) {
    const properties = ast.params[0]?.properties ?? [], names = properties.map(value => value.key?.name);
    if (ast.end - ast.start > 4096 || ast.params.length !== 1 || names.length !== 4 || !['mainContentWidth', 'storageKey', 'width', 'widthMode'].every(key => names.includes(key))) continue;
    const expression = ast.body.body[0]?.expression, key = properties.find(value => value.key.name === 'storageKey')?.value.name;
    if (ast.body.body.length === 1 && expression?.type === 'CallExpression' && expression.callee.type === 'Identifier' && expression.arguments[0]?.name === key) candidates.push(expression.callee.name);
  }
  if (!candidates.length && optional) return null;
  if (candidates.length !== 1) throw unavailable('Native viewport persistence action is missing or ambiguous');
  const local = candidates[0], syntax = workspaceModuleSyntax(source);
  if (syntax.exports.some(value => value.local === local && !value.source)) return {
    local, source: null, imported: workspaceExportName(source, local, 'workspace_viewport_unsupported', 'viewport persistence writer'),
  };
  const matches = syntax.imports.filter(value =>
    value.local === local && /^\.\/[A-Za-z0-9_-]+\.js$/.test(value.source) && value.imported !== '*');
  if (matches.length !== 1) throw unavailable('Native viewport persistence import is missing or ambiguous');
  return matches[0];
}
export function viewportPersistenceExport(source) { return viewportPersistenceReference(source).imported; }

export function nativeViewportContext(document, native, pins = new WeakMap()) {
  const root = document.getElementById('root'), input = nativeMainInput(document, native);
  const main = input?.input.closest('main[data-app-shell-main-surface]') ?? [...document.querySelectorAll('main[data-app-shell-main-surface]')]
    .find(node => !node.closest(OWNED + ',[data-app-shell-active-page="false"]'));
  if (!root || !main?.isConnected) throw workspaceError('workspace_host_pending', 'Native main viewport is not mounted');
  const valid = facade => facade && typeof facade.get === 'function' && typeof facade.set === 'function' && typeof facade.watch === 'function' &&
    facade.chain?.get(native.RouteScope.id)?.token === native.RouteScope && facade.chain?.get(native.ThreadScope.id)?.token === native.ThreadScope;
  let facade = valid(input?.scope) ? input.scope : null;
  if (!facade) for (const fiber of currentElementAncestry(main, root) ?? []) {
    for (let hook = fiber.memoizedState, count = 0; hook && count++ < 128; hook = hook.next) if (valid(hook.memoizedState?.current)) facade = hook.memoizedState.current;
  }
  if (!facade) throw workspaceError('workspace_host_pending', 'Native viewport scope is not mounted');
  const chain = new Map(facade.chain), routeNode = chain.get(native.RouteScope.id), threadNode = chain.get(native.ThreadScope.id);
  let pinned = pins.get(routeNode);
  if (!pinned || pinned.chain.get(native.ThreadScope.id) !== threadNode) {
    // Capture a new Native hook facade in a temporary root. It reads the
    // existing provider nodes and cannot later rebind with the user's editor.
    // Only this owned facade receives an immutable copy of its context chain.
    if (typeof native.useScope !== 'function') throw unavailable('Native pinned viewport context is unavailable');
    const box = document.createElement('div'); box.dataset.codletWorkspaceOwned = 'viewport-context:' + crypto.randomUUID(); box.style.display = 'none'; document.body.append(box);
    let captured, failure, captureRoot;
    const Capture = () => { captured = native.useScope(native.RouteScope); return null; };
    try {
      const providers = providersFor(main); if (!providers.length) throw unavailable('Native viewport providers are unavailable');
      captureRoot = native.Client.createRoot(box, { onUncaughtError: error => { failure = error; }, onCaughtError: error => { failure = error; } });
      native.DOM.flushSync(() => captureRoot.render(wrapProviders(native, providers, native.React.createElement(Capture))));
      if (failure) throw failure;
      if (!captured || captured === facade || captured.node !== routeNode || !valid(captured)) throw unavailable('Native pinned viewport context changed ownership');
      captured.chain = new Map(captured.chain); pinned = captured;
    } finally { try { if (captureRoot) native.DOM.flushSync(() => captureRoot.unmount()); } finally { box.remove(); } }
    pins.set(routeNode, pinned);
  }
  if (!valid(pinned) || pinned.chain.get(native.RouteScope.id) !== routeNode || pinned.chain.get(native.ThreadScope.id) !== threadNode)
    throw unavailable('Native pinned viewport context changed ownership');
  return { root, main, facade: pinned, routeNode, threadNode,
    threadId: input ? nativeInputBinding(input, native)?.threadId ?? null : null };
}

export function nativeViewportLayout(context) {
  const shell = (currentElementAncestry(context.main, context.root) ?? []).find(fiber => {
    const text = componentSource(fiber.type); return text.includes('data-app-shell-main-surface') && text.includes('contentPaneWidthRatio');
  });
  if (!shell) throw workspaceError('workspace_host_pending', 'Native viewport layout is not mounted');
  const pending = [shell.child], seen = new Set(), candidates = [];
  while (pending.length) {
    const fiber = pending.pop(); if (!fiber || seen.has(fiber)) continue;
    if (seen.size >= 512) throw unavailable('Native viewport layout exceeds the discovery boundary');
    seen.add(fiber); if (fiber.sibling) pending.push(fiber.sibling);
    const props = fiber.memoizedProps, text = componentSource(fiber.type);
    if (text.includes('pane_resize') && text.includes('contentPaneWidthRatio') && text.includes('data-app-shell-focus-area')) {
      if (typeof props?.isContentPaneOpen !== 'boolean' || !['contentPaneWidth', 'contentPaneWidthRatio', 'workspaceWidth'].every(key => typeof props[key]?.get === 'function') || typeof props.contentPaneWidth?.on !== 'function')
        throw unavailable('Native viewport motion/layout contract changed');
      candidates.push(props); continue;
    }
    // Native places the content pane beside the main-content viewport *inside*
    // <main>. Prune the actual body/resource branches, not that whole shell.
    if (fiber.stateNode?.matches?.(`${OWNED},[data-app-shell-main-content-layout],[data-app-shell-focus-area="main"],.thread-scroll-container,[data-codex-composer-root],aside[data-app-shell-focus-area="right-panel"]`)) continue;
    if (fiber.child) pending.push(fiber.child);
  }
  if (candidates.length !== 1) throw workspaceError('workspace_host_pending', 'A unique Native viewport layout is required');
  return candidates[0];
}

// Learn the width signal through the semantic Native outlet in an owned,
// temporary Thread/Route scope. It never registers over the user's outlet,
// opens a conversation, creates a backend, or mounts a composer.
export function learnNativeViewportWidth(document, native, context) {
  const box = document.createElement('div'), owner = 'viewport-discovery:' + crypto.randomUUID();
  box.dataset.codletWorkspaceOwned = owner; box.style.display = 'none'; document.body.append(box);
  const R = native.React, h = R.createElement, config = Object.freeze({ defaultWidth: 360, storageKey: owner });
  let root;
  try {
    const providers = providersFor(context.main); if (!providers.length) throw unavailable('Native viewport providers are unavailable');
    const route = native.routeDescription({ pathname: '/local/codlet-viewport-discovery', search: '?codletViewport=' + encodeURIComponent(owner) });
    const child = h(native.Scope, { scope: native.ThreadScope, value: { clientThreadId: owner } },
      h(native.Scope, { scope: native.RouteScope, value: route }, h(native.Shell.RightPanelOutlet, { presentation: 'over-tabs', paneWidth: config, children: h('span') })));
    let failure;
    root = native.Client.createRoot(box, { onUncaughtError: error => { failure = error; }, onCaughtError: error => { failure = error; } });
    native.DOM.flushSync(() => root.render(wrapProviders(native, providers, child)));
    if (failure) throw failure;
    const key = Object.keys(box).find(key => key.startsWith('__reactContainer$')), container = key && box[key], current = container?.stateNode?.current ?? container;
    const pending = [current], seen = new Set(), signals = new Set();
    while (pending.length) {
      const fiber = pending.pop(); if (!fiber || seen.has(fiber)) continue;
      if (seen.size >= 128) throw unavailable('Native viewport outlet exceeds the discovery boundary');
      seen.add(fiber); const props = fiber.memoizedProps;
      if (props?.value === config && props.signal?.scope === native.RouteScope && props.signal.cache === 'signal' && typeof props.signal.resolve === 'function') signals.add(props.signal);
      if (fiber.sibling) pending.push(fiber.sibling); if (fiber.child) pending.push(fiber.child);
    }
    if (signals.size !== 1) throw unavailable('Native viewport width registration is missing or ambiguous');
    return [...signals][0];
  } finally { try { if (root) native.DOM.flushSync(() => root.unmount()); } finally { box.remove(); } }
}

export function createNativeViewportDriver({ document, native, signals, readContext,
    readLayout = nativeViewportLayout, learnWidth = context => learnNativeViewportWidth(document, native, context) }) {
  for (const key of ['open', 'fullWidth', 'expanded', 'motion']) if (signals[key]?.scope !== native.ThreadScope || signals[key].cache !== 'signal' || typeof signals[key].resolve !== 'function') throw unavailable('Native viewport signals belong to another scope');
  if (typeof signals.setOpen !== 'function' || typeof native.writeAtom !== 'function') throw unavailable('Native viewport state/persistence controls are unavailable');
  const pins = new WeakMap(); readContext ??= () => nativeViewportContext(document, native, pins);
  let widthSignal;
  return Object.freeze({ api: 1, independent: true, restoresSettings: true, avoidsThreadPersistence: true, notifiesChanges: true,
    async create(initial, { onError = () => {}, isCurrentContext = () => true } = {}) {
      native.check?.(); const first = readContext(); readLayout(first);
      widthSignal ??= learnWidth(first);
      if (widthSignal?.scope !== native.RouteScope || widthSignal.cache !== 'signal' || typeof widthSignal.resolve !== 'function') throw unavailable('Native independent width signal changed scope');
      const key = 'codlet.workspace.viewport.' + crypto.randomUUID(), entries = new Map(), listeners = new Set();
      let active = true, current, state = { ...initial }, bound = false, unwatch, unmotion, masked, restoreMask, queued = false, failure;
      const remember = (error, phase) => {
        failure ??= Object.assign(workspaceError(error?.code ?? 'workspace_viewport_failed', `Native viewport ${phase} failed: ${String(error?.message ?? error)}`), { cause: error });
        return failure;
      };
      const retireFailed = async (error, phase) => {
        const primary = remember(error, phase);
        try { onError(primary); } catch {}
        try { await close(); } catch (cleanup) { throw Object.assign(new AggregateError([primary, cleanup], primary.message + '; viewport cleanup also failed', { cause: primary }), { code: primary.code }); }
        throw primary;
      };
      const notify = () => { if (active) for (const listener of listeners) listener(Object.freeze({ ...state })); };
      const journal = context => {
        let entry = entries.get(context.routeNode);
        if (!entry) {
          for (const signal of [widthSignal, ...['open', 'fullWidth', 'expanded', 'motion'].map(role => signals[role])]) {
            const node = context.facade.chain.get(signal.scope.id);
            if (!node?.signalBindings?.has(signal)) throw workspaceError('workspace_host_pending', 'Native viewport state is not bound');
          }
          const flags = Object.fromEntries(['open', 'fullWidth', 'expanded'].map(role => [role, context.facade.get(signals[role])]));
          if (Object.values(flags).some(value => typeof value !== 'boolean')) throw unavailable('Native viewport state has changed shape');
          entry = { context, flags, config: context.facade.get(widthSignal), applied: null, leased: false }; entries.set(context.routeNode, entry);
        }
        return entry;
      };
      const unmask = () => { restoreMask?.(); restoreMask = null; masked = null; };
      const mask = () => {
        const panel = bound ? null : [...document.querySelectorAll('aside[data-app-shell-focus-area="right-panel"]')].find(node => !node.closest(OWNED + ',[data-app-shell-active-page="false"]'));
        if (masked === panel) return; unmask(); if (!panel) return;
        masked = panel; const visibility = [panel.style.getPropertyValue('visibility'), panel.style.getPropertyPriority('visibility')], inert = panel.getAttribute('inert'), hidden = panel.getAttribute('aria-hidden');
        panel.style.setProperty('visibility', 'hidden', 'important'); panel.setAttribute('inert', ''); panel.setAttribute('aria-hidden', 'true');
        restoreMask = () => {
          if (panel.style.getPropertyValue('visibility') === 'hidden' && panel.style.getPropertyPriority('visibility') === 'important') visibility[0] ? panel.style.setProperty('visibility', ...visibility) : panel.style.removeProperty('visibility');
          if (panel.getAttribute('inert') === '') inert == null ? panel.removeAttribute('inert') : panel.setAttribute('inert', inert);
          if (panel.getAttribute('aria-hidden') === 'true') hidden == null ? panel.removeAttribute('aria-hidden') : panel.setAttribute('aria-hidden', hidden);
        };
      };
      const restore = entry => {
        if (!entry.leased) return;
        const facade = entry.context.facade;
        for (const signal of [widthSignal, ...['open', 'fullWidth', 'expanded'].map(role => signals[role])])
          if (!facade.chain.get(signal.scope.id)?.signalBindings?.has(signal)) throw workspaceError('workspace_viewport_state_evicted', 'Native evicted the leased viewport state');
        native.DOM.flushSync(() => {
          if (facade.get(widthSignal) === entry.applied) facade.set(widthSignal, entry.config);
          signals.setOpen(facade, entry.flags.open, { animate: false, closeReason: 'window-resize' });
          facade.set(signals.fullWidth, entry.flags.fullWidth); facade.set(signals.expanded, entry.flags.expanded);
        });
        entry.leased = false;
      };
      const stop = () => {
        const callbacks = [unwatch, unmotion, restoreMask], errors = [];
        unwatch = unmotion = restoreMask = null; masked = null;
        for (const callback of callbacks) try { callback?.(); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new AggregateError(errors, 'Native viewport listeners could not be released'), { code: 'workspace_viewport_cleanup_failed' });
      };
      const width = () => {
        const layout = readLayout(current.context), value = layout.contentPaneWidth.get();
        if (Number.isFinite(value) && value >= 240 && value <= 1600 && state.width !== value) { state = { ...state, width: value }; notify(); }
        mask(); return layout;
      };
      const onWidth = value => {
        if (!active || !isCurrentContext(current.context.threadId)) return;
        if (Number.isFinite(value) && value >= 240 && value <= 1600 && state.width !== value) { state = { ...state, width: value }; notify(); }
        mask();
      };
      const apply = () => {
        const facade = current.context.facade;
        current.applied = Object.freeze({ defaultWidth: state.width, storageKey: key }); current.leased = true;
        native.DOM.flushSync(() => {
          facade.set(widthSignal, current.applied); facade.set(signals.fullWidth, false); facade.set(signals.expanded, false);
          signals.setOpen(facade, state.open, { animate: false, closeReason: 'window-resize' });
        });
        const layout = width();
        if (layout.widthMode === 'full') throw unavailable('Native full viewport layout could not be leased independently');
        if (unmotion) { unmotion(); unmotion = layout.contentPaneWidth.on('change', onWidth); }
      };
      const listen = () => {
        unwatch = current.context.facade.watch(({ get }) => {
          if (!active || !isCurrentContext(current.context.threadId)) return;
          const config = get(widthSignal), open = get(signals.open), full = get(signals.fullWidth), expanded = get(signals.expanded);
          if (state.open !== open) { state = { ...state, open }; notify(); }
          if ((config !== current.applied || full || expanded) && !queued) {
            // A Native viewer may change its normal pane configuration. Keep
            // that latest value for release, then restore the owned width key.
            if (config !== current.applied) current.config = config;
            queued = true;const entry = current;
            queueMicrotask(() => {
              queued = false; if (!active || current !== entry || !entry.leased) return;
              try {
                // Navigation can publish a new Native shell before the caller
                // binds its new identity. Old-context signals must not reapply
                // an override against that new shell's live layout.
                if (!isCurrentContext(entry.context.threadId)) return;
                let now;
                try { now = readContext(); } catch (error) {
                  if (['workspace_host_pending','workspace_composer_binding_drift'].includes(error?.code)) return;
                  throw error;
                }
                if (now.routeNode !== entry.context.routeNode || now.threadNode !== entry.context.threadNode) return;
                apply();
              } catch (error) { const primary=remember(error,'notification');onError(primary);void close().catch(onError); }
            });
          }
        });
        unmotion = readLayout(current.context).contentPaneWidth.on('change', onWidth);
        if (typeof unwatch !== 'function' || typeof unmotion !== 'function') throw unavailable('Native viewport notifications cannot be released');
      };
      let closing;
      const close = () => {
        if (closing) return closing; active = false;
        return closing = Promise.resolve().then(() => {
        listeners.clear(); const errors = [];try { stop(); } catch (error) { errors.push(error); }
        for (const entry of entries.values()) try { restore(entry); } catch (error) { errors.push(error); }
        try { native.writeAtom(key, undefined); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new AggregateError(errors, 'Native viewport restoration failed'), { code: 'workspace_viewport_cleanup_failed' });
        entries.clear(); current = null;
      });};
      const ready = Promise.resolve().then(() => {
        if (!active) throw workspaceError('workspace_retired', 'Native viewport retired during readiness');
        const now = readContext();
        if (now.routeNode !== first.routeNode || now.threadNode !== first.threadNode) throw workspaceError('workspace_viewport_superseded', 'Native context changed during viewport readiness');
        current = journal(first); apply(); listen();
      }).catch(error => retireFailed(error,'readiness'));
      ready.catch(() => {});
      const valid = signal => {
        if (!active) throw failure ?? workspaceError('workspace_retired', 'Native viewport retired'); native.check?.();
        if (signal?.aborted) throw workspaceError('invocation_cancelled', 'Native viewport update cancelled');
      };
      return Object.freeze({
        ready,
        subscribe(listener) { valid(); listeners.add(listener); listener(Object.freeze({ ...state })); return () => listeners.delete(listener); },
        async bind(identity, { signal } = {}) {
          valid(signal);
          if (identity === null) {
            // Null clears presentation during a route transition. It is not
            // permission to adopt an unconfirmed context or reapply old flags
            // to the new shell. Confirmed bind will restore/adopt contexts.
            if (!isCurrentContext(current.context.threadId)) stop();
            bound = false; mask(); notify(); return;
          }
          const context = readContext();
          if (identity && context.threadId !== identity.threadId) throw workspaceError('workspace_selection_not_confirmed', 'Native viewport selection changed');
          try {
          if (current.context.routeNode !== context.routeNode) { stop(); restore(current); current = journal(context); }
          else stop();
          bound = identity !== null; apply(); listen(); notify();
          } catch (error) { return retireFailed(error,'binding'); }
        },
        async update(next, { signal } = {}) {
          valid(signal);try { stop();
          if (next.width !== state.width) native.writeAtom(key, undefined);
          state = { ...next }; apply(); listen(); notify(); return Object.freeze({ ...state });
          } catch (error) { return retireFailed(error,'update'); }
        },
        close,
      });
    },
  });
}
