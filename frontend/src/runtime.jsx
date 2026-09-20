import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { AppsSDKUIProvider } from '@openai/apps-sdk-ui/components/AppsSDKUIProvider';
import { Button, ButtonLink } from '@openai/apps-sdk-ui/components/Button';
import { Input } from '@openai/apps-sdk-ui/components/Input';
import { Textarea } from '@openai/apps-sdk-ui/components/Textarea';
import { Switch } from '@openai/apps-sdk-ui/components/Switch';
import { Checkbox } from '@openai/apps-sdk-ui/components/Checkbox';
import { Popover } from '@openai/apps-sdk-ui/components/Popover';
import { Menu } from '@openai/apps-sdk-ui/components/Menu';
import { EmptyMessage } from '@openai/apps-sdk-ui/components/EmptyMessage';
import { Tooltip } from '@openai/apps-sdk-ui/components/Tooltip';
import { SegmentedControl } from '@openai/apps-sdk-ui/components/SegmentedControl';
import { Select } from '@openai/apps-sdk-ui/components/Select';
import { TextLink } from '@openai/apps-sdk-ui/components/TextLink';
import { LoadingIndicator } from '@openai/apps-sdk-ui/components/Indicator';
import { ArrowLeft, ArrowRotateCw, ArrowUpRight, ChevronDown, Cube, Download, ExclamationMarkCircle, ExternalLink, FolderOpen, InfoCircle, Plus, QuestionMarkCircle, Regenerate, Search, TriangleExclamationErrorWarning, X } from '@openai/apps-sdk-ui/components/Icon';
import { Dialog } from './radix-bridge.jsx';
import { PortalContainer, PortalScope } from './portal-context.jsx';
import { useEscCloseStack } from '@openai/apps-sdk-ui/hooks/useEscCloseStack';
import './official.css';

const components = Object.freeze({ Button, ButtonLink, Input, Textarea, Switch, Checkbox, Popover, Menu, EmptyMessage, Tooltip, SegmentedControl, Select, TextLink, LoadingIndicator, Dialog });
const icons = Object.freeze({ ArrowLeft, ArrowRotateCw, ArrowUpRight, ChevronDown, Cube, Download, ExclamationMarkCircle, ExternalLink, FolderOpen, InfoCircle, Plus, QuestionMarkCircle, Regenerate, Search, TriangleExclamationErrorWarning, X });
const STYLE_ID = 'data-codlet-official-styles';
// Codex semantic colors, resolved outside our scoped SDK defaults. In the
// pinned client the native accent Switch uses chart-blue and thumb-on-accent.
const hostTokens = Object.freeze(Object.fromEntries([
  'color-text','color-text-secondary','color-text-tertiary','color-text-inverse',
  'color-surface','color-surface-elevated','color-border','color-border-primary-outline','color-ring','color-text-warning',
].map(name=>['--'+name,'--'+name]).concat([
  ['--switch-track-color-checked','--color-chart-blue'],
  ['--switch-thumb-color','--color-control-thumb-on-accent'],
  ['--color-page-search','--color-background-page-search'],
  ['--codlet-content-width','--thread-content-max-width'],
  ['--codlet-panel-padding','--padding-panel'],
])));
let sharedStyle, owners = 0;
// Replaced with scoped, compiled upstream CSS by the reproducible build.
const stylesheet = '__CODLET_OFFICIAL_CSS__';
const themeOf = () => {
  const root = document.documentElement, style = getComputedStyle(root);
  return root.getAttribute('data-theme') === 'dark' || root.classList.contains('dark') || style.colorScheme === 'dark' ? 'dark' : 'light';
};
function cleanAll(actions) {
  const errors=[];
  for(const action of actions)try{action();}catch(error){errors.push(...(error instanceof AggregateError?error.errors:[error]));}
  return errors;
}
function throwCleanup(errors) {
  if(errors.length===1)throw errors[0];
  if(errors.length)throw new AggregateError(errors,'UI cleanup failed: '+errors.map(error=>String(error?.message??error)).join('; '));
}
export default function createUI(context) {
  const abort = new AbortController(), roots = new Map(), containers = new Set(), pages = new Set();
  let disposed = false;
  const unregister = context.onDeactivate(dispose);
  const assertLive = () => { if (disposed) throw Object.assign(new Error('UI owner has retired'), { code: 'ui_disposed' }); };
  const reportCleanup = error => {
    try { context.reportDiagnostic?.({code:'ui_cleanup_failed',message:String(error?.message??error).slice(0,3000)}); }
    catch { console.error(error); }
  };
  if (!owners++) {
    sharedStyle = document.createElement('style'); sharedStyle.setAttribute(STYLE_ID, '0.2.2');
    sharedStyle.textContent = stylesheet; document.head?.appendChild(sharedStyle);
  }
  const syncTheme = () => {
    if (!document.documentElement) return;
    const theme = themeOf(), native = getComputedStyle(document.body??document.documentElement);
    for (const node of containers) {
      node.dataset.theme = theme;
      node.lang = context.i18n?.locale === 'zh' ? 'zh' : 'en';
      node.dir = document.documentElement.dir || 'ltr';
      node.style.fontFamily = native.fontFamily;
      node.style.colorScheme = theme;
      for(const [target,source] of Object.entries(hostTokens)) {
        const value=native.getPropertyValue(source).trim();
        if(value)node.style.setProperty(target,value);else node.style.removeProperty(target);
      }
      // The SDK's dark disabled-on default is blue. Keep disabled controls in
      // the host accent family as well, using the public component token.
      if(node.style.getPropertyValue('--switch-track-color-checked'))node.style.setProperty('--switch-track-color-checked-disabled','color-mix(in srgb, var(--switch-track-color-checked) 40%, var(--color-surface))');
      else node.style.removeProperty('--switch-track-color-checked-disabled');
    }
  };
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement ?? document, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'dir'] });
  if(document.body)themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','data-theme','style']});
  if(document.head)themeObserver.observe(document.head,{childList:true,subtree:true,characterData:true});
  const stopLocale = context.i18n?.onChange?.(syncTheme);
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', syncTheme);
  function container(parent = document.body) {
    assertLive();
    if (!(parent instanceof Element)) throw new Error('A DOM mount parent is required');
    if (!sharedStyle.isConnected) document.head.appendChild(sharedStyle);
    const node = document.createElement('div');
    node.setAttribute('data-codlet-official-ui', context.pluginId); node.setAttribute('data-codlet-generation', String(context.generation));
    containers.add(node); parent.appendChild(node); syncTheme(); return node;
  }
  function mount(node, content, overlay = node, scope = node) {
    assertLive();
    if (!containers.has(node)) throw new Error('UI mount must belong to this plugin');
    if (roots.has(node)) throw new Error('This UI container already has a React root');
    let live = true, unmounting = false;
    const reactErrors=[];
    const root = createRoot(node,{onUncaughtError(error){if(unmounting)reactErrors.push(error);else reportCleanup(error);}});
    const handle=Object.freeze({ render(next) { assertLive(); if (!live) throw new Error('UI mount retired'); flushSync(() => root.render(<AppsSDKUIProvider><PortalScope value={scope}><PortalContainer value={overlay}>{next}</PortalContainer></PortalScope></AppsSDKUIProvider>)); },
      unmount() {
        if (!live) return; live = false; unmounting = true;
        // React 19 reports effect/WillUnmount errors through onUncaughtError.
        // A direct unmount throw must also retire our references and owned DOM.
        const errors=cleanAll([()=>flushSync(()=>root.unmount()),()=>node.replaceChildren()]);
        roots.delete(node); unmounting=false;
        throwCleanup([...errors,...reactErrors.splice(0)]);
      } });
    roots.set(node,handle);
    try { handle.render(content); } catch(error) { throwCleanup([error,...cleanAll([()=>handle.unmount()])]); }
    return handle;
  }
  async function page({ label, icon = 'Cube', toolbar = false, render, onActivate, onDeactivate }) {
    assertLive();
    if (typeof render !== 'function') throw new Error('A page render function is required');
    if (typeof toolbar !== 'boolean') throw new Error('Toolbar must be a boolean');
    if (!document.body || !document.head) await new Promise((resolve, reject) => {
      const done = () => { document.removeEventListener('DOMContentLoaded', ready); abort.signal.removeEventListener('abort', cancelled); };
      const ready = () => { done(); resolve(); };
      const cancelled = () => { done(); reject(new Error('Page owner retired before document readiness')); };
      document.addEventListener('DOMContentLoaded', ready, { once: true }); abort.signal.addEventListener('abort', cancelled, { once: true });
    });
    assertLive();
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'dir'] });
    themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','data-theme','style']});
    themeObserver.observe(document.head,{childList:true,subtree:true,characterData:true});
    const token = crypto.randomUUID(), lease = document.createElement('span'), node = container();
    const toolbarNode = toolbar ? container() : null;
    const overlayNode = container();
    overlayNode.dataset.codletPageOverlays = token;
    overlayNode.style.display = 'contents';
    overlayNode.remove();
    const scope = {contains:target=>node.contains(target)||!!toolbarNode?.contains(target)||overlayNode.contains(target)};
    if(toolbarNode){toolbarNode.remove();toolbarNode.style.width='100%';toolbarNode.style.minWidth='0';}
    node.remove(); node.style.height = '100%'; node.style.minHeight = '0'; node.style.minWidth = '0';
    lease.hidden = true; lease.dataset.codletPageLease = token; lease.dataset.codletPageOwner = context.pluginId;
    lease.dataset.codletGeneration = String(context.generation); document.body.appendChild(lease);
    let live = true, mounted = null, host = null, observer;
    const detach = () => {
      const oldMount=mounted, oldHost=host; mounted=null; host=null;
      return cleanAll([()=>oldMount?.unmount(),()=>{if(oldHost)onDeactivate?.();},()=>node.remove(),()=>toolbarNode?.remove(),()=>overlayNode.remove()]);
    };
    const stop = () => {
      if (!live) return; live = false;
      const errors=cleanAll([()=>observer?.disconnect()]);
      errors.push(...detach(),...cleanAll([()=>lease.remove()]));
      containers.delete(node); containers.delete(overlayNode); if(toolbarNode)containers.delete(toolbarNode); pages.delete(stop);
      throwCleanup(errors);
    };
    pages.add(stop);
    try {
      const reply = await context.rpc.request({ name: 'codex.ui.navigation.page', api: 1, scope: 'target' }, 'register', { label, icon, token, ...(toolbar?{toolbar:true}:{}) });
      if (!live || disposed) { stop(); throw new Error('Page owner retired'); }
      if (reply?.api !== 1 || reply.token !== token) throw new Error('Invalid native page registration');
      if(reply.available===false&&reply.path===null){stop();return Object.freeze({path:null,dispose:stop});}
      if(typeof reply.path!=='string'||reply.available===false)throw new Error('Invalid native page registration');
      const reconcile = () => {
        if (!live) return;
        // Deferred native registration can be declined by an auxiliary window
        // or retired before the official shell becomes ready.
        if (!lease.isConnected) { stop(); return; }
        const next = [...document.querySelectorAll('[data-codlet-page-host]')].find(element => element.dataset.codletPageHost === token) ?? null;
        if (next !== host) {
          const errors=detach();
          if(errors.length){errors.push(...cleanAll([stop]));throwCleanup(errors);}
          if(!live||disposed)return;
          host = next;
          if (host) { host.appendChild(node); document.body.appendChild(overlayNode); onActivate?.(); mounted = mount(node, render({toolbar:toolbarNode}), overlayNode, scope); }
        }
        if(toolbarNode){
          const target=host&&[...document.querySelectorAll('[data-codlet-page-toolbar]')].find(element=>element.dataset.codletPageToolbar===token);
          if(target){if(toolbarNode.parentElement!==target)target.appendChild(toolbarNode);}
          else toolbarNode.remove();
        }
      };
      observer = new MutationObserver(records => {
        if (!records.some(record => !scope.contains(record.target)))return;
        try { reconcile(); } catch(error) {
          const errors=[error,...cleanAll([stop])];
          try{throwCleanup(errors);}catch(failure){reportCleanup(failure);}
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true }); reconcile();
      return Object.freeze({ path: reply.path, dispose: stop });
    } catch (error) { throwCleanup([error,...cleanAll([stop])]); }
  }
  function dispose() {
    if (disposed) return;
    const focused = document.activeElement, heldFocus = [...containers].some(node => node.contains(focused));
    disposed = true;
    const errors=cleanAll([()=>abort.abort(),()=>themeObserver.disconnect(),()=>stopLocale?.(),()=>media.removeEventListener('change',syncTheme)]);
    errors.push(...cleanAll([...pages])); pages.clear();
    errors.push(...cleanAll([...roots.values()].map(root=>()=>root.unmount()))); roots.clear();
    errors.push(...cleanAll([...containers].map(node=>()=>node.remove()))); containers.clear();
    if (!--owners) { const style=sharedStyle; sharedStyle=null; errors.push(...cleanAll([()=>style?.remove()])); }
    errors.push(...cleanAll([unregister,()=>{if(heldFocus&&focusReturn?.isConnected)focusReturn.focus({preventScroll:true});}]));
    throwCleanup(errors);
  }
  const focusReturn = document.activeElement;
  return Object.freeze({ api: 2, React, components, icons, PortalContainer, useEscCloseStack, createPortal, flushSync, container, mount, page, signal: abort.signal, dispose });
}
