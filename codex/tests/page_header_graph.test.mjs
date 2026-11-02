import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativePageHeader} from '../frontend/src/adapter/discovery.js';

const base='app://-/assets/',entry=base+'index-current.js',main=base+'app-main-current.js',runtime=base+'app-runtime-current.js',primary=base+'app-primary-current.js';
const headerSource=`var shell;function initialize(){return(initialize=once(()=>{prepare();shell={Root:root,Header:header,HeaderToolbar:toolbar}}))()}export{shell as shellExport,initialize as initializeExport};`;
const mainSource=`import{client as nativeClient}from'./app-shared-current.js';import'./app-initial-current.js';
let library,element,browser,handle;library=nativeClient();element=document.getElementById('root');browser=window;
browser.__nativeRoot??(browser.__nativeRoot=(0,library.createRoot)(element));handle=browser.__nativeRoot;
preload(async()=>{const{initializeApp}=await import('./app-runtime-current.js');return{initializeApp}}).then(({initializeApp})=>initializeApp()).then(view=>handle.render(view));`;
function fixture(t){
  const previous=Object.getOwnPropertyDescriptors(globalThis),root={id:'root'},internal={containerInfo:root},container={stateNode:internal};internal.current={stateNode:internal};root.__reactContainer$test=container;
  const script={src:entry,type:'module'},document={scripts:[script],getElementById:id=>id==='root'?root:null,querySelectorAll:()=>[]},window={__nativeRoot:{_internalRoot:internal}};
  Object.defineProperties(globalThis,{document:{configurable:true,value:document},window:{configurable:true,value:window},location:{configurable:true,value:{origin:'app://-',pathname:'/index.html',href:'app://-/index.html'}},performance:{configurable:true,value:{getEntriesByType:()=>[]}}});
  t.after(()=>{for(const key of ['document','window','location','performance']){if(previous[key])Object.defineProperty(globalThis,key,previous[key]);else delete globalThis[key];}});
  const sources=new Map([[entry,`boot(()=>import('./app-main-current.js'))`],[main,mainSource],[runtime,`import'./app-primary-current.js';import'./settings-unrelated.js';export function initializeApp(){}`],[primary,headerSource]]),reads=[],loads=[];
  const header={Root(){},Header(){},HeaderToolbar(){}};let value,calls=0;
  const module={get shellExport(){return value;},initializeExport(){calls++;value=header;}};
  return {sources,reads,loads,window,internal,script,header,module,get calls(){return calls;},
    read:async url=>{reads.push(url);assert.ok(sources.has(url),'Read only the proved application edge: '+url);return sources.get(url);},
    load:async url=>{loads.push(url);assert.equal(url,primary);return module;}};
}

test('page headers follow the rendered application runtime when initial has no primary reference',async t=>{
  const f=fixture(t),records=[{module:{},source:'export const initialOnly=true;'}];
  assert.equal(await loadNativePageHeader(records,{read:f.read,load:f.load}),f.header);
  assert.deepEqual(f.reads,[entry,main,runtime,primary]);assert.deepEqual(f.loads,[primary]);assert.equal(f.calls,1);
});

test('legacy initial-only headers require no main, runtime or primary discovery',async()=>{
  let value,calls=0;const header={Root(){},Header(){},HeaderToolbar(){}},module={get shellExport(){return value;},initializeExport(){calls++;value=header;}};
  const options={read:()=>assert.fail('Legacy page read an unrelated module'),load:()=>assert.fail('Legacy page loaded an unrelated module')};
  assert.equal(await loadNativePageHeader([{module,source:headerSource}],options),header);assert.equal(calls,1);
  assert.equal(await loadNativePageHeader([{module,source:headerSource}],options),header);assert.equal(calls,1);
});

test('a page does not select primary from an unrelated lazy initializer or ambiguous runtime imports',async t=>{
  const f=fixture(t);f.sources.set(main,mainSource.replace('handle.render(view)','unrelated.render(view)'));
  await assert.rejects(loadNativePageHeader([{module:{},source:''}],{read:f.read,load:f.load}),{code:'desktop_asset_drift'});assert.deepEqual(f.loads,[]);
  f.sources.set(main,mainSource);f.sources.set(runtime,`import'./app-primary-current.js';import'./app-primary-other.js';`);
  await assert.rejects(loadNativePageHeader([{module:{},source:''}],{read:f.read,load:f.load}),{code:'ui_build_drift'});assert.deepEqual(f.loads,[]);
});

for(const phase of ['read','load'])test('page header discovery revalidates its exact public root after '+phase,async t=>{
  const f=fixture(t),replace=()=>{f.window.__nativeRoot={_internalRoot:f.internal};};
  const read=async url=>{const result=await f.read(url);if(phase==='read'&&url===primary)replace();return result;};
  const load=async url=>{const result=await f.load(url);if(phase==='load')replace();return result;};
  await assert.rejects(loadNativePageHeader([{module:{},source:''}],{read,load}),{code:'desktop_asset_owner_replaced'});
  assert.equal(f.calls,0);assert.equal(f.loads.length,phase==='read'?0:1);
});

test('page header cancellation during an accepted source read does not import or initialize its module',async t=>{
  const f=fixture(t),controller=new AbortController();
  const read=async url=>{const result=await f.read(url);if(url===primary)controller.abort();return result;};
  await assert.rejects(loadNativePageHeader([{module:{},source:''}],{read,load:f.load,signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(f.loads,[]);assert.equal(f.calls,0);
});

test('a proved header initializer failure keeps its original contract error',async t=>{
  const f=fixture(t),failure=Object.assign(Error('Native header contract changed'),{code:'header_contract_changed'});
  f.module.initializeExport=()=>{throw failure;};
  await assert.rejects(loadNativePageHeader([{module:{},source:''}],{read:f.read,load:f.load}),error=>error===failure);
});
