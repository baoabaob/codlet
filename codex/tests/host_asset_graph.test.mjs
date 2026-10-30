import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLoadedAsset,nativeRootModuleContract,staticModuleImports,captureResolvedAssets} from '../frontend/src/host-assets.js';

const base='app://-/assets/',entry=base+'index-current.js',main=base+'app-main-shell.js',initial=base+'app-initial-live.js',shared=base+'app-shared-core.js',utility=base+'utility.js';
const rootSource=`import {client as nativeClient} from './app-shared-core.js';import './app-initial-live.js';
let library,element,browser,handle;library=nativeClient();element=document.getElementById('root');browser=window;
browser.__nativeRoot??(browser.__nativeRoot=(0,library.createRoot)(element));handle=browser.__nativeRoot;
Promise.resolve().then(view=>handle.render(view));`;
function fixture(t){
  const previous=Object.getOwnPropertyDescriptors(globalThis),root={id:'root'},internal={containerInfo:root},container={stateNode:internal};internal.current={stateNode:internal};root.__reactContainer$test=container;
  const script={src:entry,type:'module'},document={root,scripts:[script],getElementById(id){return id==='root'?this.root:null;},querySelectorAll(){return[];}},window={__nativeRoot:{_internalRoot:internal}};
  Object.defineProperties(globalThis,{document:{configurable:true,value:document},window:{configurable:true,value:window},location:{configurable:true,value:{origin:'app://-',pathname:'/index.html',href:'app://-/index.html'}},performance:{configurable:true,value:{getEntriesByType:()=>[]}}});
  t.after(()=>{for(const key of ['document','window','location','performance']){if(previous[key])Object.defineProperty(globalThis,key,previous[key]);else delete globalThis[key];}});
  const sources=new Map([[entry,`await boot(()=>import('./app-main-shell.js'));`],[main,rootSource+"import './utility.js';"],[shared,`globalThis.mustNeverExecute=true;`],[utility,`export const passive=true;`]]),reads=[];
  const read=async url=>{reads.push(url);assert.ok(sources.has(url),'Read only the selected static Native graph: '+url);return sources.get(url);};
  return{root,internal,container,script,document,window,sources,reads,read};
}
test('a mounted Native root proves its entry main and static initial dependency without executing modules',async t=>{
  const f=fixture(t);assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);
  assert.equal(globalThis.mustNeverExecute,undefined);assert.equal(f.reads.includes(initial),false);assert.equal(new Set(f.reads).size,f.reads.length);
  const count=f.reads.length;assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);assert.equal(f.reads.length,count);
});
test('an unmounted Native root remains pending and the same document resolves after its real mount',async t=>{
  const f=fixture(t);delete f.root.__reactContainer$test;await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'ui_host_pending'});assert.deepEqual(f.reads,[]);
  f.document.root=null;await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'ui_host_pending'});
  f.document.root=f.root;f.root.__reactContainer$test=f.container;assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);
});
test('an existing container with a changed FiberRoot contract is drift, not an unmounted wait',async t=>{
  const f=fixture(t);f.container.stateNode={};await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});assert.deepEqual(f.reads,[]);
});
test('static graph cycles terminate by module identity and lazy imports are never followed',async t=>{
  const f=fixture(t);f.sources.set(utility,`import './app-shared-core.js';function unrelated(){return import('./app-initial-lazy.js');}`);
  assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);assert.equal(f.reads.filter(url=>url===shared).length,0);assert.equal(f.reads.filter(url=>url===utility).length,1);
});
test('dotted static module names remain in the closure and cannot hide a second initial role',async t=>{
  const f=fixture(t),dotted=base+'index.client-helper.js';f.sources.set(utility,"import './index.client-helper.js';");f.sources.set(dotted,"import './app-initial-hidden.js';");
  await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});assert.ok(f.reads.includes(dotted));
});
test('unsupported static imports reject instead of silently claiming a unique closure',async t=>{
  const f=fixture(t);f.sources.set(utility,"import 'https://foreign.invalid/app-initial-other.js';");await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});
});
test('shared and initial role modules are terminal namespaces, not an unrelated application graph',async t=>{
  const f=fixture(t);f.sources.set(shared,"import './app-initial-unrelated.js';");assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);assert.equal(f.reads.includes(shared),false);
});
test('missing, ambiguous and unowned root module contracts are terminal rather than initialization waits',async t=>{
  const f=fixture(t);f.sources.set(main,rootSource.replace("import './app-initial-live.js';",''));
  await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});
  f.sources.set(main,rootSource+"import './app-initial-second.js';");await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});
  f.sources.set(main,rootSource);f.window.__nativeRoot={_internalRoot:{}};await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});
});
test('two entry root imports stay ambiguous even when one could produce a matching root',async t=>{
  const f=fixture(t);f.sources.set(entry,`import('./app-main-shell.js');import('./app-main-other.js');`);
  await assert.rejects(resolveLoadedAsset('initial',{read:f.read}),{code:'desktop_asset_drift'});assert.deepEqual(f.reads,[entry]);
});
for(const change of ['dom','entry','public-root'])test(`an awaited source read cannot publish after ${change} ownership changes`,async t=>{
  const f=fixture(t);const read=async url=>{const source=await f.read(url);if(url===utility){if(change==='dom')f.document.root={id:'root'};if(change==='entry')f.script.src=base+'index-replaced.js';if(change==='public-root')f.window.__nativeRoot={_internalRoot:f.internal};}return source;};
  await assert.rejects(resolveLoadedAsset('initial',{read}),{code:'desktop_asset_owner_replaced'});
});
test('normal React current and alternate commits retain the same root owner',async t=>{
  const f=fixture(t),read=async url=>{const result=await f.read(url);f.internal.current={stateNode:f.internal,alternate:f.internal.current};return result;};
  assert.equal(await resolveLoadedAsset('initial',{read}),initial);assert.equal(await resolveLoadedAsset('initial',{read}),initial);
});
test('a changed public root discards a completed graph instead of reusing its cached proof',async t=>{
  const f=fixture(t);assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);const count=f.reads.length;
  f.window.__nativeRoot={_internalRoot:f.internal};assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);assert.ok(f.reads.length>count);
});
test('a late retired graph cannot replace a new owner completed proof',async t=>{
  const f=fixture(t);let finish,entered;const gate=new Promise(resolve=>entered=resolve),first=resolveLoadedAsset('initial',{read:async url=>{const source=await f.read(url);if(url===utility){entered();await new Promise(resolve=>finish=resolve);}return source;}});
  await gate;const next={containerInfo:f.root};next.current={stateNode:next};f.container.stateNode=next;f.window.__nativeRoot={_internalRoot:next};
  assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);finish();await assert.rejects(first,{code:'desktop_asset_owner_replaced'});
  const count=f.reads.length;assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);assert.equal(f.reads.length,count);
});
test('steady-state checks retain their captured root proof after a newer caller replaces the cache',async t=>{
  const f=fixture(t);await resolveLoadedAsset('initial',{read:f.read});const original=captureResolvedAssets({initial});
  const next={containerInfo:f.root};next.current={stateNode:next};f.container.stateNode=next;f.window.__nativeRoot={_internalRoot:next};
  await resolveLoadedAsset('initial',{read:f.read});assert.throws(original,{code:'desktop_asset_owner_replaced'});captureResolvedAssets({initial})();
});
test('shadowed namespace, window or render bindings cannot prove Native root execution',()=>{
  for(const source of [
    rootSource.replace('library=nativeClient();','library={};'),
    rootSource.replace('browser=window;','browser={};'),
    rootSource.replace('Promise.resolve().then(view=>handle.render(view));','function foreign(handle){handle.render(null);}'),
  ])assert.throws(()=>nativeRootModuleContract(source,main),{code:'desktop_asset_drift'});
});
test('complete static import grammar ignores text, dynamic imports, aliases and imported string names',()=>{
  const source=`const fake="import './app-initial-text.js'";import {'string-name' as local} from './utility.js';import('./app-initial-lazy.js');export {local};`;
  assert.deepEqual(staticModuleImports(source,main),[utility]);
});
test('direct loaded evidence retains its fast path and source failures keep their original rejection',async t=>{
  const f=fixture(t);f.document.querySelectorAll=()=>[{href:initial}];assert.equal(await resolveLoadedAsset('initial',{read:()=>assert.fail('No graph needed')}),initial);
  f.document.querySelectorAll=()=>[];const error=new Error('Native source unavailable');await assert.rejects(resolveLoadedAsset('initial',{read:()=>Promise.reject(error)}),value=>value===error);
});
test('already-aborted calls cannot reuse either the direct fast path or completed graph proof',async t=>{
  const f=fixture(t),controller=new AbortController();assert.equal(await resolveLoadedAsset('initial',{read:f.read}),initial);controller.abort();
  await assert.rejects(resolveLoadedAsset('initial',{read:f.read,signal:controller.signal}),{name:'AbortError'});
  f.document.querySelectorAll=()=>[{href:initial}];await assert.rejects(resolveLoadedAsset('initial',{read:f.read,signal:controller.signal}),{name:'AbortError'});
});
test('retirement before the queued source read begins dispatches no read',async t=>{
  const f=fixture(t),controller=new AbortController(),pending=resolveLoadedAsset('initial',{read:f.read,signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(f.reads,[]);
});
