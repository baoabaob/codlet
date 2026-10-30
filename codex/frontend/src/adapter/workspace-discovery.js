import { parse,parseExpressionAt } from 'acorn';
import { localConnection, uniqueModuleExport, componentSource } from '../host-discovery.js';
import {resolveLoadedAsset,captureResolvedAssets,staticModuleImports,nativeRootModuleImport,nativeRootModuleProof,resolveNativeRootModule} from '../host-assets.js';
import { workspaceError } from './workspace-dom.js';
import { createNativeComposerDriver } from './workspace-native-composer.js';
import { createNativeNavigation, navigationSignalExport, nativeNavigationScope } from './workspace-native-navigation.js';
import { createNativeViewportDriver, viewportSignalExports, viewportPersistenceReference } from './workspace-native-viewport.js';
import { keymapSourceExport, clearWorkspaceSourceCache,visitWorkspaceSource } from './workspace-source.js';
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
export function transcriptImplementationReference(source,parent){
  try{
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),exports=[];
    for(const node of ast.body){
      if(node.type==='ImportDeclaration')for(const specifier of node.specifiers)if(specifier.type==='ImportSpecifier')imports.set(specifier.local.name,{source:node.source.value,imported:specifier.imported.name??specifier.imported.value});
    }
    for(const node of ast.body){
      if(node.type==='ExportNamedDeclaration')for(const specifier of node.specifiers??[])if((specifier.exported.name??specifier.exported.value)==='LocalConversationSideChatTab')exports.push(node.source?{source:node.source.value,imported:specifier.local.name??specifier.local.value}:imports.get(specifier.local.name));
    }
    const targets=[...new Set(exports.filter(Boolean).map(value=>new URL(value.source,parent).href))];
    if(targets.length!==1||!/^app:\/\/-\/assets\/local-conversation-thread-[A-Za-z0-9_-]+\.js$/.test(targets[0]))return null;
    const target=targets[0];
    const initializes=ast.body.some(node=>node.type==='ExpressionStatement'&&node.expression.type==='CallExpression'&&node.expression.arguments.length===0&&node.expression.callee.type==='Identifier'&&imports.has(node.expression.callee.name)&&new URL(imports.get(node.expression.callee.name).source,parent).href===target);
    return initializes?target:null;
  }catch{return null;}
}

export async function transcriptModuleReferences(graph,parent,read){
  const urls=assetReferences(graph,parent,'local-conversation-thread');
  if(!urls.length)throw workspaceError('workspace_transcript_unavailable','Native transcript modules are missing');
  const candidates=await Promise.all(urls.map(async url=>({url,source:await read(url)})));
  const wrappers=candidates.filter(value=>value.source.includes('LocalConversationSideChatTab')&&!value.source.includes('retainActiveInterest'));
  if(wrappers.length!==1)throw workspaceError('workspace_transcript_unavailable','The native transcript entry contract changed');
  const wrapper=wrappers[0],target=transcriptImplementationReference(wrapper.source,wrapper.url);
  if(target&&!candidates.some(value=>value.url===target))candidates.push({url:target,source:await read(target)});
  const implementations=candidates.filter(value=>value.source.includes('trackReadState')&&value.source.includes('retainActiveInterest'));
  if(implementations.length!==1||target&&implementations[0].url!==target)throw workspaceError('workspace_transcript_unavailable','The native transcript entry contract changed');
  return{wrapper:wrapper.url,implementation:implementations[0].url};
}
const currentEntries=()=>Array.from(document.querySelectorAll('script[type="module"][src]'),node=>node.src);
const propertyName=node=>node&&!node.computed?(node.key?.name??node.key?.value):null;
// This is the asynchronous initializer whose result the current main module
// renders, not a search through unrelated lazy or settings modules.
export function initializedAppRuntimeReference(source,parent,proof=nativeRootModuleProof(source,parent)){
  if(proof.source!==source||proof.parent!==parent)throw workspaceError('workspace_host_drift','Native root source proof changed');
  const ast=proof.ast,targets=new Set(),parents=new WeakMap();
  visitWorkspaceSource(ast,node=>{for(const value of Object.values(node))if(Array.isArray(value)){for(const child of value)if(child?.type)parents.set(child,node);}else if(value?.type)parents.set(value,node);});
  const rendersResult=node=>{
    let value=node,owner=parents.get(value);
    while(owner?.type==='ConditionalExpression'&&(owner.consequent===value||owner.alternate===value)||owner?.type==='SequenceExpression'&&owner.expressions.at(-1)===value){value=owner;owner=parents.get(value);}
    const call=parents.get(owner),callback=call?.arguments?.[0],argument=callback?.params?.[0],render=callback?.body;
    return owner?.type==='MemberExpression'&&!owner.computed&&owner.object===value&&owner.property.name==='then'&&call?.type==='CallExpression'&&call.callee===owner&&callback?.type==='ArrowFunctionExpression'&&!callback.async&&callback.params.length===1&&argument?.type==='Identifier'&&proof.renderCalls.has(render)&&render.arguments[0].type==='Identifier'&&render.arguments[0].name===argument.name;
  };
  visitWorkspaceSource(ast,node=>{
    const member=node.callee,loader=member?.object,initialize=node.arguments?.[0];
    if(node.type!=='CallExpression'||member?.type!=='MemberExpression'||member.computed||member.property.name!=='then'||loader?.type!=='CallExpression'||initialize?.type!=='ArrowFunctionExpression'||initialize.async||!rendersResult(node))return;
    const pattern=initialize.params[0],call=initialize.body;
    if(initialize.params.length!==1||pattern?.type!=='ObjectPattern'||pattern.properties.length!==1||propertyName(pattern.properties[0])!=='initializeApp'||pattern.properties[0].value.type!=='Identifier'||call?.type!=='CallExpression'||call.callee.type!=='Identifier'||call.callee.name!==pattern.properties[0].value.name||call.arguments.length!==0)return;
    const load=loader.arguments[0],body=load?.body?.body;
    if(load?.type!=='ArrowFunctionExpression'||!load.async||load.params.length||body?.length!==2||body[0].type!=='VariableDeclaration'||body[0].declarations.length!==1||body[1].type!=='ReturnStatement')return;
    const declaration=body[0].declarations[0],fields=declaration.id?.properties,result=body[1].argument;
    if(declaration.id?.type!=='ObjectPattern'||fields.length!==1||propertyName(fields[0])!=='initializeApp'||fields[0].value.type!=='Identifier'||declaration.init?.type!=='AwaitExpression'||declaration.init.argument.type!=='ImportExpression'||result?.type!=='ObjectExpression'||result.properties.length!==1||propertyName(result.properties[0])!=='initializeApp'||result.properties[0].value.type!=='Identifier'||result.properties[0].value.name!==fields[0].value.name)return;
    const path=declaration.init.argument.source;
    const literal=path.type==='Literal'?path.value:path.type==='TemplateLiteral'&&!path.expressions.length?path.quasis[0].value.cooked:null;
    if(typeof literal==='string'){const url=new URL(literal,parent).href;if(/^app:\/\/-\/assets\/app-runtime-[A-Za-z0-9_-]+\.js$/.test(url))targets.add(url);}
  });
  if(targets.size!==1)throw workspaceError('workspace_host_drift','A unique Native application initializer is required');
  return[...targets][0];
}
export async function workspaceRuntimeReferences(read,entryUrls=currentEntries,main){
  if(!main){
    const entries=[...new Set(entryUrls().filter(url=>/^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(url)))];
    if(entries.length!==1)throw workspaceError('workspace_host_drift','A unique loaded Native entry is required');
    const mainUrl=nativeRootModuleImport(await read(entries[0]),entries[0]);
    main={mainUrl,mainSource:await read(mainUrl)};
  }
  main.check?.();
  const runtimeUrl=initializedAppRuntimeReference(main.mainSource,main.mainUrl,main.proof);
  const imports=staticModuleImports(await read(runtimeUrl),runtimeUrl);main.check?.();
  return{...main,runtimeUrl,imports};
}
export async function shortcutSettingsReferences(graph, parent, read, entryUrls=currentEntries, runtime=main=>workspaceRuntimeReferences(read,entryUrls,main)) {
  const direct = assetReferences(graph, parent, 'keyboard-shortcuts-settings');
  if (direct.length) return direct;
  // New Native builds keep settings dependencies in their lazy route graph.
  // Follow only the current document's entry and its unique main/settings edges;
  // reading these modules does not run their initializers.
  const entries = [...new Set(entryUrls().filter(url => /^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(url)))];
  if (entries.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'A unique loaded Native entry is required');
  const mainUrl=nativeRootModuleImport(await read(entries[0]),entries[0]);
  const mainSource=await read(mainUrl);
  let routes = assetReferences(mainSource, mainUrl, 'settings-lazy-routes');
  if(!routes.length){
    routes=(await runtime({mainUrl,mainSource})).imports.filter(url=>/^app:\/\/-\/assets\/settings-lazy-routes-[A-Za-z0-9_-]+\.js$/.test(url));
  }
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
  let connection,assetOwnerCheck,runtimeOwnerCheck;
  const assertOwner=()=>{controller.signal.throwIfAborted();assetOwnerCheck?.();runtimeOwnerCheck?.();};
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
  const runtimeReferences=()=>cached('runtime',async()=>{
    const root=await resolveNativeRootModule({read:source,signal:controller.signal});assertOwner();root.check();
    runtimeOwnerCheck??=root.check;
    return workspaceRuntimeReferences(source,currentEntries,root);
  });
  const primaryModules=graph=>cached('primaryModules',async()=>{
    const native=await getCommon();let urls=assetReferences(graph,native.initialUrl,'app-primary');
    if(!urls.length)urls=(await runtimeReferences()).imports.filter(url=>/^app:\/\/-\/assets\/app-primary-[A-Za-z0-9_-]+\.js$/.test(url));
    if(urls.length!==1)throw workspaceError('workspace_host_drift','A unique Native primary application module is required');
    await module(urls[0]);return urls;
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
      const native = await getCommon(), graph = await source(native.initialUrl);
      const transcript=await transcriptModuleReferences(graph,native.initialUrl,source);
      // The semantic wrapper runs Native's own initializer. Source is never evaluated.
      await module(transcript.wrapper);
      await module(transcript.implementation);
      const Content = workspaceFunction(native, 'transcriptContent');
      const Scope = workspaceFunction(native, 'scopeProvider');
      const composerScope = uniqueModuleExport(native.modules, value => value?.__scopeBrand === 'ComposerScope' && typeof value.id === 'symbol', 'composer scope');
      const composerValue = workspaceFunction(native, 'composerValue');
      const ThreadScope=uniqueModuleExport(native.modules,value=>value?.__scopeBrand==='ThreadScope','thread scope');
      const RouteScope=uniqueModuleExport(native.modules,value=>value?.__scopeBrand==='RouteScope','route scope');
      const routeDescription=workspaceFunction(native,'routeDescription');
      await primaryModules(graph);
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
      const native = await getCommon(), graph = await source(native.initialUrl);
      const settingsUrls = await shortcutSettingsReferences(graph, native.initialUrl, source,currentEntries,runtimeReferences);
      if (!settingsUrls.length) throw workspaceError('workspace_shortcuts_unavailable', 'Native shortcut settings entries are unavailable');
      const settings = await Promise.all(settingsUrls.map(async url => ({ url, source: await source(url) })));
      const wrappers = settings.filter(value => value.source.includes('KeyboardShortcutsSettings') && !value.source.includes('settings.keyboardShortcuts.resetAllConfirm'));
      if (wrappers.length !== 1) throw workspaceError('workspace_shortcuts_unavailable', 'The native shortcut settings entry changed');
      await module(wrappers[0].url);
      await primaryModules(graph);
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
          assertOwner();connection.check?.();
          if (!connection.node.cachedBindings?.has(keymap)) throw workspaceError('workspace_host_pending', 'Waiting for Native to bind its shortcut keymap');
          return connection.node.store.get(keymap.resolve(connection.node, connection.chain));
        } };
    }),
    dispose() { controller.abort(); connection?.dispose?.(); sources.clear(); modules.clear(); moduleNamespaces.clear(); preparations.clear(); clearWorkspaceSourceCache(); connection = null; },
  };
  return api;
}
