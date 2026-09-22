import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {setImmediate as nextJob} from 'node:timers/promises';

const source=readFileSync(new URL('../../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
const context=vm.createContext({setTimeout,clearTimeout,TextEncoder,AbortController,performance});
vm.runInContext(`globalThis.loads=0;globalThis.refs=[];globalThis.contexts=[];
(${source})({world:'isolated',lazyUI:true},()=>{
  loads++;
  const state=new Uint8Array(1024*1024);
  const factory=owner=>({bytes:state.byteLength,owner:owner.pluginId});
  refs.push(new WeakRef(factory));return factory;
});`,context);
const runtime=context.__codletRendererV1;
const activate=async(id,useUI=true)=>{
  const result=await vm.runInContext(`__codletRendererV1.activate({id:${JSON.stringify(id)},generation:1}, {
    activate(ctx){contexts.push(ctx);${useUI?'globalThis.lastView=ctx.ui.create();':''}},deactivate(){}
  })`,context);
  assert.equal(result.ok,true);
};
const collect=async()=>{for(let i=0;i<6;i++){await nextJob();global.gc();}};
await activate('no-ui',false);assert.equal(context.loads,0);
await runtime.deactivate('no-ui',1);assert.equal(context.loads,0);
await activate('first');await activate('second');assert.equal(context.loads,1);
assert.equal(context.lastView.bytes,1024*1024);
await runtime.deactivate('first',1);await collect();assert.ok(context.refs[0].deref(),'another active owner must retain the shared factory');
await runtime.deactivate('second',1);await collect();
assert.equal(context.__codletRendererV1,runtime,'immutable generation runtime still exists');
assert.equal(context.refs[0].deref(),undefined,'retired runtime must not pin UI SDK modules');
const before=context.loads;
assert.throws(()=>context.contexts[1].ui.create(),{code:'plugin_deactivated'});
assert.equal(context.loads,before,'retired context must not reinitialize helpers');
await activate('third');assert.equal(context.loads,2);await runtime.deactivate('third',1);await collect();assert.equal(context.refs[1].deref(),undefined);
const isolated=vm.createContext({setTimeout,clearTimeout,TextEncoder,AbortController,performance});
vm.runInContext(`globalThis.loads=0;globalThis.refs=[];
(${source})({world:'isolated',lazyUI:true,retireOnEmpty:true},()=>{
  loads++;const factory=()=>({});refs.push(new WeakRef(factory));return factory;
});`,isolated);
const once=isolated.__codletRendererV1;
assert.equal((await vm.runInContext(`__codletRendererV1.activate({id:'generation',generation:1},{activate(ctx){ctx.ui.create();},deactivate(){}})`,isolated)).ok,true);
assert.equal((await once.deactivate('generation',1)).ok,true);await collect();
assert.equal(isolated.refs[0].deref(),undefined);
assert.equal(Object.getOwnPropertyDescriptor(isolated,'__codletRendererV1').configurable,false);
assert.equal((await once.activate({id:'generation',generation:2},{activate(){},deactivate(){}})).ok,false,'Core generation context must never be revived');
assert.equal(isolated.loads,1);
console.log('lazy UI lifecycle passed');
const helpers=readFileSync(new URL('../../bundled/runtime/helpers.js',import.meta.url),'utf8');
const facadeSource=readFileSync(new URL('../../bundled/runtime/facade.js',import.meta.url),'utf8');
const facadeContext=vm.createContext({setTimeout,clearTimeout,TextEncoder,AbortController,performance});
vm.runInContext(`globalThis.retiredRefs=[];(${helpers})(()=>()=>({}),null,null,null,(...args)=>{
  const publish=args[6];args[6]=value=>{retiredRefs.push(new WeakRef(value));return publish(value);};return (${source})(...args);
});`,facadeContext);
vm.runInContext(`(${facadeSource})({world:'isolated',lazyUI:true,retireOnEmpty:true})`,facadeContext);
const facade=facadeContext.__codletRendererV1;
assert.equal((await facade.activate({id:'facade-owner',generation:1},{activate(){},deactivate(){}})).ok,true);
await facade.deactivate('facade-owner',1);await collect();
assert.equal(facadeContext.retiredRefs[0].deref(),undefined,'the permanent ABI must release the whole retired runtime, not only its UI factory');
assert.equal(facadeContext.__codletRendererV1,facade);
assert.equal(Object.getOwnPropertyDescriptor(facadeContext,'__codletRendererV1').configurable,false);
assert.equal((await facade.activate({id:'facade-owner',generation:2},{activate(){}})).ok,false);
assert.equal(facade.status().length,0);
