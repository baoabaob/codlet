import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeManagerRpc} from '../frontend/src/desktop/native-manager-rpc.js';
import {createRequire} from 'node:module';
import {resolveThreadReference,resolveThreadInteraction} from '../frontend/src/adapter/workspace-dom.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(overrides={}) {
  const calls=[],subscriptions=[],errors=[];let owner=true,disposed=0;
  const rpc={getHostId:async()=> 'local',getCachedThreadIds:async()=>[],getCachedThreadMetadata:async ids=>ids.map(id=>({id})),
    getConversation:async id=>({id,resumeState:'resumed'}),getStreamRole:async()=>({role:'owner'}),
    subscribe(spec){calls.push(['subscribe',spec]);const sub={spec,unsubscribed:0,released:0,async unsubscribe(){this.unsubscribed++;},[Symbol.dispose](){this.released++;}};subscriptions.push(sub);return Promise.resolve(sub);},
    [Symbol.dispose](){disposed++;},...overrides};
  const manager=createNativeManagerRpc({rpc,client:{},check(){if(!owner)throw Object.assign(new Error('retired'),{code:'retired'});},report:error=>errors.push(error)});
  return{manager,rpc,calls,subscriptions,errors,retire(){owner=false;},get nativeDisposed(){return disposed;}};
}
test('initialization reads host and cached identities; metadata enumeration never reads conversations',async()=>{
  let conversations=0;const f=fixture({getCachedThreadIds:async()=>['a','b'],getConversation:async()=>{conversations++;}});
  await f.manager.ready;assert.equal(f.calls.length,0);assert.deepEqual(await f.manager.readLoadedThreadMetadata(),[{id:'a'},{id:'b'}]);assert.equal(conversations,0);
  await f.manager.dispose();assert.equal(f.nativeDisposed,0);
});
test('the first Native sidebar gesture uses cached identity metadata without preparing its history',async()=>{
  let reads=0;const f=fixture({getCachedThreadIds:async()=>['sidebar-thread'],getConversation:async()=>{reads++;}});await f.manager.ready;
  const dom=new JSDOM('<div id="root"><button><span data-thread-title>Task</span></button></div>'),document=dom.window.document,root=document.getElementById('root'),title=document.querySelector('[data-thread-title]');
  const current={child:null},row={stateNode:title,memoizedProps:{conversationId:'sidebar-thread'},return:current};current.child=row;root.__reactContainer$fixture={stateNode:{current}};title.__reactFiber$fixture=row;
  assert.deepEqual(resolveThreadReference(document,title,id=>f.manager.hasKnownThread(id)),{threadId:'sidebar-thread',hostId:'local'});
  assert.deepEqual(resolveThreadInteraction(document,title,id=>f.manager.hasKnownThread(id)),{threadId:'sidebar-thread',hostId:'local'});assert.equal(reads,0);
  row.memoizedProps.hostId='remote';assert.equal(resolveThreadReference(document,title,id=>f.manager.hasKnownThread(id)),null);
  await f.manager.dispose();assert.equal(f.subscriptions.every(value=>value.unsubscribed===1&&value.released===1),true);dom.window.close();
});
test('Core subscription releases once and suppresses callbacks after retirement',async()=>{
  const f=fixture();await f.manager.ready;let events=0;const sub=f.manager.subscribe({type:'event',event:'conversation-removed'},()=>events++);await sub.ready;
  f.subscriptions[0].spec.listener('a');assert.equal(events,1);await sub.dispose();await sub.dispose();f.subscriptions[0].spec.listener('a');
  assert.equal(events,1);assert.equal(f.subscriptions[0].unsubscribed,1);assert.equal(f.subscriptions[0].released,1);assert.equal(f.nativeDisposed,0);
});
test('late subscription receipt is released when driver retires before receipt',async()=>{
  const pending=deferred();let unsubscribed=0,released=0;const f=fixture({subscribe:()=>pending.promise});await f.manager.ready;
  const sub=f.manager.subscribe({type:'event',event:'conversation-removed'},()=>{}),closing=f.manager.dispose();
  pending.resolve({async unsubscribe(){unsubscribed++;},[Symbol.dispose](){released++;}});await closing;await sub.ready;
  assert.equal(unsubscribed,1);assert.equal(released,1);assert.equal(f.nativeDisposed,0);
});
test('owner replacement invalidates an already dispatched read',async()=>{
  const pending=deferred(),f=fixture({getConversation:()=>pending.promise});await f.manager.ready;const read=f.manager.getConversation('a');f.retire();pending.resolve({id:'a'});await assert.rejects(read,{code:'retired'});
});
test('dirty notifications publish an ordered first snapshot and then refresh only the observed thread',async()=>{
  const first=deferred(),started=deferred();let reads=0;const f=fixture({getConversation:id=>{assert.equal(id,'selected');started.resolve();return ++reads===1?first.promise:Promise.resolve({id,revision:reads});}});await f.manager.ready;
  const observation=f.manager.observeThread('selected');await started.promise;
  f.subscriptions[0].spec.listener({id:'selected'});first.resolve({id:'selected',revision:1});await observation.ready;
  assert.equal(f.manager.peekConversation('selected').revision,2);assert.equal(reads,2);assert.equal(f.manager.peekConversation('unrelated'),null);await observation.dispose();assert.equal(f.manager.peekConversation('selected'),null);
});
test('synchronous subscribe failure leaves no unclosable record',async()=>{
  const error=new Error('subscribe rejected'),f=fixture({subscribe(){throw error;}});await f.manager.ready;
  assert.throws(()=>f.manager.subscribe({type:'event',event:'conversation-removed'},()=>{}),value=>value===error);
  assert.deepEqual(await f.manager.dispose(),[]);assert.equal(f.nativeDisposed,0);
});
test('a broken pending RPC subscription retires its late handle exactly once',async()=>{
  const pending=deferred();let broken,unsubscribed=0,released=0;pending.promise.onRpcBroken=callback=>{broken=callback;};
  const f=fixture({subscribe:()=>pending.promise});await f.manager.ready;const sub=f.manager.subscribe({type:'event',event:'conversation-removed'},()=>{});
  const error=new Error('broken');broken(error);pending.resolve({async unsubscribe(){unsubscribed++;},[Symbol.dispose](){released++;}});await sub.dispose();await f.manager.dispose();
  assert.equal(unsubscribed,1);assert.equal(released,1);assert.equal(f.errors[0],error);
});
test('notifications during publication do not starve readiness or lose the follow-up read',async()=>{
  let reads=0,observed;const second=deferred();const f=fixture({async getConversation(id){reads++;if(reads===2)second.resolve();return{id,revision:reads};}});await f.manager.ready;
  observed=f.manager.observeThread('selected',()=>{if(reads===1)f.subscriptions[0].spec.listener({id:'selected'});});
  await observed.ready;await second.promise;assert.ok(reads>=2);await observed.dispose();await f.manager.dispose();
});
test('stream role events refresh observed thread; removal cancels its pending snapshot',async()=>{
  let reads=0;const f=fixture({async getConversation(id){reads++;return{id};}});await f.manager.ready;const observed=f.manager.observeThread('selected');await observed.ready;
  const role=f.subscriptions.find(value=>value.spec.event==='stream-role-changed');role.spec.listener({conversationId:'unrelated',role:'owner'});await Promise.resolve();assert.equal(reads,1);
  role.spec.listener({conversationId:'selected',role:'follower'});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);
  f.subscriptions.find(value=>value.spec.event==='conversation-removed').spec.listener('selected');assert.equal(f.manager.peekConversation('selected'),null);await observed.dispose();await f.manager.dispose();
});
test('removed thread invalidates pending snapshot',async()=>{
  const first=deferred(),f=fixture({getConversation:()=>first.promise});await f.manager.ready;const remove=f.manager.addConversationRemovedCallback(()=>{});await remove.ready;
  const observation=f.manager.observeThread('selected');await Promise.resolve();await Promise.resolve();f.subscriptions[0].spec.listener('selected');first.resolve({id:'selected'});
  await assert.rejects(observation.ready,{code:'desktop_thread_retired'});assert.equal(f.manager.peekConversation('selected'),null);await f.manager.dispose();
});
test('permission submission has one dispatch and awaits actual Native ack',async()=>{
  const ack=deferred();let dispatches=0;const f=fixture({updateThreadPermissions(){dispatches++;return ack.promise;}});await f.manager.ready;
  let complete=false;const update=f.manager.updateThreadPermissions('selected',{}).then(()=>{complete=true;});await Promise.resolve();assert.equal(complete,false);assert.equal(dispatches,1);
  await assert.rejects(f.manager.updateThreadPermissions('selected',{}),{code:'permissions_busy'});ack.resolve();await update;assert.equal(complete,true);assert.equal(dispatches,1);assert.equal('waitForPendingThreadSettingsUpdate' in f.manager,false);
});
