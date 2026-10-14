import assert from 'node:assert/strict';
import test from 'node:test';
import {attachNativeIngress} from '../frontend/src/desktop/native-ingress.js';
const symbol=Symbol.for('codlet.core.native-ingress.v1');
function fixture(){
  const global={},sent=[],errors=[],client={requestPromises:new Map(),onError(id,error){errors.push({id,error});this.requestPromises.delete(id);}};
  const postbox={postMessage(message){sent.push({owner:'native',message});}},original=postbox.postMessage;
  const attach=owner=>attachNativeIngress({global,postbox,client,dispatch(message){sent.push({owner,message});}});
  const owner=attach('old'),api=global[symbol];
  const request=(id,extra={})=>{client.requestPromises.set(id,{});return{type:'mcp-request',hostId:'local',request:{id,method:'turn/start',params:{threadId:'fixture',input:[{type:'text',text:'synthetic'}]}},...extra};};
  return{global,sent,errors,client,postbox,original,attach,owner,api,request};
}
test('held ingress survives old provider retirement and enters only the acknowledged current owner once',()=>{
  const f=fixture(),accepted=f.request('accepted');f.postbox.postMessage(accepted);
  assert.equal(Object.isFrozen(f.api),true);assert.equal(f.api.api,1);
  assert.equal(f.api.pause('update-1').held,true);const wrapper=f.postbox.postMessage;
  const queued=f.request('queued');f.postbox.postMessage(queued);queued.request.params.input[0].text='later mutation';
  f.owner.detach();assert.equal(f.postbox.postMessage,wrapper);assert.equal(f.global[symbol],f.api);
  const gap=f.request('during-gap');f.postbox.postMessage(gap);
  assert.equal(f.api.resume('update-1',{outcome:'applied'}).code,'core_ingress_unsupported');assert.equal(f.sent.length,1);
  const next=f.attach('new');assert.equal(f.global[symbol],f.api);assert.equal(f.postbox.postMessage,wrapper);
  assert.equal(f.api.resume('update-1',{outcome:'applied'}).resumed,true);
  assert.deepEqual(f.sent.map(value=>[value.owner,value.message.request.id]),[['old','accepted'],['new','queued'],['new','during-gap']]);
  assert.equal(f.sent[1].message.request.params.input[0].text,'synthetic');
  assert.equal(f.api.resume('update-1',{outcome:'applied'}).code,'core_ingress_stale');assert.equal(f.sent.length,3);
  assert.throws(()=>f.owner.coreDispatch(()=>{}),{code:'desktop_patch_drift'});next.detach();assert.equal(f.postbox.postMessage,f.original);assert.equal(f.global[symbol],undefined);
});
test('responses and already admitted Core Native dispatch remain live while ordinary Native request ingress is held',()=>{
  const f=fixture();f.api.pause('drain');f.postbox.postMessage(f.request('new-write'));
  f.postbox.postMessage({type:'mcp-response',hostId:'local',response:{id:'already-sent',result:{ok:true}}});
  f.owner.coreDispatch(()=>f.postbox.postMessage(f.request('accepted-sdk-descendant')));
  assert.deepEqual(f.sent.map(value=>value.message.request?.id??value.message.response.id),['already-sent','accepted-sdk-descendant']);
  assert.throws(()=>f.owner.coreDispatch(()=>{throw Error('synthetic');}),/synthetic/);
  f.postbox.postMessage(f.request('after-exception'));assert.equal(f.sent.length,2);
  f.api.resume('drain',{outcome:'rolledBack'});assert.deepEqual(f.sent.slice(2).map(value=>value.message.request.id),['new-write','after-exception']);f.owner.detach();
});
test('unknown outcomes, wrong operations, cancellation, expiry, and drift never silently replay a write',()=>{
  const f=fixture();f.api.pause('operation');f.postbox.postMessage(f.request('cancelled'));f.client.requestPromises.delete('cancelled');
  f.postbox.postMessage(f.request('expired',{expiresAtMs:Date.now()+50}));
  f.postbox.postMessage(f.request('live'));
  assert.equal(f.api.pause('other').code,'core_ingress_busy');assert.equal(f.api.resume('other',{outcome:'applied'}).code,'core_ingress_stale');
  assert.equal(f.api.resume('operation',{outcome:'unknown'}).ok,false);assert.equal(f.sent.length,0);
  const oldNow=Date.now;Date.now=()=>oldNow()+100;
  try{assert.equal(f.api.resume('operation',{outcome:'rolledBack'}).ok,true);}finally{Date.now=oldNow;}
  assert.deepEqual(f.sent.map(value=>value.message.request.id),['live']);assert.equal(f.errors[0].id,'expired');assert.equal(f.errors[0].error.code,'core_ingress_expired');
  f.api.pause('drift');f.postbox.postMessage=f.original;
  assert.equal(f.api.resume('drift',{outcome:'applied'}).code,'core_ingress_unsupported');assert.throws(()=>f.owner.detach(),{code:'desktop_patch_drift'});
});
test('queue bounds reject excess Native calls through their own request lifecycle without sending them',()=>{
  const f=fixture();f.api.pause('bounded');
  for(let i=0;i<65;i++)f.postbox.postMessage(f.request(`request-${i}`));
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].id,'request-64');assert.equal(f.errors[0].error.code,'core_ingress_limit');assert.equal(f.sent.length,0);
  f.api.resume('bounded',{outcome:'rolledBack'});assert.equal(f.sent.length,64);f.owner.detach();
});
test('candidate retirement preserves the held queue for rollback and a changed Native connection cannot take it over',()=>{
  const f=fixture();f.api.pause('rollback');f.postbox.postMessage(f.request('held'));f.owner.detach();
  assert.throws(()=>attachNativeIngress({global:f.global,postbox:f.postbox,client:{requestPromises:new Map(),onError(){}},dispatch(){}}),{code:'core_ingress_conflict'});
  const candidate=f.attach('candidate');candidate.detach();assert.equal(f.sent.length,0);
  const rollback=f.attach('rollback');f.api.resume('rollback',{outcome:'rolledBack'});assert.deepEqual(f.sent.map(value=>value.owner),['rollback']);rollback.detach();
});
test('an old queued request cannot replay into or reject a new Native pending record reusing its identity',()=>{
  const f=fixture();f.api.pause('epoch');f.postbox.postMessage(f.request('reused'));f.client.requestPromises.delete('reused');
  const newPending={newGeneration:true};f.client.requestPromises.set('reused',newPending);
  f.api.resume('epoch',{outcome:'rolledBack'});assert.equal(f.sent.length,0);assert.equal(f.errors.length,0);assert.equal(f.client.requestPromises.get('reused'),newPending);f.owner.detach();
});
test('stable wrapper and API release the retired dispatch lexical environment after takeover', {skip:typeof globalThis.gc!=='function'},async()=>{
  const global={},postbox={postMessage(){}},client={requestPromises:new Map(),onError(){}};
  let weak;
  (()=>{
    const generation={privateOldProvider:true};weak=new WeakRef(generation);
    const owner=attachNativeIngress({global,postbox,client,dispatch(){return generation;}});
    global[symbol].pause('gc');owner.detach();
  })();
  const next=attachNativeIngress({global,postbox,client,dispatch(){}}),stable=postbox.postMessage,api=global[symbol];
  // WeakRef targets are kept alive to the end of the current job. Collect only
  // across event-loop turns, without retaining the old owner or deref result.
  for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();}
  assert.equal(weak.deref(),undefined);assert.equal(postbox.postMessage,stable);assert.equal(global[symbol],api);
  api.resume('gc',{outcome:'applied'});next.detach();
});
test('new Native documents inherit the private Core SDK transaction hold before their first request',()=>{
  const global={[Symbol.for('codlet.core.renderer-admission.v1')]:{api:1,operationId:'future-document'}},sent=[],client={requestPromises:new Map(),onError(){}};
  const postbox={postMessage(message){sent.push(message);}};
  const owner=attachNativeIngress({global,postbox,client,dispatch(message){sent.push(message);}});
  client.requestPromises.set('new-document-request',{});
  postbox.postMessage({type:'mcp-request',hostId:'local',request:{id:'new-document-request',method:'turn/start',params:{threadId:'synthetic'}}});
  assert.equal(sent.length,0);owner.detach();assert.equal(global[symbol].resume('other',{outcome:'applied'}).ok,false);assert.equal(sent.length,0);
  const next=attachNativeIngress({global,postbox,client,dispatch(message){sent.push(message);}});
  global[Symbol.for('codlet.core.renderer-admission.v1')].operationId=null;
  global[symbol].resume('future-document',{outcome:'rolledBack'});assert.equal(sent.length,1);next.detach();
});
