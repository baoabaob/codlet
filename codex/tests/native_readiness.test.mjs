import test from 'node:test';
import assert from 'node:assert/strict';
import {awaitNativeInitialization,memoizeNativeLoad} from '../frontend/src/adapter/native-readiness.js';
import {createWorkspaceDiscovery} from '../frontend/src/adapter/workspace-discovery.js';
const pending=()=>Object.assign(new Error('Native initializer pending'),{code:'ui_host_pending'});

test('cold Native failures recover without poisoning the shared preparation promise',async()=>{
  let calls=0;const value={},load=memoizeNativeLoad(async()=>{if(++calls===1)throw pending();return value;});
  const first=load();assert.equal(load(),first);await assert.rejects(first,{code:'ui_host_pending'});
  assert.equal(await load(),value);assert.equal(await load(),value);assert.equal(calls,2);
});

test('Native readiness backs off while pending, stops at its deadline and never retries ambiguity',async()=>{
  let now=0,calls=0;const delays=[];
  await assert.rejects(awaitNativeInitialization(async()=>{calls++;throw pending();},{timeout:400,clock:()=>now,pause:async ms=>{delays.push(ms);now+=ms;}}),{code:'ui_host_pending'});
  assert.deepEqual(delays,[50,100,200,50]);assert.equal(calls,5);
  let attempts=0;await assert.rejects(awaitNativeInitialization(async()=>{attempts++;throw Object.assign(new Error('A unique native scope is required (found 2)'),{code:'desktop_contract_drift'});},{pause:()=>assert.fail('must not retry ambiguity')}),{code:'desktop_contract_drift'});
  assert.equal(attempts,1);
  await assert.rejects(awaitNativeInitialization(async()=>{throw Object.assign(new Error('A unique native scope is required (found 0)'),{code:'desktop_contract_drift'});},{pause:()=>assert.fail('a missing contract is not initialization evidence')}),{code:'desktop_contract_drift'});
});

test('Native initialization can complete after a slow startup without a Core-imposed deadline',async()=>{
  let now=0,calls=0;
  assert.equal(await awaitNativeInitialization(async()=>{if(++calls<40)throw pending();return 'ready';},{clock:()=>now,pause:async ms=>{now+=ms;}}),'ready');
  assert.ok(now>15000);
});

test('retired preparation cannot publish a late successful loader or retain a retry timer',async()=>{
  const controller=new AbortController();let release;
  const ready=awaitNativeInitialization(()=>new Promise(resolve=>{release=resolve;}),{signal:controller.signal});
  controller.abort();await assert.rejects(ready,{name:'AbortError'});release({});
  const next=new AbortController();const waiting=awaitNativeInitialization(async()=>{next.abort();throw pending();},{signal:next.signal,pause:()=>assert.fail('must not schedule after retirement')});
  await assert.rejects(waiting,{name:'AbortError'});
});

test('workspace module discovery retries a cold base without importing unrelated Native code',async t=>{
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  const initial='app://-/assets/app-initial-cold.js',shared='app://-/assets/app-shared-cold.js';
  globalThis.document={querySelectorAll:()=>[{href:initial},{href:shared}]};globalThis.location={origin:'app://-',pathname:'/index.html'};
  t.after(()=>{globalThis.document=oldDocument;globalThis.location=oldLocation;});
  let bases=0,imports=0;const native={React:{},Client:{},RailButton(){},RailTooltip(){}};
  const discovery=createWorkspaceDiscovery(async()=>{if(++bases===1)throw pending();return native;},{load:async()=>{imports++;return{};}});
  t.after(()=>discovery.dispose());
  const action=await awaitNativeInitialization(()=>discovery.action(),{pause:async()=>{}});
  assert.equal(action.Button,native.RailButton);assert.equal(bases,2);assert.equal(imports,2);
  assert.equal((await discovery.action()).Button,action.Button);assert.equal(imports,2);
});

test('action discovery reads the current mounted navigation contract after a classic-to-rail change',async t=>{
  const previous={document:globalThis.document,location:globalThis.location};
  globalThis.document={querySelectorAll:()=>[{href:'app://-/assets/app-initial-current.js'},{href:'app://-/assets/app-shared-current.js'}]};
  globalThis.location={origin:'app://-',pathname:'/index.html'};
  t.after(()=>Object.assign(globalThis,previous));
  let current={},bases=0,imports=0;
  const native={React:{},Client:{},resolveNavigation:()=>current};
  const discovery=createWorkspaceDiscovery(async()=>{bases++;return native;},{load:async()=>{imports++;return{};}});
  t.after(()=>discovery.dispose());
  await assert.rejects(discovery.action(),{code:'workspace_action_unavailable'});
  current={RailButton(){},RailTooltip(){}};
  const first=await discovery.action();assert.equal(first.Button,current.RailButton);assert.equal(first.Tooltip,current.RailTooltip);
  current={RailButton(){},RailTooltip(){}};
  const second=await discovery.action();assert.equal(second.Button,current.RailButton);assert.notEqual(second.Button,first.Button);
  assert.equal(bases,1);assert.equal(imports,2,'only layout discovery refreshes; imported Native modules remain cached');
});
test('workspace cached results and captured connection checks reject a retired asset owner',async t=>{
  const previous={document:globalThis.document,location:globalThis.location},root={},internal={containerInfo:root};internal.current={stateNode:internal};root.__reactContainer$test={stateNode:internal};
  globalThis.document={scripts:[],getElementById:()=>root,querySelectorAll:()=>[{href:'app://-/assets/app-initial-owned.js'},{href:'app://-/assets/app-shared-owned.js'}]};globalThis.location={origin:'app://-',pathname:'/index.html'};t.after(()=>Object.assign(globalThis,previous));
  let imports=0;const discovery=createWorkspaceDiscovery(async()=>({React:{},Client:{},RailButton(){},RailTooltip(){}}),{load:async()=>{imports++;return{};},connect:()=>assert.fail('A retired asset proof must reject before connection discovery')});t.after(()=>discovery.dispose());
  await discovery.action();assert.equal(imports,2);root.__reactContainer$test={stateNode:{}};
  await assert.rejects(discovery.action(),{code:'desktop_asset_owner_replaced'});assert.throws(()=>discovery.connection(),{code:'desktop_asset_owner_replaced'});assert.equal(imports,2);
});
test('workspace late module receipts cannot publish after the asset root changes',async t=>{
  const previous={document:globalThis.document,location:globalThis.location};let root={};
  globalThis.document={scripts:[],getElementById:()=>root,querySelectorAll:()=>[{href:'app://-/assets/app-initial-late.js'},{href:'app://-/assets/app-shared-late.js'}]};globalThis.location={origin:'app://-',pathname:'/index.html'};t.after(()=>Object.assign(globalThis,previous));
  let complete,entered;const started=new Promise(resolve=>entered=resolve),discovery=createWorkspaceDiscovery(async()=>({React:{},Client:{},RailButton(){},RailTooltip(){}}),{load:async url=>{if(url.includes('app-shared')){entered();await new Promise(resolve=>complete=resolve);}return{};}});t.after(()=>discovery.dispose());
  const pending=discovery.action();await started;root={};complete();await assert.rejects(pending,{code:'desktop_asset_owner_replaced'});
});
