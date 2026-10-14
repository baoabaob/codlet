import { component, componentSource, desktopDocument, loadedAsset, uniqueExport } from '../host-discovery.js';
import { reactFactories } from './react-factories.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
export const COMPOSER_PROFILE = Object.freeze({ rootAttribute: 'data-codex-composer-root', scrollAreaAttribute: 'data-composer-utility-bar-scroll-area' });
function ancestors(element) {
  const key = element && Object.keys(element).find(key => key.startsWith('__reactFiber$'));
  let fiber = key && element[key];
  const result = [];
  for (let i = 0; fiber && i < 32; i++, fiber = fiber.return) result.push(fiber);
  return result;
}
function railComponents(shared, initial) {
  const rails = document.querySelectorAll('nav[data-app-navigation-rail="true"]');
  if (!rails.length) throw fail('ui_host_pending', 'Waiting for the native navigation rail');
  if (rails.length !== 1) throw fail('ui_host_drift', 'Native navigation rail is ambiguous');
  const homes = rails[0].querySelectorAll('[data-sidebar-destination="builtin:home"]');
  if (homes.length !== 1) throw fail('ui_host_pending', 'Waiting for the native Home destination');
  const chain = ancestors(homes[0]);
  const exports = new Set([...Object.values(shared), ...Object.values(initial)]);
  const one = (predicate, role) => {
    const found = [...new Set(chain.filter(f => component(f.type) && exports.has(f.type) && predicate(f.memoizedProps ?? {}, componentSource(f.type))).map(f => f.type))];
    if (found.length !== 1) throw fail('ui_host_drift', `A unique mounted native ${role} is required (found ${found.length})`);
    return found[0];
  };
  return {
    RailButton: one((props, source) => props.uniform === true && props.iconSize && props['data-sidebar-destination'] === 'builtin:home' && source.includes('data-selected') && source.includes('data-uniform'), 'rail button'),
    RailTooltip: one((props, source) => props.tooltipContent != null && props.side === 'right' && source.includes('tooltipContent') && source.includes('delayDuration'), 'rail tooltip'),
    SidebarGroup: one((props, source) => props.itemSpacing === 'rail' && source.includes('group/nav-list'), 'sidebar group'),
  };
}
export function newTaskHook(initial) {
  const actions = Object.values(initial).filter(fn => typeof fn === 'function' && ['startInSidebar', 'focusComposerNonce', 'prefillAeonStartTarget', 'codexAppMode'].every(marker => componentSource(fn).includes(marker)));
  if (actions.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(actions[0].name)) return undefined;
  const actionCall = new RegExp('\\b' + actions[0].name.replace(/\$/g, '\\$') + '\\(');
  const hooks = Object.values(initial).filter(fn => typeof fn === 'function' && fn.length === 0 && actionCall.test(componentSource(fn)) && componentSource(fn).includes('useContext'));
  return hooks.length === 1 ? hooks[0] : undefined;
}
export async function discoverNative({ load = url => import(url), read = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), credentials: 'omit' });
  if (!response.ok || response.url !== url) throw fail('ui_asset_unavailable', 'Unable to read the loaded native shared module');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw fail('ui_asset_unavailable', 'Native shared module exceeds the source limit'); parts.push(value); }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(bytes);
} } = {}) {
  desktopDocument();
  const sharedUrl = loadedAsset('shared'), initialUrl = loadedAsset('initial');
  const [shared, initial] = await Promise.all([load(sharedUrl), load(initialUrl)]);
  // Require mounted native components before calling even the React factories.
  const rail = railComponents(shared, initial);
  const names = reactFactories(await read(sharedUrl));
  for (const name of Object.values(names)) if (typeof shared[name] !== 'function') throw fail('ui_react_drift', 'Native React factory export changed');
  const React = shared[names.react](), DOM = shared[names.dom](), Client = shared[names.client]();
  if (typeof React?.createElement !== 'function' || typeof React?.useState !== 'function' || typeof DOM?.flushSync !== 'function' ||
      typeof Client?.createRoot !== 'function' || React.version !== DOM.version)
    throw fail('ui_react_drift', 'Native React and DOM contracts do not match');
  const header = uniqueExport(initial, value => value && component(value.Header) && component(value.HeaderToolbar) && component(value.Root), 'page header', true);
  return { React, DOM, Client, ...rail, Header: header?.Header, HeaderToolbar: header?.HeaderToolbar,
    composerActionProfile: COMPOSER_PROFILE, toolbarInset: 'page', newTaskOptions: { codexAppMode: 'codex' },
    useStartNewConversation: newTaskHook(initial), compatibility: 'structural' };
}
