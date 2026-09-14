import { Cube, CodeSquareSlash } from '@openai/apps-sdk-ui/components/Icon';

// Host internals belong only to this optional adapter. Never run these imports
// outside the reviewed Desktop build, or create another app-host connection.
export const PROFILE = Object.freeze({
  version: '26.908.40834', build: '8881', entry: 'app://-/assets/index-cbd874f72008.js',
  react: 'app://-/assets/react-d6ffadc57208.js', dom: 'app://-/assets/react-dom-2c70d35283e7.js',
  client: 'app://-/assets/client-d8dffccad60c.js', primary: 'app://-/assets/app-primary-17b54400f32a.js',
});
export const CAPABILITY = Object.freeze({ name: 'codex.ui.navigation.page', api: 1, scope: 'target' });
const fail = (code, message) => Object.assign(new Error(message), { code });
const icons = { Cube, CodeSquareSlash };
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
    if (child?.props?.element === undefined && Array.isArray(child?.props?.children) &&
        child.props.children.some(route => route?.props?.path === '/avatar-overlay')) trees.add(child);
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

export function createNavigation(context, native, host) {
  const { React, DOM, Client, SidebarItem } = native;
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
  function register(args, invocation) {
    check();
    const caller = invocation?.caller;
    if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation)) throw fail('invalid_owner', 'Page registration requires a Core-authenticated caller');
    if (!args || Object.keys(args).some(key => !['label', 'icon', 'token'].includes(key)) ||
        typeof args.label !== 'string' || !args.label.trim() || args.label.length > 64 || !Object.hasOwn(icons, args.icon) ||
        typeof args.token !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(args.token)) throw fail('invalid_argument', 'Invalid page registration');
    const lease = [...document.querySelectorAll('[data-codlet-page-lease]')].find(node => node.dataset.codletPageLease === args.token);
    if (!lease || lease.dataset.codletPageOwner !== caller.pluginId || lease.dataset.codletGeneration !== String(caller.generation))
      throw fail('invalid_owner', 'The page lifetime does not match its caller');
    // The Desktop pet is a reviewed auxiliary route, not a page surface.
    // Tell the public helper to release its pending DOM without an error.
    if(host.auxiliary)return {api:1,token:args.token,path:null,available:false};
    const existing = entries.get(caller.pluginId);
    if (existing) {
      if (existing.token === args.token && existing.lease === lease) return existing.description;
      retire(existing);
    }
    const entry = { owner: caller.pluginId, token: args.token, lease, label: args.label, icon: args.icon,
      path: '/codlet/' + encodeURIComponent(caller.pluginId), active: false, previous: null };
    entry.description = { api: 1, token: entry.token, path: entry.path };
    entry.route = h(host.Route, { id: 'codlet:' + caller.pluginId, path: entry.path + '/*',
      element: h('div', { 'data-codlet-page-host': entry.token, className: 'h-full min-h-0 min-w-0 flex flex-col',
        ref: node => { entry.active = !!node; queueMicrotask(renderNav); } }) });
    host.routes.push(entry.route); entries.set(entry.owner, entry); reconcile(); renderNav();
    return entry.description;
  }
  return { register, dispose() {
    if (!alive) return;
    observer.disconnect();
    for (const entry of [...entries.values()]) retire(entry);
    alive = false;
    if (navRoot) DOM.flushSync(() => navRoot.unmount());
    navContainer?.remove();
  } };
}

async function loadNative() {
  const build = globalThis.electronBridge?.getSentryInitOptions?.();
  if (location.origin !== 'app://-' || location.pathname !== '/index.html' || build?.appVersion !== PROFILE.version || String(build?.buildNumber) !== PROFILE.build)
    throw fail('ui_build_drift', 'No reviewed sidebar/page profile for this Desktop build');
  if (![...document.scripts].some(script => script.src === PROFILE.entry)) throw fail('ui_host_pending', 'Waiting for the Desktop entry');
  const [react, dom, client, primary] = await Promise.all([import(PROFILE.react), import(PROFILE.dom), import(PROFILE.client), import(PROFILE.primary)]);
  const native = { React: react.t(), DOM: dom.t(), Client: client.t(), SidebarItem: primary.ov };
  if (typeof native.React.createElement !== 'function' || typeof native.Client.createRoot !== 'function' || typeof native.SidebarItem !== 'function')
    throw fail('ui_build_drift', 'The reviewed native UI exports changed');
  return native;
}

export function deactivate() {
  const session = current; current = null;
  session?.cancel?.(); session?.navigation?.dispose();
}
export async function activate(context) {
  deactivate(); const session = {}; current = session;
  const deadline = Date.now() + 12000;
  session.ready = (async () => {
    let native;
    while (current === session) {
      try { native ??= await loadNative(); if (current !== session) break; session.navigation = createNavigation(context, native, locateHost()); return session.navigation; }
      catch (error) {
        if (error.code !== 'ui_host_pending' || Date.now() >= deadline) throw error;
        await new Promise(resolve => { const timer = setTimeout(resolve, 50); session.cancel = () => { clearTimeout(timer); resolve(); }; });
      }
    }
    throw fail('ui_retired', 'The UI adapter retired during initialization');
  })();
  session.ready.catch(error => { if (current === session) context.reportDiagnostic?.({ code: error.code || 'ui_unavailable', message: error.message }); });
  context.rpc.provide(CAPABILITY, 'register', async (args, invocation) => {
    const navigation = await session.ready;
    if (current !== session || invocation.signal?.aborted) throw fail('ui_retired', 'The page registration retired');
    return navigation.register(args, invocation);
  });
}
