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
function tooltipContentProp(source) {
  if (source.includes('tooltipContent') && source.includes('delayDuration')) return 'tooltipContent';
  if (['renderTooltip', 'contentClassName', 'enabledWhen', 'forceOpen', 'delayDuration', 'disableHoverableContent'].every(marker => source.includes(marker))) return 'content';
  return null;
}
function adaptRailTooltip(React, Tooltip) {
  if (tooltipContentProp(componentSource(Tooltip)) === 'tooltipContent') return Tooltip;
  return function NativeRailTooltip({ tooltipContent, delayDuration, cloneCustomTrigger, closeOnTriggerClick, variant, ...props }) {
    return React.createElement(Tooltip, { ...props, content: tooltipContent, ...(delayDuration == null ? {} : { openDelay: delayDuration }) });
  };
}
function railComponents(modules) {
  const rails = document.querySelectorAll('nav[data-app-navigation-rail="true"]');
  if (!rails.length) throw fail('ui_host_pending', 'Waiting for the native navigation rail');
  if (rails.length !== 1) throw fail('ui_host_drift', 'Native navigation rail is ambiguous');
  const homes = rails[0].querySelectorAll('[data-sidebar-destination="builtin:home"]');
  if (homes.length !== 1) throw fail('ui_host_pending', 'Waiting for the native Home destination');
  const chain = ancestors(homes[0]);
  const exports = new Set(modules.flatMap(module => Object.values(module)));
  const one = (predicate, role) => {
    const found = [...new Set(chain.filter(f => component(f.type) && exports.has(f.type) && predicate(f.memoizedProps ?? {}, componentSource(f.type))).map(f => f.type))];
    if (found.length !== 1) throw fail('ui_host_drift', `A unique mounted native ${role} is required (found ${found.length})`);
    return found[0];
  };
  return {
    RailButton: one((props, source) => props.uniform === true && props.iconSize && props['data-sidebar-destination'] === 'builtin:home' && source.includes('data-selected') && source.includes('data-uniform'), 'rail button'),
    RailTooltip: one((props, source) => { const content = tooltipContentProp(source); return content !== null && props[content] != null && props.side === 'right'; }, 'rail tooltip'),
    SidebarGroup: one((props, source) => props.itemSpacing === 'rail' && source.includes('group/nav-list'), 'sidebar group'),
  };
}
export function newTaskHook(initial) {
  const values = [...new Set(Object.values(initial))];
  const actions = values.filter(fn => {
    if (typeof fn !== 'function') return false;
    const source = componentSource(fn);
    return ['startInSidebar', 'focusComposerNonce', 'codexAppMode'].every(marker => source.includes(marker)) &&
      (source.includes('prefillAeonStartTarget') || ['freshDraft', 'prefillComposerMode', 'prepareNavigation'].every(marker => source.includes(marker)));
  });
  if (actions.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(actions[0].name)) return undefined;
  const actionCall = new RegExp('\\b' + actions[0].name.replace(/\$/g, '\\$') + '\\(');
  const hooks = values.filter(fn => typeof fn === 'function' && fn.length === 0 && actionCall.test(componentSource(fn)) && componentSource(fn).includes('useContext'));
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
  const [sharedSource, initialSource] = await Promise.all([read(sharedUrl), read(initialUrl)]);
  const primaryUrls = [...new Set([...initialSource.matchAll(/["'`]((?:\.\/)?app-primary-[A-Za-z0-9_-]+\.js)["'`]/g)].map(match => new URL(match[1], initialUrl).href))];
  if (primaryUrls.length > 1) throw fail('ui_host_drift', 'The native primary module is ambiguous');
  const modules = [shared, initial, ...await Promise.all(primaryUrls.map(load))];
  // Require mounted native components before calling even the React factories.
  const rail = railComponents(modules);
  const names = reactFactories(sharedSource);
  for (const name of Object.values(names)) if (typeof shared[name] !== 'function') throw fail('ui_react_drift', 'Native React factory export changed');
  const React = shared[names.react](), DOM = shared[names.dom](), Client = shared[names.client]();
  if (typeof React?.createElement !== 'function' || typeof React?.useState !== 'function' || typeof DOM?.flushSync !== 'function' ||
      typeof Client?.createRoot !== 'function' || React.version !== DOM.version)
    throw fail('ui_react_drift', 'Native React and DOM contracts do not match');
  const appExports = modules.slice(1).flatMap(module => Object.values(module));
  const header = uniqueExport(appExports, value => value && component(value.Header) && component(value.HeaderToolbar) && component(value.Root), 'page header', true);
  return { React, DOM, Client, ...rail, RailTooltip: adaptRailTooltip(React, rail.RailTooltip), Header: header?.Header, HeaderToolbar: header?.HeaderToolbar,
    composerActionProfile: COMPOSER_PROFILE, toolbarInset: 'page', newTaskOptions: { codexAppMode: 'codex' },
    useStartNewConversation: newTaskHook(appExports), compatibility: 'structural' };
}
