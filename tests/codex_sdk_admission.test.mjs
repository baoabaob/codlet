import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const bootstrap=readFileSync(new URL('../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
const sdk=readFileSync(new URL('../bundled/runtime/codex.js',import.meta.url),'utf8');
const cap={name:'codex.ui.workspace',api:1,scope:'target'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(native){
 const requests=[],scope=vm.createContext({setTimeout,clearTimeout,TextEncoder,AbortController});
 scope.native=native;scope.bridge=payload=>requests.push(JSON.parse(payload));
 vm.runInContext(`globalThis[Symbol.for('codlet.codex.ui.workspace.v1')]={api:1,connect(){return native}};(${bootstrap})({world:'main'},null,null,null,null,null,null,(${sdk}))`,scope);
 const runtime=scope.__codletRendererV1;
 const definition=vm.runInContext('({activate(context){globalThis.ctx=context;this.context=context},deactivate(){},saveState(){return {schema:1,value:globalThis.saved??0}},restoreState(){}})',scope);
 await runtime.activate({id:'local',generation:1,binding:'bridge',requires:[cap]},definition);
 const connecting=scope.ctx.codex.workspace.connect();
 runtime.__rpcReceive('bridge',{v:1,type:'response',id:requests[0].id,ok:true,result:{api:1,symbol:'codlet.codex.ui.workspace.v1',ticket:'owned'}});
 const session=await connecting;
 return {scope,runtime,definition,session,requests};
}
test('Native local handle writes and committed promises share checkpoint admission and drain',async()=>{
 let finish,opens=0,closes=0;
 const committed=new Promise(resolve=>{finish=resolve});
 const native={getSnapshot(){return {current:'owned'}},createNavigation(){return {ready:Promise.resolve(),open(){opens++;return {executed:Promise.resolve('sent'),committed,dispose(){}}},focus(){opens++},dispose(){}}},dispose(){closes++}};
 const f=await fixture(native),navigation=f.session.createNavigation();
 const operation=navigation.open({threadId:'owned'});operation.committed.then(()=>{f.scope.saved=42});
 let completed=false;const saving=f.runtime.__snapshot('local',1).then(value=>{completed=true;return value});await tick();
 assert.equal(completed,false);assert.throws(()=>navigation.open({threadId:'new'}),{code:'core_updating'});assert.throws(()=>navigation.focus({revision:1}),{code:'core_updating'});
 assert.throws(()=>f.session.createNavigation(),{code:'core_updating'});assert.equal(f.session.getSnapshot().current,'owned');assert.equal(opens,1);
 finish({confirmed:true});assert.equal((await saving).snapshot.value,42);
 f.session.dispose();assert.equal(closes,1);assert.equal(f.runtime.__resume('local',1).ok,true);navigation.focus({revision:1});assert.equal(opens,2);
 await f.runtime.deactivate('local',1);assert.throws(()=>navigation.open({threadId:'old'}),{code:'plugin_deactivated'});
});
test('Native asynchronous ready and bind work are drained while exportState and cleanup stay available',async()=>{
 let readyDone,bindDone,bindings=0,closed=0;
 const ready=new Promise(resolve=>{readyDone=resolve});
 const binding=new Promise(resolve=>{bindDone=resolve});
 const f=await fixture({captureLocation(){return {ready,exportState(){return Promise.resolve({api:1,token:'retained'})},restore(){bindings++;return binding},dispose(){closed++}}}});
 const location=f.session.captureLocation(),accepted=location.restore();let completed=false;
 const saving=f.runtime.__snapshot('local',1).then(value=>{completed=true;return value});await tick();assert.equal(completed,false);
 assert.throws(()=>location.restore(),{code:'core_updating'});assert.deepEqual(await location.exportState(),{api:1,token:'retained'});
 readyDone();await tick();assert.equal(completed,false);bindDone();await accepted;assert.equal((await saving).ok,true);assert.equal(bindings,1);
 f.scope.location=location;vm.runInContext('ctx.onCleanup(async()=>{await location.dispose()})',f.scope);
 await f.runtime.deactivate('local',1);assert.equal(closed,1);
});
test('Core-authenticated local connection accepted before checkpoint can finish its ticket exchange',async()=>{
 const requests=[],scope=vm.createContext({setTimeout,clearTimeout,TextEncoder,AbortController});scope.bridge=p=>requests.push(JSON.parse(p));let connections=0;
 scope.native={connect(){connections++;return {getSnapshot(){return {ready:true}}}}};
 vm.runInContext(`globalThis[Symbol.for('codlet.codex.ui.workspace.v1')]={api:1,connect(){return native.connect()}};(${bootstrap})({world:'main'},null,null,null,null,null,null,(${sdk}))`,scope);
 const runtime=scope.__codletRendererV1;await runtime.activate({id:'local',generation:1,binding:'bridge',requires:[cap]},vm.runInContext('({activate(c){globalThis.ctx=c},deactivate(){}})',scope));
 const connecting=scope.ctx.codex.workspace.connect(),saving=runtime.__snapshot('local',1);await tick();assert.equal(connections,0);
 await assert.rejects(scope.ctx.codex.workspace.connect(),{code:'core_updating'});
 runtime.__rpcReceive('bridge',{v:1,type:'response',id:requests[0].id,ok:true,result:{api:1,symbol:'codlet.codex.ui.workspace.v1',ticket:'owned'}});
 assert.equal((await connecting).getSnapshot().ready,true);assert.equal((await saving).ok,true);assert.equal(connections,1);await runtime.deactivate('local',1);
});
