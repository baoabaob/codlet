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
