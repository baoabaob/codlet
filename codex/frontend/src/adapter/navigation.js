import { createCodletIcons } from '../icons.js';
import { CLIENT_PROFILES, clientProfile } from '../../../compatibility/client-profiles.js';
import { COMPOSER_CAPABILITY, createComposerActions, composerLease } from './composer-action.js';
import { reviewedNavigator } from '../native-navigation.js';
import { COMPOSER_PROFILE, discoverNative } from './discovery.js';
import { desktopDocument, hostFibers } from '../host-discovery.js';
import { createWorkspace } from './workspace.js';

// Reviewed mappings are the fast path. Structural discovery handles unlisted
// builds; all private host details remain in this optional adapter.
export function pageProfile(build, entries = Array.from(document.scripts, script => script.src), readyState = document.readyState) {
  const profile = clientProfile(build, entries);
  if (!profile?.page) {
    const sources = Array.isArray(entries) ? entries : [entries];
    const candidates = CLIENT_PROFILES.filter(profile => profile.appVersion === build?.appVersion && profile.buildNumber === String(build?.buildNumber));
    if (candidates.length && !candidates.some(profile => sources.includes(profile.entry)) && readyState !== 'complete')
      throw fail('ui_host_pending', 'Waiting for the reviewed Desktop entry resource');
    throw fail('ui_build_drift', 'No reviewed sidebar/page profile for this Desktop build');
  }
  return profile;
}
export const CAPABILITY = Object.freeze({ name: 'codex.ui.navigation.page', api: 1, scope: 'target' });
const fail = (code, message) => Object.assign(new Error(message), { code });
let current;

export function fibers() {
  try { return hostFibers(); }
  catch (error) {
    if (error.code === 'desktop_host_pending') throw fail('ui_host_pending', error.message);
    if (error.code === 'desktop_host_drift') throw fail('ui_host_drift', error.message);
    throw error;
  }
}

export function locateHost() {
  const navigators = new Set(), routerContexts = new Set(), trees = new Set(), objectTrees = new Set();
  for (const fiber of fibers()) {
    for (const value of [fiber.memoizedProps, fiber.memoizedProps?.value]) if (value?.navigator) {
      navigators.add(value.navigator);
      if (value.router) routerContexts.add(value);
    }
    const child = fiber.memoizedProps?.children;
    // Build 9771 wraps the route collection in a Fragment inside the same
    // element-less root Route. Keep the Route identity for appended pages.
    const children = child?.props?.children;
    const routes = children?.type === Symbol.for('react.fragment') ? children.props?.children : children;
    if (child?.props?.element === undefined && child?.type !== Symbol.for('react.fragment') && Array.isArray(routes) &&
        routes.some(route => route?.props?.path === '/avatar-overlay')) trees.add(child);
    // Newer hosts preconvert JSX with createRoutesFromElements. Their existing
    // RouteContext exposes the same live collection through matched route objects.
    const matches = fiber.memoizedProps?.value?.matches;
    if (Array.isArray(matches)) for (const { route } of matches) {
      if (route?.element === undefined && Array.isArray(route?.children) && route.children.some(child => child?.path === '/avatar-overlay')) objectTrees.add(route);
    }
  }
  // Legacy <Routes> retains its JSX input as well as derived match objects.
  // Mutate the retained input there; only use objects when JSX is absent.
  if (!trees.size) for (const tree of objectTrees) trees.add(tree);
  if (navigators.size !== 1 || trees.size !== 1) throw fail('ui_host_pending', 'A unique Desktop router and route tree are required');
  const navigator = reviewedNavigator(navigators, routerContexts), tree = [...trees][0];
  if (!navigator)
    throw fail('ui_host_drift', 'The Desktop memory router is unavailable in this window');
  if(navigator.location.pathname==='/avatar-overlay'||navigator.location.pathname.startsWith('/avatar-overlay/'))
    return {navigator,tree,rootNode:document.getElementById('root'),auxiliary:true};
  const candidates = [], objects = !tree.props;
  const visit = element => {
    const props = objects ? element : element?.props;
    if (!props) return;
    const children = props.children;
    if (Array.isArray(children)) {
      const path = child => objects ? child?.path : child?.props?.path;
      if (children.some(child => path(child) === '/inbox') && children.some(child => path(child) === '/connector/oauth_callback')) candidates.push(children);
      children.forEach(visit);
    } else visit(children);
  };
  visit(tree);
  if (candidates.length !== 1 || Object.isFrozen(candidates[0]) || !Object.isExtensible(candidates[0]))
    throw fail('ui_host_drift', 'The reviewed authenticated route collection is unavailable');
  return { navigator, routes: candidates[0], Route: tree.type, objects, tree, rootNode: document.getElementById('root') };
}

function nativePlacement(SidebarItem, SidebarGroup) {
  const candidates = [];
  for (const button of document.querySelectorAll('nav button.sidebar-item')) {
    if (button.closest('[data-codlet-native-navigation]')) continue;
    const key = Object.keys(button).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && button[key];
    for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
      if (fiber.type !== SidebarItem) continue;
      const anchors = SidebarGroup ? ['sidebar-tasks', 'sidebar-plugins', 'sidebar-library', 'sidebar-new-chat'] : ['sidebar-tasks', 'sidebar-plugins', 'sidebar-library'];
      const priority = anchors.indexOf(fiber.memoizedProps?.animatedIcon);
      if (priority !== -1) {
        if (SidebarGroup) {
          // Build 11645 puts New chat inside a drag/drop wrapper. Insert beside
          // that row in the reviewed group, not inside its interactive region.
          let group = fiber.return;
          for (let n=0;group&&group.type!==SidebarGroup&&n<20;n++) group=group.return;
          const parent = group?.type===SidebarGroup ? group.child?.stateNode : null;
          if (parent?.nodeType===1 && parent.contains(button)) {
            let anchor=button;while(anchor.parentElement!==parent)anchor=anchor.parentElement;
            candidates.push({parent,anchor,priority});
          }
        } else candidates.push({ parent: button.parentElement, anchor: button, priority });
      }
      break;
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0] ?? null;
}

function railPlacement(SidebarGroup) {
  const rails = document.querySelectorAll('nav[data-app-navigation-rail="true"]');
  if (rails.length !== 1) return null;
  // The reviewed rail's outer SidebarGroup owns Home, the fixed destinations,
  // Explore and the nested sortable group. Stay outside the sortable region.
  const rail = rails[0], home = rail.querySelector('[data-sidebar-destination="builtin:home"]');
  const key = home && Object.keys(home).find(key => key.startsWith('__reactFiber$'));
  let fiber = key && home[key];
  for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
    if (fiber.type !== SidebarGroup || fiber.memoizedProps?.itemSpacing !== 'rail') continue;
    const parent = fiber.child?.stateNode;
    if (parent?.nodeType !== 1 || !rail.contains(parent) || !parent.contains(home)) return null;
    const fixed = parent.querySelector('[data-sidebar-destination="builtin:customize"]') ?? home;
    let anchor = fixed;
    while (anchor.parentElement !== parent) anchor = anchor.parentElement;
    return { parent, anchor };
  }
  return null;
}

function pageOwner(args, invocation) {
  const caller = invocation?.caller;
  if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation)) throw fail('invalid_owner', 'Page registration requires a Core-authenticated caller');
  if (!args || Object.keys(args).some(key => !['label', 'icon', 'token', 'toolbar'].includes(key)) ||
      typeof args.label !== 'string' || !args.label.trim() || args.label.length > 64 || !['Cube', 'CodeSquareSlash', 'Codlet'].includes(args.icon) ||
      (args.toolbar !== undefined && typeof args.toolbar !== 'boolean') ||
      typeof args.token !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(args.token)) throw fail('invalid_argument', 'Invalid page registration');
  const lease = [...document.querySelectorAll('[data-codlet-page-lease]')].find(node => node.dataset.codletPageLease === args.token);
  if (!lease || lease.dataset.codletPageOwner !== caller.pluginId || lease.dataset.codletGeneration !== String(caller.generation))
    throw fail('invalid_owner', 'The page lifetime does not match its caller');
  return { caller, lease };
}

export function createNavigation(context, native, host, withComposer = true) {
  // The pet window mounts a router, but never mounts the main AppShell. Its
  // lazy header/composer modules must not be initialized by this adapter.
  if (host.auxiliary) {
    const actions = createComposerActions(context, host, null);
    let alive = true;
    return {
      register(args, invocation) {
        if (!alive) throw fail('ui_retired', 'The UI adapter retired');
        const current = locateHost();
        if (!current.auxiliary || current.tree !== host.tree || current.navigator !== host.navigator)
          throw fail('ui_host_drift', 'Desktop route ownership changed; reload the UI adapter');
        pageOwner(args, invocation);
        return { api: 1, token: args.token, path: null, available: false };
      },
      newTaskDraft() { throw fail('ui_composer_unavailable', 'This window has no task composer'); },
      registerComposer: (args, invocation) => actions.register(args, invocation),
      unregisterComposer: (args, invocation) => actions.unregister(args, invocation),
      statusComposer: (args, invocation) => actions.status(args, invocation),
      dispose() { alive = false; actions.dispose(); },
    };
  }
  const { React, DOM, Client, SidebarItem, Header, HeaderToolbar, RailButton, RailTooltip } = native;
  const { Cube, CodeSquareSlash, PluginPuzzle } = createCodletIcons(React);
  const icons = { Cube, CodeSquareSlash, Codlet: PluginPuzzle };
  const entries = new Map(), h = React.createElement;
  const composerActions = createComposerActions(context, host, withComposer ? native.composerActionProfile : null);
  let alive = true, navContainer, navRoot, pending = false;
  const hostLive = () => document.getElementById('root') === host.rootNode && host.rootNode.isConnected;
  const check = () => {
    const current = alive ? locateHost() : null;
    if (!current || current.tree !== host.tree || current.navigator !== host.navigator)
      throw fail('ui_host_drift', 'Desktop route ownership changed; reload the UI adapter');
  };
  const renderNav = () => {
    if (!alive || !navRoot) return;
    navRoot.render(h(React.Fragment, null, ...[...entries.values()].map(entry => {
      const onClick = () => { try { check(); if (!entry.active) { entry.previous = { ...host.navigator.location }; host.navigator.push(entry.path); } }
        catch (error) { context.reportDiagnostic?.({ code: error.code, message: error.message }); } };
      const props = { 'aria-label': entry.label, 'data-codlet-navigation-entry': entry.owner, onClick };
      return RailButton ? h(RailTooltip, { key: entry.token, cloneCustomTrigger: true, closeOnTriggerClick: true,
        side: 'right', tooltipContent: entry.label },
        h(RailButton, { ...props, 'aria-current': entry.active ? 'page' : undefined,
          color: 'secondary', variant: 'ghost', pill: false, size: 'xl', iconSize: 'lg', uniform: true, selected: entry.active },
          h(icons[entry.icon], {filled:entry.active}), h('span', { className: 'sr-only' }, entry.label))) :
        h(SidebarItem, { ...props, key: entry.token, label: entry.label, icon: icons[entry.icon], isActive: entry.active });
    })));
  };
  const retire = entry => {
    if (!entries.delete(entry.owner)) return;
    // A native route unmounts its page. Back/forward/other destinations all use
    // the same host lifecycle; no hidden conversation or inert overlay remains.
    if (hostLive() && (host.navigator.location.pathname === entry.path || host.navigator.location.pathname.startsWith(entry.path + '/'))) {
      const previous = entry.previous;
      host.navigator.replace(previous && !previous.pathname.startsWith('/codlet/') ?
        { pathname: previous.pathname, search: previous.search, hash: previous.hash } : '/', previous?.state);
    }
    const index = host.routes.indexOf(entry.route);
    if (index !== -1) host.routes.splice(index, 1);
    renderNav();
  };
  const reconcile = () => {
    if (!alive) return;
    if (!hostLive()) { navContainer?.remove(); return; }
    for (const entry of [...entries.values()]) if (!entry.lease.isConnected) retire(entry);
    const placement = RailButton ? railPlacement(native.SidebarGroup) : nativePlacement(SidebarItem, native.SidebarGroup);
    if (!placement || !entries.size) { navContainer?.remove(); return; }
    if (!navContainer) {
      navContainer = document.createElement('div'); navContainer.dataset.codletNativeNavigation = '1';
      // Let the native rail own spacing, scrolling and sizing, including when
      // several plugins register pages. Legacy sidebars keep their row spacing.
      navContainer.className = RailButton ? 'contents' : 'flex flex-col gap-px';
      navRoot = Client.createRoot(navContainer); renderNav();
    }
    if (navContainer.parentElement !== placement.parent || navContainer.previousElementSibling !== placement.anchor)
      placement.parent.insertBefore(navContainer, placement.anchor.nextSibling);
  };
  const schedule = records => {
    if (!alive || pending || records.every(record => navContainer?.contains(record.target) || record.target.closest?.('[data-codlet-official-ui]'))) return;
    // Streaming messages change the document much more often than the sidebar.
    // Inspect only the changed subtrees; a document-wide placement scan is needed
    // when the native navigation changes or an owned lifetime is disconnected.
    const selector = 'nav, button.sidebar-item';
    const navigationChanged = records.some(record => {
      if (record.target.closest?.('nav')) return true;
      return [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector)));
    });
    if (hostLive() && [...entries.values()].every(entry => entry.lease.isConnected) &&
        (!navContainer || navContainer.isConnected || !entries.size) && !navigationChanged) return;
    pending = true; queueMicrotask(() => { pending = false; reconcile(); });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  function DraftBridge({entry}) {
    const compose=native.useStartNewConversation();
    React.useLayoutEffect(()=>{entry.compose=compose;return()=>{if(entry.compose===compose)entry.compose=null;};},[entry,compose]);
    return null;
  }
  function newTaskDraft(args,invocation) {
    check();
    const caller=invocation?.caller,entry=entries.get(caller?.pluginId);
    if(!entry||!Number.isSafeInteger(caller.generation)||!entry.lease.isConnected||entry.lease.dataset.codletGeneration!==String(caller.generation)||!entry.active||!(host.navigator.location.pathname===entry.path||host.navigator.location.pathname.startsWith(entry.path+'/'))||invocation.signal?.aborted)
      throw fail('invalid_owner','A new task draft requires this caller’s active page');
    if(!args||Object.keys(args).some(key=>key!=='prompt')||typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>16384)
      throw fail('invalid_argument','A new task draft requires a bounded prompt');
    if(typeof entry.compose!=='function')throw fail('ui_composer_unavailable','The native new-task composer is not ready');
    entry.compose({...native.newTaskOptions,prefillPrompt:args.prompt,prefillLocalExecution:true,prefillComposerMode:'local',startInSidebar:true});
    return {opened:true,submitted:false};
  }
  function register(args, invocation) {
    check();
    const { caller, lease } = pageOwner(args, invocation);
    if(args.toolbar && (!Header || !HeaderToolbar))throw fail('ui_build_drift','The reviewed native page toolbar is unavailable');
    const existing = entries.get(caller.pluginId);
    if (existing) {
      if (existing.token === args.token && existing.lease === lease) return existing.description;
      retire(existing);
    }
    const entry = { owner: caller.pluginId, token: args.token, lease, label: args.label, icon: args.icon,
      path: '/codlet/' + encodeURIComponent(caller.pluginId), active: false, previous: null };
    entry.description = { api: 1, token: entry.token, path: entry.path };
    // The route owns both the content and the native Header outlet. Native
    // teardown clears the outlet on navigation; a second toolbar in the page
    // body would duplicate the shell's header height and shift all content.
    const content = h('div', { 'data-codlet-page-host': entry.token,
      className: 'h-full min-h-0 min-w-0 flex flex-col overflow-auto',
      ref: node => { entry.active = !!node; queueMicrotask(renderNav); } });
    const routeProps = { id: 'codlet:' + caller.pluginId, path: entry.path + '/*',
      element: h(React.Fragment,null,
        native.useStartNewConversation?h(DraftBridge,{entry}):null,
        args.toolbar ? h(React.Fragment, null,
        h(Header, null, h(HeaderToolbar, { inset: native.toolbarInset ?? true },
          h('div', { 'data-codlet-page-toolbar': entry.token, className: 'flex w-full min-w-0 items-center' }))),
        content) : content) };
    entry.route = host.objects ? routeProps : h(host.Route, routeProps);
    host.routes.push(entry.route); entries.set(entry.owner, entry); reconcile(); renderNav();
    return entry.description;
  }
  return { register, newTaskDraft,
    registerComposer: (args, invocation) => composerActions.register(args, invocation),
    unregisterComposer: (args, invocation) => composerActions.unregister(args, invocation),
    statusComposer: (args, invocation) => composerActions.status(args, invocation),
    dispose() {
    if (!alive) return;
    observer.disconnect();
    composerActions.dispose();
    for (const entry of [...entries.values()]) retire(entry);
    alive = false;
    if (navRoot) DOM.flushSync(() => navRoot.unmount());
    navContainer?.remove();
  } };
}

export function reviewedHeader(initial, names) {
  // This exact module exports a lazy AppShell initializer (Uxa as hB) and
  // its live value (fQ as mB). Importing the module alone does not initialize it.
  if (typeof initial[names.headerInit] !== 'function') throw fail('ui_build_drift', 'The reviewed native AppShell initializer changed');
  initial[names.headerInit]();
  const Header = initial[names.header]?.Header, HeaderToolbar = initial[names.header]?.HeaderToolbar;
  const component = value => typeof value === 'function' || value?.$$typeof === Symbol.for('react.memo');
  if (!component(Header) || !component(HeaderToolbar)) throw fail('ui_build_drift', 'The reviewed native header exports changed');
  return { Header, HeaderToolbar };
}

function nativeProfile() {
  const build = globalThis.electronBridge?.getSentryInitOptions?.();
  if (location.origin !== 'app://-' || location.pathname !== '/index.html')
    throw fail('ui_build_drift', 'No reviewed sidebar/page profile for this Desktop build');
  const profile = pageProfile(build);
  if (![...document.scripts].some(script => script.src === profile.entry))
    throw fail(document.readyState === 'complete' ? 'ui_build_drift' : 'ui_host_pending', 'The Desktop entry resource does not match this adapter');
  return profile;
}

async function loadNative() {
  desktopDocument();
  const detected = globalThis.electronBridge?.getSentryInitOptions?.();
  const entries = Array.from(document.scripts, script => script.src);
  const reviewed = clientProfile(detected, entries);
  // Profiles are a fast path for known resources. New version numbers and new
  // asset hashes are reasons to probe the actual contract, not to reject it.
  if (!reviewed?.page || !entries.includes(reviewed.entry)) return discoverNative();
  const profile = nativeProfile(), page = profile.page, names = page.exports;
  const [react, dom, client, primary, initial] = await Promise.all([import(page.react), import(page.dom), import(page.client), import(page.primary), import(page.initial ?? profile.module)]);
  const native = { React: react[names.react??'t'](), DOM: dom[names.dom??'t'](), Client: client[names.client??'t'](), SidebarItem: primary[names.sidebar], ...reviewedHeader(initial, names) };
  native.composerActionProfile = page.composerAction ?? null;
  native.SidebarGroup = names.sidebarGroup ? primary[names.sidebarGroup] : undefined;
  if(names.sidebarGroup && typeof native.SidebarGroup!=='function')throw fail('ui_build_drift','The reviewed native sidebar group changed');
  if (page.navigationRail) {
    native.RailButton = react[page.navigationRail.button];
    native.RailTooltip = react[page.navigationRail.tooltip];
    if (typeof native.RailButton !== 'function' || typeof native.RailTooltip !== 'function' || !native.SidebarGroup)
      throw fail('ui_build_drift', 'The reviewed native navigation rail changed');
  }
  native.toolbarInset = page.toolbarInset;
  native.newTaskOptions = page.newTaskOptions ?? {};
  // Same lazy initializer and hook used by the official Create plugin/skill
  // flow. The hook is called inside Native's route and AppScope providers.
  if(typeof initial[names.newTaskInit]!=='function')throw fail('ui_build_drift','The reviewed new-task initializer changed');
  initial[names.newTaskInit]();
  if(typeof initial[names.newTask]!=='function')throw fail('ui_build_drift','The reviewed new-task hook changed');
  native.useStartNewConversation=initial[names.newTask];
  if (typeof native.React.createElement !== 'function' || typeof native.Client.createRoot !== 'function' || typeof native.SidebarItem !== 'function')
    throw fail('ui_build_drift', 'The reviewed native UI exports changed');
  return native;
}

export function deferredNavigation(context, load = loadNative) {
  let alive = true, navigation, failure, cancelWait, independentActions, native;
  const pending = new Map(), pendingComposer = new Map();
  const composer = () => {
    if (load !== loadNative) return null;
    if (independentActions) return independentActions;
    desktopDocument();
    const rootNode = document.getElementById('root');
    if (!rootNode?.isConnected) return null;
    let host = { rootNode, auxiliary: false };
    try { host = locateHost(); } catch { /* DOM outlets do not require a router. */ }
    independentActions = createComposerActions(context, host, COMPOSER_PROFILE);
    return independentActions;
  };
  const ready = (async () => {
    let delay = 50;
    while (alive) {
      try {
        if (load === loadNative) desktopDocument();
        const actions = composer();
        if (actions) for (const [id, entry] of pendingComposer) {
          pendingComposer.delete(id);
          if (entry.lease.isConnected) try { actions.register(entry.args, { caller: entry.caller }); }
          catch (error) { entry.lease.remove(); context.reportDiagnostic?.({ code: error.code || 'ui_unavailable', message: error.message }); }
        }
        // Importing Native's lazy modules and invoking their initializers before
        // its own router commits can mutate partially initialized registries.
        // Observe the existing tree first; never bootstrap the host for it.
        const host = locateHost();
        if (host.auxiliary) {
          navigation = createNavigation(context, null, host);
          break;
        }
        native ??= await load();
        if (!alive) break;
        // The document/tree may have changed while the imports were pending.
        navigation = createNavigation(context, native, locateHost(), load !== loadNative);
        break;
      } catch (error) {
        if (error.code !== 'ui_host_pending') throw error;
        // Cold startup may need substantially longer than one RPC deadline.
        // Back off while the document lives; accepted leases mount when ready.
        await new Promise(resolve => { const timer = setTimeout(resolve, delay); cancelWait = () => { clearTimeout(timer); resolve(); }; });
        cancelWait = null; delay = Math.min(1000, delay * 2);
      }
    }
    if (!alive) throw fail('ui_retired', 'The UI adapter retired during initialization');
    for (const entry of pending.values()) {
      if (!entry.lease.isConnected) continue;
      try {
        const result = navigation.register(entry.args, { caller: entry.caller });
        if (result.available === false) entry.lease.remove();
      } catch (error) {
        entry.lease.remove();
        context.reportDiagnostic?.({ code: error.code || 'ui_unavailable', message: error.message });
      }
    }
    pending.clear();
    for (const entry of pendingComposer.values()) {
      if (!entry.lease.isConnected) continue;
      try {
        const result = navigation.registerComposer(entry.args, { caller: entry.caller });
        if (result.available === false) entry.lease.remove();
      } catch (error) {
        entry.lease.remove();
        context.reportDiagnostic?.({ code: error.code || 'ui_unavailable', message: error.message });
      }
    }
    pendingComposer.clear();
    return navigation;
  })();
  ready.catch(error => {
    failure = error;
    for (const entry of pending.values()) entry.lease.remove();
    pending.clear();
    for (const entry of pendingComposer.values()) entry.lease.remove();
    pendingComposer.clear();
    if (alive) context.reportDiagnostic?.({ code: error.code || 'ui_unavailable', message: error.message });
  });
  return {
    ready,
    native: () => ready.then(() => native),
    register(args, invocation) {
      if (!alive || invocation?.signal?.aborted) throw fail('ui_retired', 'The page registration retired');
      if (failure) throw failure;
      if (navigation) return navigation.register(args, invocation);
      const { caller, lease } = pageOwner(args, invocation);
      for (const [id, entry] of pending) if (!entry.lease.isConnected) pending.delete(id);
      if (!pending.has(caller.pluginId) && pending.size >= 64) throw fail('resource_limit', 'Too many pending native pages');
      const previous = pending.get(caller.pluginId);
      if (previous && previous.lease !== lease) previous.lease.remove();
      pending.set(caller.pluginId, { args: { ...args }, caller: { ...caller }, lease });
      return { api: 1, token: args.token, path: '/codlet/' + encodeURIComponent(caller.pluginId), pending: true };
    },
    newTaskDraft(args, invocation) {
      if (!alive) throw fail('ui_retired', 'The page provider retired');
      if (failure) throw failure;
      if (!navigation) throw fail('ui_host_pending', 'The native page is not ready');
      return navigation.newTaskDraft(args, invocation);
    },
    registerComposer(args, invocation) {
      if (!alive || invocation?.signal?.aborted) throw fail('ui_retired', 'The composer provider retired');
      const actions = composer();
      if (actions) return actions.register(args, invocation);
      if (failure) throw failure;
      if (navigation) return navigation.registerComposer(args, invocation);
      const { caller, lease } = composerLease(args, invocation);
      for (const [id, entry] of pendingComposer) if (!entry.lease.isConnected) pendingComposer.delete(id);
      const id = `${caller.pluginId}\0${args.token}`;
      if (!pendingComposer.has(id) && pendingComposer.size >= 64) throw fail('resource_limit', 'Too many pending composer actions');
      const previous = pendingComposer.get(id);
      if (previous && previous.lease !== lease) previous.lease.remove();
      pendingComposer.set(id, { args: { ...args }, caller: { ...caller }, lease });
      return { api: 1, token: args.token, available: true, pending: true, mounted: 0 };
    },
    unregisterComposer(args, invocation) {
      if (!alive) throw fail('ui_retired', 'The composer provider retired');
      const actions = composer();
      if (actions) return actions.unregister(args, invocation);
      if (navigation) return navigation.unregisterComposer(args, invocation);
      const caller = invocation?.caller;
      if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation) ||
          typeof args?.token !== 'string') throw fail('invalid_argument', 'Invalid composer action removal');
      const id = `${caller.pluginId}\0${args.token}`, entry = pendingComposer.get(id);
      if (!entry || entry.caller.generation !== caller.generation) return { removed: false };
      pendingComposer.delete(id); return { removed: true };
    },
    statusComposer(args, invocation) {
      if (!alive) throw fail('ui_retired', 'The composer provider retired');
      const actions = composer();
      if (actions) return actions.status(args, invocation);
      if (navigation) return navigation.statusComposer(args, invocation);
      const caller = invocation?.caller;
      if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation) ||
          typeof args?.token !== 'string') throw fail('invalid_argument', 'Invalid composer action status');
      const entry = pendingComposer.get(`${caller.pluginId}\0${args.token}`);
      return { registered: !!entry && entry.caller.generation === caller.generation, mounted: 0, pending: true };
    },
    dispose() {
      if (!alive) return;
      alive = false; cancelWait?.();
      for (const entry of pending.values()) entry.lease.remove();
      pending.clear(); navigation?.dispose(); independentActions?.dispose();
      for (const entry of pendingComposer.values()) entry.lease.remove();
      pendingComposer.clear();
    },
  };
}
export function deactivate() { current?.dispose(); current = null; }
export async function activate(context) {
  deactivate(); const session = deferredNavigation(context);
  context.rpc.provide(CAPABILITY, 'register', async (args, invocation) => session.register(args, invocation));
  context.rpc.provide(CAPABILITY, 'newTaskDraft', async (args, invocation) => session.newTaskDraft(args, invocation));
  context.rpc.provide(COMPOSER_CAPABILITY, 'register', async (args, invocation) => session.registerComposer(args, invocation));
  context.rpc.provide(COMPOSER_CAPABILITY, 'unregister', async (args, invocation) => session.unregisterComposer(args, invocation));
  context.rpc.provide(COMPOSER_CAPABILITY, 'status', async (args, invocation) => session.statusComposer(args, invocation));
  const workspace = createWorkspace(context, { locate: locateHost, baseNative: session.native });
  current = { dispose() { workspace.dispose(); session.dispose(); } };
  session.ready.then(() => workspace.refresh(), () => {}).catch(() => {});
}
