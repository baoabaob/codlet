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
import registerPage from './page.js';
import { releaseDocumentEvents } from './react-document-events.js';

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
  let themeSignature;
  const syncTheme = (target) => {
    if(!containers.size||![...containers].some(node=>node.hasAttribute('data-codlet-official-ui')))return;
    if (!document.documentElement) return;
    const theme = themeOf(), native = getComputedStyle(document.body??document.documentElement);
    const lang=context.i18n?.locale === 'zh' ? 'zh' : 'en', dir=document.documentElement.dir || 'ltr';
    const values=Object.entries(hostTokens).map(([name,source])=>[name,native.getPropertyValue(source).trim()]);
    const signature=JSON.stringify([theme,lang,dir,native.fontFamily,values]);
    if(!(target instanceof Element)&&signature===themeSignature)return;
    // Targeted creation may observe a transient host theme before the observer
    // runs. Invalidate the full-pass cache so that node also gets reconciled if
    // the host returns to its previous theme in the same task.
    themeSignature=target instanceof Element?undefined:signature;
    for (const node of target instanceof Element?[target]:containers) {
      if (!node.hasAttribute('data-codlet-official-ui')) continue;
      if(node.dataset.theme!==theme)node.dataset.theme = theme;
      if(node.lang!==lang)node.lang=lang;
      if(node.dir!==dir)node.dir=dir;
      if(node.style.fontFamily!==native.fontFamily)node.style.fontFamily = native.fontFamily;
      if(node.style.colorScheme!==theme)node.style.colorScheme = theme;
      for(const [target,value] of values) {
        if(node.style.getPropertyValue(target)!==value){if(value)node.style.setProperty(target,value);else node.style.removeProperty(target);}
      }
      // The SDK's dark disabled-on default is blue. Keep disabled controls in
      // the host accent family as well, using the public component token.
      const disabled=node.style.getPropertyValue('--switch-track-color-checked')?'color-mix(in srgb, var(--switch-track-color-checked) 40%, var(--color-surface))':'';
      if(node.style.getPropertyValue('--switch-track-color-checked-disabled')!==disabled){if(disabled)node.style.setProperty('--switch-track-color-checked-disabled',disabled);else node.style.removeProperty('--switch-track-color-checked-disabled');}
    }
  };
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement ?? document, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'dir'] });
  if(document.body)themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','data-theme','style']});
  if(document.head)themeObserver.observe(document.head,{childList:true,subtree:true,characterData:true});
  const stopLocale = context.i18n?.onChange?.(syncTheme);
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', syncTheme);
  function container(parent = document.body, {styled = true} = {}) {
    assertLive();
    if (!(parent instanceof Element)) throw new Error('A DOM mount parent is required');
    if (!sharedStyle.isConnected) document.head.appendChild(sharedStyle);
    const node = document.createElement('div');
    node.setAttribute(styled?'data-codlet-official-ui':'data-codlet-react-ui', context.pluginId); node.setAttribute('data-codlet-generation', String(context.generation));
    containers.add(node); parent.appendChild(node); if(styled)syncTheme(node); return node;
  }
  function mount(node, content, overlay = node, scope = node, options = {sync:true}) {
    assertLive();
    if (!containers.has(node)) throw new Error('UI mount must belong to this plugin');
    if (roots.has(node)) throw new Error('This UI container already has a React root');
    let live = true, unmounting = false;
    const reactErrors=[];
    const root = createRoot(node,{onUncaughtError(error){if(unmounting)reactErrors.push(error);else reportCleanup(error);}});
    let revision=0;
    function Commit({children, version}) {
      React.useLayoutEffect(()=>{if(live)options.onCommit?.(version);},[version]);
      return children;
    }
    const handle=Object.freeze({ render(next, {sync=options.sync} = {}) { assertLive(); if (!live) throw new Error('UI mount retired'); const version=++revision;
      const content=options.onCommit?<Commit version={version}>{next}</Commit>:next;
      const render=()=>root.render(<AppsSDKUIProvider><PortalScope value={scope}><PortalContainer value={overlay}>{content}</PortalContainer></PortalScope></AppsSDKUIProvider>);
      if(sync)flushSync(render);else render(); return version; },
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
  function mountReact(node, content, options = {}) {
    return mount(node,content,options.overlay??node,options.scope??node,{...options,sync:options.sync??false});
  }
  function removeContainer(node) {
    if(!containers.has(node))return;
    const errors=cleanAll([()=>roots.get(node)?.unmount(),()=>node.remove()]);
    containers.delete(node);throwCleanup(errors);
  }
  async function page(options) {
    assertLive();
    const handle = await registerPage(context, options, () => {assertLive();return createUI(context);}, stop=>pages.delete(stop), stop=>pages.add(stop));
    if(disposed){handle.dispose();throw new Error('Page owner retired');}
    return handle;
  }
  function dispose() {
    if (disposed) return;
    const focused = document.activeElement, heldFocus = [...containers].some(node => node.contains(focused));
    disposed = true;
    const errors=cleanAll([()=>abort.abort(),()=>themeObserver.disconnect(),()=>stopLocale?.(),()=>media.removeEventListener('change',syncTheme)]);
    errors.push(...cleanAll([...pages])); pages.clear();
    errors.push(...cleanAll([...roots.values()].map(root=>()=>root.unmount()))); roots.clear();
    errors.push(...cleanAll([...containers].map(node=>()=>node.remove()))); containers.clear();
    if (!--owners) { const style=sharedStyle; sharedStyle=null; errors.push(...cleanAll([()=>style?.remove(),releaseDocumentEvents])); }
    errors.push(...cleanAll([unregister,()=>{if(heldFocus&&focusReturn?.isConnected)focusReturn.focus({preventScroll:true});}]));
    throwCleanup(errors);
  }
  const focusReturn = document.activeElement;
  return Object.freeze({ api: 2, React, components, icons, PortalContainer, useEscCloseStack, createPortal, flushSync, container, removeContainer, mount, mountReact, page, signal: abort.signal, dispose });
}
