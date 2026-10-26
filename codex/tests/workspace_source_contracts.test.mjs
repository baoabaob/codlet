import test from 'node:test';
import assert from 'node:assert/strict';
import { keymapSourceExport, navigationSourceExport, workspaceModuleSyntax, workspaceSourceFunctions, clearWorkspaceSourceCache } from '../frontend/src/adapter/workspace-source.js';
import { createWorkspaceDiscovery } from '../frontend/src/adapter/workspace-discovery.js';
import { uniqueModuleExport } from '../frontend/src/host-discovery.js';
import { WORKSPACE_FUNCTION_ROLES, matchesWorkspaceFunction, workspaceInputProperties } from '../frontend/src/adapter/workspace-role-contracts.js';
import { parseExpressionAt } from '../frontend/node_modules/acorn/dist/acorn.mjs';

const keymap = ({ query = 'query', derived = 'derived', getter = 'get', body } = {}) =>
  `var ${query},${derived};function init(){return init=lazy(()=>{${query}=queryFactory(app,"codex-command-keymap-state",{enabled:true,staleTime:minute});
  ${derived}=signal(app,({get:${getter}})=>{${body ?? `let {data:state}=${getter}(${query});return state==null||${getter}(flag)?state:{...state,primaryNumberShortcutTarget:void 0};`}});})();}
  export{${derived} as keymap};`;
const missing = source => assert.throws(() => keymapSourceExport(source), { code: 'workspace_shortcuts_unavailable' });

test('a query and a cache invalidation reference identify one derived keymap responsibility', () => {
  const source = keymap({ query: 'renamedQuery', derived: '$state', getter: 'read' }) +
    'function invalidate(client){client.invalidate({queryKey:makeKey("codex-command-keymap-state")});}';
  assert.equal(keymapSourceExport(source), 'keymap');
  assert.equal(keymapSourceExport(source + ';"codex-command-keymap-state";'), 'keymap');
  assert.equal(keymapSourceExport(source.replace('$state as keymap', '$state as keymap,$state as alias')), 'alias');
});

test('source ownership survives larger declarations, repeated markers and unrelated nested functions', () => {
  const unrelated = Array.from({ length: 140 }, (_, index) => `function other${index}(){return ${index}}`).join('');
  const source = keymap().replace('function init(){', `function init(){/*${'padding '.repeat(6000)}*/${unrelated}`) +
    Array(160).fill(';"codex-command-keymap-state";').join('');
  assert.equal(keymapSourceExport(source), 'keymap');
  const complex = 'function owner(a=function defaults(){return "marker"},{x}={x:`${(()=>({text:"marker"}))()}`}){function nested(){return "marker"}return a}';
  assert.deepEqual(workspaceSourceFunctions(complex, 'marker').map(node => node.id.name), ['owner', 'defaults', 'nested']);
  const delegate = 'function renamed(owner,...args){/*' + 'comment '.repeat(100) + '*/return owner.get(nav).navigateToLocalConversation(...args)}';
  assert.equal(matchesWorkspaceFunction(delegate, 1, WORKSPACE_FUNCTION_ROLES.threadNavigation), true);
});

test('keymap selection follows data reaching the return value, not an unrelated matching string', () => {
  missing(keymap({ body: 'let {data:state}=get(query);return {primaryNumberShortcutTarget:undefined};' }));
  missing(keymap({ body: 'let {data:state}=get(otherQuery);return {...state,primaryNumberShortcutTarget:undefined};' }));
  missing(keymap().replace('derived=signal(app,', 'derived=signal(otherScope,'));
  missing(keymap({ body: 'let {data:state}=get(query);return ()=>({...state,primaryNumberShortcutTarget:undefined});' }));
  assert.equal(keymapSourceExport(keymap({ body: 'const result=get(query);const state=result.data;return {...state,primaryNumberShortcutTarget:undefined};' })), 'keymap');
});

test('shadowed query and getter variables cannot impersonate the original query flow', () => {
  missing(keymap({ body: 'const state=(()=>{const get=foreign;return get(query).data})();return {...state,primaryNumberShortcutTarget:undefined};' }));
  missing(keymap({ body: 'const state=((query)=>get(query).data)(foreign);return {...state,primaryNumberShortcutTarget:undefined};' }));
  missing(keymap({ body: 'function unrelated(get){const {data:state}=get(query);return {...state,primaryNumberShortcutTarget:undefined}}return unrelated(foreign);' }));
  assert.equal(keymapSourceExport(keymap({ body: 'const {data:state}=get(query);function unrelated(get){return get(query)}return {...state,primaryNumberShortcutTarget:undefined};' })), 'keymap');
});

test('two real query-to-state candidates are rejected even if their text or exports look similar', () => {
  const duplicate = keymap() + keymap({ query: 'otherQuery', derived: 'otherState' }).replace('function init()', 'function otherInit()').replace('as keymap', 'as otherKeymap');
  missing(duplicate);
});

test('query-options keymaps retain lexical query-key and returned-data ownership', () => {
  const source = 'var key,query,state;function init(){return init=lazy(()=>{key=["vscode","codex-command-keymap-state"];' +
    'query=make(app,()=>({queryKey:key,queryFn:({signal})=>fetchKeymap(signal),enabled:true}));' +
    'state=derived(app,({get:read})=>{let {data:value}=read(query);return value});})()}export{state as keymap};';
  assert.equal(keymapSourceExport(source), 'keymap');
  missing(source.replace('return value', 'return unrelated'));
  missing(source.replace('read(query)', 'read(unrelatedQuery)'));
  missing(source.replace('queryKey:key', 'queryKey:unrelatedKey'));
  missing(source.replace('()=>({queryKey:key', '(key)=>({queryKey:key'));
  missing(source.replace('"vscode"', '"unreviewed"'));
  missing(source.replace('query=make', 'key=["other"];query=make'));
});

test('keymap query keys may initialize separately while shadowing and competing writes remain rejected',()=>{
  const source='var key,query,state;function initKey(){key=["vscode","codex-command-keymap-state"]}' +
    'function initState(){initKey();query=make(app,()=>({queryKey:key,queryFn:({signal})=>fetchKeymap(signal)}));state=derived(app,({get:read})=>{let {data:value}=read(query);return value})}export{state as keymap};';
  assert.equal(keymapSourceExport(source),'keymap');
  assert.equal(keymapSourceExport(source+'function other(){return ['+Array(150).fill('otherkeyname').join(',')+']}'),'keymap');
  missing(source.replace('function initState()','function initState(key)'));
  missing(source+'function overwrite(){key=["unrelated"]}');
  missing(source.replace('read(query)','read(unrelated)'));
});

test('local navigation delegates must forward the complete argument list without extra actions',()=>{
  const contract=WORKSPACE_FUNCTION_ROLES.threadNavigation;
  const source='function renamed(owner,...args){return owner.get(nav).navigateToLocalConversation(...args)}';
  assert.equal(matchesWorkspaceFunction(source,1,contract),true);
  assert.equal(matchesWorkspaceFunction(source,2,contract),true);
  for(const changed of [source.replace('function renamed','async function renamed'),source.replace('return owner','owner.set(other);return owner'),source.replace('...args)}','"other") }'),source.replace('owner.get(nav)','foreign.get(nav)')])
    assert.equal(matchesWorkspaceFunction(changed,1,contract),false);
});

test('module syntax ignores string/comment decoys and records actual imports and export aliases', () => {
  const source = 'const text="export{wrong as alias}";/* import {wrong} from "./fake.js"; */' +
    'import {remote as local} from "./moved.js";function f(){return `export{alsoWrong as alias}`;}export{local as alias,local as second};';
  const syntax = workspaceModuleSyntax(source);
  assert.deepEqual(syntax.imports, [{ local: 'local', imported: 'remote', source: './moved.js' }]);
  assert.deepEqual(syntax.exports.map(value => value.exported), ['alias', 'second']);
  assert.equal(syntax.functions.length, 1);
  clearWorkspaceSourceCache();
});

test('navigation signal follows its actual defaults despite intervening declarations and duplicate diagnostic text', () => {
  const source = 'function missing(){throw Error("AppNavigationSignalBridge is missing")}function unrelated(){return 1}' +
    'var defaults,signal;function bootstrap(){function nested(){return 2}defaults={navigate:missing,navigateToLocalConversation:missing,prepareNavigation:missing};signal=make(app,defaults)}export{signal as bridge};"AppNavigationSignalBridge is missing";';
  assert.equal(navigationSourceExport(source), 'bridge');
  assert.throws(() => navigationSourceExport(source.replace('signal=make(app,defaults)', 'signal=make(app,otherDefaults)')), { code: 'workspace_navigation_unsupported' });
});

test('re-export aliases are deduplicated by identity while different matching values remain ambiguous', () => {
  const scope = { __scopeBrand: 'ComposerScope', id: Symbol('composer') };
  assert.equal(uniqueModuleExport(new Map([['shared', { alias: scope }], ['initial', { moved: scope }]]),
    value => value.__scopeBrand === 'ComposerScope', 'composer scope'), scope);
  assert.throws(() => uniqueModuleExport(new Map([['shared', { scope }], ['initial', { scope: { ...scope, id: Symbol() } }]]),
    value => value.__scopeBrand === 'ComposerScope', 'composer scope'), { code: 'desktop_contract_drift' });
});

test('capture controls and transcripts are identified by consumed inputs, not wrappers forwarding their properties', () => {
  const control = 'function control(props){let {allowsBareModifiers,allowsSequences,captureAriaLabel,onStartCapture,onCapture,onCancelCapture}=props;return captureAriaLabel}';
  const wrapper = 'function wrapper(props){return control({allowsBareModifiers:false,allowsSequences:true,captureAriaLabel:"label",onStartCapture:props.start,onCapture:props.capture,onCancelCapture:props.cancel})}';
  const contract = WORKSPACE_FUNCTION_ROLES.shortcutCapture;
  assert.equal(matchesWorkspaceFunction(control, 1, contract, workspaceInputProperties(parseExpressionAt(control, 0, { ecmaVersion: 'latest' }))), true);
  assert.equal(matchesWorkspaceFunction(wrapper, 1, contract, workspaceInputProperties(parseExpressionAt(wrapper, 0, { ecmaVersion: 'latest' }))), false);
});

test('navigation discovers migrated scopes, draft identity and signal without importing a version-specific name', async t => {
  const oldDocument = globalThis.document, oldLocation = globalThis.location;
  const sharedUrl = 'app://-/assets/app-shared-arbitrary.js', initialUrl = 'app://-/assets/app-initial-unrelated.js';
  globalThis.document = { querySelectorAll: () => [{ href: sharedUrl }, { href: initialUrl }] };
  globalThis.location = { origin: 'app://-', pathname: '/index.html' };
  t.after(() => { globalThis.document = oldDocument; globalThis.location = oldLocation; });
  const app = { id: Symbol('app') }, entry = {};
  const signal = { scope: app, cache: 'signal', resolve: () => entry };
  const bridge = { pathname: '/', search: '', navigate() {}, navigateToLocalConversation() {}, prepareNavigation() {} };
  const connection = { node: { token: app, signalBindings: new Map([[signal, entry]]), store: { get: () => bridge } }, chain: new Map(), manager: {} };
  connection.check = () => connection;
  const composerScope = { __scopeBrand: 'ComposerScope', id: Symbol() };
  function dispatch(a, b, c, d, e, f, g) { return { sidebarThreadLocationId: a, orbitPrewarmId: b, source: `sidebar`, threadId: g }; }
  function draft(value) { return ['gpt-draft:', 'draftThreadLocationId', 'library-preview:', 'widget-overlay:', 'clientThreadId', value]; }
  const moved = { arbitraryComposer: composerScope,
    arbitraryThread: { __scopeBrand: 'ThreadScope', id: Symbol() }, arbitraryRoute: { __scopeBrand: 'RouteScope', id: Symbol() },
    nav: signal, dispatch, draft };
  const graph = 'function missing(){throw Error("AppNavigationSignalBridge is missing")}var defaults,state;function init(){defaults={navigate:missing,navigateToLocalConversation:missing,prepareNavigation:missing};state=make(app,defaults)}export{state as nav};';
  const discovery = createWorkspaceDiscovery(async () => ({ React: {}, Client: {} }), {
    load: async url => url === sharedUrl ? { oldAlias: composerScope } : moved,
    read: async url => url === initialUrl ? graph : 'export {};',
    connect: () => connection,
  });
  t.after(() => discovery.dispose());
  const navigation = await discovery.navigation();
  assert.equal(navigation.composerScope, composerScope); assert.equal(navigation.draftKey, draft); assert.equal(navigation.inputApi, 1);
});
