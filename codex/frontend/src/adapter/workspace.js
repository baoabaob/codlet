import { desktopDocument } from '../host-discovery.js';
import { subscribeNativeRoute } from '../native-navigation.js';
import { OWNED, workspaceError, findWorkspaceSurface, workspaceBodyGeometry, findActivity, activityPlacement, resolveThreadReference, resolveThreadInteraction, hasBlockingOverlay, geometry, createSurfaceControl, surfaceOptions } from './workspace-dom.js';
import { createWorkspaceDiscovery } from './workspace-discovery.js';
import { createTranscripts } from './workspace-transcript.js';
import { createShortcuts } from './workspace-shortcuts.js';
import { createWorkspaceNavigation } from './workspace-navigation.js';
import { createWorkspaceActions } from './workspace-actions.js';
import { createComposers } from './workspace-composer.js';
import { createWorkspaceMetrics } from './workspace-metrics.js';
import { createWorkspaceLocations } from './workspace-location.js';
import { createWorkspaceSelection } from './workspace-selection.js';
import { createWorkspaceViewports } from './workspace-viewport.js';
import { createComposerControls } from './workspace-composer-controls.js';

export const WORKSPACE_CAPABILITY = Object.freeze({ name: 'codex.ui.workspace', api: 1, scope: 'target' });
export const WORKSPACE_SYMBOL = 'codlet.codex.ui.workspace.v1';
const emptyFeatures = () => ({ surface: false, activitySlot: false, transcript: false, shortcuts: false, navigation: false, navigationInput: false, locationRestore:false, selectionPresentation:true, independentViewport:false, action: false, composer:false, composerRebind:false });
const roleNames = ['main', 'content', 'scroller', 'composer', 'footer', 'header', 'rightPanel'];
const errorValue = error => ({ code: typeof error?.code === 'string' ? error.code : 'workspace_host_drift', message: String(error?.message ?? error) });

export function createWorkspace(context, { locate, baseNative, discovery: suppliedDiscovery, document: doc = document,
    requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id), validateDocument = desktopDocument,
    apiSymbol=WORKSPACE_SYMBOL,capability=WORKSPACE_CAPABILITY,navigationBinding,transcriptIsolation=false,testPoints } = {}) {
  const symbol = Symbol.for(apiSymbol), tickets = new Map(), sessions = new Set(), slots = new Set(), control = createSurfaceControl();
  if (globalThis[symbol] !== undefined) throw workspaceError('workspace_host_drift', 'Another workspace provider owns this document');
  let alive = true, frame = null, observer, resize, styleObserver, motion, unmotion, host, root, unroute, structural = true, surface, activity, features = emptyFeatures(), diagnostic = null, surfaceFailure = null, revision = 0;
  let snapshot = Object.freeze({ api: 1, revision, route: null, threadId: null, hostId: null, auxiliary: false, available: false, features: Object.freeze(features), diagnostic: null });
  let publicSurface = Object.freeze({ available: false, ...Object.fromEntries(roleNames.map(key => [key, null])), bodyViewport:null, floatingContent:Object.freeze([]) }), geometrySignature = '';
  const report = error => { try { context.reportDiagnostic?.({ ...errorValue(error), level: 'warning' }); } catch {} };
  const metrics = createWorkspaceMetrics(testPoints);
  const observedNodes = new Set();
  let surfaceRevision = 0, publishedSurfaceRevision = -1, geometryDirty = true;
  const check = () => { if (!alive) throw workspaceError('workspace_retired', 'Workspace provider retired'); };
  const discovery = suppliedDiscovery ?? createWorkspaceDiscovery(baseNative);
  const featureLoad = (role, load) => Promise.resolve().then(load).then(value => { check(); features = { ...features, [role]: true }; schedule(false); return value; }, error => {
    features = { ...features, [role]: false }; diagnostic = errorValue(error); report(error); schedule(false); throw error;
  });
  const transcripts = createTranscripts({ document: doc, load: () => featureLoad('transcript', discovery.transcript), surface: () => surface, check, report, isolate:transcriptIsolation, metrics });
  const shortcuts = createShortcuts({ document: doc, load: () => featureLoad('shortcuts', discovery.shortcuts), surface: () => surface, activity: () => activity, check, report, changed: () => schedule(false) });
  const navigation = createWorkspaceNavigation({document:doc,load:()=>featureLoad('navigation',discovery.navigation).then(value=>{
    features={...features,navigationInput:value.inputApi===1};schedule(false);return value;
  }),host:()=>host,check,changed:(value,operationId)=>{
    if(value?.input){refreshConfirmedSurface(value.input,operationId);return;}
    publish(true);
  },metrics,...(navigationBinding?{readBinding:navigationBinding}:{})});
  const locations=createWorkspaceLocations({document:doc,host:()=>host,load:()=>navigation.prepare().then(value=>{features={...features,locationRestore:typeof value.restoreLocation==='function'};schedule(false);return value;}),check,
    beforeCapture:()=>navigation.assertNotComposing(),beforeRestore:()=>navigation.beginLocationRestore(),retainGuard:()=>navigation.retainGuard(),changed:value=>value?.input?refreshConfirmedSurface(value.input):publish(true)});
  const selection=createWorkspaceSelection({document:doc,surface:()=>surface,snapshot:()=>snapshot,check,isConfirmed:id=>navigation.matchesCurrentThread(id),changed:()=>schedule(false)});
  const composerControls=createComposerControls({document:doc,surface:()=>surface,check,isConfirmed:id=>navigation.matchesCurrentThread(id),changed:()=>schedule(false)});
  const viewports=createWorkspaceViewports({load:()=>typeof discovery.viewport==='function'?discovery.viewport():Promise.reject(workspaceError('workspace_viewport_unsupported','Native viewport driver is unavailable')),prepared:()=>{features={...features,independentViewport:true};schedule(false);},failed:error=>{features={...features,independentViewport:false};diagnostic=errorValue(error);schedule(false);},check,isConfirmed:id=>navigation.matchesCurrentThread(id),isCurrentContext:id=>snapshot.threadId===id&&(id===null||navigation.matchesCurrentThread(id)),report});
  const actions=createWorkspaceActions({document:doc,load:()=>featureLoad('action',discovery.action),activity:()=>activity??=findActivity(doc),check,report});
  const composers=createComposers({document:doc,load:()=>featureLoad('composer',discovery.composer),surface:()=>surface,check,report,metrics});
  let composerFeatures, composerFeatureEpoch = 0;
  function prepareComposerFeatures() {
    if (host?.auxiliary || typeof discovery.composerCapabilities !== 'function') return;
    const epoch = composerFeatureEpoch;
    composerFeatures ??= Promise.resolve().then(discovery.composerCapabilities).then(async capabilities => {
      if (!alive || !sessions.size || epoch !== composerFeatureEpoch || !capabilities?.rebind) return;
      await composers.prepare();
      if (!alive || !sessions.size || epoch !== composerFeatureEpoch) return;
      features = { ...features, composerRebind: composers.supportsRebind() }; schedule(false);
    }).catch(error => { if (alive && sessions.size) report(error); });
  }
  function callback(listener, value) { try { Promise.resolve(listener(value)).catch(report); } catch (error) { report(error); } }
  let composerControlFailure=null;
  function reconcileComposerControls(){
    try{composerControls.reconcile();if(diagnostic===composerControlFailure)diagnostic=composerControlFailure=null;}
    catch(error){const value=errorValue(error);if(composerControlFailure?.code!==value.code||composerControlFailure?.message!==value.message)report(error);diagnostic=composerControlFailure=value;}
  }
  function publish(routeChanged = false) {
    reconcileComposerControls();
    const location = host?.navigator.location, route = location ? { pathname: location.pathname, search: location.search ?? '', hash: location.hash ?? '' } : null;
    const match = route && /^\/local\/([\w-]{8,256})\/?$/.exec(route.pathname), threadId = match?.[1] ?? null;
    const next = { api: 1, route, threadId, hostId: threadId ? 'local' : null, auxiliary: !!host?.auxiliary,
      available: !!surface?.composer && !host?.auxiliary, features, diagnostic };
    const previous = { ...snapshot }; delete previous.revision;
  const changed = routeChanged || surfaceRevision !== publishedSurfaceRevision || geometrySignature !== previousGeometry || JSON.stringify(next) !== JSON.stringify(previous);
    if (!changed) return;
    previousGeometry = geometrySignature;
    publishedSurfaceRevision = surfaceRevision;
    metrics?.add('surface.publish');
    snapshot = Object.freeze({ ...next, revision: ++revision, route: route && Object.freeze(route), features: Object.freeze({ ...features }), diagnostic: diagnostic && Object.freeze({ ...diagnostic }) });
    for (const session of sessions) for (const listener of session.listeners) callback(listener, snapshot);
    selection.reconcile();
  }
  let previousGeometry = '';
  let microtaskSequence = 0;
  function refreshGeometry(operationId) {
    const started=metrics?.start();
    geometryDirty = false;
    metrics?.add('surface.geometry');
    if (metrics) for (const key of roleNames) if (surface?.[key]) metrics.add('surface.layout.read');
    const roles = Object.fromEntries(roleNames.map(key => [key, geometry(surface?.[key])])), base = roles.scroller ?? roles.content ?? roles.main;
    if(metrics)for(const node of surface?.floatingContent??[])metrics.add('surface.layout.read');
    const regions = workspaceBodyGeometry(doc,surface,base?.rect);
    publicSurface = Object.freeze({ available: !!surface?.composer && !host?.auxiliary, ...roles, ...regions });
    geometrySignature = JSON.stringify([...roleNames.map(key => publicSurface[key]?.rect ?? null),regions.bodyViewport?.rect??null,regions.floatingContent.map(node=>[node.rect,node.visible])]);
    metrics?.end('surface.geometry.complete',started,{operationId});
  }
  function observeSurface() {
    const next = new Set([...roleNames.map(key => surface?.[key]),...surface?.floatingContent??[]].filter(Boolean));
    const changed = next.size !== observedNodes.size || [...next].some(node=>!observedNodes.has(node));
    for (const node of observedNodes) if (!next.has(node)) {
      resize?.unobserve(node); observedNodes.delete(node); metrics?.add('surface.resize.unobserve');
    }
    for (const node of next) if (!observedNodes.has(node)) {
      resize?.observe(node); observedNodes.add(node); metrics?.add('surface.resize.observe');
    }
    if(changed&&styleObserver){styleObserver.disconnect();for(const node of next)styleObserver.observe(node,{attributes:true,attributeFilter:['style','class','inert','aria-hidden']});}
    if(motion!==surface?.contentMotion){unmotion?.();motion=surface?.contentMotion;unmotion=motion?.on('change',()=>{geometryDirty=true;schedule(false);});}
  }
  function replaceSurface(next) {
    if (roleNames.some(key => surface?.[key] !== next?.[key])) {
      surfaceRevision++; geometryDirty = true;
    }
    if(surface?.contentMotion!==next?.contentMotion||surface?.floatingContent?.length!==next?.floatingContent?.length||next?.floatingContent?.some((node,index)=>surface?.floatingContent?.[index]!==node)){surfaceRevision++;geometryDirty=true;}
    surface = next;
    features = { ...features, surface: !!surface?.composer };
    observeSurface();
  }
  function surfaceUnavailable(error) {
    diagnostic = surfaceFailure = errorValue(error);
    if (diagnostic.code !== 'workspace_host_pending' && diagnostic.code !== 'ui_host_pending') report(error);
    if (surface) surfaceRevision++;
    surface = null; observeSurface(); control.reconcile(null); features = { ...features, surface: false }; refreshGeometry();
  }
  function refreshConfirmedSurface(input,operationId) {
    // Publish the same proven input before the committed receipt. A visible
    // document's queued rAF must not keep the previous cached composer public.
    try {
      const scanStarted=metrics?.start();
      metrics?.add('surface.scan');
      try{replaceSurface(findWorkspaceSurface(doc, input));}
      finally{metrics?.end('navigation.surface.scan',scanStarted,{operationId});}
      const controlStarted=metrics?.start();
      try{control.reconcile(surface);}
      finally{metrics?.end('navigation.surface.control',controlStarted,{operationId});}
      if (diagnostic === surfaceFailure) diagnostic = surfaceFailure = null;
      if (geometryDirty) refreshGeometry(operationId);
    } catch (error) { surfaceUnavailable(error); }
    const publishStarted=metrics?.start();
    try{publish(true);}
    finally{metrics?.end('navigation.surface.publish',publishStarted,{operationId});}
  }
  function reconcile() {
    frame = null; if (!alive || !sessions.size) return;
    const started = metrics?.start();
    metrics?.add('surface.reconcile');
    let routeChanged = false;
    try {
      if (!root?.isConnected || root !== doc.getElementById('root') || !host) {
        validateDocument(); host = locate(); root = host.rootNode;
        unroute?.(); unroute = subscribeNativeRoute(host.navigator, () => schedule(true));
      }
      routeChanged = host.navigator.location.pathname !== snapshot.route?.pathname;
      if (structural || routeChanged) {
        structural = false;
        metrics?.add('surface.scan');
        const next = host.auxiliary ? null : findWorkspaceSurface(doc, navigation.currentInput()?.input);
        replaceSurface(next);
        if (!activity?.isConnected && !host.auxiliary && (slots.size || features.shortcuts || features.action)) activity = findActivity(doc);
        features = { ...features, surface: !!surface?.composer, activitySlot: !!activity, transcript: host.auxiliary ? false : features.transcript, shortcuts: host.auxiliary ? false : features.shortcuts, composerRebind: host.auxiliary ? false : features.composerRebind, navigationInput: host.auxiliary ? false : features.navigationInput };
        if (diagnostic === surfaceFailure) diagnostic = surfaceFailure = null;
      }
      control.reconcile(surface);
      selection.reconcile();
      reconcileComposerControls();
      let anchor = activity?.isConnected ? activityPlacement(activity).anchor : null;
      if (anchor?.isConnected) for (const slot of slots) {
        if (slot.name !== 'activity.before') continue;
        let sibling=slot.container.nextSibling;while(sibling?.nodeType===1&&sibling.matches(OWNED))sibling=sibling.nextSibling;
        if (slot.container.parentElement !== anchor.parentElement || sibling !== anchor) anchor.before(slot.container);
      }
      for (const slot of slots) if (slot.name === 'workspace.overlay' && slot.container.parentElement !== root) root.append(slot.container);
      actions.reconcile();
      if (geometryDirty) refreshGeometry();
      if (routeChanged) shortcuts.rebind();
      else if (structuralSettings) shortcuts.refresh();
    } catch (error) {
      surfaceUnavailable(error);
    }
    structuralSettings = false; publish(routeChanged);
    navigation.pulse();
    if (metrics) metrics.end('surface.reconcile.complete', started);
  }
  let structuralSettings = false;
  function schedule(scan = true) {
    if (!alive || !sessions.size) return;
    structural ||= scan;
    geometryDirty ||= scan;
    if (frame == null) {
      // Current UIKit can display a native window while its backing Chromium
      // document reports hidden. Its rAF/timers are throttled. Batch committed
      // events in a microtask there; visible web documents batch by frame.
      if (doc.visibilityState === 'hidden') {
        const token = --microtaskSequence; frame = token;
        queueMicrotask(() => { if (frame === token) reconcile(); });
      } else frame = requestFrame(reconcile);
    }
  }
  function observe() {
    if (observer) return;
    observer = new doc.defaultView.MutationObserver(records => {
      metrics?.add('surface.mutation');
      // Native toolbar commits can remove only the injected action container.
      // Restore its placement even though owned-only changes are filtered below.
      if(actions.displaced(records)){
        if(!activity?.isConnected)activity=null;
        actions.reconcile();
      }
      if(selection.displaced(records))selection.reconcile();
      // Ignore consumer roots and changes below a stable native scroller. A new
      // direct body/footer child or a shell replacement still invalidates roles.
      const relevant = records.filter(record => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest(OWNED)) return false;
        if (record.type === 'attributes' && record.attributeName === 'data-app-shell-active-page') return true;
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.length && nodes.every(node => node.nodeType === 1 && node.matches(OWNED))) return false;
        if (surface?.scroller?.contains(target) && target !== surface.scroller && ![...record.removedNodes].some(node => roleNames.some(key => node === surface[key] || node.contains?.(surface[key])))) return false;
        return true;
      });
      if (!relevant.length) return;
      structuralSettings = true; schedule(true);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-app-shell-active-page'] });
    if (doc.defaultView.ResizeObserver) resize = new doc.defaultView.ResizeObserver(entries => {
      if (!entries.some(entry => observedNodes.has(entry.target))) return;
      metrics?.add('surface.resize'); geometryDirty = true; schedule(false);
    });
    styleObserver=new doc.defaultView.MutationObserver(()=>{geometryDirty=true;metrics?.add('surface.style');schedule(false);});
    doc.defaultView.addEventListener('resize', onResize);
  }
  const onResize = () => { geometryDirty = true; schedule(false); };
  function stopObserving() {
    observer?.disconnect(); resize?.disconnect(); styleObserver?.disconnect();unmotion?.();motion=unmotion=null;observer = resize = styleObserver = null; unroute?.(); unroute = null;
    observedNodes.clear(); geometryDirty = true;
    composerFeatureEpoch++; composerFeatures = undefined;
    doc.defaultView.removeEventListener('resize', onResize);
    if (frame != null && frame >= 0) cancelFrame(frame); frame = null; host = root = surface = activity = null;
  }
  function issueTicket(args, invocation) {
    check();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw workspaceError('invalid_argument', 'getApi expects an empty object');
    const caller = invocation?.caller;
    if (invocation?.signal?.aborted || !caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation)) throw workspaceError('invalid_owner', 'Workspace access requires a Core-authenticated caller');
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
    if (tickets.size >= 64) throw workspaceError('resource_limit', 'Too many pending workspace tickets');
    const ticket = crypto.randomUUID(); tickets.set(ticket, { ...caller, expires: Date.now() + 15000 });
    return { api: 1, symbol: apiSymbol, ticket };
  }
  function connect(owner, token) {
    check(); const ticket = tickets.get(token);
    if (!owner || owner.world !== 'main' || typeof owner.onDeactivate !== 'function' || typeof owner.pluginId !== 'string' || !Number.isSafeInteger(owner.generation)) throw workspaceError('invalid_owner', 'Workspace requires the live main-world consumer context');
    if (!ticket || ticket.expires < Date.now() || ticket.pluginId !== owner.pluginId || ticket.generation !== owner.generation) throw workspaceError('api_ticket_retired', 'Workspace ticket expired, was used or belongs to another owner');
    tickets.delete(token);
    if (sessions.size >= 64) throw workspaceError('resource_limit', 'Too many workspace sessions');
    const record = { listeners: new Set(), handles: new Map(), alive: true };
    const ownerKey = owner.pluginId + ':' + owner.generation; let release;
    const live = () => { check(); if (!record.alive) throw workspaceError('workspace_retired', 'Workspace consumer retired'); };
    function own(kind, limit, factory) {
      live(); const entries = record.handles.get(kind) ?? new Set(); record.handles.set(kind, entries);
      if (limit !== null && entries.size >= limit) throw workspaceError('resource_limit', `Too many owned ${kind} handles`);
      const value = factory();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      descriptors.dispose = { enumerable: true, value(options) { if (!entries.has(result)) return; value.dispose(options); entries.delete(result); } };
      if (typeof value.close === 'function') descriptors.close = { enumerable: true, value(options) { const completion = value.close(options); entries.delete(result); return completion; } };
      const result = Object.freeze(Object.defineProperties({}, descriptors)); entries.add(result); return result;
    }
    const session = Object.freeze({ api: 1,
      getSnapshot() { live(); return snapshot; },
      subscribe(listener) { live(); if (typeof listener !== 'function' || record.listeners.size >= 32) throw workspaceError('invalid_argument', 'Expected a workspace listener (at most 32)'); record.listeners.add(listener); callback(listener, snapshot); return () => record.listeners.delete(listener); },
      getSurface() { live(); return publicSurface; },
      resolveThreadReference(element) { live(); return resolveThreadReference(doc, element, id => {
        try { return !!discovery.connection?.().manager.getConversation(id); } catch { return false; }
      }); },
      resolveThreadInteraction(element) { live(); return resolveThreadInteraction(doc, element, id => {
        try { return !!discovery.connection?.().manager.getConversation(id); } catch { return false; }
      }); },
      hasBlockingOverlay(target) { live(); return hasBlockingOverlay(doc, target); },
      createSlot(name) {
        if (!['activity.before', 'workspace.overlay'].includes(name)) throw workspaceError('invalid_argument', 'Unknown workspace slot');
        return own('slot', 8, () => {
          if (name === 'activity.before' && !activity?.isConnected && !host?.auxiliary) try {
            activity = findActivity(doc); features = { ...features, activitySlot: !!activity };
          } catch (error) { diagnostic = errorValue(error); report(error); }
          const container = doc.createElement('span'); container.dataset.codletWorkspaceOwned = ownerKey; container.style.display = 'contents';
          const slot = { container, name }; slots.add(slot);
          if (name === 'workspace.overlay') root?.append(container);
          else if (activity?.isConnected) activityPlacement(activity).anchor.before(container);
          schedule(true);
          return { container, dispose() { slots.delete(slot); container.remove(); schedule(false); } };
        });
      },
      acquireSurface(options) { return own('surface', 8, () => {
        const lease = { options: surfaceOptions(options) }; control.leases.add(lease); control.reconcile(surface);
        let active = true;
        return { update(partial) { live(); if (!active) throw workspaceError('workspace_retired', 'Surface lease retired'); lease.options = surfaceOptions(partial, lease.options); control.reconcile(surface); },
          dispose() { active = false; control.leases.delete(lease); control.reconcile(surface); } };
      }); },
      mountTranscript(container, options) { return own('transcript', null, () => { if (host?.auxiliary) throw workspaceError('workspace_transcript_unavailable', 'Auxiliary windows have no transcripts'); return transcripts.mount(container, options, ownerKey); }); },
      mountComposer(container, options) { return own('composer',16,()=>{if(host?.auxiliary)throw workspaceError('workspace_composer_unavailable','Auxiliary windows have no composers');return composers.mount(container,options,ownerKey,live);}); },
      createNavigation() { return own('navigation',1,()=>navigation.create(live)); },
      captureLocation(options) { return own('location',4,()=>locations.capture(live,owner,options)); },
      acquireSelectionPresentation(options) { return own('selection',1,()=>selection.acquire(options,ownerKey,live)); },
      acquireComposerControl(options) { return own('composerControl',1,()=>composerControls.acquire(options,ownerKey,live)); },
      createViewport(options) { return own('viewport',1,()=>viewports.create(options,live)); },
      registerAction(options) { return own('action',16,()=>actions.register(options,ownerKey,live)); },
      registerShortcut(options) { return own('shortcut', 16, () => { if (host?.auxiliary) throw workspaceError('workspace_shortcuts_unavailable', 'Auxiliary windows have no shortcut workspace'); schedule(true); return shortcuts.register(options, ownerKey); }); },
      dispose() {
        if (!record.alive) return; record.alive = false; record.listeners.clear();
        for (const entries of record.handles.values()) for (const handle of [...entries]) handle.dispose(); record.handles.clear(); sessions.delete(record); release?.();
        if (!sessions.size) stopObserving();
      },
    });
    record.session = session; sessions.add(record);
    try { release = owner.onDeactivate(session.dispose); if (!record.alive) throw workspaceError('workspace_retired', 'The consumer is already retired'); observe(); structural = true; reconcile(); prepareComposerFeatures(); }
    catch (error) { session.dispose(); throw error; }
    return session;
  }
  const publicApi = Object.freeze({ api: 1, connect });
  Object.defineProperty(globalThis, symbol, { value: publicApi, configurable: true });
  context.rpc.provide(capability, 'getApi', issueTicket);
  function dispose() {
    if (!alive) return;
    for (const record of [...sessions]) record.session.dispose();
    alive = false; tickets.clear(); stopObserving(); control.dispose(); locations.dispose(); selection.dispose(); composerControls.dispose(); viewports.dispose(); navigation.dispose(); actions.dispose();composers.dispose();transcripts.dispose(); shortcuts.dispose(); discovery.dispose();
    if (globalThis[symbol] === publicApi) delete globalThis[symbol];
  }
  const releaseProvider = context.onDeactivate(dispose);
  const releaseCleanup = context.onCleanup?.(async cleanup => {await composers.cleanup(cleanup);await viewports.cleanup();});
  return { issueTicket, connect, refresh: () => schedule(true),
    ...(metrics ? { readTestPoints: () => metrics.report() } : {}),
    dispose() { dispose(); releaseProvider?.(); composers.cleanup().then(() => releaseCleanup?.(), report); } };
}
