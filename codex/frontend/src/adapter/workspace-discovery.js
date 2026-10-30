import { parseExpressionAt } from 'acorn';
import { localConnection, uniqueModuleExport, componentSource } from '../host-discovery.js';
import {resolveLoadedAsset,captureResolvedAssets} from '../host-assets.js';
import { workspaceError } from './workspace-dom.js';
import { createNativeComposerDriver } from './workspace-native-composer.js';
import { createNativeNavigation, navigationSignalExport, nativeNavigationScope } from './workspace-native-navigation.js';
import { createNativeViewportDriver, viewportSignalExports, viewportPersistenceReference } from './workspace-native-viewport.js';
import { keymapSourceExport, clearWorkspaceSourceCache } from './workspace-source.js';
import { WORKSPACE_FUNCTION_ROLES, matchesWorkspaceFunction, workspaceInputProperties } from './workspace-role-contracts.js';
import { memoizeNativeLoad } from './native-readiness.js';

export async function readWorkspaceAsset(url, signal) {
  const response = await fetch(url, { credentials: 'omit', signal });
  if (!response.ok || response.url !== url) throw workspaceError('workspace_host_drift', 'Unable to read the loaded workspace module');
  return response.text();
}
export function assetReferences(source, parent, role) {
  if (!/^[a-z-]+$/.test(role)) throw workspaceError('invalid_argument', 'Invalid native module role');
  const pattern = new RegExp('["\'`]((?:\\./)?' + role + '-[A-Za-z0-9_-]+\\.js)["\'`]', 'g');
  return [...new Set([...source.matchAll(pattern)].map(match => new URL(match[1], parent).href))].filter(url => /^app:\/\/-\/assets\/[A-Za-z0-9_-]+\.js$/.test(url));
}
export async function shortcutSettingsReferences(graph, parent, read, entryUrls = () =>
  Array.from(document.querySelectorAll('script[type="module"][src]'), node => node.src)) {
  const direct = assetReferences(graph, parent, 'keyboard-shortcuts-settings');
  if (direct.length) return direct;
  // New Native builds keep settings dependencies in their lazy route graph.
  // Follow only the current document's entry and its unique main/settings edges;
  // reading these modules does not run their initializers.
  const entries = [...new Set(entryUrls().filter(url => /^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(url)))];
  if (entries.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'A unique loaded Native entry is required');
  const mains = assetReferences(await read(entries[0]), entries[0], 'app-main');
  if (mains.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'A unique Native main settings graph is required');
  const routes = assetReferences(await read(mains[0]), mains[0], 'settings-lazy-routes');
  if (routes.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'A unique Native settings route graph is required');
  return assetReferences(await read(routes[0]), routes[0], 'keyboard-shortcuts-settings');
}
export function keymapExport(_initial, source, options) {
  try { return keymapSourceExport(source, options); }
  catch (error) {
    if (error.code) throw error;
    throw workspaceError('workspace_shortcuts_unavailable', 'Native shortcut source cannot be parsed');
  }
}
const inputProperties = new WeakMap();
function workspaceFunction(native, name, optional = false) {
  const contract = WORKSPACE_FUNCTION_ROLES[name];
  return uniqueModuleExport(native.modules, value => {
    const source = componentSource(value);
    if ((contract.arity != null || contract.variants) && typeof value !== 'function' || !contract.markers.every(marker => source.includes(marker))) return false;
    let properties = [];
    if (contract.inputProperties) {
      if (!inputProperties.has(value)) {
        try { inputProperties.set(value, workspaceInputProperties(parseExpressionAt(source, 0, { ecmaVersion: 'latest' }))); }
        catch { inputProperties.set(value, []); }
      }
      properties = inputProperties.get(value);
    }
    return matchesWorkspaceFunction(source, value?.length, contract, properties);
  }, contract.label, optional);
}

// One cache per provider lifetime; lazy modules never initialize in pet windows.
export function createWorkspaceDiscovery(baseNative, { load = url => import(url), read = readWorkspaceAsset, connect = localConnection } = {}) {
  const controller = new AbortController(), sources = new Map(), modules = new Map(), moduleNamespaces = new Map();
  let connection,assetOwnerCheck;
  const assertOwner=()=>{controller.signal.throwIfAborted();assetOwnerCheck?.();};
  const preparations=new Map();
  const cached=(name,load)=>{assertOwner();if(!preparations.has(name))preparations.set(name,memoizeNativeLoad(load));return preparations.get(name)().then(value=>{assertOwner();return value;});};
  const source = async url => {assertOwner();if(!sources.has(url))sources.set(url,Promise.resolve().then(()=>{assertOwner();return read(url,controller.signal);}));const value=await sources.get(url);assertOwner();return value;};
  const module = url => {
    assertOwner();
    if (!modules.has(url)) modules.set(url, Promise.resolve().then(() => {assertOwner();return load(url);}).then(namespace => {
      assertOwner();
      moduleNamespaces.set(url, namespace); return namespace;
    }));
    return modules.get(url).then(value=>{assertOwner();return value;});
  };
  const existing = () => {
    assertOwner();
    connection ??= connect();
    if (connection.check) return connection.check();
    const { node, chain, managerFamily, clientFamily, manager, client } = connection;
    if (managerFamily.read(node, chain, 'local') !== manager || clientFamily.read(node, chain, 'local') !== client || manager.requestClient !== client)
      throw workspaceError('workspace_host_drift', 'The existing local Desktop connection was replaced');
    return connection;
  };
  const getCommon = () => cached('common',async () => {
    const native = await baseNative();
    const [sharedUrl,initialUrl]=await Promise.all(['shared','initial'].map(name=>resolveLoadedAsset(name,{read:source,signal:controller.signal})));
    const checkAssets=captureResolvedAssets({shared:sharedUrl,initial:initialUrl},{signal:controller.signal});
    assertOwner();assetOwnerCheck??=checkAssets;
    if (!native?.React || !native?.Client) throw workspaceError('workspace_host_pending', 'Native React is not ready');
    const [shared, initial] = await Promise.all([module(sharedUrl), module(initialUrl)]);
    checkAssets();
    return { ...native, shared, initial, sharedUrl, initialUrl, modules: moduleNamespaces };
  });
  const sourceSelection = async (native, select, role) => {
    const candidates = [];
    for (const [url, namespace] of native.modules) {
      const selection = select(await source(url), { optional: true });
      if (selection == null) continue;
      const names = typeof selection === 'string' ? [selection] : Object.values(selection);
      const values = names.map(name => namespace[name]);
      if (values.some(value => value === undefined)) throw workspaceError('workspace_host_pending', `Waiting for Native to initialize ${role}`);
      if (!candidates.some(candidate => candidate.values.length === values.length && candidate.values.every((value, index) => value === values[index]))) candidates.push({ url, namespace, selection, values });
    }
    if (candidates.length !== 1) throw workspaceError('workspace_host_drift', `A unique Native ${role} source is required (found ${candidates.length})`);
    return candidates[0];
  };
  const sourceReference = async (native, select, role) => {
    const candidates = new Map();
    for (const [url] of native.modules) {
      const reference = select(await source(url), { optional: true });
      if (!reference) continue;
      const target = reference.source === null ? url : new URL(reference.source, url).href;
      if (!/^app:\/\/-\/assets\/[A-Za-z0-9_-]+\.js$/.test(target)) throw workspaceError('workspace_host_drift', `Native ${role} module is outside the workspace`);
      const namespace = await module(target), value = namespace[reference.imported];
      if (typeof value !== 'function') throw workspaceError('workspace_host_pending', `Waiting for Native to initialize ${role}`);
      candidates.set(value, { value, url: target, reference });
    }
    if (candidates.size !== 1) throw workspaceError('workspace_host_drift', `A unique Native ${role} source is required (found ${candidates.size})`);
    return candidates.values().next().value;
  };
  const api = {
    connection: existing,
    // Finding a component alone cannot establish live-main draft handoff or
    // persistent cleanup. No archived Native profile has passed those checks.
    // A future reviewed profile can prepare its driver here, before any mount.
    composerCapabilities: async () => ({ rebind: false }),
    viewport: () => cached('viewport',async () => {
      const native = await api.transcript();
      const selected = await sourceSelection(native, viewportSignalExports, 'viewport state');
      const roles = selected.selection;
      const Shell = uniqueModuleExport(native.modules, value => value && typeof value === 'object' &&
        value.RightPanelOutlet && value.DetailPanelOutlet && value.HeaderToolbar && value.MainContentLayout, 'Native viewport namespace');
      const signals = Object.fromEntries(Object.entries(roles).map(([role, key]) => [role, selected.namespace[key]]));
      const writeAtom = (await sourceReference(native, viewportPersistenceReference, 'viewport persistence writer')).value;
      const useScope = workspaceFunction(native, 'scopeFacade');
      return createNativeViewportDriver({ document: globalThis.document, native: { ...native, Shell, writeAtom, useScope, check: existing }, signals });
    }),
    navigation: async () => {
      const native = await getCommon(), connection = existing();
      await connection.ready;controller.signal.throwIfAborted();connection.check?.();
      const composerScope = uniqueModuleExport(native.modules, value => value?.__scopeBrand === 'ComposerScope' && typeof value.id === 'symbol', 'composer scope');
      const ThreadScope = uniqueModuleExport(native.modules, value => value?.__scopeBrand === 'ThreadScope' && typeof value.id === 'symbol', 'thread scope');
      const RouteScope = uniqueModuleExport(native.modules, value => value?.__scopeBrand === 'RouteScope' && typeof value.id === 'symbol', 'route scope');
      const selected = await sourceSelection(native, navigationSignalExport, 'navigation signal');
      const signal = selected.namespace[selected.selection];
      const dispatch = workspaceFunction(native, 'threadNavigation');
      const parts = { manager: connection.manager, composerScope, ThreadScope, RouteScope, inputApi: 1, check: () => existing() };
      // Native's EditorProvider key is the draft namespace, independent of a
      // particular ProseMirror controller. Optional for older navigation hosts.
      parts.draftKey = workspaceFunction(native, 'draftIdentity', true);
      return { ...parts, ...createNativeNavigation(signal, existing, dispatch, () => nativeNavigationScope(existing())) };
    },
    action: async () => { const native=await getCommon(),current=native.resolveNavigation?.()??native;if(!current.RailButton||!current.RailTooltip)throw workspaceError('workspace_action_unavailable','Native toolbar button or tooltip is unavailable');return{...native,...current,Button:current.RailButton,Tooltip:current.RailTooltip}; },
    transcript: () => cached('transcript',async () => {
      const connection=existing();await connection.ready;controller.signal.throwIfAborted();connection.check?.();
      const native = await getCommon(), graph = await source(native.initialUrl), urls = assetReferences(graph, native.initialUrl, 'local-conversation-thread');
      if (!urls.length) throw workspaceError('workspace_transcript_unavailable', 'Native transcript modules are missing');
      const candidates = await Promise.all(urls.map(async url => ({ url, source: await source(url) })));
      const wrappers = candidates.filter(value => value.source.includes('LocalConversationSideChatTab') && !value.source.includes('retainActiveInterest'));
      const implementations = candidates.filter(value => value.source.includes('trackReadState') && value.source.includes('retainActiveInterest'));
      if (wrappers.length !== 1 || implementations.length !== 1) throw workspaceError('workspace_transcript_unavailable', 'The native transcript entry contract changed');
      // The semantic wrapper runs Native's own initializer. Source is never evaluated.
      await module(wrappers[0].url);
      await module(implementations[0].url);
      const Content = workspaceFunction(native, 'transcriptContent');
      const Scope = workspaceFunction(native, 'scopeProvider');
      const composerScope = uniqueModuleExport(native.modules, value => value?.__scopeBrand === 'ComposerScope' && typeof value.id === 'symbol', 'composer scope');
      const composerValue = workspaceFunction(native, 'composerValue');
      const ThreadScope=uniqueModuleExport(native.modules,value=>value?.__scopeBrand==='ThreadScope','thread scope');
      const RouteScope=uniqueModuleExport(native.modules,value=>value?.__scopeBrand==='RouteScope','route scope');
      const routeDescription=workspaceFunction(native,'routeDescription');
      const primaryUrls = assetReferences(graph, native.initialUrl, 'app-primary');
      if (primaryUrls.length !== 1) throw workspaceError('workspace_transcript_unavailable', 'A unique native thread subscription module is required');
      await module(primaryUrls[0]);
      const ThreadSubscription = workspaceFunction(native, 'threadSubscription');
      const manager = existing().manager;
      for (const method of ['getConversation', 'loadBackgroundThreadHistoryPage', 'loadRemainingTurnItems', 'addConversationStateCallback'])
        if (typeof manager[method] !== 'function') throw workspaceError('workspace_transcript_unavailable', `Native transcript manager lacks ${method}`);
      return { ...native, Content, ThreadSubscription, Scope, composerScope, composerValue, manager, ThreadScope, RouteScope, routeDescription };
    }),
    composerParts: () => cached('composerParts',async()=>{
      const native=await api.transcript();
      // Native's thread footer uses these components directly. The outer Frame
      // adds scroll/layout and route work even with hideThreadContent. Finding
      // these parts does not enable rebind without a validated draft driver.
      const Composer=workspaceFunction(native,'composerComponent');
      const ComposerSurface=workspaceFunction(native,'composerSurface');
      const useScope=workspaceFunction(native,'scopeFacade');
      const createEditor=workspaceFunction(native,'editorFactory');
      const parts={...native,Composer,ComposerSurface,useScope,createEditor,check:existing};
      // This factory still rejects without a reviewed Native lifecycle bridge.
      // It is private and does not change composerCapabilities or enable rebind.
      parts.mountDirect=options=>createNativeComposerDriver({...options,native:parts});
      return parts;
    }),
    composer: () => cached('composer',async()=>{
      const native=await api.transcript();
      if(typeof native.manager.getStreamRole!=='function')throw workspaceError('workspace_composer_unavailable','Native stream identity is unavailable');
      const Frame=workspaceFunction(native,'composerFrame');
      return{...native,Frame,check:existing};
    }),
    shortcuts: () => cached('shortcuts',async () => {
      const native = await getCommon(), graph = await source(native.initialUrl), urls = assetReferences(graph, native.initialUrl, 'app-primary');
      const settingsUrls = await shortcutSettingsReferences(graph, native.initialUrl, source);
      if (!settingsUrls.length) throw workspaceError('workspace_shortcuts_unavailable', 'Native shortcut settings entries are unavailable');
      const settings = await Promise.all(settingsUrls.map(async url => ({ url, source: await source(url) })));
      const wrappers = settings.filter(value => value.source.includes('KeyboardShortcutsSettings') && !value.source.includes('settings.keyboardShortcuts.resetAllConfirm'));
      if (wrappers.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'The native shortcut settings entry changed');
      await module(wrappers[0].url);
      if (urls.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'A unique native shortcut control module is required');
      await module(urls[0]);
      const Capture = workspaceFunction(native, 'shortcutCapture');
      const eventAccelerator = workspaceFunction(native, 'eventAccelerator');
      const Row = workspaceFunction(native, 'settingsRow');
      const useCommand = workspaceFunction(native, 'commandHook');
      const dispatchKeyboard = workspaceFunction(native, 'keyboardDispatch');
      const bindings = workspaceFunction(native, 'shortcutBindings');
      const commands = uniqueModuleExport(native.modules, value => Array.isArray(value) && value.some(command => command?.id === 'newTask') && value.some(command => command?.id === 'keyboardShortcuts'), 'command definitions');
      const selected = await sourceSelection(native, (source, options) => keymapExport(null, source, options), 'shortcut state');
      const keymap = selected.namespace[selected.selection], connection = existing();
      if (keymap?.scope !== connection.node.token || typeof keymap.resolve !== 'function' || typeof connection.node.store?.get !== 'function') throw workspaceError('workspace_shortcuts_unavailable', 'Native shortcut keymap ownership or signal contract changed');
      // Current Native's unexported detector uses navigator.platform. Use the
      // actual client identity with explicit unsupported handling, never a fixed
      // Windows argument. macOS derivation is not macOS acceptance evidence.
      const identity = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '';
      const platform = /^(Win|Windows)/.test(identity) ? 'windows' : /^(Mac|macOS)/.test(identity) ? 'macOS' : /^(Linux|linux)/.test(identity) ? 'linux' : null;
      if (!['windows', 'macOS', 'linux'].includes(platform)) throw workspaceError('workspace_shortcuts_unavailable', 'The native shortcut platform is unknown');
      return { ...native, Capture, Row, useCommand, dispatchKeyboard, eventAccelerator, bindings, commands, platform,
        keymap: () => {
          if (!connection.node.cachedBindings?.has(keymap)) throw workspaceError('workspace_host_pending', 'Waiting for Native to bind its shortcut keymap');
          return connection.node.store.get(keymap.resolve(connection.node, connection.chain));
        } };
    }),
    dispose() { controller.abort(); connection?.dispose?.(); sources.clear(); modules.clear(); moduleNamespaces.clear(); preparations.clear(); clearWorkspaceSourceCache(); connection = null; },
  };
  return api;
}
