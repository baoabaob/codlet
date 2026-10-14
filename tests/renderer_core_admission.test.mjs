import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=name=>readFileSync(new URL('../bundled/runtime/'+name+'.js',import.meta.url),'utf8');
const bootstrap=source('bootstrap'),helpers=source('helpers'),facade=source('facade'),sdk=source('codex');
const capability={name:'dev.state',api:1,scope:'target'},workspace={name:'codex.ui.workspace',api:1,scope:'target'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(seed=null,world='main'){
 const scope=vm.createContext({setTimeout,clearTimeout,TextEncoder,AbortController}),requests=[];
 scope.bridge=payload=>requests.push(JSON.parse(payload));scope.nativeWrites=0;
 vm.runInContext("globalThis[Symbol.for('codlet.codex.ui.workspace.v1')]={api:1,connect(){return {getSnapshot(){return {read:true}},createNavigation(){return {ready:Promise.resolve(),open(){globalThis.nativeWrites++;return {executed:Promise.resolve(),committed:Promise.resolve(),dispose(){}}},dispose(){}}},dispose(){}}}}",scope);
 const stage=(id=seed)=>{vm.runInContext(`(${helpers})(()=>null,null,null,null,(${bootstrap}),(${sdk}))`,scope);return vm.runInContext(`(${facade})({world:${JSON.stringify(world)},coreAdmissionId:${JSON.stringify(id)}})`,scope)};
 stage();
 const metadata=generation=>{scope['bridge'+generation]=scope.bridge;return {id:'owner',generation,binding:'bridge'+generation,requires:[capability,workspace]}};
 const definition=code=>vm.runInContext(`({activate(context){this.context=context;globalThis.ctx=context},deactivate(){},saveState(){return {schema:1,value:null}},restoreState(){},${code}})`,scope);
 return {scope,stage,metadata,definition,requests,runtime:()=>scope.__codletRendererV1,reply(result=null){const request=requests.shift();assert.ok(request);scope.__codletRendererV1.__rpcReceive('bridge'+request.generation,{v:1,type:'response',id:request.id,ok:true,result});return request}};
}
test('whole-Core lease remains closed after snapshot resume and after candidate activation/restore finishes',async()=>{
 const f=fixture();await f.runtime().activate(f.metadata(1),f.definition(''));
 assert.equal(f.runtime().__coreAdmissionPause('core-transaction').ok,true);assert.equal((await f.runtime().__snapshot('owner',1)).ok,true);assert.equal(f.runtime().__resume('owner',1).ok,true);
 await assert.rejects(f.scope.ctx.rpc.request(capability,'ordinary',{}),{code:'core_updating'});assert.throws(()=>f.scope.ctx.rpc.notify(capability,'ordinary',{}),{code:'core_updating'});
 const candidate=f.definition(`async activate(context){this.context=context;globalThis.ctx=context;await context.rpc.request({name:'dev.state',api:1,scope:'target'},'activate',{});globalThis.session=await context.codex.workspace.connect();globalThis.navigation=session.createNavigation()},async restoreState(){await this.context.rpc.request({name:'dev.state',api:1,scope:'target'},'restore',{})}`);
 const activating=f.runtime().activate(f.metadata(2),candidate,vm.runInContext('({schema:1,value:null})',f.scope));await tick();assert.equal(f.reply().method,'activate');await tick();
 assert.equal(f.reply({api:1,symbol:'codlet.codex.ui.workspace.v1',ticket:'owned'}).method,'getApi');await tick();assert.equal(f.reply().method,'restore');assert.equal((await activating).ok,true);
 await assert.rejects(candidate.context.rpc.request(capability,'after-ready',{}),{code:'core_updating'});assert.throws(()=>candidate.context.rpc.notify(capability,'after-ready',{}),{code:'core_updating'});assert.throws(()=>f.scope.navigation.open({threadId:'owned'}),{code:'core_updating'});assert.equal(f.scope.session.getSnapshot().read,true);assert.equal(f.scope.nativeWrites,0);
 assert.equal(f.runtime().__coreAdmissionResume('stale').ok,false);assert.equal(f.runtime().__coreAdmissionResume('core-transaction').ok,true);
 const resumed=candidate.context.rpc.request(capability,'ordinary',{});assert.equal(f.reply('accepted').method,'ordinary');assert.equal(await resumed,'accepted');f.scope.navigation.open({threadId:'owned'});assert.equal(f.scope.nativeWrites,1);await f.runtime().deactivate('owner',2);
});
test('held plain Core lease survives last owner retirement and replacement factory with no old dispatcher',async()=>{
 const f=fixture();await f.runtime().activate(f.metadata(1),f.definition(''));
 f.runtime().__coreAdmissionPause('held');await f.runtime().deactivate('owner',1);assert.equal(f.scope.__codletRendererV1,undefined);
 const retained=f.scope[Symbol.for('codlet.core.renderer-admission.v1')];assert.deepEqual(Object.keys(retained),['api','operationId']);assert.equal(retained.operationId,'held');
 assert.equal(f.stage().ok,true);const rollback=f.definition('');await f.runtime().activate(f.metadata(3),rollback);
 await assert.rejects(rollback.context.rpc.request(capability,'before-rollback-ack',{}),{code:'core_updating'});
 assert.equal(f.runtime().__resume('owner',3).ok,true);await assert.rejects(rollback.context.rpc.request(capability,'still-held',{}),{code:'core_updating'});
 f.runtime().__coreAdmissionResume('held');const resumed=rollback.context.rpc.request(capability,'rollback-confirmed',{});f.reply('accepted');assert.equal(await resumed,'accepted');await f.runtime().deactivate('owner',3);
});
test('fresh isolated candidate realm seed inherits transaction identity and conflicting operations cannot open it',async()=>{
 const f=fixture('seeded','isolated');await f.runtime().activate(f.metadata(1),f.definition(''));
 await assert.rejects(f.scope.ctx.rpc.request(capability,'ordinary',{}),{code:'core_updating'});
 assert.equal(f.runtime().__coreAdmissionPause('another').ok,false);assert.equal(f.runtime().__coreAdmissionResume('another').ok,false);
 assert.equal(f.runtime().__coreAdmissionResume('seeded').ok,true);const resumed=f.scope.ctx.rpc.request(capability,'ordinary',{});f.reply(true);assert.equal(await resumed,true);await f.runtime().deactivate('owner',1);
});

test('globally held provider accepts only the broker lineage and its bounded nested RPC',async()=>{
 const f=fixture();const definition=f.definition(`activate(context){context.rpc.provide({name:'dev.state',api:1,scope:'target'},'accepted',async(_,invocation)=>invocation.rpc.request({name:'dev.state',api:1,scope:'target'},'nested',{}))}`);
 await f.runtime().activate({...f.metadata(1),provides:[capability]},definition);f.runtime().__coreAdmissionPause('held');
 const request={v:1,type:'request',pluginId:'caller',generation:1,id:1,capability,method:'accepted',params:{}};
 assert.equal((await f.runtime().__rpcInvoke('bridge1',request)).code,'core_updating');
 const invocation=f.runtime().__rpcInvoke('bridge1',{...request,coreInvocation:{token:'already-admitted',remainingMs:2000,depth:1,caller:{pluginId:'caller',generation:1},scope:{kind:'target',targetId:'owned',epoch:1}}});await tick();
 assert.equal(f.requests[0].parentToken,'already-admitted');f.reply(17);assert.equal((await invocation).value,17);f.runtime().__coreAdmissionResume('held');await f.runtime().deactivate('owner',1);
});
