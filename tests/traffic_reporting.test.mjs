import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const {createHostedChannels}=createRequire(import.meta.url)('../runtime/host-channels.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('channel observations have an ID and coalesce bursts without blocking close',async()=>{
  const root=new AbortController(),reports=[],pending=[],requests=[];
  let inFlight=0,peak=0;
  const runtime=createHostedChannels({rootSignal:root.signal,getPeer:async()=>({}),
    coreRequest:async(method)=>{requests.push(method);return method.endsWith('openChannel')?{id:'owned-channel',endpoint:'http://127.0.0.1:1',protocols:['http']}:{closed:true};},
    reportState:snapshot=>{reports.push(snapshot);peak=Math.max(peak,++inFlight);return new Promise(resolve=>pending.push(()=>{inFlight--;resolve();}));}});
  const channel=await runtime.openChannel({}, {http:async()=>({status:200})});await tick();
  assert.equal(reports.length,1);assert.equal(reports[0][0].id,'owned-channel');assert.equal(reports[0][0].open,true);
  for(let i=0;i<100;i++)runtime.event({event:'channelState',channel:channel.id,activeRequests:i%4,forwardAttempts:i});
  await tick();assert.equal(reports.length,1,'one managed report in flight, independent of event count');
  await channel.close();assert.ok(requests.includes('services.traffic.closeChannel'));
  pending.shift()();await tick();assert.equal(reports.length,2);assert.deepEqual(reports[1],[],'publish only the newest state after close');
  pending.shift()();await tick();assert.equal(peak,1);root.abort();runtime.closeAll();
});

test('report failure neither retries unchanged state nor leaks queued reports after retirement',async()=>{
  const root=new AbortController();let calls=0,reject;
  const runtime=createHostedChannels({rootSignal:root.signal,getPeer:async()=>({}),
    coreRequest:async()=>({id:'owned',endpoint:'http://127.0.0.1:1',protocols:['http']}),
    reportState:()=>{calls++;return new Promise((_resolve,fail)=>{reject=fail;});}});
  await runtime.openChannel({}, {http:async()=>({status:200})});await tick();
  reject(Error('diagnostic queue full'));await tick();await tick();assert.equal(calls,1);
  runtime.event({event:'channelState',channel:'owned',activeRequests:1,forwardAttempts:1});await tick();assert.equal(calls,2);
  runtime.event({event:'channelState',channel:'owned',activeRequests:0,forwardAttempts:2});root.abort();runtime.closeAll();
  reject(Error('retired'));await tick();assert.equal(calls,2);
});
