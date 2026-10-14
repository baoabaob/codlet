import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {createWorkspaceLocations} from '../frontend/src/adapter/workspace-location.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

function fixture(t){
  const dom=new JSDOM('<div id="root"></div>');t.after(()=>dom.window.close());
  const document=dom.window.document,privateState={nativeDraftReference:Symbol('never-json')};
  const navigator={location:{pathname:'/',search:'?draft=original',hash:'#origin',key:'original',state:privateState}};
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
  const registry=f.document.defaultView[Symbol.for('codlet.core.workspace.locationTransfers.v1')];
  assert.equal(registry.entries.size,1);t.mock.timers.tick(10*60*1000+1);
  assert.equal(registry.entries.size,0,'housekeeping releases dormant Native refs without any API access');
  const next=f.create();assert.throws(()=>next.capture(()=>{},f.owner(2),{restoreState:state}),{code:'workspace_location_transfer_retired'});next.dispose();assert.equal(f.guards(),0);
});

test('new provider epoch replaces housekeeping while active handles remain protected',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const old=f.create(),handle=old.capture(()=>{},f.owner(1));await handle.ready;
  const state=await handle.exportState();old.dispose();const registry=f.document.defaultView[Symbol.for('codlet.core.workspace.locationTransfers.v1')],epoch=registry.epoch;
  const next=f.create();assert.ok(registry.epoch>epoch);
  const adopted=next.capture(()=>{},f.owner(2),{restoreState:state});await adopted.ready;
  t.mock.timers.tick(10*60*1000+1);assert.equal(registry.entries.size,1,'active adopted Native refs are protected');
  const refreshed=await adopted.exportState();assert.equal(refreshed.token,state.token);next.dispose();old.dispose();
  t.mock.timers.tick(10*60*1000+1);assert.equal(registry.entries.size,0,'old provider disposal cannot remove current housekeeping');
});
