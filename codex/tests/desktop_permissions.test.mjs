import assert from 'node:assert/strict';
import test from 'node:test';
import {createPermissions} from '../frontend/src/desktop/permissions.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('cold permission exports recover before publishing options and late readers retire cleanly',async()=>{
  const f=fixture();let calls=0;
  const options={manager:f.manager,client:f.client,check(){},selection:()=>({threadId:'thread-a'}),emit(){}};
  const recovering=createPermissions({...options,load:async()=>{
    if(++calls===1)throw Object.assign(new Error('Native scope is not mounted yet'),{code:'desktop_host_pending'});
    return f.native;
  }});
  assert.equal((await recovering.get({threadId:'thread-a'})).phase,'ready');assert.equal(calls,2);recovering.dispose();
  let release,disposed=0,subscribed=0;
  const retiring=createPermissions({...options,load:()=>new Promise(resolve=>{release=resolve;})});
  const read=retiring.get({threadId:'thread-a'});await tick();retiring.dispose();
  release({...f.native,subscribe(){subscribed++;},dispose(){disposed++;}});
  await assert.rejects(read,{code:'adapter_deactivated'});assert.equal(disposed,1);assert.equal(subscribed,0);f.api.dispose();
});

test('an actual Native permission contract failure remains unsupported without an initialization retry',async()=>{
  const f=fixture();let calls=0;
  const provider=createPermissions({manager:f.manager,client:f.client,check(){},selection:()=>({threadId:'thread-a'}),emit(){},load:async()=>{calls++;throw Object.assign(Error('Native scope is ambiguous'),{code:'desktop_contract_drift'});}});
  assert.equal((await provider.get({threadId:'thread-a'})).phase,'unsupported');assert.equal(calls,1);provider.dispose();f.api.dispose();
});
function fixture(){
  let current='thread-a',mode='auto',resolveUpdate;const listeners=new Set(),events=[],calls=[],errors=[],requests=new Map();
  const threads=new Map([['thread-a',{resumeState:'resumed',latestThreadSettings:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}}}],['thread-b',{resumeState:'resumed',latestThreadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}}]]);
  const client={requestPromises:requests,addRequestLifecycleListener(fn){listeners.add(fn);return()=>listeners.delete(fn);},onError(id,error){errors.push({id,error});}};
  const manager={getConversation:id=>threads.get(id),getStreamRole:()=>({role:'owner'}),waitForPendingThreadSettingsUpdate:async()=>{},async updateThreadPermissions(id,settings){calls.push({id,settings});for(const fn of listeners)fn({type:'started',id:'permission-request',method:'thread/settings/update',params:{threadId:id}});threads.get(id).latestThreadSettings={...settings};mode=settings.approvalPolicy==='never'?'full-access':'auto';for(const fn of listeners)fn({type:'completed',id:'permission-request',method:'thread/settings/update',result:{}});}};
  const native={sendPathVerified:true,canonical:id=>threads.get(id)?.latestThreadSettings,read:()=>({phase:'ready',selection:{kind:'agent-mode',mode},source:'thread',options:['auto','full-access'].map(mode=>({selection:{kind:'agent-mode',mode},label:mode,enabled:true,reason:null})),diagnostic:null}),convert:(_id,choice)=>choice.mode==='full-access'?{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}}};
  const api=createPermissions({manager,client,check(){},selection:()=>({threadId:current}),load:async()=>native,emit:event=>events.push(event)});
  const retirements=new Set();api.register({world:'main',pluginId:'consumer',generation:1,onDeactivate(fn){retirements.add(fn);return()=>retirements.delete(fn);}});
  return{api,manager,client,threads,requests,calls,events,errors,native,listeners,retirements,setCurrent:id=>current=id};
}
test('RPC permissions keep authorization and confirmation while awaiting the actual Native update ack',async()=>{
  const f=fixture(),get=f.manager.getConversation,update=f.manager.updateThreadPermissions;
  f.manager.rpc=true;f.manager.peekConversation=get;f.manager.getConversation=async id=>structuredClone(get(id));f.manager.getStreamRole=async()=>({role:'owner'});
  delete f.manager.waitForPendingThreadSettingsUpdate;f.manager.pendingPermissionUpdate=()=>undefined;
  let finish;f.manager.updateThreadPermissions=(...args)=>new Promise(resolve=>{finish=async()=>{await update(...args);resolve();};});
  const snapshot=await f.api.get({threadId:'thread-a'});let complete=false;
  const write=f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:snapshot.revision},null,{pluginId:'consumer',generation:1}).then(value=>{complete=true;return value;});
  await tick();assert.equal(complete,false);assert.equal(typeof finish,'function');await finish();assert.equal((await write).status,'confirmed');assert.equal(f.calls.length,1);
  f.api.dispose();
});
test('RPC guards refuse an external in-flight settings update and recheck ownership after async canonical reads',async()=>{
  const f=fixture(),get=f.manager.getConversation;f.manager.rpc=true;f.manager.peekConversation=get;f.manager.getConversation=async id=>structuredClone(get(id));f.manager.getStreamRole=async()=>({role:'owner'});f.manager.pendingPermissionUpdate=()=>undefined;delete f.manager.waitForPendingThreadSettingsUpdate;
  const before=await f.api.get({threadId:'thread-a'});await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});
  const message={type:'mcp-request',hostId:'local',request:{id:'send',method:'turn/start',params:{threadId:'thread-a'}}},sent=[];
  f.requests.set('send',{});f.requests.set('external',{conversationId:'thread-a',method:'thread/settings/update'});f.api.intercept(message,value=>sent.push(value));await tick();assert.equal(sent.length,0);assert.equal(f.errors.at(-1).error.code,'permissions_busy');
  f.requests.delete('external');let finish;f.native.canonical=()=>new Promise(resolve=>{finish=resolve;});f.api.intercept(message,value=>sent.push(value));await tick();f.requests.delete('send');finish({approvalPolicy:'never'});await tick();assert.equal(sent.length,0);f.api.dispose();
});
test('authenticated permissions update uses Native conversion, monotonic revisions and a matching server acknowledgement',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});
  await assert.rejects(f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:before.revision},null,null),{code:'invalid_owner'});
  const receipt=await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});
  assert.equal(receipt.status,'confirmed');assert.ok(receipt.revision>before.revision);assert.equal(f.calls.length,1);assert.equal(f.events[0].type,'permissions.changed');assert.equal('snapshot'in f.events[0],false);
  await assert.rejects(f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1}),{code:'permissions_stale'});
});
test('Native turn/resume requests use the latest canonical policy only for a registered local conversation',async()=>{
  const f=fixture(),snapshot=await f.api.get({threadId:'thread-a'});await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:snapshot.revision},null,{pluginId:'consumer',generation:1});
  const send=(id,threadId,method='turn/start')=>({type:'mcp-request',hostId:'local',request:{id,method,params:{threadId,input:[{type:'text',text:'synthetic'}],approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}}}});
  const dispatched=[],target=send('target','thread-a');f.requests.set('target',{});f.api.intercept(target,message=>dispatched.push(message));await tick();
  assert.equal(dispatched[0].request.params.approvalPolicy,'never');assert.deepEqual(dispatched[0].request.params.input,target.request.params.input);
  f.threads.get('thread-a').latestThreadSettings={approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}};f.requests.set('resume',{});f.api.intercept(send('resume','thread-a','thread/resume'),message=>dispatched.push(message));await tick();assert.equal(dispatched[1].request.params.sandboxPolicy.type,'readOnly');
  const other=send('other','thread-b'),reply=send('reply','thread-a','approval/respond');f.api.intercept(other,message=>dispatched.push(message));f.api.intercept(reply,message=>dispatched.push(message));assert.equal(dispatched[2],other);assert.equal(dispatched[3],reply);
  f.api.dispose();const after=send('after','thread-a');f.api.intercept(after,message=>dispatched.push(message));assert.equal(dispatched[4],after);
});
test('Native mapping failure reports unsupported and cancellation before dispatch makes no permission write',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:1},controller.signal,{pluginId:'consumer',generation:1}),{code:'invocation_cancelled'});assert.equal(f.calls.length,0);
  const blocked=createPermissions({manager:f.manager,client:{},check(){},selection:()=>({threadId:'thread-a'}),load:async()=>{throw Error('Missing authoritative Native mapping');},emit(){}});
  assert.equal((await blocked.get({threadId:'thread-a'})).phase,'unsupported');
});

test('permission guards pin pending objects and keep a newer same-ID dispatch reserved',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});
  await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});
  const waits=[],sent=[];f.manager.waitForPendingThreadSettingsUpdate=()=>new Promise(resolve=>waits.push(resolve));
  const message=value=>({type:'mcp-request',hostId:'local',request:{id:'reused',method:'turn/start',params:{threadId:'thread-a',input:[{type:'text',text:value}]}}});
  f.requests.set('reused',{});f.api.intercept(message('old'),value=>sent.push(value));await tick();
  const next={};f.requests.set('reused',next);f.api.intercept(message('new'),value=>sent.push(value));await tick();
  waits[0]();await tick();assert.equal(sent.length,0);assert.equal(f.errors.length,0);assert.equal(f.requests.get('reused'),next);assert.throws(()=>f.api.captureState(),{code:'permissions_busy'});
  waits[1]();await tick();assert.equal(sent.length,1);assert.equal(sent[0].request.params.input[0].text,'new');f.api.dispose();
});
test('cancelled in-flight permission writes report unknown outcome and their next Native send still waits for canonical settings',async()=>{
  const f=fixture(),controller=new AbortController(),before=await f.api.get({threadId:'thread-a'});let finish;
  f.manager.updateThreadPermissions=async(id,settings)=>{await new Promise(resolve=>{finish=resolve;});f.threads.get(id).latestThreadSettings=settings;};
  const change=f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:before.revision},controller.signal,{pluginId:'consumer',generation:1});await tick();controller.abort();finish();
  await assert.rejects(change,{code:'outcome_unknown'});
  const sent=[];f.requests.set('pending-native',{});f.api.intercept({type:'mcp-request',hostId:'local',request:{id:'pending-native',method:'turn/start',params:{threadId:'thread-a',approvalPolicy:'on-request'}}},message=>sent.push(message));await tick();assert.equal(sent[0].request.params.approvalPolicy,'never');
});
test('a settings update on an older Native protocol returns staged rather than claiming server persistence',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});
  f.manager.updateThreadPermissions=async(id,settings)=>{f.threads.get(id).latestThreadSettings=settings;};
  const receipt=await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});assert.equal(receipt.status,'staged');
});

test('concurrent permission writes reserve the conversation before asynchronous Native reads',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});let release;
  const read=f.native.read;f.native.read=async()=>{await new Promise(resolve=>{release=resolve;});return read();};
  const args={threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},principal={pluginId:'consumer',generation:1};
  const first=f.api.update(args,null,principal);await tick();
  await assert.rejects(f.api.update(args,null,principal),{code:'permissions_busy'});
  f.native.read=read;release();await first;assert.equal(f.calls.length,1);
});

test('a staged write followed by selection loss keeps the canonical send guard and reports unknown outcome',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});
  f.manager.updateThreadPermissions=async(id,settings)=>{f.threads.get(id).latestThreadSettings=settings;f.setCurrent('thread-b');};
  await assert.rejects(f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1}),{code:'outcome_unknown'});
  const sent=[];f.requests.set('after-selection-loss',{});
  f.api.intercept({type:'mcp-request',hostId:'local',request:{id:'after-selection-loss',method:'turn/start',params:{threadId:'thread-a',approvalPolicy:'on-request'}}},value=>sent.push(value));await tick();
  assert.equal(sent[0].request.params.approvalPolicy,'never');
});

test('Native full-access confirmation is revision bound and cancellation makes no write',async()=>{
  const f=fixture(),read=f.native.read;f.native.read=()=>{const value=read();value.options[1].requiresConfirmation=true;return value;};
  const before=await f.api.get({threadId:'thread-a'}),args={threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:before.revision},principal={pluginId:'consumer',generation:1};
  await assert.rejects(f.api.update(args,null,principal),{code:'permissions_confirmation_required'});assert.equal(f.calls.length,0);
  f.api.changed('thread-a');await assert.rejects(f.api.update({...args,confirmed:true},null,principal),{code:'permissions_stale'});assert.equal(f.calls.length,0);
  const fresh=await f.api.get({threadId:'thread-a'});await f.api.update({...args,confirmed:true,expectedRevision:fresh.revision},null,principal);assert.equal(f.calls.length,1);
});

test('owner retirement revokes registrations, rejects stale generations and cancels a waiting Native dispatch',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'}),principal={pluginId:'consumer',generation:1};
  await assert.rejects(f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{...principal,generation:2}),{code:'invalid_owner'});
  await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,principal);
  let finish;f.manager.waitForPendingThreadSettingsUpdate=()=>new Promise(resolve=>{finish=resolve;});const sent=[];
  f.requests.set('retired',{});f.api.intercept({type:'mcp-request',hostId:'local',request:{id:'retired',method:'turn/start',params:{threadId:'thread-a'}}},value=>sent.push(value));await tick();
  for(const retire of [...f.retirements])retire();finish();await tick();assert.equal(sent.length,0);assert.equal(f.errors[0].error.code,'permissions_owner_retired');
  const after={type:'mcp-request',hostId:'local',request:{id:'later',method:'turn/start',params:{threadId:'thread-a'}}};f.api.intercept(after,value=>sent.push(value));assert.equal(sent[0],after);
});

test('failed or unrelated lifecycle completion cannot advertise confirmed server persistence',async()=>{
  for(const event of [{type:'failed',id:'matching',method:'thread/settings/update',error:Error('synthetic rejection')},{type:'completed',id:'other',method:'thread/settings/update',result:{}},{type:'completed',id:'matching',method:'thread/settings/update',error:{code:1},result:{}}]){
    const f=fixture(),before=await f.api.get({threadId:'thread-a'});
    f.manager.updateThreadPermissions=async(id,settings)=>{for(const fn of f.listeners)fn({type:'started',id:'matching',method:'thread/settings/update',params:{threadId:id}});for(const fn of f.listeners)fn(event);f.threads.get(id).latestThreadSettings=settings;};
    const receipt=await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});assert.equal(receipt.status,'staged');f.api.dispose();
  }
});

test('public read DTO mutations cannot change the provider revision or options',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});before.options[0].enabled=false;
  const again=await f.api.get({threadId:'thread-a'});assert.equal(again.revision,before.revision);assert.equal(again.options[0].enabled,true);
  f.setCurrent('thread-b');const other=await f.api.get({threadId:'thread-b'});f.setCurrent('thread-a');assert.ok((await f.api.get({threadId:'thread-a'})).revision>other.revision);
});

test('streaming conversation updates do not resample permission menus or emit unchanged permission events',async()=>{
  const f=fixture();await f.api.get({threadId:'thread-a'});const read=f.native.read;let reads=0;f.native.read=()=>{reads++;return read();};
  for(let i=0;i<1000;i++){f.threads.get('thread-a').streamedText='synthetic '+i;f.api.observe('thread-a');}
  assert.equal(reads,0);assert.equal(f.events.length,0);
  f.threads.get('thread-a').latestThreadSettings={...f.threads.get('thread-a').latestThreadSettings,approvalPolicy:'never'};f.api.observe('thread-a');assert.equal(f.events.length,1);assert.equal('snapshot'in f.events[0],false);
});

test('a Native option change during conversion rejects before any settings update',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'}),convert=f.native.convert;
  f.native.convert=(...args)=>{f.native.read=()=>({phase:'unsupported',options:[],diagnostic:{code:'permissions_unsupported',message:'Synthetic Native change'}});return convert(...args);};
  await assert.rejects(f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1}),{code:'permissions_stale'});assert.equal(f.calls.length,0);
});

test('a resume inside the pending settings lifecycle cannot wait on its own update',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});let finish,waits=0;
  f.manager.updateThreadPermissions=async(id,settings)=>{await new Promise(resolve=>{finish=resolve;});f.threads.get(id).latestThreadSettings=settings;};
  f.manager.waitForPendingThreadSettingsUpdate=async()=>{waits++;};
  const change=f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});await tick();
  const sent=[];f.requests.set('recursive-resume',{});f.api.intercept({type:'mcp-request',hostId:'local',request:{id:'recursive-resume',method:'thread/resume',params:{threadId:'thread-a'}}},value=>sent.push(value));
  assert.equal(f.errors[0].error.code,'permissions_busy');assert.equal(waits,0);assert.equal(sent.length,0);finish();await change;assert.equal(waits,1);
});

test('reads alone retain the original Native send baseline; an explicit update opts into the canonical guard',async()=>{
  const f=fixture(),read=f.native.read,seen=[];
  f.native.read=(_id,options)=>{seen.push(options.canonical);const value=read();if(!options.canonical)value.selection={kind:'agent-mode',mode:'full-access'};return value;};
  const before=await f.api.get({threadId:'thread-a'});assert.equal(before.selection.mode,'full-access');
  const original={type:'mcp-request',hostId:'local',request:{id:'unmodified',method:'turn/start',params:{threadId:'thread-a',approvalPolicy:'never'}}},sent=[];
  f.api.intercept(original,value=>sent.push(value));assert.equal(sent[0],original);assert.equal(f.calls.length,0);
  await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});
  assert.equal((await f.api.get({threadId:'thread-a'})).selection.mode,'auto');assert.equal(seen.at(-1),true);assert.equal(seen[0],false);
});

test('Core provider reload transfers only logical guard identities and rereads canonical settings without a permission rewrite',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});
  await f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'full-access'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});
  const saved=JSON.parse(JSON.stringify(f.api.captureState()));
  assert.deepEqual(saved,{guards:[{threadId:'thread-a',pluginId:'consumer',generation:1}]});
  assert.doesNotMatch(JSON.stringify(saved),/approvalPolicy|sandboxPolicy|permissions|draft|selection/);
  const oldRetirements=[...f.retirements];for(const retire of oldRetirements)retire();f.api.dispose();
  // Native changed independently after capture. Its new canonical value must
  // win; restoring this identity never converts or writes an old settings DTO.
  f.threads.get('thread-a').latestThreadSettings={approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}};
  let conversions=0;f.native.convert=()=>{conversions++;throw Error('restore must not convert Native settings');};
  const restored=createPermissions({manager:f.manager,client:f.client,check(){},selection:()=>({threadId:'thread-a'}),load:async()=>f.native,emit(){}});
  await restored.restoreState(saved);assert.equal(f.calls.length,1);assert.equal(conversions,0);
  const sent=[];f.requests.set('during-handoff',{});
  restored.intercept({type:'mcp-request',hostId:'local',request:{id:'during-handoff',method:'turn/start',params:{threadId:'thread-a',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}}},value=>sent.push(value));await tick();
  assert.equal(sent[0].request.params.approvalPolicy,'on-request');assert.equal(sent[0].request.params.sandboxPolicy.type,'readOnly');
  assert.throws(()=>restored.register({world:'main',pluginId:'consumer',generation:1,onDeactivate(){return()=>{};}}),{code:'invalid_owner'});
  let retireFresh;restored.register({world:'main',pluginId:'consumer',generation:2,onDeactivate(fn){retireFresh=fn;return()=>{};}});
  for(const retire of oldRetirements)retire();
  assert.deepEqual(restored.captureState(),{guards:[{threadId:'thread-a',pluginId:'consumer',generation:2}]});
  await assert.rejects(restored.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:1},null,{pluginId:'consumer',generation:1}),{code:'invalid_owner'});
  retireFresh();assert.deepEqual(restored.captureState(),{guards:[]});assert.equal(conversions,0);assert.equal(f.calls.length,1);restored.dispose();
});

test('Core permission checkpoints refuse pending writes and pending Native sends instead of retiring accepted work',async()=>{
  const f=fixture(),before=await f.api.get({threadId:'thread-a'});let finish;
  f.manager.updateThreadPermissions=async(id,settings)=>{await new Promise(resolve=>{finish=resolve;});f.threads.get(id).latestThreadSettings=settings;};
  const update=f.api.update({threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,{pluginId:'consumer',generation:1});await tick();
  assert.throws(()=>f.api.captureState(),{code:'permissions_busy'});finish();await update;
  f.manager.waitForPendingThreadSettingsUpdate=()=>new Promise(resolve=>{finish=resolve;});const sent=[];f.requests.set('accepted',{});
  f.api.intercept({type:'mcp-request',hostId:'local',request:{id:'accepted',method:'turn/start',params:{threadId:'thread-a'}}},value=>sent.push(value));await tick();
  assert.throws(()=>f.api.captureState(),{code:'permissions_busy'});assert.equal(sent.length,0);finish();await tick();
  assert.equal(sent.length,1);assert.equal(f.api.captureState().guards.length,1);assert.equal(f.errors.length,0);f.api.dispose();
});

test('restored permission metadata rejects Native settings, duplicate threads and conflicts with a live owner',async()=>{
  const f=fixture();
  for(const state of [{guards:[],approvalPolicy:'never'},{guards:[{threadId:'thread-a',pluginId:'consumer',generation:1,settings:{approvalPolicy:'never'}}]},{guards:[{threadId:'thread-a',pluginId:'consumer',generation:1},{threadId:'thread-a',pluginId:'consumer',generation:2}]}]){
    await assert.rejects(f.api.restoreState(state),{code:'permissions_state_invalid'});
  }
  await assert.rejects(f.api.restoreState({guards:[]}),{code:'permissions_state_conflict'});assert.equal(f.calls.length,0);f.api.dispose();
});
