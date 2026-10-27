import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../runtime/skill-bridge.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setTimeout(r,0));};
function fixture(t,{mounted=true,ambiguous=false,version='future-backend',origin='app://-',knownRoots=[],baseline=()=>({observed:true,authorityId:'native-authority'}),request=async()=>({})}={}){
  const calls=[],coreCalls=[];let registered=false,ticket=0,uncertain=false,leasePending=false,retainedRoots=knownRoots??[],proposed=retainedRoots;
  const connection=()=>{
    let sequence=0;
    const client={hostId:'local',requestClientId:'native-client',requestPromises:new Map([['initialize',{method:'initialize'}]]),getAppServerVersion:()=>version,setAppServerVersion(){},async sendRequest(method,params,options){
      const id=++sequence,pending={method};client.requestPromises.set(id,pending);calls.push({method,params,options});
      try{return await request(method,params,options,client);}finally{if(client.requestPromises.get(id)===pending)client.requestPromises.delete(id);}
    }};
    const manager={requestClient:client,getHostId:()=> 'local',getConversation(){}};
    const token={id:Symbol()},family={scope:token,read:()=>client},managerFamily={scope:token,read:()=>manager};
    const node={token,familyBindings:new Map([[family,new Map([['local',client]])],[managerFamily,new Map([['local',manager]])]])};
    return {client,manager,family,node};
  };
  const first=connection(),original=first.client.sendRequest;
  const chain=new Map([[first.node.token.id,first.node]]);
  if(ambiguous){const second=connection();chain.set(second.node.token.id,second.node);}
  const fiber={memoizedProps:{value:chain}},root={__reactContainer$test:fiber};
  let attached=mounted;
  const document={scripts:[{src:'app://-/assets/index-new-hash.js'}],readyState:'complete',getElementById:()=>attached?root:null};
  const context=vm.createContext({setTimeout,clearTimeout,Date,Map,Set,Symbol,location:{origin,pathname:'/index.html'},document,
    electronBridge:{getSentryInitOptions:()=>({appVersion:'unlisted-frontend',buildNumber:'future'})}});
  const config={marker:'test.skill',binding:'skillBinding',root:'/runtime',skillPath:'/runtime/codlet/SKILL.md'};
  const state=()=>vm.runInContext('globalThis[Symbol.for("test.skill")]',context);
  context.skillBinding=text=>{const input=JSON.parse(text);coreCalls.push(input.action);let reply;
    if(input.action==='baseline')reply=baseline(input,first.client);
    else if(input.action==='dispatch')reply={admitted:true};
    else if(input.action==='unknown'){uncertain=true;registered=false;reply={unknown:true};}
    else if(input.action==='complete'){uncertain||=input.unknown===true;registered=input.ok&&!uncertain;if(registered)retainedRoots=proposed;if(!uncertain)leasePending=false;reply={ready:registered,unknown:uncertain};}
    else if(input.action==='invalidate'){registered=false;reply={ready:false};}
    else if(input.action!=='failed'&&uncertain)reply={error:'Native skill root write outcome is unknown',unknown:true};
    else if(['set','ensure'].includes(input.action)&&leasePending)reply={busy:true};
    else if(input.action==='ensure'&&knownRoots===null)reply={error:'The current Native extra skill roots have not been observed',unobserved:true};
    else if(input.action==='ensure'&&registered)reply={ready:true};
    else {leasePending=true;proposed=(input.roots??retainedRoots).filter(p=>p!==config.root);reply={ticket:++ticket,roots:[...proposed,config.root]};}
    Promise.resolve(reply).then(value=>queueMicrotask(()=>state()?.receive(input.id,value)));
  };
  vm.runInContext('('+source+')',context)(config);
  t.after(()=>state()?.dispose([]));
  return {...first,original,context,config,calls,coreCalls,document,state,root,chain,mount:()=>{attached=true;}};
}
test('unlisted frontend and backend reuse the mounted local connection and preserve skill roots',async t=>{
  const f=fixture(t),{client,calls,coreCalls,config}=f;await settle();
  assert.equal(f.state().status,'ready');assert.equal(calls[0].method,'skills/extraRoots/set');
  await client.sendRequest('skills/list',{cwds:['/project']});assert.equal(calls.filter(c=>c.method==='skills/extraRoots/set').length,1);
  await client.sendRequest('skills/extraRoots/set',{extraRoots:['/another-root']});assert.deepEqual([...calls.at(-1).params.extraRoots],['/another-root','/runtime']);
  await client.sendRequest('turn/start',{threadId:'one',input:[{type:'text',text:'/codlet 帮我创建一个插件：'}]});
  assert.equal(calls.at(-1).params.input.at(-1).type,'skill');assert.equal(calls.at(-1).params.input.at(-1).path,config.skillPath);
  await client.sendRequest('turn/start',{threadId:'two',input:[{type:'text',text:'regular message mentioning /codlet elsewhere'}]});assert.equal(calls.at(-1).params.input.length,1);
  client.setAppServerVersion('another-version');await settle();await client.sendRequest('skills/list',{});assert.equal(f.state().clientEpoch,1);
  await settle();await f.state().dispose(['/another-root']);assert.equal(client.sendRequest,f.original);assert.deepEqual([...calls.at(-1).params.extraRoots],['/another-root']);
});
test('an already registered authority returns to ready after the same client version changes without another roots write',async t=>{
  const f=fixture(t);await f.state().ready;
  assert.equal(f.state().status,'ready');assert.equal(f.calls.filter(call=>call.method==='skills/extraRoots/set').length,1);
  f.client.setAppServerVersion('changed-version');assert.equal(f.state().status,'waiting');
  const params={cwds:['/current']},options={timeoutMs:60000};
  await f.client.sendRequest('skills/list',params,options);await settle();
  assert.equal(f.state().clientEpoch,1);assert.equal(f.state().authorityId,'native-authority');
  assert.equal(f.state().status,'ready');assert.equal(f.state().error,null);
  assert.equal(f.calls.filter(call=>call.method==='skills/extraRoots/set').length,1);
  const native=f.calls.find(call=>call.method==='skills/list');assert.equal(native.params,params);assert.equal(native.options,options);
});
for(const end of ['retired','unknown','epoch-changed'])test(`a confirmed ready reply cannot revive a ${end} skill owner`,async t=>{
  const f=fixture(t);await f.state().ready;
  const state=f.state(),binding=f.context.skillBinding;let pending;
  f.context.skillBinding=text=>{const input=JSON.parse(text);if(input.action==='ensure')pending=input;else binding(text);};
  f.client.setAppServerVersion('changed-version');await f.client.sendRequest('skills/list',{});await settle();assert.ok(pending);
  if(end==='retired')await state.dispose();
  else if(end==='unknown'){state.uncertain=true;state.status='unknown';state.error='unconfirmed Native write';}
  else f.client.setAppServerVersion('newer-version');
  state.receive(pending.id,{ready:true});await settle();
  assert.notEqual(state.status,'ready');assert.equal(f.calls.filter(call=>call.method==='skills/extraRoots/set').length,1);
  if(end==='retired'){assert.equal(state.alive,false);assert.equal(f.state(),undefined);assert.equal(f.client.sendRequest,f.original);}
  if(end==='unknown'){assert.equal(state.status,'unknown');assert.equal(state.uncertain,true);}
});
test('cold documents wait for mounted services; disposal cancels the pending wait',async t=>{
  const f=fixture(t,{mounted:false});await settle();assert.equal(f.state().status,'starting');assert.equal(f.calls.length,0);
  f.mount();await new Promise(r=>setTimeout(r,130));await settle();assert.equal(f.state().status,'ready');
  const waiting=fixture(t,{mounted:false});await settle();const old=waiting.state();assert.equal(old.delays.size,1);
  await old.dispose([]);await settle();assert.equal(old.delays.size,0);assert.equal(waiting.state(),undefined);
});
test('a backend that becomes ready after 30 seconds still installs the skill bridge',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  const f=fixture(t,{version:null});
  t.mock.timers.tick(31000);await flush();
  assert.equal(f.state().status,'waiting');assert.equal(f.client.sendRequest,f.original);
  assert.equal(f.coreCalls.includes('failed'),false);assert.equal(f.state().delays.size,1);
  f.client.getAppServerVersion=()=> 'late-backend';
  t.mock.timers.tick(1000);await flush();
  assert.equal(f.state().status,'ready');assert.equal(f.state().delays.size,0);
  assert.equal(f.calls.filter(call=>call.method==='skills/extraRoots/set').length,1);
  await f.state().dispose([]);
});
test('retirement cancels slow discovery and cannot patch a later ready client',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  const f=fixture(t,{version:null});
  t.mock.timers.tick(31000);await flush();const old=f.state();
  assert.equal(old.status,'waiting');await old.dispose([]);
  f.client.getAppServerVersion=()=> 'late-backend';t.mock.timers.tick(60000);await flush();
  assert.equal(old.delays.size,0);assert.equal(f.state(),undefined);
  assert.equal(f.client.sendRequest,f.original);assert.equal(f.calls.length,0);
});
test('ambiguous connections fail without patching either client',async t=>{
  const f=fixture(t,{ambiguous:true});await settle();assert.equal(f.state().status,'failed');assert.match(f.state().error,/ambiguous/);
  assert.equal(f.client.sendRequest,f.original);assert.equal(f.calls.length,0);assert.ok(f.coreCalls.includes('failed'));
});
test('unbound, remote and mismatched scope clients are never initialized',async t=>{
  for(const change of [f=>f.node.familyBindings.get(f.family).clear(),f=>{f.manager.getHostId=()=> 'remote';},f=>{f.family.scope={};}]){
    const f=fixture(t,{mounted:false});change(f);f.mount();await new Promise(r=>setTimeout(r,130));await settle();
    assert.equal(f.state().status,'starting');assert.equal(f.client.sendRequest,f.original);assert.equal(f.calls.length,0);
  }
});
test('non Desktop documents do not install a skill bridge',async t=>{
  const f=fixture(t,{origin:'https://example.com'});await settle();assert.equal(f.state(),undefined);assert.equal(f.calls.length,0);
});
test('large finite Native trees and scope caches still resolve the exact local client',async t=>{
  const f=fixture(t,{mounted:false});
  for(let index=0;index<600;index++)f.node.familyBindings.set({scope:{},read(){throw Error('Unowned family was read');}},new Map());
  for(let index=0;index<300;index++){const token={id:Symbol()};f.chain.set(token.id,{token,familyBindings:new Map()});}
  let tail=f.root.__reactContainer$test;
  for(let index=0;index<20500;index++){tail.child={};tail=tail.child;}
  tail.child=f.root.__reactContainer$test;
  f.mount();await new Promise(resolve=>setTimeout(resolve,130));await settle();
  assert.equal(f.state().status,'ready');assert.equal(f.coreCalls.includes('failed'),false);
  assert.equal(f.calls.filter(call=>call.method==='skills/extraRoots/set').length,1);
});
test('root registration preserves Native request options without adding a guessed Native deadline',async t=>{
  const f=fixture(t);await settle();assert.equal(f.calls[0].options,undefined);
  const options={timeoutMs:60000};
  await f.client.sendRequest('skills/extraRoots/set',{extraRoots:['/another-root']},options);
  assert.equal(f.calls.at(-1).options,options);
  assert.deepEqual([...f.calls.at(-1).params.extraRoots],['/another-root','/runtime']);
});

test('an unobserved Native roots baseline remains explicit while ordinary Native calls continue',async t=>{
  const f=fixture(t,{knownRoots:null});await settle();
  await assert.rejects(f.state().ready,{code:'native_skill_roots_unobserved'});
  assert.equal(f.calls.length,0);
  for(const method of ['skills/list','thread/start','thread/resume','thread/fork','turn/start'])await f.client.sendRequest(method,{input:[]});
  assert.equal(f.calls.length,5);assert(!f.calls.some(call=>call.method==='skills/extraRoots/set'));
  await assert.rejects(f.client.sendRequest('turn/start',{input:[{type:'text',text:'/codlet create'}]}),{code:'native_skill_roots_unobserved'});
  assert.equal(f.calls.length,5);
});

test('unknown dispatched root writes are never replayed and later independent Native sets still dispatch',async t=>{
  let roots=0;const error=Error('Native outcome unknown'),f=fixture(t,{request:async method=>{
    if(method==='skills/extraRoots/set'&&++roots===2)throw error;
    return {native:roots};
  }});await settle();
  const options={timeoutMs:60000};
  await assert.rejects(f.client.sendRequest('skills/extraRoots/set',{extraRoots:['/first']},options),value=>value===error);
  assert.equal(roots,2);assert.equal(f.state().status,'unknown');
  const params={extraRoots:['/later']};
  assert.deepEqual(await f.client.sendRequest('skills/extraRoots/set',params,options),{native:3});
  assert.equal(roots,3);assert.equal(f.calls.at(-1).params,params);assert.equal(f.calls.at(-1).options,options);
  await f.client.sendRequest('thread/start',{});assert.equal(f.calls.at(-1).method,'thread/start');
});

test('retirement reports a pending Native root write without a blind restore or late Core completion',async t=>{
  let resolve;const f=fixture(t,{request:method=>method==='skills/extraRoots/set'?new Promise(done=>{resolve=done;}):{}});await settle();
  const previous=f.state(),ready=assert.rejects(previous.ready,{code:'runtime_skill_retired'});
  assert.equal(previous.nativeWrites.size,1);
  const result=await previous.dispose(['/retained']);await ready;
  assert.equal(result.status,'unknown');assert.equal(result.reason,'native_skill_write_pending');assert.equal(f.calls.length,1);
  resolve({});await settle();assert.equal(previous.nativeWrites.size,0);assert.equal(f.coreCalls.filter(action=>action==='complete').length,0);assert.equal(f.calls.length,1);
});

test('cleanup holds its actual write before a later Native root set and preserves the later parameters',async t=>{
  let roots=0,finish;const f=fixture(t,{request:method=>method==='skills/extraRoots/set'&&++roots===2?new Promise(resolve=>{finish=resolve;}):{}});await settle();
  const disposal=f.state().dispose(['/retained']),params={extraRoots:['/newer']},options={timeoutMs:90000};
  const later=f.client.sendRequest('skills/extraRoots/set',params,options);
  assert.equal(roots,2);finish({});assert.equal((await disposal).status,'restored');await later;
  assert.equal(roots,3);assert.equal(f.calls.at(-1).params,params);assert.equal(f.calls.at(-1).options,options);
});

test('a caller can cancel an explicit skill dependency while ordinary Native requests remain live',async t=>{
  let finish;const f=fixture(t,{request:method=>method==='skills/extraRoots/set'&&!finish?new Promise(resolve=>{finish=resolve;}):{}});await settle();
  const controller=new AbortController(),reason=Error('caller cancelled');
  const pending=f.client.sendRequest('turn/start',{input:[{type:'text',text:'/codlet create'}]},{signal:controller.signal});
  const rejected=assert.rejects(pending,error=>error===reason);controller.abort(reason);await rejected;
  await f.client.sendRequest('thread/resume',{});assert.equal(f.calls.at(-1).method,'thread/resume');finish({});await f.state().ready;
});

test('baseline replies cannot authorize a reused Native pending object',async t=>{
  let finish;const f=fixture(t,{baseline:()=>new Promise(resolve=>{finish=resolve;})});await settle();
  f.client.requestPromises.set('initialize',{method:'initialize'});
  finish({observed:true,authorityId:'old-anchor'});
  await assert.rejects(f.state().ready,{code:'native_skill_owner_changed'});assert.equal(f.calls.length,0);
});

test('a second independent Native root call dispatches once while a Core write is pending and prevents a guessed commit',async t=>{
  let finish,rootCalls=0;const f=fixture(t,{request:method=>method==='skills/extraRoots/set'&&++rootCalls===1?new Promise(resolve=>{finish=resolve;}):{native:true}});await settle();
  const options={timeoutMs:90000},params={extraRoots:['/new-user-selection']};
  assert.deepEqual(await f.client.sendRequest('skills/extraRoots/set',params,options),{native:true});
  assert.equal(rootCalls,2);assert.equal(f.calls.at(-1).params,params);assert.equal(f.calls.at(-1).options,options);
  finish({});await assert.rejects(f.state().ready,{code:'native_skill_write_unknown'});
  assert.equal(f.state().status,'unknown');assert.equal(rootCalls,2);
});
