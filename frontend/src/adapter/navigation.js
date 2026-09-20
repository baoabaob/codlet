import { Cube, CodeSquareSlash } from '@openai/apps-sdk-ui/components/Icon';
import { clientProfile } from '../../../compatibility/client-profiles.js';
import { createCodletIcon } from '../brand.js';

// Host internals belong only to this optional adapter. Never run these imports
// outside the reviewed Desktop build, or create another app-host connection.
export function pageProfile(build) {
  const profile = clientProfile(build);
  if (!profile?.page) throw fail('ui_build_drift', 'No reviewed sidebar/page profile for this Desktop build');
  return profile;
}
export const CAPABILITY = Object.freeze({ name: 'codex.ui.navigation.page', api: 1, scope: 'target' });
const fail = (code, message) => Object.assign(new Error(message), { code });
let current;

export function fibers() {
  const root = document.getElementById('root');
  const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
  const container = key && root[key], pending = [container?.stateNode?.current ?? container], seen = new Set();
  while (pending.length && seen.size < 20000) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    if (fiber.sibling) pending.push(fiber.sibling);
    if (fiber.child) pending.push(fiber.child);
  }
  if (pending.length) throw fail('ui_host_drift', 'The Desktop tree exceeded the reviewed probe boundary');
  return seen;
}

export function locateHost() {
  const navigators = new Set(), trees = new Set();
  for (const fiber of fibers()) {
    for (const value of [fiber.memoizedProps, fiber.memoizedProps?.value]) if (value?.navigator) navigators.add(value.navigator);
    const child = fiber.memoizedProps?.children;
    // Build 9771 wraps the route collection in a Fragment inside the same
    // element-less root Route. Keep the Route identity for appended pages.
    const children = child?.props?.children;
    const routes = children?.type === Symbol.for('react.fragment') ? children.props?.children : children;
    if (child?.props?.element === undefined && child?.type !== Symbol.for('react.fragment') && Array.isArray(routes) &&
        routes.some(route => route?.props?.path === '/avatar-overlay')) trees.add(child);
  }
  if (navigators.size !== 1 || trees.size !== 1) throw fail('ui_host_pending', 'A unique Desktop router and route tree are required');
  const navigator = [...navigators][0], tree = [...trees][0];
  if (typeof navigator.push !== 'function' || typeof navigator.replace !== 'function' ||
      typeof navigator.location?.pathname !== 'string')
    throw fail('ui_host_drift', 'The Desktop memory router is unavailable in this window');
  if(navigator.location.pathname==='/avatar-overlay'||navigator.location.pathname.startsWith('/avatar-overlay/'))
    return {navigator,tree,rootNode:document.getElementById('root'),auxiliary:true};
  const candidates = [];
  const visit = element => {
    if (!element?.props) return;
    const children = element.props.children;
    if (Array.isArray(children)) {
      if (children.some(child => child?.props?.path === '/inbox') && children.some(child => child?.props?.path === '/connector/oauth_callback')) candidates.push(children);
      children.forEach(visit);
    } else visit(children);
  };
  visit(tree);
  if (candidates.length !== 1 || Object.isFrozen(candidates[0]) || !Object.isExtensible(candidates[0]))
    throw fail('ui_host_drift', 'The reviewed authenticated route collection is unavailable');
  return { navigator, routes: candidates[0], Route: tree.type, tree, rootNode: document.getElementById('root') };
}

function nativePlacement(SidebarItem) {
  const candidates = [];
  for (const button of document.querySelectorAll('nav button.sidebar-item')) {
    if (button.closest('[data-codlet-native-navigation]')) continue;
    const key = Object.keys(button).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && button[key];
    for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
      if (fiber.type !== SidebarItem) continue;
      const priority = ['sidebar-tasks', 'sidebar-plugins', 'sidebar-library'].indexOf(fiber.memoizedProps?.animatedIcon);
      if (priority !== -1) candidates.push({ parent: button.parentElement, anchor: button, priority });
      break;
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0] ?? null;
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

export function createNavigation(context, native, host) {
  const { React, DOM, Client, SidebarItem, Header, HeaderToolbar } = native;
  const icons = { Cube, CodeSquareSlash, Codlet: createCodletIcon(React,{compact:true}) };
  const entries = new Map(), h = React.createElement;
  let alive = true, navContainer, navRoot, pending = false;
  const hostLive = () => document.getElementById('root') === host.rootNode && host.rootNode.isConnected;
  const check = () => {
    if (!alive || locateHost().tree !== host.tree || locateHost().navigator !== host.navigator)
      throw fail('ui_host_drift', 'Desktop route ownership changed; reload the UI adapter');
  };
  const renderNav = () => {
    if (!alive || !navRoot) return;
    navRoot.render(h(React.Fragment, null, ...[...entries.values()].map(entry =>
      h(SidebarItem, { key: entry.token, label: entry.label, icon: icons[entry.icon],
        isActive: entry.active, 'aria-label': entry.label, 'data-codlet-navigation-entry': entry.owner,
        onClick: () => { try { check(); if (!entry.active) { entry.previous = { ...host.navigator.location }; host.navigator.push(entry.path); } }
          catch (error) { context.reportDiagnostic?.({ code: error.code, message: error.message }); } } }))));
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
    const placement = nativePlacement(SidebarItem);
    if (!placement || !entries.size) { navContainer?.remove(); return; }
    if (!navContainer) {
      navContainer = document.createElement('div'); navContainer.dataset.codletNativeNavigation = '1';
      navContainer.className = 'flex flex-col gap-px';
      navRoot = Client.createRoot(navContainer); renderNav();
    }
    if (navContainer.parentElement !== placement.parent || navContainer.previousElementSibling !== placement.anchor)
      placement.parent.insertBefore(navContainer, placement.anchor.nextSibling);
  };
  const schedule = records => {
    if (!alive || pending || records.every(record => navContainer?.contains(record.target) || record.target.closest?.('[data-codlet-official-ui]'))) return;
    pending = true; queueMicrotask(() => { pending = false; reconcile(); });
  };
  const observer = new MutationObserver(schedule);
  if(!host.auxiliary)observer.observe(document.documentElement, { childList: true, subtree: true });
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
    entry.compose({prefillPrompt:args.prompt,prefillLocalExecution:true,prefillComposerMode:'local',startInSidebar:true});
    return {opened:true,submitted:false};
  }
  function register(args, invocation) {
    check();
    const { caller, lease } = pageOwner(args, invocation);
    // The Desktop pet is a reviewed auxiliary route, not a page surface.
    // Tell the public helper to release its pending DOM without an error.
    if(host.auxiliary)return {api:1,token:args.token,path:null,available:false};
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
      className: 'h-full min-h-0 min-w-0 flex flex-col',
      ref: node => { entry.active = !!node; queueMicrotask(renderNav); } });
    entry.route = h(host.Route, { id: 'codlet:' + caller.pluginId, path: entry.path + '/*',
      element: h(React.Fragment,null,
        native.useStartNewConversation?h(DraftBridge,{entry}):null,
        args.toolbar ? h(React.Fragment, null,
        h(Header, null, h(HeaderToolbar, { inset: true },
          h('div', { 'data-codlet-page-toolbar': entry.token, className: 'flex w-full min-w-0 items-center' }))),
        content) : content) });
    host.routes.push(entry.route); entries.set(entry.owner, entry); reconcile(); renderNav();
    return entry.description;
  }
  return { register, newTaskDraft, dispose() {
    if (!alive) return;
    observer.disconnect();
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

async function loadNative() {
  const build = globalThis.electronBridge?.getSentryInitOptions?.();
  if (location.origin !== 'app://-' || location.pathname !== '/index.html')
    throw fail('ui_build_drift', 'No reviewed sidebar/page profile for this Desktop build');
  const profile = pageProfile(build), page = profile.page, names = page.exports;
  if (![...document.scripts].some(script => script.src === profile.entry)) throw fail('ui_host_pending', 'Waiting for the Desktop entry');
  const [react, dom, client, primary, initial] = await Promise.all([import(page.react), import(page.dom), import(page.client), import(page.primary), import(profile.module)]);
  const native = { React: react[names.react??'t'](), DOM: dom[names.dom??'t'](), Client: client[names.client??'t'](), SidebarItem: primary[names.sidebar], ...reviewedHeader(initial, names) };
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
  let alive = true, navigation, failure, cancelWait;
  const pending = new Map();
  const ready = (async () => {
    let native, delay = 50;
    while (alive) {
      try {
        native ??= await load();
        if (!alive) break;
        navigation = createNavigation(context, native, locateHost());
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
    return navigation;
  })();
  ready.catch(error => {
    failure = error;
    for (const entry of pending.values()) entry.lease.remove();
    pending.clear();
    if (alive) context.reportDiagnostic?.({ code: error.code || 'ui_unavailable', message: error.message });
  });
  return {
    ready,
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
    dispose() {
      if (!alive) return;
      alive = false; cancelWait?.();
      for (const entry of pending.values()) entry.lease.remove();
      pending.clear(); navigation?.dispose();
    },
  };
}
export function deactivate() { current?.dispose(); current = null; }
export async function activate(context) {
  deactivate(); const session = deferredNavigation(context); current = session;
  context.rpc.provide(CAPABILITY, 'register', async (args, invocation) => session.register(args, invocation));
  context.rpc.provide(CAPABILITY, 'newTaskDraft', async (args, invocation) => session.newTaskDraft(args, invocation));
}
