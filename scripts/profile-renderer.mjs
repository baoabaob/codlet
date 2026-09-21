// Offline Core renderer lifecycle/RPC profile. No client launch, accounts or
// native request interception; the Core-side RPC bridge is an in-memory echo.
// node --expose-gc scripts/profile-renderer.mjs <report.json>
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {MessageChannel as NativeChannel} from 'node:worker_threads';

if(!global.gc||!process.argv[2])throw Error('Use --expose-gc and an output path');
const timers=new Set();let ports=0,wakeTasks=0,runtime,rpcCalls=0;
class Channel extends NativeChannel{
  constructor(){super();for(const port of [this.port1,this.port2]){ports++;const close=port.close.bind(port);let closed=false;port.close=()=>{if(!closed){closed=true;ports--;}return close();};}const post=this.port2.postMessage.bind(this.port2);this.port2.postMessage=value=>{wakeTasks++;return post(value);};}
}
const sandbox=vm.createContext({TextEncoder,AbortController,performance,MessageChannel:Channel,
  setTimeout(fn,delay){const timer=setTimeout(()=>{timers.delete(timer);fn();},delay);timers.add(timer);return timer;},
  clearTimeout(timer){timers.delete(timer);clearTimeout(timer);},
  bridge(payload){const value=JSON.parse(payload);if(value.type==='request'){rpcCalls++;queueMicrotask(()=>runtime.__rpcReceive('bridge',{v:1,type:'response',id:value.id,ok:true,result:value.params}));}}
});
const source=readFileSync(new URL('../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
assert.equal(vm.runInContext(`(${source})({world:'isolated'})`,sandbox).ok,true);runtime=sandbox.__codletRendererV1;
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,10));assert.equal(ports,0);assert.equal(timers.size,0);};
const collect=async()=>{for(let i=0;i<3;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}return process.memoryUsage().heapUsed;};
const capability={name:'profile.echo',api:1,scope:'target'},result={schema:1,node:process.version,platform:process.platform,arch:process.arch,method:'Production Core renderer bootstrap in Node VM; in-memory echo replaces native Core IPC. Full GC before heap samples; no browser UI SDK included.',lifecycle:[]};
await settle();result.baselineHeap=await collect();
for(let generation=1;generation<=200;generation++){
  const before=process.cpuUsage(),start=performance.now();
  const definition=vm.runInContext(`({activate(ctx){globalThis.profileContext=ctx;ctx.rpc.provide(${JSON.stringify(capability)},'echo',value=>value);},deactivate(){delete globalThis.profileContext;}})`,sandbox);
  assert.equal((await runtime.activate({id:'profile-plugin',generation,binding:'bridge',requires:[capability],provides:[capability]},definition)).ok,true);
  for(let call=0;call<50;call++)assert.equal(await sandbox.profileContext.rpc.request('echo',call),call);
  assert.equal((await runtime.__rpcInvoke('bridge',{v:1,type:'request',pluginId:'caller',generation:1,id:generation,capability,method:'echo',params:generation})).value,generation);
  assert.equal((await runtime.deactivate('profile-plugin',generation)).ok,true);
  const used=process.cpuUsage(before),duration=performance.now()-start;
  await settle();assert.equal(runtime.status().length,0);await settle();
  if(generation%10===0)result.lifecycle.push({cycles:generation,rpcCalls,heapUsed:await collect(),ports,timers:timers.size,activePlugins:runtime.status().length,cycleWallMs:duration,cycleCpuMs:(used.user+used.system)/1000});
}
await settle();const wakeBefore=wakeTasks,cpuBefore=process.cpuUsage(),start=performance.now();await new Promise(resolve=>setTimeout(resolve,1000));const used=process.cpuUsage(cpuBefore);
result.idle={durationMs:performance.now()-start,wakeTasks:wakeTasks-wakeBefore,ports,timers:timers.size,cpuMs:(used.user+used.system)/1000};
assert.equal(result.idle.wakeTasks,0);assert.equal(result.idle.ports,0);assert.equal(result.idle.timers,0);
mkdirSync(path.dirname(process.argv[2]),{recursive:true});writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({output:process.argv[2],baselineHeap:result.baselineHeap,first:result.lifecycle[0],last:result.lifecycle.at(-1),idle:result.idle}));
