import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){const scope=vm.createContext({setTimeout,clearTimeout,AbortController,TextEncoder});vm.runInContext(`(${source})({world:'main'})`,scope);return{scope,runtime:scope.__codletRendererV1,metadata:generation=>({id:'dev.activation',generation,binding:'bridge',requires:[{name:'dev.rpc',api:1,scope:'target'}]}),definition:text=>vm.runInContext(`({deactivate(){},${text}})`,scope)};}
test('async activation receives its admitted RPC response before becoming active',async()=>{
 const f=fixture(),requests=[];f.scope.bridge=value=>requests.push(JSON.parse(value));
 const activating=f.runtime.activate(f.metadata(1),f.definition('async activate(context){globalThis.context=context;globalThis.result=await context.rpc.request({name:"dev.rpc",api:1,scope:"target"},"read",{})}'));
 await tick();assert.equal(requests.length,1);assert.equal(f.runtime.status().length,0);
 assert.equal(f.runtime.__rpcReceive('bridge',{v:1,type:'response',id:requests[0].id,ok:true,result:17}).ok,true);
 assert.equal((await activating).ok,true);assert.equal(f.scope.result,17);await f.runtime.deactivate('dev.activation',1);
});
test('host retirement cancels an unresolved activation and releases its serialization gate',async()=>{
 const f=fixture(),requests=[];f.scope.bridge=value=>requests.push(JSON.parse(value));
 const definition=f.definition('activate(context){globalThis.context=context;context.onDeactivate(()=>globalThis.disposed=(globalThis.disposed??0)+1);return new Promise(resolve=>globalThis.lateResolve=resolve)}');
 const activating=f.runtime.activate(f.metadata(1),definition);await tick();
 assert.equal(f.runtime.__rpcClose('bridge').ok,true);assert.equal((await activating).ok,false);assert.equal(f.scope.disposed,1);
 assert.equal((await f.runtime.activate(f.metadata(2),f.definition('activate(){}'))).ok,true);
 await assert.rejects(f.scope.context.rpc.request({name:'dev.rpc',api:1,scope:'target'},'late-write',{}),{code:'plugin_deactivated'});assert.equal(requests.length,0);
 f.scope.lateResolve();await tick();assert.equal(f.runtime.status()[0].generation,2);await f.runtime.deactivate('dev.activation',2);
});
test('explicit deactivation cancels a pending entry without waiting for its own operation gate',async()=>{
 const f=fixture(),activating=f.runtime.activate(f.metadata(1),f.definition('activate(){return new Promise(()=>{})}'));await tick();
 assert.equal((await f.runtime.deactivate('dev.activation',1)).ok,true);assert.equal((await activating).ok,false);
 assert.equal((await f.runtime.activate(f.metadata(2),f.definition('activate(){}'))).ok,true);await f.runtime.deactivate('dev.activation',2);
});
test('cancelled restore releases the candidate gate while retaining the previous active owner',async()=>{
 const f=fixture();assert.equal((await f.runtime.activate(f.metadata(1),f.definition('activate(){}'))).ok,true);
 const snapshot=vm.runInContext('({schema:1,value:null})',f.scope);
 const replacing=f.runtime.activate({...f.metadata(2),binding:'candidate'},f.definition('activate(){},restoreState(){return new Promise(()=>{})}'),snapshot);await tick();
 assert.equal((await f.runtime.deactivate('dev.activation',2)).ok,true);assert.equal((await replacing).ok,false);
 assert.equal(f.runtime.status()[0].generation,1);await f.runtime.deactivate('dev.activation',1);
});
