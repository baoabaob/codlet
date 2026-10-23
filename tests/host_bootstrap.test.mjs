import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const { listenTrafficPeer } = createRequire(import.meta.url)('../runtime/traffic-wire.cjs');

const bootstrap = (await Promise.all([
  readFile(new URL('../runtime/core-services.cjs', import.meta.url), 'utf8').then(source => `const createEmbeddedServicesRuntime = (() => { const module = {exports:{}};${source};return module.exports.createCoreServicesRuntime;})();`),
  readFile(new URL('../runtime/sdk-source-parser.cjs', import.meta.url), 'utf8').then(source => `const parseEmbeddedSdkHostSource = (() => { const module = {exports:{}};${source};return module.exports.parse;})();`),
  readFile(new URL('../runtime/sdk-host.cjs', import.meta.url), 'utf8').then(source => `const createEmbeddedSdkHost = (() => { const module = {exports:{}};${source};return module.exports.createSdkHost;})();`),
  readFile(new URL('../runtime/codex-host-bundle.cjs', import.meta.url), 'utf8').then(source => `const createEmbeddedCodexHost = (() => { const module = {exports:{}};${source};return module.exports.createCodexHost;})();`),
  readFile(new URL('../runtime/host-traffic-bundle.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../runtime/host.cjs', import.meta.url), 'utf8'),
])).join('\n');
const identity = { v: 1, pluginId: 'dev.js-bootstrap', generation: 8 };

test('managed SDK Host process denies Node globals and bridges ordinary computation', async t => {
  const fixture = await host(t, `module.exports={async activate(context){
    if(typeof process!=='undefined'||typeof Buffer!=='undefined')throw new Error('ambient Node leaked');
    try{require('node:fs');throw new Error('Node loader accepted');}catch(e){if(e.code!=='sdk_import_denied')throw e;}
    const values=Array.from({length:1000},(_,n)=>n); await new Promise(resolve=>setTimeout(resolve,1));
    await context.core.request('Fixture.compute',{sum:values.reduce((a,b)=>a+b,0)});
  },deactivate(){}};`, undefined, 'sdk');
  fixture.initialize();
  const request = await fixture.next();
  assert.equal(request.method, 'Fixture.compute');
  assert.deepEqual(request.params, {sum:499500});
  fixture.send({type:'response',id:request.id,ok:true,result:{}});
  assert.equal((await fixture.next()).result.ready, true);
  fixture.shutdown(); assert.equal((await fixture.next()).ok, true);
});

test('explicit Host snapshots transfer after activation and before readiness in both modes', async t => {
  for (const mode of [undefined, 'sdk']) {
    const source = `let count=0;module.exports={activate(){count=41;},saveState(){return {schema:1,value:{count}};},restoreState(snapshot){count=snapshot.value.count+1;console.log('restored='+count);},deactivate(){}};`;
    const previous = await host(t, source, undefined, mode); previous.initialize();
    assert.equal((await previous.next()).result.ready,true);
    previous.send({type:'request',id:2,method:'host.snapshot',params:null});
    const snapshot = await previous.next();
    assert.deepEqual(snapshot.result,{schema:1,value:{count:41}});
    previous.send({type:'request',id:3,method:'shutdown',params:null}); assert.equal((await previous.next()).ok,true);
    const next = await host(t, source, undefined, mode); next.initialize({initialState:snapshot.result});
    assert.equal((await next.next()).result.ready,true);
    assert.match(next.stderr(),/restored=42/);
    next.shutdown(); assert.equal((await next.next()).ok,true);
  }
});

test('Core transaction hold reaches candidates without snapshots and rollback generations before ready while finite initialization remains admitted', async t => {
  for(const mode of [undefined,'sdk'])for(const restored of [false,true]){
    const capability={name:'dev.core.hold',api:1,scope:'runtime'};
    const fixture=await host(t,`let count=1,denied=0,finished=false;module.exports={async activate(context){
      await context.core.request('Fixture.activation',{});
      context.rpc.provide({name:'dev.core.hold',api:1,scope:'runtime'},'inspect',()=>({count,denied}));
      const write=async()=>{if(finished)return;try{await context.core.request('Fixture.backgroundWrite',{count});finished=true;}catch(e){if(e.code!=='core_updating')throw e;denied++;setTimeout(write,10);}};setTimeout(write,20);
    },saveState(){return {schema:1,value:{count,denied}};},async restoreState(snapshot,context){count=snapshot.value.count;await context.core.request('Fixture.restore',{});},deactivate(){finished=true;}};`,undefined,mode);
    fixture.initialize({provides:[capability],coreAdmission:'core-hold',...(restored?{initialState:{schema:1,value:{count:42}}}:{})});
    let request=await fixture.next();assert.equal(request.method,'Fixture.activation');fixture.send({type:'response',id:request.id,ok:true,result:{}});
    if(restored){request=await fixture.next();assert.equal(request.method,'Fixture.restore');fixture.send({type:'response',id:request.id,ok:true,result:{}});}
    assert.equal((await fixture.next()).result.ready,true);
    await new Promise(resolve=>setTimeout(resolve,45));
    // Snapshot resume is independent and cannot open the Core transaction gate.
    fixture.send({type:'request',id:2,method:'host.resume',params:null});assert.deepEqual((await fixture.next()).result,{resumed:true});
    const invocation={capability,method:'inspect',params:null,caller:{pluginId:'caller',generation:1,targetId:'',documentEpoch:0},remainingMs:2000,scope:{kind:'runtime'}};
    fixture.send({type:'request',id:3,method:'capability.invoke',params:invocation});assert.equal((await fixture.next()).error.code,'core_updating');
    fixture.send({type:'request',id:4,method:'capability.invoke',params:{...invocation,admitted:true}});
    const observed=(await fixture.next()).result;assert.equal(observed.count,restored?42:1);assert.ok(observed.denied>0);
    fixture.send({type:'request',id:5,method:'host.coreResume',params:{operationId:'wrong'}});assert.equal((await fixture.next()).error.code,'core_admission_stale');
    fixture.send({type:'request',id:6,method:'host.coreResume',params:{operationId:'core-hold'}});assert.equal((await fixture.next()).result.resumed,true);
    request=await fixture.next();assert.equal(request.method,'Fixture.backgroundWrite');assert.deepEqual(request.params,{count:restored?42:1});fixture.send({type:'response',id:request.id,ok:true,result:{}});
    fixture.send({type:'request',id:7,method:'shutdown',params:null});assert.equal((await fixture.next()).ok,true);
  }
});

test('Core global hold delivers more than the snapshot queue bound of events without admitting callback writes or killing the old Host', async t => {
  for(const mode of [undefined,'sdk']){
    const capability={name:'dev.hold.events',api:1,scope:'runtime'};
    const fixture=await host(t,`let seen=0;module.exports={async activate(context){
      context.rpc.provide({name:'dev.hold.events',api:1,scope:'runtime'},'inspect',()=>({seen}));
      await context.cdp.subscribe({scope:'all'},async()=>{seen++;await context.core.request('Fixture.forbiddenEventWrite',{});});
    },deactivate(){}};`,undefined,mode);
    fixture.initialize({provides:[capability]});const subscribe=await fixture.next();
    fixture.send({type:'response',id:subscribe.id,ok:true,result:{subscriptionId:1}});assert.equal((await fixture.next()).result.ready,true);
    fixture.send({type:'request',id:2,method:'host.corePause',params:{operationId:'events-hold'}});assert.equal((await fixture.next()).result.held,true);
    // Pipe reads may coalesce even individually paced writes under CPU load.
    fixture.send(...Array.from({length:96},()=>({type:'notification',method:'cdp.event',params:{subscriptionId:1,event:{method:'Fixture.event'}}})));
    fixture.send({type:'request',id:3,method:'capability.invoke',params:{capability,method:'inspect',params:null,caller:{pluginId:'caller',generation:1,targetId:'',documentEpoch:0},remainingMs:2000,scope:{kind:'runtime'},admitted:true}});
    const observed=await fixture.next();assert.equal(observed.type,'response','controlled callback writes never reach Core');assert.equal(observed.result.seen,96);
    assert.equal(fixture.child.exitCode,null);fixture.send({type:'request',id:4,method:'host.coreResume',params:{operationId:'events-hold'}});assert.equal((await fixture.next()).result.resumed,true);
    fixture.send({type:'request',id:5,method:'shutdown',params:null});assert.equal((await fixture.next()).ok,true);
  }
});

test('genuinely stalled event callbacks retain the concurrent-handler bound',async t=>{
  for(const mode of [undefined,'sdk']){
    const fixture=await host(t,`module.exports={async activate(context){await context.cdp.subscribe({scope:'all'},()=>new Promise(()=>{}));},deactivate(){}};`,undefined,mode);
    fixture.initialize();const subscribe=await fixture.next();
    fixture.send({type:'response',id:subscribe.id,ok:true,result:{subscriptionId:1}});assert.equal((await fixture.next()).result.ready,true);
    fixture.send(...Array.from({length:5},()=>({type:'notification',method:'cdp.event',params:{subscriptionId:1,event:{method:'Fixture.event'}}})));
    assert.equal((await fixture.exited)[0],1);assert.match(fixture.stderr(),/not keeping up with the bounded stream/);
  }
});

test('whole-Core traffic busy preflight retains the old data peer and snapshot refuses live resources until explicit cleanup', async t => {
  const root=new AbortController(),listener=await listenTrafficPeer({signal:root.signal,handle:()=>null});t.after(()=>root.abort());
  const capability={name:'dev.hold.traffic',api:1,scope:'runtime'};
  const fixture=await host(t,`let channel;module.exports={async activate(context){
    channel=await context.traffic.openHttpChannel({},()=>({status:204}));
    context.rpc.provide({name:'dev.hold.traffic',api:1,scope:'runtime'},'inspect',()=>channel.status());
    context.rpc.provide({name:'dev.hold.traffic',api:1,scope:'runtime'},'close',()=>channel.close());
  },saveState(){return {schema:1,value:{settled:true}};},restoreState(){},deactivate(){}};`);
  fixture.initialize({provides:[capability]});let request=await fixture.next();assert.equal(request.method,'traffic.connectPeer');fixture.send({type:'response',id:request.id,ok:true,result:listener.endpoint});
  request=await fixture.next();assert.equal(request.method,'traffic.openChannel');fixture.send({type:'response',id:request.id,ok:true,result:{id:'owned',endpoint:'http://127.0.0.1:1',protocols:['http']}});assert.equal((await fixture.next()).result.ready,true);
  fixture.send({type:'request',id:2,method:'host.corePause',params:{operationId:'traffic-hold'}});assert.equal((await fixture.next()).error.code,'core_admission_traffic_busy');assert.equal(listener.status().connected,true);
  const invoke=(id,method)=>fixture.send({type:'request',id,method:'capability.invoke',params:{capability,method,params:null,caller:{pluginId:'caller',generation:1,targetId:'',documentEpoch:0},remainingMs:2000,scope:{kind:'runtime'}}});
  invoke(3,'inspect');assert.equal((await fixture.next()).result.open,true,'busy preflight leaves the old ordinary owner admitted');
  fixture.send({type:'request',id:4,method:'host.corePause',params:{operationId:'traffic-hold',rehold:true}});assert.equal((await fixture.next()).result.held,true);
  fixture.send({type:'request',id:5,method:'host.snapshot',params:null});assert.equal((await fixture.next()).error.code,'core_admission_traffic_busy');assert.equal(listener.status().connected,true);
  fixture.send({type:'request',id:6,method:'host.coreResume',params:{operationId:'traffic-hold'}});assert.equal((await fixture.next()).result.resumed,true);
  invoke(7,'close');request=await fixture.next();assert.equal(request.method,'traffic.closeChannel');fixture.send({type:'response',id:request.id,ok:true,result:{closed:true}});assert.equal((await fixture.next()).ok,true);
  fixture.send({type:'request',id:8,method:'host.corePause',params:{operationId:'traffic-hold'}});assert.equal((await fixture.next()).result.held,true);
  fixture.send({type:'request',id:9,method:'host.snapshot',params:null});assert.equal((await fixture.next()).result.value.settled,true);
  fixture.send({type:'request',id:10,method:'shutdown',params:null});assert.equal((await fixture.next()).ok,true);
});

test('snapshot refusal preserves the old active Host and invalid restore never reports ready', async t => {
  const previous=await host(t, `module.exports={activate(){},saveState(){return {schema:1,value:{callback(){}}};},restoreState(){},deactivate(){}};`);
  previous.initialize(); assert.equal((await previous.next()).result.ready,true);
  previous.send({type:'request',id:2,method:'host.snapshot',params:null});
  const refusal=await previous.next(); assert.equal(refusal.error.code,'invalid_snapshot');
  previous.send({type:'request',id:3,method:'shutdown',params:null}); assert.equal((await previous.next()).ok,true);
  const next=await host(t, `module.exports={activate(){},deactivate(){}};`);
  next.initialize({initialState:{schema:1,value:{count:2}}});
  const failed=await next.next(); assert.equal(failed.ok,false); assert.equal(failed.error.code,'state_restore_unsupported');
  next.shutdown(); assert.equal((await next.next()).ok,true);
});

test('Host snapshot drains accepted invocation writes, denies new work, and resumes without replay', async t => {
  for(const mode of [undefined,'sdk']){
    const capability={name:'dev.snapshot.compute',api:1,scope:'runtime'};
    const fixture=await host(t,`let accepted=0,denied=false;module.exports={activate(context){
      context.rpc.provide({name:'dev.snapshot.compute',api:1,scope:'runtime'},'write',async()=>{
        const result=await context.core.request('Fixture.write',{operationKey:'once'});accepted=result.value;
        await new Promise(resolve=>setTimeout(resolve,40));
        await context.core.request('Fixture.finishAccepted',{value:accepted});return {accepted};
      });setTimeout(async()=>{try{await context.core.request('Fixture.newWrite',{});}catch(error){denied=error.code==='core_updating';}},20);
    },saveState(){return {schema:1,value:{accepted,denied}};},restoreState(){},deactivate(){}};`,undefined,mode);
    fixture.initialize({provides:[capability]});assert.equal((await fixture.next()).result.ready,true);
    fixture.send({type:'request',id:2,method:'capability.invoke',params:{capability,method:'write',params:null,caller:{pluginId:'caller',generation:1,targetId:'',documentEpoch:0},remainingMs:2000,scope:{kind:'runtime'}}});
    const write=await fixture.next();assert.equal(write.method,'capability.request');assert.equal(write.params.method,'Fixture.write');
    fixture.send({type:'request',id:3,method:'host.snapshot',params:null},{type:'response',id:write.id,ok:true,result:{value:42}});
    const continued=await fixture.next();assert.equal(continued.method,'capability.request');assert.equal(continued.params.method,'Fixture.finishAccepted');
    fixture.send({type:'response',id:continued.id,ok:true,result:{}});
    const invocation=await fixture.next();assert.equal(invocation.id,2);assert.deepEqual(invocation.result,{accepted:42});
    const snapshot=await fixture.next();assert.equal(snapshot.id,3);assert.deepEqual(snapshot.result,{schema:1,value:{accepted:42,denied:true}});
    fixture.send({type:'request',id:4,method:'host.resume',params:null});assert.deepEqual((await fixture.next()).result,{resumed:true});
    fixture.send({type:'request',id:5,method:'shutdown',params:null});assert.equal((await fixture.next()).ok,true);
  }
});

test('legacy stateless Host snapshots are null and saveState cannot introduce new SDK writes',async t=>{
  const legacy=await host(t,`module.exports={activate(){},deactivate(){}};`);legacy.initialize();assert.equal((await legacy.next()).result.ready,true);
  legacy.send({type:'request',id:2,method:'host.snapshot',params:null});assert.equal((await legacy.next()).result,null);
  legacy.send({type:'request',id:3,method:'host.resume',params:null});assert.equal((await legacy.next()).result.resumed,true);
  legacy.send({type:'request',id:4,method:'shutdown',params:null});assert.equal((await legacy.next()).ok,true);
  const impure=await host(t,`module.exports={activate(){},saveState(context){return context.core.request('Fixture.newWrite',{});},restoreState(){},deactivate(){}};`);impure.initialize();assert.equal((await impure.next()).result.ready,true);
  impure.send({type:'request',id:2,method:'host.snapshot',params:null});assert.equal((await impure.next()).error.code,'core_updating');
  impure.send({type:'request',id:3,method:'host.resume',params:null});assert.equal((await impure.next()).result.resumed,true);
  impure.send({type:'request',id:4,method:'shutdown',params:null});assert.equal((await impure.next()).ok,true);
});

test('paused Hosts admit only Core-authenticated cleanup and its bound requests',async t=>{
  for(const mode of [undefined,'sdk']){
    const capability={name:'dev.cleanup',api:1,scope:'runtime'};
    const fixture=await host(t,`module.exports={activate(context){context.rpc.provide({name:'dev.cleanup',api:1,scope:'runtime'},'restore',async()=>await context.core.request('Fixture.restore',{value:7}));},saveState(){return {schema:1,value:{count:42}};},restoreState(){},deactivate(){}};`,undefined,mode);
    fixture.initialize({provides:[capability]});assert.equal((await fixture.next()).result.ready,true);
    fixture.send({type:'request',id:2,method:'host.snapshot',params:null});assert.equal((await fixture.next()).result.value.count,42);
    const input={capability,method:'restore',params:{cleanup:true},caller:{pluginId:'caller',generation:1,targetId:'',documentEpoch:0},remainingMs:2000};
    fixture.send({type:'request',id:3,method:'capability.invoke',params:input});assert.equal((await fixture.next()).error.code,'core_updating');
    fixture.send({type:'request',id:4,method:'capability.invoke',params:{...input,cleanup:true}});
    const child=await fixture.next();assert.equal(child.method,'capability.request');assert.equal(child.params.invocationId,4);assert.equal(child.params.method,'Fixture.restore');
    fixture.send({type:'response',id:child.id,ok:true,result:{restored:7}});const receipt=await fixture.next();assert.equal(receipt.id,4);assert.deepEqual(receipt.result,{restored:7});
    fixture.send({type:'request',id:5,method:'host.resume',params:null});assert.equal((await fixture.next()).result.resumed,true);
    fixture.send({type:'request',id:6,method:'shutdown',params:null});assert.equal((await fixture.next()).ok,true);
  }
});

test('late snapshot completion after timeout/resume cannot overwrite a newer snapshot or emit a second receipt',async t=>{
  const fixture=await host(t,`let count=0;module.exports={activate(){},async saveState(){const value=++count;if(value===1)await new Promise(resolve=>setTimeout(resolve,1700));return {schema:1,value:{count:value}};},restoreState(){},deactivate(){}};`,undefined,'sdk');
  fixture.initialize();assert.equal((await fixture.next()).result.ready,true);
  fixture.send({type:'request',id:2,method:'host.snapshot',params:null});assert.equal((await fixture.next()).error.code,'snapshot_timeout');
  fixture.send({type:'request',id:3,method:'host.resume',params:null});assert.equal((await fixture.next()).result.resumed,true);
  fixture.send({type:'request',id:4,method:'host.snapshot',params:null});const snapshot=await fixture.next();assert.equal(snapshot.id,4);assert.deepEqual(snapshot.result,{schema:1,value:{count:2}});
  await new Promise(resolve=>setTimeout(resolve,350));
  fixture.send({type:'request',id:5,method:'shutdown',params:null});const stopped=await fixture.next();assert.equal(stopped.id,5);assert.equal(stopped.ok,true);
});

test('snapshot refuses an unpaired save hook and retains a resumable active Host',async t=>{
  for(const mode of [undefined,'sdk']){
    const fixture=await host(t,`module.exports={activate(){},saveState(){console.log('must-not-save');return {schema:1,value:null};},deactivate(){}};`,undefined,mode);
    fixture.initialize();assert.equal((await fixture.next()).result.ready,true);
    fixture.send({type:'request',id:2,method:'host.snapshot',params:null});
    assert.equal((await fixture.next()).error.code,'state_restore_unsupported');
    assert.doesNotMatch(fixture.stderr(),/must-not-save/);
    fixture.send({type:'request',id:3,method:'host.resume',params:null});
    assert.equal((await fixture.next()).result.resumed,true);
    fixture.send({type:'request',id:4,method:'shutdown',params:null});assert.equal((await fixture.next()).ok,true);
  }
});

async function host(t, source, setup, mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'codlet-js-bootstrap-'));
  const entry = path.join(root, 'host.js');
  const snapshot = path.join(root, 'snapshot.js');
  const bootstrapPath = path.join(root, 'bootstrap.cjs');
  await writeFile(snapshot, source);
  await writeFile(bootstrapPath, bootstrap);
  await setup?.(root);
  const child = spawn(process.execPath, ['--no-addons', '--no-experimental-strip-types', '--require', bootstrapPath, '--eval', '', '--', entry, snapshot, ...(mode ? [mode] : [])], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    const frame = JSON.parse(line);
    if (waiters.length) waiters.shift()(frame); else frames.push(frame);
  });
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    reader.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('codlet-js-bootstrap-'));
    await rm(root, { recursive: true, force: true });
  });
  return {
    child, exited, stderr: () => stderr,
    send(...messages) { child.stdin.write(messages.map(message => JSON.stringify({ ...identity, ...message }) + '\n').join('')); },
    next() {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`host did not produce a frame: ${stderr}`)), 3000);
        waiters.push(value => { clearTimeout(timer); resolve(value); });
      });
    },
    initialize(params = {}) { this.send({ type: 'request', id: 1, method: 'initialize', params: { protocolVersion: 1, pluginVersion: '1', ...params } }); },
    shutdown(cleanupBudgetMs) { this.send({ type: 'request', id: 2, method: 'shutdown', params: cleanupBudgetMs === undefined ? null : { cleanupBudgetMs } }); },
  };
}

test('retired async subscription callbacks cannot abort the separate cleanup phase', async t => {
  for (const method of ['cdp.event', 'cdp.subscriptionEnded']) {
    const fixture = await host(t, `module.exports = {
      async activate(context) {
        const callback = async () => { await context.cdp.request('Fixture.waitingCallback'); };
        await context.cdp.subscribe({scope:'all'}, callback, callback);
      },
      async deactivate(cleanup) {
        await cleanup.cdp.request('Fixture.cleanup');
        console.log('cleanup-finished');
      }
    };`);
    fixture.initialize();
    const subscribe = await fixture.next();
    fixture.send({ type: 'response', id: subscribe.id, ok: true, result: { subscriptionId: 1 } });
    assert.equal((await fixture.next()).result.ready, true);
    fixture.send({ type: 'notification', method, params: { subscriptionId: 1, event: { method: 'Fixture.event' }, reason: 'fixture-end' } });
    const pending = await fixture.next();
    assert.equal(pending.params.method, 'Fixture.waitingCallback');
    fixture.shutdown(800);
    const cleanup = await fixture.next();
    assert.equal(cleanup.method, 'cleanup.request');
    assert.equal(cleanup.params.params.method, 'Fixture.cleanup');
    fixture.send({ type: 'response', id: cleanup.id, ok: true, result: {} });
    assert.equal((await fixture.next()).ok, true);
    assert.equal((await fixture.exited)[0], 0);
    assert.match(fixture.stderr(), /cleanup-finished/);
  }
});

test('errors in active subscription callbacks still fail their plugin', async t => {
  for (const method of ['cdp.event', 'cdp.subscriptionEnded']) {
    const fixture = await host(t, `module.exports = {
      async activate(context) {
        const callback = async () => { throw new Error('active-callback-failed'); };
        await context.cdp.subscribe({scope:'all'}, callback, callback);
      },
      deactivate() {}
    };`);
    fixture.initialize();
    const subscribe = await fixture.next();
    fixture.send({ type: 'response', id: subscribe.id, ok: true, result: { subscriptionId: 1 } });
    assert.equal((await fixture.next()).result.ready, true);
    fixture.send({ type: 'notification', method, params: { subscriptionId: 1, event: { method: 'Fixture.event' }, reason: 'fixture-end' } });
    assert.equal((await fixture.exited)[0], 1);
    assert.match(fixture.stderr(), /active-callback-failed/);
  }
});

test('host bootstrap delivers a coalesced subscription response and first event before activation completes', async t => {
  const fixture = await host(t, `module.exports = {
    async activate(context) {
      const first = new Promise(resolve => context.cdp.subscribe({scope:'all'}, event => resolve(event)));
      const event = await first;
      await context.cdp.request('Fixture.afterEvent', {method:event.method});
    },
    deactivate() { console.log('cleaned-once'); }
  };`);
  fixture.initialize();
  const subscribe = await fixture.next();
  assert.equal(subscribe.method, 'cdp.subscribe');
  fixture.send(
    { type: 'response', id: subscribe.id, ok: true, result: { subscriptionId: 1 } },
    { type: 'notification', method: 'cdp.event', params: { subscriptionId: 1, event: { method: 'Runtime.fixture', params: {}, sessionId: null } } },
  );
  const request = await fixture.next();
  assert.equal(request.params.method, 'Fixture.afterEvent');
  assert.deepEqual(request.params.params, { method: 'Runtime.fixture' });
  fixture.send({ type: 'response', id: request.id, ok: true, result: {} });
  assert.equal((await fixture.next()).result.ready, true);
  fixture.shutdown();
  const stopped = await fixture.next();
  assert.equal(stopped.id, 2);
  assert.equal(stopped.ok, true);
  assert.equal((await fixture.exited)[0], 0);
  assert.equal(fixture.stderr().match(/cleaned-once/g).length, 1);
});

test('shutdown aborts an initializing JS request and runs deactivate without late activation replies', async t => {
  const fixture = await host(t, `module.exports = {
    activate(context) { return context.cdp.request('Fixture.never'); },
    deactivate() { console.log('cancelled-cleanup'); }
  };`);
  fixture.initialize();
  const pending = await fixture.next();
  assert.equal(pending.method, 'cdp.request');
  fixture.shutdown();
  const reply = await fixture.next();
  assert.equal(reply.id, 2);
  assert.equal(reply.ok, true);
  assert.equal((await fixture.exited)[0], 0);
  assert.match(fixture.stderr(), /cancelled-cleanup/);
});

test('activation errors retain their code and cleanup still runs during shutdown', async t => {
  const fixture = await host(t, `module.exports = {
    activate() { throw Object.assign(new Error('fixture failure'), {code:'fixture_error'}); },
    deactivate() { console.log('failed-cleanup'); }
  };`);
  fixture.initialize();
  const failed = await fixture.next();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'fixture_error');
  fixture.shutdown();
  assert.equal((await fixture.next()).id, 2);
  assert.equal((await fixture.exited)[0], 0);
  assert.match(fixture.stderr(), /failed-cleanup/);
});

test('a CommonJS dependency back-reference sees the source snapshot without evaluating the changed entry twice', async t => {
  const fixture = await host(t, `
    exports.marker = 'snapshot';
    const marker = require('./helper.js');
    exports.activate = context => context.cdp.request('Fixture.cache', {marker});
    exports.deactivate = () => {};
  `, async root => {
    await writeFile(path.join(root, 'host.js'), "throw new Error('disk entry must not be evaluated again');");
    await writeFile(path.join(root, 'helper.js'), "module.exports = require('./host.js').marker;");
  });
  fixture.initialize();
  const request = await fixture.next();
  assert.equal(request.method, 'cdp.request');
  assert.deepEqual(request.params.params, { marker: 'snapshot' });
  fixture.send({ type: 'response', id: request.id, ok: true, result: {} });
  assert.equal((await fixture.next()).result.ready, true);
  fixture.shutdown();
  assert.equal((await fixture.next()).ok, true);
  assert.equal((await fixture.exited)[0], 0);
});

test('deactivate has a distinct cleanup request phase while ordinary calls and late replies retire', async t => {
  const fixture = await host(t, `let ordinary; module.exports = {
    activate(context) { ordinary = context; return context.cdp.request('Fixture.old'); },
    async deactivate(cleanup) {
      try { await ordinary.cdp.request('Fixture.mustNotRun'); } catch (error) { console.log(error.code); }
      if (!ordinary.signal.aborted || cleanup.signal.aborted) throw new Error('incorrect phase signals');
      await cleanup.cdp.request('Target.detachFromTarget', {sessionId:'old-session'});
    }
  };`);
  fixture.initialize();
  const old = await fixture.next();
  fixture.shutdown(800);
  const cleanup = await fixture.next();
  assert.equal(cleanup.method, 'cleanup.request');
  assert.equal(cleanup.params.method, 'cdp.request');
  assert.equal(cleanup.params.params.method, 'Target.detachFromTarget');
  fixture.send(
    {type:'response', id:old.id, ok:true, result:{late:true}},
    {type:'response', id:cleanup.id, ok:true, result:{}},
  );
  const stopped = await fixture.next();
  assert.equal(stopped.id, 2);
  assert.equal(stopped.ok, true);
  assert.equal((await fixture.exited)[0], 0);
  assert.match(fixture.stderr(), /host_stopping/);
});

test('an unresolved activation Promise does not consume the entire deactivate opportunity', async t => {
  const fixture = await host(t, `module.exports = {
    async activate(context) { await context.cdp.request('Fixture.started'); return new Promise(() => {}); },
    deactivate(cleanup) { return cleanup.core.request('cdp.request', {method:'Fixture.cleanup'}); }
  };`);
  fixture.initialize();
  const activated = await fixture.next();
  fixture.send({type:'response', id:activated.id, ok:true, result:{}});
  fixture.shutdown(800);
  const cleanup = await fixture.next();
  assert.equal(cleanup.method, 'cleanup.request');
  fixture.send({type:'response', id:cleanup.id, ok:true, result:{}});
  assert.equal((await fixture.next()).id, 2);
  assert.equal((await fixture.exited)[0], 0);
});

test('a sequence of cleanup calls shares one total deadline and yields an explicit failure', async t => {
  const fixture = await host(t, `module.exports = {
    activate() {},
    async deactivate(cleanup) {
      await cleanup.cdp.request('Fixture.first');
      await cleanup.cdp.request('Fixture.never', {}, {timeoutMs:15000});
    }
  };`);
  fixture.initialize();
  assert.equal((await fixture.next()).result.ready, true);
  const started = performance.now();
  fixture.shutdown(120);
  const first = await fixture.next();
  await new Promise(resolve => setTimeout(resolve, 50));
  fixture.send({type:'response', id:first.id, ok:true, result:{}});
  assert.equal((await fixture.next()).params.params.method, 'Fixture.never');
  const stopped = await fixture.next();
  assert.equal(stopped.id, 2);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, 'cleanup_timeout');
  assert.ok(performance.now() - started < 500);
  assert.equal((await fixture.exited)[0], 1);
});
