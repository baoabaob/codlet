import { createWorkspace } from '../../../../frontend/src/adapter/workspace.js';
import { deferredNavigation, locateHost } from '../../../../frontend/src/adapter/navigation.js';
import { createWorkspaceDiscovery, readWorkspaceAsset } from '../../../../frontend/src/adapter/workspace-discovery.js';
import { localConnection } from '../../../../frontend/src/host-discovery.js';
import { createLoadedThreads } from '../../../../frontend/src/desktop/loaded-threads.js';
let workspace, summaries, original, navigation;
export function activate(context) {
  const started = performance.now(), metrics = { assetReads: [] };
  navigation = deferredNavigation(context);
  const base = navigation.native().then(value => { metrics.baseReadyMs = performance.now() - started; return value; }); base.catch(() => {});
  const discovery = createWorkspaceDiscovery(() => base, { read: async (url, signal) => {
    const start = performance.now(), text = await readWorkspaceAsset(url, signal);
    metrics.assetReads.push({ role: url.split('/').at(-1).replace(/-[a-zA-Z0-9_]{8,}\.js$/, ''), ms: performance.now() - start, characters: text.length }); return text;
  } });
  workspace = createWorkspace(context, { locate: locateHost, discovery });
  context.rpc.provide({ name: 'workspace.audit.metadata', api: 1, scope: 'target' }, 'metrics', () => metrics);
  context.rpc.provide({ name: 'workspace.audit.metadata', api: 1, scope: 'target' }, 'loaded', args => {
    summaries ??= createLoadedThreads(localConnection().manager, () => {}, 'audit'); return summaries.read(args);
  });
  context.rpc.provide({ name: 'workspace.audit.metadata', api: 1, scope: 'target' }, 'settings', args => {
    const host = locateHost();
    if (args?.open === true) { original = { ...host.navigator.location }; host.navigator.push('/settings/keyboard-shortcuts'); }
    else if (args?.open === false && original) { host.navigator.replace(original, original.state); original = null; }
    else throw new Error('Invalid acceptance navigation');
    return { changed: true };
  });
}
export function deactivate() {
  if (original) try { const host = locateHost(); if (host.navigator.location.pathname === '/settings/keyboard-shortcuts') host.navigator.replace(original, original.state); } catch {}
  original = null; workspace?.dispose(); navigation?.dispose(); summaries?.dispose(); workspace = summaries = navigation = null;
}
