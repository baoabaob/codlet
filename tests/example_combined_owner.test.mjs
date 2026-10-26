import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const host=createRequire(import.meta.url)('../examples/local-host-renderer-capability/host.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
test('combined example shares one attach/marker owner and never reports ready before the marker commits',async()=>{
  const attach=deferred(),marker=deferred(),calls=[];let describe;
  host.activate({plugin:{id:'example.combined',generation:7},rpc:{provide(_cap,_method,handler){describe=handler;}},cdp:{request(method){calls.push(method);return method==='Target.attachToTarget'?attach.promise:marker.promise;}}});
  const invocation={caller:{targetId:'target',pluginId:'example.combined'}};
  let secondReady=false;
  const first=describe(null,invocation),second=describe(null,invocation).then(value=>{secondReady=true;return value;});
  try{
    assert.deepEqual(calls,['Target.attachToTarget']);
    attach.resolve({sessionId:'session'});await Promise.resolve();await Promise.resolve();
    assert.equal(secondReady,false);assert.deepEqual(calls,['Target.attachToTarget','Runtime.evaluate']);
    marker.resolve({});assert.equal((await first).ready,true);assert.equal((await second).ready,true);
  }finally{await host.deactivate({cdp:{async request(){}}});}
});
test('an uncertain marker write remains failed for later callers and retains its session for cleanup',async()=>{
  const failure=Error('unknown marker outcome'),calls=[];let describe;
  host.activate({plugin:{id:'example.combined',generation:8},rpc:{provide(_cap,_method,handler){describe=handler;}},cdp:{async request(method){calls.push(method);if(method==='Target.attachToTarget')return{sessionId:'owned-session'};throw failure;}}});
  const invocation={caller:{targetId:'target',pluginId:'example.combined'}};
  try{
    for(let i=0;i<2;i++)await assert.rejects(describe(null,invocation),error=>error===failure);
    assert.deepEqual(calls,['Target.attachToTarget','Runtime.evaluate']);
  }finally{
    const cleanup=[];await host.deactivate({cdp:{async request(method,params,options){cleanup.push({method,params,options});}}});
    assert.deepEqual(cleanup.map(value=>value.method),['Runtime.evaluate','Target.detachFromTarget']);
    assert.equal(cleanup[1].params.sessionId,'owned-session');
  }
});
