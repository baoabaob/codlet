import assert from 'node:assert/strict';
import test from 'node:test';
import {attachNativeIngress} from '../frontend/src/desktop/native-ingress.js';
const symbol=Symbol.for('codlet.core.native-ingress.v1');
function fixture(){
  const global={},sent=[],errors=[],client={requestPromises:new Map(),onError(id,error){errors.push({id,error});this.requestPromises.delete(id);}};
  const postbox={postMessage(...args){sent.push({owner:'native',receiver:this,args,message:args[0]});return args[1];}},original=postbox.postMessage;
  const attach=owner=>attachNativeIngress({global,postbox,client,dispatch(...args){sent.push({owner,receiver:this,args,message:args[0]});return args[1];}});
  const owner=attach('old'),api=global[symbol];
  const request=id=>{client.requestPromises.set(id,{});return{type:'mcp-request',hostId:'local',request:{id,method:'turn/start',params:{threadId:'fixture'}}};};
  return{global,sent,errors,client,postbox,original,attach,owner,api,request};
}
test('Native calls keep their receiver, arguments and result through Core update, retirement and rollback',()=>{
  const f=fixture();f.postbox.postMessage(f.request('before'));
  assert.equal(Object.isFrozen(f.api),true);assert.equal(f.api.pause('update').held,true);
  const wrapper=f.postbox.postMessage,receiver={},result=Promise.resolve('native'),message=f.request('held');
  assert.equal(wrapper.call(receiver,message,result),result);
  assert.equal(f.sent[1].receiver,receiver);assert.equal(f.sent[1].message,message);assert.deepEqual(f.sent[1].args,[message,result]);
  f.owner.detach();wrapper.call(receiver,f.request('gap'));
  assert.equal(f.api.resume('update',{outcome:'applied'}).code,'core_ingress_unsupported');
  const candidate=f.attach('candidate');wrapper(f.request('candidate'));candidate.detach();
  const rollback=f.attach('rollback');
  assert.equal(f.api.resume('update',{outcome:'rolledBack'}).resumed,true);
  assert.equal(f.sent.length,4);f.postbox.postMessage(f.request('after'));
  assert.deepEqual(f.sent.map(value=>value.owner),['old','old','native','candidate','rollback']);
  assert.throws(()=>f.owner.coreDispatch(()=>{}),{code:'desktop_patch_drift'});
  rollback.detach();assert.equal(f.postbox.postMessage,f.original);assert.equal(f.global[symbol],undefined);
});
test('unknown or stalled Core handoffs never queue, expire, clone or reject Native traffic',()=>{
  const f=fixture();f.api.pause('stalled');
  for(let i=0;i<300;i++)f.postbox.postMessage(f.request(`request-${i}`));
  const cyclic=f.request('native-owned');cyclic.self=cyclic;cyclic.expiresAtMs=0;
  f.postbox.postMessage(cyclic);f.postbox.postMessage(cyclic);f.postbox.postMessage();
  assert.equal(f.sent.length,303);assert.equal(f.sent[300].message,cyclic);assert.deepEqual(f.sent[302].args,[]);assert.deepEqual(f.errors,[]);
  assert.equal(f.api.pause('other').code,'core_ingress_busy');assert.equal(f.api.resume('stalled',{outcome:'unknown'}).ok,false);
  f.postbox.postMessage(f.request('after-unknown'));assert.equal(f.sent.length,304);
  f.api.resume('stalled',{outcome:'rolledBack'});assert.equal(f.sent.length,304);f.owner.detach();
});
test('Native synchronous errors retain their identity during a held handoff',()=>{
  const error=Error('native failure'),global={},postbox={postMessage(){throw error;}},client={requestPromises:new Map(),onError(){assert.fail('Core must not replace a Native error');}};
  const original=postbox.postMessage,owner=attachNativeIngress({global,postbox,client,dispatch:original});global[symbol].pause('handoff');
  assert.throws(()=>postbox.postMessage({}),value=>value===error);
  assert.throws(()=>owner.coreDispatch(()=>postbox.postMessage({})),value=>value===error);
  assert.throws(()=>owner.coreDispatch(()=>{throw error;}),value=>value===error);
  assert.throws(()=>postbox.postMessage({}),value=>value===error);
  global[symbol].resume('handoff',{outcome:'applied'});owner.detach();
});
test('new Native documents forward while the Core SDK admission lease is held',()=>{
  const global={[Symbol.for('codlet.core.renderer-admission.v1')]:{api:1,operationId:'future-document'}},sent=[],client={requestPromises:new Map(),onError(){}};
  const postbox={postMessage(message){sent.push(message);}},message={type:'mcp-request',hostId:'local',request:{id:'new',method:'turn/start'}};
  const owner=attachNativeIngress({global,postbox,client,dispatch:postbox.postMessage});
  postbox.postMessage(message);assert.deepEqual(sent,[message]);owner.detach();postbox.postMessage(message);assert.equal(sent.length,2);
});
test('takeover releases only undispatched, still-current requests from an older queue once',()=>{
  const f=fixture();f.api.pause('legacy');f.owner.detach();
  const state=f.global[Symbol.for('codlet.core.native-ingress.owner.v1')];
  const current=f.request('current'),cancelled=f.request('cancelled'),reused=f.request('reused');
  const entry=message=>({message,receiver:f.postbox,rest:[],pending:f.client.requestPromises.get(message.request.id),expires:Date.now()+10000});
  state.queue=[entry(current),entry(cancelled),entry(reused)];state.bytes=100;
  f.client.requestPromises.delete('cancelled');f.client.requestPromises.set('reused',{});
  const next=f.attach('new');assert.deepEqual(f.sent.map(value=>value.message),[current]);assert.equal(state.queue,undefined);
  f.api.resume('legacy',{outcome:'applied'});assert.equal(f.sent.length,1);assert.deepEqual(f.errors,[]);next.detach();
});
test('stable wrapper and API release the retired dispatch lexical environment after takeover', {skip:typeof globalThis.gc!=='function'},async()=>{
  const global={},postbox={postMessage(){}},client={requestPromises:new Map(),onError(){}};let weak;
  (()=>{const generation={privateOldProvider:true};weak=new WeakRef(generation);const owner=attachNativeIngress({global,postbox,client,dispatch(){return generation;}});global[symbol].pause('gc');owner.detach();})();
  const next=attachNativeIngress({global,postbox,client,dispatch(){}}),stable=postbox.postMessage,api=global[symbol];
  for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();}
  assert.equal(weak.deref(),undefined);assert.equal(postbox.postMessage,stable);assert.equal(global[symbol],api);api.resume('gc',{outcome:'applied'});next.detach();
});
