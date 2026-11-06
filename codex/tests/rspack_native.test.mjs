import test from 'node:test';
import assert from 'node:assert/strict';
import {bindRspackRuntime,rspackFactory,loadRspackNative} from '../frontend/src/rspack-native.js';
import {createWorkspaceDiscovery} from '../frontend/src/adapter/workspace-discovery.js';

function fixture(){
  const root={},internal={containerInfo:root};internal.current={stateNode:internal};root.__reactContainer$fixture={stateNode:internal};
  const entry={type:'module',src:'app://-/assets/1234.abcdef.js'};
  const document={scripts:[entry],getElementById:id=>id==='root'?root:null,defaultView:{__codexRoot:{_internalRoot:internal}}};
  function require(){throw Error('Discovery must not initialize Native modules');}
  require.c={root:{exports:{}},react:{exports:{createRoot(){}}},app:{exports:{Header:{}}},scope:{exports:{__scopeBrand:'AppScope'}},unrelated:{exports:{}}};
  require.m={root(e,t,r){var react=r('react');let node=document.getElementById('root'),win=window;null==win.__codexRoot&&(win.__codexRoot=(0,react.createRoot)(node));let current=win.__codexRoot;(async()=>{let{initializeApp}=await Promise.all([r.e(12)]).then(r.bind(r,'app'));return initializeApp();})().then(value=>current.render(value));},react(){},app(e,t,r){r('scope');r('not-loaded');},scope(){},unrelated(){throw Error('Unrelated module');}};
  return{document,entry,require};
}
function withDocument(fn){return()=>{const previous=globalThis.document;const f=fixture();globalThis.document=f.document;try{return fn(f);}finally{globalThis.document=previous;}};}

test('Rspack discovery binds the current cache without executing or parsing unrelated factories',withDocument(f=>{
  f.require.m.unrelated=new Proxy(function(){},{});
  const runtime=bindRspackRuntime(f.require,f),records=[...runtime.records().values()];
  assert.deepEqual(new Set(records.map(r=>r.id)),new Set(['root','react','app','scope','unrelated']));
  assert.equal(records.find(r=>r.id==='scope').namespace,f.require.c.scope.exports);
}));
test('shadowed require calls do not add module dependencies',()=>{
  const factory=rspackFactory(function(e,t,r){r('owned');function unrelated(r){r('foreign');}return unrelated;});
  assert.deepEqual([...factory.dependencies],['owned']);
});
test('the root creator selects its own client even when another client exports createRoot',withDocument(f=>{
  f.require.m.other=function(){};f.require.c.other={exports:{createRoot(){},hydrateRoot(){}}};
  const runtime=bindRspackRuntime(f.require,f);
  assert.equal(runtime.client(),f.require.c.react.exports);
  assert.equal(runtime.client().hydrateRoot,undefined);
  f.require.c.react.exports.createRoot=()=>{};
  assert.throws(()=>runtime.check(),{code:'desktop_asset_owner_replaced'});
}));
test('Native module retirement and replacement invalidate captured bindings',withDocument(f=>{
  const runtime=bindRspackRuntime(f.require,f);runtime.records();runtime.pinValue(f.require.c.scope.exports);f.require.c.scope={exports:{}};
  assert.throws(()=>runtime.check(),{code:'desktop_asset_owner_replaced'});
}));
test('retiring an unrelated cache entry does not retire selected Native services',withDocument(f=>{
  const runtime=bindRspackRuntime(f.require,f);runtime.records();runtime.pinValue(f.require.c.scope.exports);delete f.require.c.unrelated;assert.doesNotThrow(()=>runtime.check());
}));
test('a stale discovery snapshot cannot select an export after its module retires',withDocument(f=>{
  const runtime=bindRspackRuntime(f.require,f),stale=f.require.c.scope.exports;runtime.records();delete f.require.c.scope;
  assert.throws(()=>runtime.pinValue(stale),{code:'desktop_asset_owner_replaced'});
}));
test('a later chunk factory does not replace an already initialized Native module owner',withDocument(f=>{
  const runtime=bindRspackRuntime(f.require,f),before=[...runtime.records().values()].find(r=>r.id==='scope');
  f.require.m.scope=function(){throw Error('Future factory is not the current cached module');};
  const after=[...runtime.records().values()].find(r=>r.id==='scope');assert.equal(after,before);assert.doesNotThrow(()=>runtime.check());
}));
test('replacing Native root or entry invalidates discovery',withDocument(f=>{
  const runtime=bindRspackRuntime(f.require,f);f.document.defaultView.__codexRoot={};
  assert.throws(()=>runtime.check(),{code:'desktop_asset_owner_replaced'});
}));
test('an unbound public root cannot authorize a module runtime',withDocument(f=>{
  f.document.defaultView.__codexRoot={_internalRoot:{}};
  assert.throws(()=>bindRspackRuntime(f.require,f),{code:'desktop_asset_drift'});
}));
test('retiring one consumer does not poison another consumer of the same Native runtime',async()=>{
  const previous=globalThis.document,f=fixture();globalThis.document=f.document;
  try{
    const controller=new AbortController(),options={read:async()=> 'const runtime=()=>{}; export {runtime as __webpack_require__};',load:async()=>({__webpack_require__:f.require})};
    const first=await loadRspackNative({...options,signal:controller.signal});controller.abort();
    assert.throws(()=>first.check(),{name:'AbortError'});
    const next=await loadRspackNative(options);assert.doesNotThrow(()=>next.check());
  }finally{globalThis.document=previous;}
});
test('lazy Native modules follow the exported loader and stop before initialization after cancellation',async()=>{
  const previous=globalThis.document,f=fixture();globalThis.document=f.document;
  try{
    const original=f.require,called=[],require=id=>{called.push(id);return require.c[id]?.exports;};Object.assign(require,original);f.require=require;
    require.m.app=function(e,t,r){r('lazy');};require.c.lazy={exports:{LazyView:{}}};
    require.m.lazy=function(e,t,r){let view=wrap(async()=>(await Promise.all([r.e(42)]).then(r.bind(r,'implementation'))).LazyView);r.d(t,{},{LazyView:view});};
    let release;require.e=()=>new Promise(resolve=>{release=resolve;});
    const runtime=bindRspackRuntime(require,f),controller=new AbortController();
    const pending=runtime.prepareExport('LazyView',{signal:controller.signal});controller.abort();release();
    await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(called,[]);
    require.e=async id=>{assert.equal(id,42);require.c.implementation={exports:{LazyView:'current'}};require.m.implementation=function(){};};
    assert.deepEqual(await runtime.prepareExport('LazyView'),{LazyView:'current'});assert.deepEqual(called,['implementation']);
  }finally{globalThis.document=previous;}
});
test('a shadowed document cannot claim the current Native root',withDocument(f=>{
  f.require.m.root=function(e,t,r){const document={getElementById(){}};var react=r('react');let node=document.getElementById('root'),win=window;win.__codexRoot=(0,react.createRoot)(node);let current=win.__codexRoot;current.render(null);};
  assert.throws(()=>bindRspackRuntime(f.require,f),{code:'desktop_asset_drift'});
}));

test('Rspack workspace follows the bound navigation signal and shortcut query/registry owners',async t=>{
  const previous=globalThis.document,navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),f=fixture();
  globalThis.document=f.document;Object.defineProperty(globalThis,'navigator',{value:{platform:'Win32'},configurable:true});
  t.after(()=>{globalThis.document=previous;if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else delete globalThis.navigator;});
  const token={id:Symbol()},navigation={scope:token,cache:'signal',resolve:()=>navigation},query={scope:token,resolve:()=>query},keymap={scope:token,resolve:()=>keymap},decoy={scope:token,resolve:()=>decoy};
  const commands=[{id:'newTask',kind:'webview'},{id:'keyboardShortcuts',kind:'electron-only'}],keymapValue={overrides:{newTask:['Ctrl+N']}},opened=[];
  const bridge={pathname:'/codex',search:'',navigate(){return true;},navigateToLocalConversation(id){opened.push(id);return true;},prepareNavigation(){}};
  function dispatch(scope,...args){return scope.get(signal).navigateToLocalConversation(...args);}
  function Capture({allowsBareModifiers,allowsSequences,captureAriaLabel,onStartCapture,onCapture,onCancelCapture}){return [allowsBareModifiers,allowsSequences,captureAriaLabel,onStartCapture,onCapture,onCancelCapture];}
  function eventAccelerator(event){const keys=[];event.ctrlKey&&keys.push('Ctrl');event.metaKey&&keys.push('Command');event.altKey&&keys.push('Alt');event.shiftKey&&keys.push('Shift');keys.push(event.key);return keys.join('+');}
  function Row(){return ['labelSizing','controlSizing','description','control'];}
  function useCommand(){return ['contextHandler','keyboardHandler','menuItem','useEffect'];}
  function dispatchKeyboard(a,b,c){return ['keyboard_shortcut',a,b,c];}
  function bindings(command,keymap,platform){return registry.effective({commandId:command,keymapState:keymap,windowType:'chatgpt',macOS:platform==='macOS'}).map(accelerator=>({accelerator:accelerator,label:format(accelerator)}));}
  const add=(id,factory,exports)=>{f.require.m[id]=factory;f.require.c[id]={exports};};
  add('scopes',function(){},{AppScope:token,ComposerScope:{__scopeBrand:'ComposerScope',id:Symbol()},ThreadScope:{__scopeBrand:'ThreadScope',id:Symbol()},RouteScope:{__scopeBrand:'RouteScope',id:Symbol()}});
  add('navigation',function(e,t,r){const scopes=r('scopes');function missing(){throw Error('AppNavigationSignalBridge is missing');}const navigation=signal(scopes.AppScope,{navigate:missing,navigateToLocalConversation:missing,prepareNavigation:missing});r.d(t,{},{navigation});},{navigation,dispatch});
  add('registry',function(){},{commands,effective(){},decoy:[{id:'newTask'},{id:'keyboardShortcuts'}]});
  add('key',function(){},{key:['vscode','codex-command-keymap-state']});
  add('shortcuts',function(e,t,r){const registry=r('registry'),scopes=r('scopes'),keys=r('key');function bindings(command,keymap,platform){return registry.effective({commandId:command,keymapState:keymap,windowType:'chatgpt',macOS:platform==='macOS'}).map(accelerator=>({accelerator:accelerator,label:format(accelerator)}));}const query=createQuery(scopes.AppScope,()=>({queryKey:keys.key,queryFn:()=>request()})),keymap=signal(scopes.AppScope,({get,...rest})=>{let{data:value,...unused}=get(query);return value;}),decoy=signal(scopes.AppScope,({...rest})=>{let{...unused}=read(query);return unused;});r.d(t,{},{bindings,query,keymap,decoy});},{Capture,eventAccelerator,Row,useCommand,dispatchKeyboard,bindings,query,keymap,decoy});
  const connection={node:{token,store:{get:atom=>atom===navigation?bridge:keymapValue},signalBindings:new Set([navigation]),cachedBindings:new Set([keymap])},chain:new Map(),manager:{},check:()=>connection,dispose(){}};
  const runtime=bindRspackRuntime(f.require,f),discovery=createWorkspaceDiscovery(async()=>({moduleRuntime:runtime}),{connect:()=>connection});t.after(()=>discovery.dispose());
  const nav=await discovery.navigation();assert.deepEqual(nav.currentRoute(),{pathname:'/codex',search:''});nav.openLocalThread('owned-thread');assert.deepEqual(opened,['owned-thread']);
  const shortcuts=await discovery.shortcuts();assert.equal(shortcuts.commands,commands);assert.equal(shortcuts.keymap(),keymapValue);assert.equal(shortcuts.eventAccelerator({ctrlKey:true,key:'N'}),'Ctrl+N');
  f.require.c.shortcuts.exports.keymap={...keymap};assert.throws(()=>shortcuts.keymap(),{code:'desktop_asset_owner_replaced'});
});
