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
import { Tooltip } from '@openai/apps-sdk-ui/components/Tooltip';
import { SegmentedControl } from '@openai/apps-sdk-ui/components/SegmentedControl';
import { Select } from '@openai/apps-sdk-ui/components/Select';
import { TextLink } from '@openai/apps-sdk-ui/components/TextLink';
import { LoadingIndicator } from '@openai/apps-sdk-ui/components/Indicator';
import { ArrowLeft, ArrowRotateCw, Download, ExternalLink, FolderOpen, InfoCircle, Regenerate, Search, X } from '@openai/apps-sdk-ui/components/Icon';
import { PortalContainer } from './portal-context.jsx';
import { useEscCloseStack } from '@openai/apps-sdk-ui/hooks/useEscCloseStack';
import './official.css';

const components = Object.freeze({ Button, ButtonLink, Input, Textarea, Switch, Checkbox, Popover, Tooltip, SegmentedControl, Select, TextLink, LoadingIndicator });
const icons = Object.freeze({ ArrowLeft, ArrowRotateCw, Download, ExternalLink, FolderOpen, InfoCircle, Regenerate, Search, X });
const STYLE_ID = 'data-codlet-official-styles';
let sharedStyle, owners = 0;
// Replaced with scoped, compiled upstream CSS by the reproducible build.
const stylesheet = '__CODLET_OFFICIAL_CSS__';
const themeOf = () => {
  const root = document.documentElement, style = getComputedStyle(root);
  return root.getAttribute('data-theme') === 'dark' || root.classList.contains('dark') || style.colorScheme === 'dark' ? 'dark' : 'light';
};
export default function createUI(context) {
  const abort = new AbortController(), roots = new Map(), containers = new Set(), pages = new Set();
  let disposed = false;
  const unregister = context.onDeactivate(dispose);
  const assertLive = () => { if (disposed) throw Object.assign(new Error('UI owner has retired'), { code: 'ui_disposed' }); };
  if (!owners++) {
    sharedStyle = document.createElement('style'); sharedStyle.setAttribute(STYLE_ID, '0.2.2');
    sharedStyle.textContent = stylesheet; document.head?.appendChild(sharedStyle);
  }
  const syncTheme = () => {
    if (!document.documentElement) return;
    const theme = themeOf(), native = getComputedStyle(document.documentElement);
    for (const node of containers) {
      node.dataset.theme = theme;
      node.lang = context.i18n?.locale === 'zh' ? 'zh' : 'en';
      node.dir = document.documentElement.dir || 'ltr';
      node.style.fontFamily = native.fontFamily;
    }
  };
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement ?? document, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'dir'] });
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
  function mount(node, content) {
    assertLive();
    if (!containers.has(node)) throw new Error('UI mount must belong to this plugin');
    if (roots.has(node)) throw new Error('This UI container already has a React root');
    const root = createRoot(node); roots.set(node, root);
    flushSync(() => root.render(<AppsSDKUIProvider><PortalContainer value={node}>{content}</PortalContainer></AppsSDKUIProvider>));
    let live = true;
    return Object.freeze({ render(next) { assertLive(); if (!live) throw new Error('UI mount retired'); flushSync(() => root.render(<AppsSDKUIProvider><PortalContainer value={node}>{next}</PortalContainer></AppsSDKUIProvider>)); },
      unmount() { if (!live) return; live = false; flushSync(() => root.unmount()); roots.delete(node); } });
  }
  async function page({ label, icon = 'Cube', render, onActivate, onDeactivate }) {
    assertLive();
    if (typeof render !== 'function') throw new Error('A page render function is required');
    if (!document.body || !document.head) await new Promise((resolve, reject) => {
      const done = () => { document.removeEventListener('DOMContentLoaded', ready); abort.signal.removeEventListener('abort', cancelled); };
      const ready = () => { done(); resolve(); };
      const cancelled = () => { done(); reject(new Error('Page owner retired before document readiness')); };
      document.addEventListener('DOMContentLoaded', ready, { once: true }); abort.signal.addEventListener('abort', cancelled, { once: true });
    });
    assertLive();
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'dir'] });
    const token = crypto.randomUUID(), lease = document.createElement('span'), node = container();
    node.remove(); node.style.height = '100%'; node.style.minHeight = '0'; node.style.minWidth = '0';
    lease.hidden = true; lease.dataset.codletPageLease = token; lease.dataset.codletPageOwner = context.pluginId;
    lease.dataset.codletGeneration = String(context.generation); document.body.appendChild(lease);
    let live = true, mounted = null, host = null, observer;
    const stop = () => {
      if (!live) return; live = false; observer?.disconnect();
      mounted?.unmount(); mounted = null;
      if (host) onDeactivate?.(); host = null;
      node.remove(); containers.delete(node); lease.remove(); pages.delete(stop);
    };
    pages.add(stop);
    try {
      const reply = await context.rpc.request({ name: 'codex.ui.navigation.page', api: 1, scope: 'target' }, 'register', { label, icon, token });
      if (!live || disposed) { stop(); throw new Error('Page owner retired'); }
      if (reply?.api !== 1 || reply.token !== token || typeof reply.path !== 'string') throw new Error('Invalid native page registration');
      const reconcile = () => {
        if (!live) return;
        const next = [...document.querySelectorAll('[data-codlet-page-host]')].find(element => element.dataset.codletPageHost === token) ?? null;
        if (next === host) return;
        mounted?.unmount(); mounted = null;
        if (host) onDeactivate?.();
        node.remove(); host = next;
        if (host) { host.appendChild(node); onActivate?.(); mounted = mount(node, render()); }
      };
      observer = new MutationObserver(records => { if (records.some(record => !node.contains(record.target))) reconcile(); });
      observer.observe(document.documentElement, { childList: true, subtree: true }); reconcile();
      return Object.freeze({ path: reply.path, dispose: stop });
    } catch (error) { stop(); throw error; }
  }
  function dispose() {
    if (disposed) return;
    const focused = document.activeElement, heldFocus = [...containers].some(node => node.contains(focused));
    disposed = true; abort.abort(); themeObserver.disconnect(); stopLocale?.(); media.removeEventListener('change', syncTheme);
    // Synchronous unmount runs all official component cleanups before retiring DOM.
    for (const stop of [...pages]) stop();
    for (const root of roots.values()) flushSync(() => root.unmount());
    roots.clear();
    for (const node of containers) node.remove();
    containers.clear();
    if (!--owners) { sharedStyle?.remove(); sharedStyle = null; }
    unregister();
    if (heldFocus && focusReturn?.isConnected) focusReturn.focus({ preventScroll: true });
  }
  const focusReturn = document.activeElement;
  return Object.freeze({ api: 2, React, components, icons, PortalContainer, useEscCloseStack, createPortal, flushSync, container, mount, page, signal: abort.signal, dispose });
}
