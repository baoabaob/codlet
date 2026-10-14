import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from '../frontend/node_modules/esbuild/lib/main.js';
import {createWorkspaceLocations} from '../frontend/src/adapter/workspace-location.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const {outputFiles:[moduleSource]}=await build({stdin:{contents:'export {createWorkspaceLocations} from "./adapter/workspace-location.js"; export {reviewedNavigator} from "./native-navigation.js";',resolveDir:fileURLToPath(new URL('../frontend/src',import.meta.url))},bundle:true,format:'iife',globalName:'locationModule',write:false,platform:'browser'});

function dataRouterFixture(t){
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
  const document=dom.window.document,rootNode=document.getElementById('root'),nativeNavigator={},privateState={nativeDraftReference:Symbol('never-json')};
  const router={state:{location:{pathname:'/',search:'?draft=original',hash:'#origin',state:privateState}},routes:[{path:'*'}],navigate(to,options){this.state.location={pathname:to,state:options?.state};},subscribe(){return()=>{};}};
  const modules=()=>{dom.window.eval(moduleSource.text);return dom.window.locationModule;};
  const oldModule=modules(),nextModule=modules(),review=(module,nav=nativeNavigator,value=router)=>module.reviewedNavigator(new Set([nav]),new Set([{navigator:nav,router:value}]));
  let host={navigator:review(oldModule),rootNode},restoredBy=null;
  const create=(module,label)=>module.createWorkspaceLocations({document,host:()=>host,load:async()=>({restoreLocation(value){restoredBy=label;router.state.location={...value};}}),check(){},changed(){},readInput:()=>null});
  return{document,rootNode,router,nativeNavigator,privateState,oldModule,nextModule,review,create,setHost(value){host=value;},restoredBy:()=>restoredBy,owner:generation=>({pluginId:'dev.workbench',generation})};
}

test('fresh independent provider modules adopt the same Native data router without retaining old Core bridges',async t=>{
  const f=dataRouterFixture(t),oldBridge=f.review(f.oldModule),newBridge=f.review(f.nextModule);assert.notEqual(oldBridge,newBridge);
  const old=f.create(f.oldModule,'old'),handle=old.capture(()=>{},f.owner(1));await handle.ready;
  const state=await handle.exportState(),registry=f.document.defaultView[Symbol.for('codlet.core.workspace.locationTransfers.v2')],entry=registry.entries.get(state.token);
  assert.equal(registry.api,2);assert.equal('source' in entry,false);assert.equal(entry.nativeIdentity.navigator,f.nativeNavigator);assert.equal(entry.nativeIdentity.router,f.router);
  assert.equal(Object.values(entry.nativeIdentity).includes(oldBridge),false);
  old.dispose();f.router.state.location={pathname:'/local/selected',state:null};f.setHost({navigator:newBridge,rootNode:f.rootNode});
  const next=f.create(f.nextModule,'next'),adopted=next.capture(()=>{},f.owner(2),{restoreState:state});await adopted.ready;await adopted.restore();
  assert.equal(f.restoredBy(),'next');assert.equal(f.router.state.location.state,f.privateState);assert.equal(f.router.state.location.search,'?draft=original');
  adopted.dispose({releaseTransfer:true});assert.equal(registry.entries.size,0);next.dispose();
});

test('fresh provider adoption rejects genuine Native router, navigator, function and root drift',async t=>{
  for(const drift of ['router','navigator','navigate','subscribe','root'])await t.test(drift,async t=>{
    const f=dataRouterFixture(t),old=f.create(f.oldModule,'old'),handle=old.capture(()=>{},f.owner(1));await handle.ready;const state=await handle.exportState();old.dispose();
    let router=f.router,navigator=f.nativeNavigator,rootNode=f.rootNode;
    if(drift==='router')router={...router};if(drift==='navigator')navigator={};
    if(drift==='navigate')router.navigate=function(){};if(drift==='subscribe')router.subscribe=function(){return()=>{};};
    if(drift==='root'){rootNode=f.document.createElement('div');f.rootNode.replaceWith(rootNode);}
    f.setHost({navigator:f.review(f.nextModule,navigator,router),rootNode});const next=f.create(f.nextModule,'next');
    assert.throws(()=>next.capture(()=>{},f.owner(2),{restoreState:state}),{code:'workspace_host_drift'});next.dispose();
  });
});

test('Native provenance remains checked after adoption and incompatible v1 resources are never migrated',async t=>{
  const f=dataRouterFixture(t),old=f.create(f.oldModule,'old'),handle=old.capture(()=>{},f.owner(1));await handle.ready;const state=await handle.exportState();old.dispose();
  f.setHost({navigator:f.review(f.nextModule),rootNode:f.rootNode});const next=f.create(f.nextModule,'next'),adopted=next.capture(()=>{},f.owner(2),{restoreState:state});await adopted.ready;
  f.router.navigate=function(){};await assert.rejects(adopted.exportState(),{code:'workspace_host_drift'});await assert.rejects(adopted.restore(),{code:'workspace_host_drift'});adopted.dispose({releaseTransfer:true});next.dispose();
  const legacy={api:1,entries:new Map([[state.token,{source:{navigator:f.review(f.oldModule),rootNode:f.rootNode},pluginId:'dev.workbench',exportedGeneration:1,holder:null,expires:Date.now()+600000}]]),epoch:0,timer:null};
  Object.defineProperty(f.document.defaultView,Symbol.for('codlet.core.workspace.locationTransfers.v1'),{value:legacy});
  const fresh=f.create(f.nextModule,'fresh');assert.throws(()=>fresh.capture(()=>{},f.owner(3),{restoreState:state}),{code:'workspace_location_transfer_retired'});assert.equal(legacy.entries.size,1);fresh.dispose();
});

test('an opaque location ticket cannot move to another Native document',async t=>{
  const f=dataRouterFixture(t),old=f.create(f.oldModule,'old'),handle=old.capture(()=>{},f.owner(1));await handle.ready;const state=await handle.exportState();old.dispose();
  const other=dataRouterFixture(t),next=other.create(other.nextModule,'next');assert.throws(()=>next.capture(()=>{},other.owner(2),{restoreState:state}),{code:'workspace_location_transfer_retired'});next.dispose();
});

function fixture(t){
  const dom=new JSDOM('<div id="root"></div>');t.after(()=>dom.window.close());
  const document=dom.window.document,privateState={nativeDraftReference:Symbol('never-json')};
  const navigator={location:{pathname:'/',search:'?draft=original',hash:'#origin',key:'original',state:privateState},push(){},replace(){},listen(){}};
  const source={navigator,rootNode:document.getElementById('root')};let host=source,guards=0;
  const create=()=>createWorkspaceLocations({document,host:()=>host,load:async()=>({restoreLocation(value){navigator.location={...value};}}),check(){},changed(){},retainGuard(){guards++;return()=>guards--;},readInput:()=>null});
  const owner=generation=>({pluginId:'dev.workbench',generation});
  return{document,navigator,privateState,source,create,owner,setHost(value){host=value;},guards:()=>guards};
}

test('location token survives provider replacement and keeps Native state out of JSON',async t=>{
  const f=fixture(t),old=f.create(),handle=old.capture(()=>{},f.owner(1));await handle.ready;
  const state=await handle.exportState();assert.deepEqual(Object.keys(state),['api','token']);
  assert.equal(JSON.stringify(state).includes('draft'),false);
  const next=f.create();assert.throws(()=>next.capture(()=>{},f.owner(2),{restoreState:state}),{code:'workspace_location_transfer_busy'});
  f.navigator.location={pathname:'/local/synthetic-task',state:null};old.dispose();assert.equal(f.guards(),0);
  const adopted=next.capture(()=>{},f.owner(2),{restoreState:JSON.parse(JSON.stringify(state))});await adopted.ready;
  assert.equal(f.guards(),1);assert.deepEqual(await adopted.restore(),{restored:true,kind:'page'});
  assert.equal(f.navigator.location.state,f.privateState);assert.equal(f.navigator.location.search,'?draft=original');
  adopted.dispose({releaseTransfer:true});assert.equal(f.guards(),0);
  assert.throws(()=>next.capture(()=>{},f.owner(3),{restoreState:state}),{code:'workspace_location_transfer_retired'});next.dispose();
});

test('failed candidate retirement preserves token for later rollback but cannot duplicate ownership',async t=>{
  const f=fixture(t),old=f.create(),handle=old.capture(()=>{},f.owner(4));await handle.ready;
  const state=await handle.exportState();handle.dispose();old.dispose();
  const candidate=f.create(),adopted=candidate.capture(()=>{},f.owner(5),{restoreState:state});await adopted.ready;
  assert.throws(()=>candidate.capture(()=>{},f.owner(6),{restoreState:state}),{code:'workspace_location_transfer_busy'});
  candidate.dispose();const rollback=f.create(),restored=rollback.capture(()=>{},f.owner(6),{restoreState:state});await restored.ready;
  await restored.restore();restored.dispose({releaseTransfer:true});rollback.dispose();assert.equal(f.guards(),0);
});

test('transfer validates same-plugin later-generation authority, state shape and Native host',async t=>{
  const f=fixture(t),old=f.create(),handle=old.capture(()=>{},f.owner(1));await handle.ready;
  const state=await handle.exportState();old.dispose();const next=f.create();
  for(const owner of [f.owner(1),{pluginId:'other',generation:2}])assert.throws(()=>next.capture(()=>{},owner,{restoreState:state}),{code:'workspace_location_transfer_retired'});
  for(const restoreState of [null,{...state,extra:true},{api:2,token:state.token},{api:1,token:123}])assert.throws(()=>next.capture(()=>{},f.owner(2),{restoreState}),{code:'invalid_argument'});
  f.setHost({...f.source,navigator:{location:{pathname:'/'}}});
  assert.throws(()=>next.capture(()=>{},f.owner(2),{restoreState:state}),{code:'workspace_host_drift'});next.dispose();
});

test('dormant transfer expires after ten minutes and cannot reacquire a Native draft',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const old=f.create(),handle=old.capture(()=>{},f.owner(1));await handle.ready;
  const state=await handle.exportState();old.dispose();
  const registry=f.document.defaultView[Symbol.for('codlet.core.workspace.locationTransfers.v2')];
  assert.equal(registry.entries.size,1);t.mock.timers.tick(10*60*1000+1);
  assert.equal(registry.entries.size,0,'housekeeping releases dormant Native refs without any API access');
  const next=f.create();assert.throws(()=>next.capture(()=>{},f.owner(2),{restoreState:state}),{code:'workspace_location_transfer_retired'});next.dispose();assert.equal(f.guards(),0);
});

test('new provider epoch replaces housekeeping while active handles remain protected',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const old=f.create(),handle=old.capture(()=>{},f.owner(1));await handle.ready;
  const state=await handle.exportState();old.dispose();const registry=f.document.defaultView[Symbol.for('codlet.core.workspace.locationTransfers.v2')],epoch=registry.epoch;
  const next=f.create();assert.ok(registry.epoch>epoch);
  const adopted=next.capture(()=>{},f.owner(2),{restoreState:state});await adopted.ready;
  t.mock.timers.tick(10*60*1000+1);assert.equal(registry.entries.size,1,'active adopted Native refs are protected');
  const refreshed=await adopted.exportState();assert.equal(refreshed.token,state.token);next.dispose();old.dispose();
  t.mock.timers.tick(10*60*1000+1);assert.equal(registry.entries.size,0,'old provider disposal cannot remove current housekeeping');
});
