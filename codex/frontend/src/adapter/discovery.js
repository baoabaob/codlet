import { component, componentSource, desktopDocument, uniqueExport, currentElementAncestry, classicNavigationItem } from '../host-discovery.js';
import {resolveLoadedAsset,captureResolvedAssets} from '../host-assets.js';
import { reactFactories } from './react-factories.js';
import {parseExpressionAt} from 'acorn';

const fail = (code, message) => Object.assign(new Error(message), { code });
export const COMPOSER_PROFILE = Object.freeze({ rootAttribute: 'data-codex-composer-root', scrollAreaAttribute: 'data-composer-utility-bar-scroll-area' });
export function notificationBadge(exports) {
  const matches=[...new Set(exports)].filter(value=>component(value)&&['badgeEnabled','border-surface-secondary absolute right-0','rounded-full'].every(marker=>componentSource(value).includes(marker)));
  return matches.length===1?matches[0]:undefined;
}
export function nativeDownloadGlyph(exports) {
  // This is the glyph used by Native's appHeader.installUpdate control. Resolve
  // its exported SVG data so isolated pages can reuse it without Native objects.
  const matches=[...new Set(exports)].filter(value=>componentSource(value).includes('M2.66831 12.6664V12.5004'));
  if(matches.length!==1)return undefined;
  try{
    const root=parseExpressionAt(componentSource(matches[0]),0,{ecmaVersion:'latest'}),pending=[root],paths=[],boxes=[];
    const literal=value=>value?.type==='Literal'?value.value:value?.type==='TemplateLiteral'&&!value.expressions.length?value.quasis[0].value.cooked:undefined;
    while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;
      if(node.type==='Property'&&!node.computed){const key=node.key.name??literal(node.key),value=literal(node.value);if(key==='d'&&typeof value==='string')paths.push(value);if(key==='viewBox'&&typeof value==='string')boxes.push(value);}
      for(const value of Object.values(node)){if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value);}
    }
    return boxes.length===1&&paths.length?{viewBox:boxes[0],paths}:undefined;
  }catch{return undefined;}
}
function ancestors(element) {
  const chain = currentElementAncestry(element);
  if (!chain) throw fail('ui_host_drift', 'Native navigation is not owned by the current React tree');
  return chain;
}
function tooltipContentProp(source) {
  if (source.includes('tooltipContent') && source.includes('delayDuration')) return 'tooltipContent';
  if (['renderTooltip', 'contentClassName', 'enabledWhen', 'forceOpen', 'delayDuration', 'disableHoverableContent'].every(marker => source.includes(marker))) return 'content';
  return null;
}
const railTooltips = new WeakMap();
function adaptRailTooltip(React, Tooltip) {
  if (tooltipContentProp(componentSource(Tooltip)) === 'tooltipContent') return Tooltip;
  const cache = railTooltips.get(React) ?? new WeakMap();
  railTooltips.set(React, cache);
  if (cache.has(Tooltip)) return cache.get(Tooltip);
  const adapted = function NativeRailTooltip({ tooltipContent, delayDuration, cloneCustomTrigger, closeOnTriggerClick, variant, ...props }) {
    return React.createElement(Tooltip, { ...props, content: tooltipContent, ...(delayDuration == null ? {} : { openDelay: delayDuration }) });
  };
  cache.set(Tooltip, adapted);
  return adapted;
}
function railComponents(modules) {
  const rails = document.querySelectorAll('nav[data-app-navigation-rail="true"]');
  if (!rails.length) throw fail('ui_host_pending', 'Waiting for the native navigation rail');
  if (rails.length !== 1) throw fail('ui_host_drift', 'Native navigation rail is ambiguous');
  const homes = rails[0].querySelectorAll('[data-sidebar-destination="builtin:home"]');
  if (!homes.length) throw fail('ui_host_pending', 'Waiting for the native Home destination');
  if (homes.length !== 1) throw fail('ui_host_drift', 'Native Home destination ownership is ambiguous');
  const chain = ancestors(homes[0]);
  const exports = new Set(modules.flatMap(module => Object.values(module)));
  const one = (predicate, role) => {
    const found = [...new Set(chain.filter(f => component(f.type) && exports.has(f.type) && predicate(f.memoizedProps ?? {}, componentSource(f.type), f)).map(f => f.type))];
    if (found.length !== 1) throw fail('ui_host_drift', `A unique mounted native ${role} is required (found ${found.length})`);
    return found[0];
  };
  return {
    RailButton: one((props, source) => props.uniform === true && props.iconSize && props['data-sidebar-destination'] === 'builtin:home' && source.includes('data-selected') && source.includes('data-uniform'), 'rail button'),
    RailTooltip: one((props, source, fiber) => {
      const content = tooltipContentProp(source);
      if (content === null || props[content] == null) return false;
      // Newer Native rails inherit their side from this exact Tooltip's
      // DefaultsProvider around the nav. Explicit instance props take priority.
      const defaults = component(fiber.type.DefaultsProvider) && chain.slice(chain.indexOf(fiber) + 1).find(owner =>
        owner.type === fiber.type.DefaultsProvider && owner.memoizedProps?.side != null);
      return (props.side ?? defaults?.memoizedProps.side) === 'right';
    }, 'rail tooltip'),
    SidebarGroup: one((props, source) => props.itemSpacing === 'rail' && source.includes('group/nav-list'), 'sidebar group'),
  };
}
function classicComponents(modules) {
  const buttons = [...document.querySelectorAll('nav button.sidebar-item')].filter(button => !button.closest('[data-codlet-native-navigation]'));
  if (!buttons.length) throw fail('ui_host_pending', 'Waiting for native navigation');
  const exports = new Set(modules.flatMap(module => Object.values(module)));
  const items = new Set(), groups = new Set(), navigations = new Set();
  for (const button of buttons) {
    const chain = currentElementAncestry(button);
    if (!chain) continue;
    const matches = chain.filter(fiber => exports.has(fiber.type) && classicNavigationItem(fiber));
    if (matches.length > 1) throw fail('ui_host_drift', 'Native classic navigation row ownership is ambiguous');
    if (!matches.length) continue;
    const item = matches[0];
    // Follow this fixed row's lexical group, outside any drag/drop wrapper.
    // Other task rows and message descendants do not identify navigation.
    const group = chain.slice(chain.indexOf(item) + 1).find(fiber => component(fiber.type) && exports.has(fiber.type) && componentSource(fiber.type).includes('group/nav-list'));
    const parent = group?.child?.stateNode;
    if (!group || group.memoizedProps?.itemSpacing === 'rail' || parent?.nodeType !== 1 || !parent.contains(button))
      throw fail('ui_host_drift', 'The mounted native classic navigation group changed');
    items.add(item.type); groups.add(group.type); navigations.add(button.closest('nav'));
  }
  if (navigations.size > 1) throw fail('ui_host_drift', 'Native classic navigation ownership is ambiguous');
  if (items.size !== 1 || groups.size !== 1) throw fail('ui_host_drift', 'A unique mounted native classic navigation contract is required');
  return { SidebarItem: [...items][0], SidebarGroup: [...groups][0] };
}
export function navigationComponents(modules) {
  if (document.querySelectorAll('nav[data-app-navigation-rail="true"]').length) return railComponents(modules);
  return classicComponents(modules);
}
export function nativeNavigation(React, modules) {
  const navigation = navigationComponents(modules);
  return { ...navigation, ...(navigation.RailTooltip ? { RailTooltip: adaptRailTooltip(React, navigation.RailTooltip) } : {}) };
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
export async function discoverNative({ load = url => import(url), signal, read = async url => {
  const response = await fetch(url, { credentials: 'omit',signal });
  if (!response.ok || response.url !== url) throw fail('ui_asset_unavailable', 'Unable to read the loaded native shared module');
  return response.text();
} } = {}) {
  desktopDocument();
  const [sharedUrl,initialUrl]=await Promise.all(['shared','initial'].map(name=>resolveLoadedAsset(name,{read,signal})));
  const checkAssets=captureResolvedAssets({shared:sharedUrl,initial:initialUrl},{signal});
  const [shared, initial] = await Promise.all([load(sharedUrl), load(initialUrl)]);
  checkAssets();
  const [sharedSource, initialSource] = await Promise.all([read(sharedUrl), read(initialUrl)]);
  checkAssets();
  const primaryUrls = [...new Set([...initialSource.matchAll(/["'`]((?:\.\/)?app-primary-[A-Za-z0-9_-]+\.js)["'`]/g)].map(match => new URL(match[1], initialUrl).href))];
  if (primaryUrls.length > 1) throw fail('ui_host_drift', 'The native primary module is ambiguous');
  const modules = [shared, initial, ...await Promise.all(primaryUrls.map(load))];
  checkAssets();
  // Require mounted native components before calling even the React factories.
  const navigation = navigationComponents(modules);
  const names = reactFactories(sharedSource);
  for (const name of Object.values(names)) if (typeof shared[name] !== 'function') throw fail('ui_react_drift', 'Native React factory export changed');
  const React = shared[names.react](), DOM = shared[names.dom](), Client = shared[names.client]();
  if (typeof React?.createElement !== 'function' || typeof React?.useState !== 'function' || typeof DOM?.flushSync !== 'function' ||
      typeof Client?.createRoot !== 'function' || React.version !== DOM.version)
    throw fail('ui_react_drift', 'Native React and DOM contracts do not match');
  const appExports = modules.slice(1).flatMap(module => Object.values(module));
  const header = uniqueExport(appExports, value => value && component(value.Header) && component(value.HeaderToolbar) && component(value.Root), 'page header', true);
  const resolveNavigation = () => nativeNavigation(React, modules);
  return { React, DOM, Client, ...navigation, resolveNavigation, NotificationBadge: notificationBadge(appExports), ...(navigation.RailTooltip ? { RailTooltip: adaptRailTooltip(React, navigation.RailTooltip) } : {}), Header: header?.Header, HeaderToolbar: header?.HeaderToolbar,
    nativeDownloadGlyph:nativeDownloadGlyph(Object.values(shared)),
    composerActionProfile: COMPOSER_PROFILE, toolbarInset: 'page', newTaskOptions: { codexAppMode: 'codex' },
    useStartNewConversation: newTaskHook(appExports), compatibility: 'structural' };
}
