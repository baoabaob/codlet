import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const bundle = fileURLToPath(new URL('../runtime/client-bridge-bundle.cjs', import.meta.url));
const TOKEN = 'c'.repeat(48);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function request(endpoint, input) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: endpoint.host, port: endpoint.port});
    let body = '';
    socket.on('connect', () => socket.write(JSON.stringify({...input, token: TOKEN}) + '\n'));
    socket.on('data', data => body += data);
    socket.on('error', error=>{error.bridgeOperation=input.op;error.bridgeOperationId=input.operationId;reject(error);});
    socket.on('end', () => {socket.destroy();try {resolve(JSON.parse(body));} catch {reject(Error('connection_closed'));}});
  });
}
function source(generation, {broken = false, invalid = false, rollbackBroken = false,fixtureSource=false} = {}) {
  return `module.exports={handoffVersion:1,validateClientSource(){},validateSnapshot:s=>s.schema===1,
  installElectronTraffic(electron,configuration,context){
    let count=0,suspended=false,closed=false;
    if(${fixtureSource}&&!context.resources.has('plaintextSource'))context.resources.set('plaintextSource',{reserveRoute(options){require('node:fs').appendFileSync(configuration.log,'fixture-route-register:'+options.upstreamBaseUrl+'\\n');return {baseUrl:'http://127.0.0.1:49123/private-fixture-route',ready:Promise.resolve(true),close(){require('node:fs').appendFileSync(configuration.log,'fixture-route-close\\n');}};},close(){}});
    const Native=context.modules.list().find(r=>r.name==='native.cjs').exported.Native;
    const original=Native.prototype.value;const hook=()=>({generation:${generation},count});Native.prototype.value=hook;
    const restore=s=>{if(s)count=s.count;};
    const ingress=function(params,operationId){
      if(!context.onlineUpdates.accepting())return context.onlineUpdates.whenAccepting().then(()=>Native.prototype.submit.call(this,params,operationId));
      return context.onlineUpdates.execute({operationId,expectedEpoch:context.onlineUpdates.epoch(),method:'increment',params},(value,metadata)=>runtime.handleWrite('increment',value,metadata));
    };
    const originalSubmit=Native.prototype.submit;Native.prototype.submit=ingress;
    const runtime={handoffVersion:1,
      snapshot:()=>${invalid ? '({schema:1,count,node:()=>{}})' : '({schema:1,count})'},
      suspend(){suspended=true;if(Native.prototype.value===hook)Native.prototype.value=original;if(Native.prototype.submit===ingress)Native.prototype.submit=originalSubmit;return true;},
      resume(s){if(${rollbackBroken})return false;restore(s);suspended=false;Native.prototype.value=hook;Native.prototype.submit=ingress;return true;},restore,
      confirmTakeover:()=>${!broken},ready:async()=>({installed:true,activatedSources:[],unsupportedSources:[]}),
      async handleWrite(method,params,{signal,operationId}){
        if(method!=='increment')throw Object.assign(Error(),{code:'unknown_method',outcome:'not_applied'});
        await new Promise(resolve=>setTimeout(resolve,params.delay??0));
        if(closed||suspended)throw Object.assign(Error(),{code:'late_owner',outcome:'not_applied'});
        count++;require('node:fs').appendFileSync(configuration.log,operationId+'\\n');return {count};
      },
      close(){closed=true;if(Native.prototype.value===hook)Native.prototype.value=original;if(Native.prototype.submit===ingress)Native.prototype.submit=originalSubmit;}
    };return runtime;}};`;
}
async function nativeFixture(t,{ownedFixtureRoutes=false}={}) {
  const root = await mkdtemp(path.join(tmpdir(), 'codlet-online-ipc-'));
  const entry = path.join(root, 'entry.cjs');
  await writeFile(entry, `const net=require('node:net');const Module=require('node:module');
  const {startClientBridge}=require(${JSON.stringify(bundle)});
  const bridge=startClientBridge({app:{isReady:()=>false,getAppPath:()=>__dirname}},{token:${JSON.stringify(TOKEN)},ownedFixtureRoutes:${ownedFixtureRoutes}});
  const mod=new Module(__dirname+'/native.cjs');mod.filename=__dirname+'/native.cjs';
  mod._compile('class Native {constructor(){this.alive=true;}value(){return "initial";}};module.exports={Native};',mod.filename);
  const native=new mod.exports.Native();
  const sockets=new Set();let sequence=0;
  const stream=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  stream.listen(0,'127.0.0.1',async()=>{const endpoint=await bridge.endpoint();process.send({endpoint,streamPort:stream.address().port,pid:process.pid});});
  setInterval(()=>{for(const socket of sockets)socket.write(JSON.stringify({sequence:++sequence,value:native.value()})+'\\n');},15);
  process.on('message',message=>{if(message==='stop')bridge.close().finally(()=>process.exit(0));
    else if(message?.op==='pluginWrite')Promise.resolve().then(()=>native.submit(message.params,message.operationId)).then(result=>process.send({tag:message.tag,result}),error=>process.send({tag:message.tag,error:error.code??'native_write_failed'}));});`);
  const child = spawn(process.execPath, [entry], {cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = '';
  child.stderr.on('data', bytes => stderr += bytes);
  const identity = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('fixture_timeout: ' + stderr)), 5000);
    child.once('message', value => {clearTimeout(timer); resolve(value);});
    child.once('error', reject);
  });
  t.after(async () => {
    if (child.exitCode === null) {child.send('stop'); await new Promise(resolve => child.once('exit', resolve));}
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, {recursive: true});
  });
  return {...identity, child, root, log: path.join(root, 'writes.log')};
}
async function coreLease(t, f, options = {}) {
  const file = path.join(f.root, 'lease-' + Math.random().toString(16).slice(2) + '.cjs');
  await writeFile(file, `const net=require('node:net');const socket=net.createConnection({host:'127.0.0.1',port:${f.endpoint.port}});let text='';
  socket.on('connect',()=>socket.write(JSON.stringify({op:'lease',token:${JSON.stringify(TOKEN)},...${JSON.stringify(options)}})+'\\n'));
  socket.on('data',bytes=>{text+=bytes;const at=text.indexOf('\\n');if(at>=0)process.send({pid:process.pid,...JSON.parse(text.slice(0,at))});});
  socket.on('error',error=>process.send({error:error.code}));socket.on('close',()=>process.exit(0));
  process.on('message',message=>{if(message==='stop')socket.destroy();});`);
  const child = spawn(process.execPath, [file], {windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  const receipt = await new Promise((resolve, reject) => {child.once('message', resolve); child.once('error', reject);});
  t.after(() => {if (child.exitCode === null) child.kill();});
  return {child, receipt};
}
const replacement = (f, generation, epoch, options = {}) => ({op: 'replace', operationId: `generation-${generation}-${options.broken ? 'broken' : 'good'}`, expectedEpoch: epoch, previousOwner: epoch ? 'codlet.core' : null,
  owner: 'codlet.core', generation, code: source(generation, options), compatibleUpdate: true, configuration: {log: f.log}, ...options});
function pluginWrite(f,operationId,params={}) {
  const tag=Math.random().toString(16).slice(2);
  return new Promise((resolve,reject)=>{const listener=message=>{if(message.tag!==tag)return;f.child.off('message',listener);message.error?reject(Error(message.error)):resolve(message.result);};f.child.on('message',listener);f.child.send({op:'pluginWrite',tag,operationId,params});});
}

test('real IPC takeover preserves the Native stream, explicit state and accepted write outcomes across Core lease owners', async t => {
  const f = await nativeFixture(t);
  const first = await coreLease(t, f);
  assert.equal(first.receipt.result.leased, true);
  assert.equal((await request(f.endpoint, replacement(f, 1, 0))).result.outcome, 'applied');
  const frames = [];let buffer = '';
  const stream = net.createConnection({host: '127.0.0.1', port: f.streamPort});
  const streamErrors=[];stream.on('error',error=>streamErrors.push(error.code));
  stream.on('data', bytes => {buffer += bytes; for(let at; (at=buffer.indexOf('\n'))>=0;) {frames.push(JSON.parse(buffer.slice(0, at)));buffer=buffer.slice(at+1);}});
  t.after(() => stream.destroy());
  await delay(35);
  const write = {op:'write',operationId:'accepted-write',expectedEpoch:1,method:'increment',params:{delay:100}};
  assert.equal((await request(f.endpoint, write)).result.outcome, 'accepted');
  const update = request(f.endpoint, replacement(f, 2, 1));
  await delay(20);
  assert.equal((await request(f.endpoint, {op:'status'})).result.onlineUpdate.writes.accepting, false);
  assert.equal((await request(f.endpoint, {...write,operationId:'paused-write'})).code, 'core_write_admission_paused');
  const updated = (await update).result;
  assert.equal(updated.outcome, 'applied');assert.equal(updated.retirement, 'confirmed');assert.equal(updated.epoch, 2);
  assert.equal((await request(f.endpoint, {op:'writeResult',operationId:write.operationId})).result.outcome, 'applied');
  assert.equal((await request(f.endpoint, write)).result.outcome, 'applied');
  assert.equal(await readFile(f.log,'utf8'), 'accepted-write\n');
  assert.equal((await request(f.endpoint, {...write,operationId:'stale-write'})).code, 'core_write_stale_epoch');
  const transfer = (await request(f.endpoint,{op:'prepareLeaseTransfer',expectedLeaseEpoch:0})).result;
  assert.equal((await request(f.endpoint,{op:'abortLeaseTransfer',transferId:transfer.transferId,expectedLeaseEpoch:0})).result.outcome,'aborted');
  const retryTransfer=(await request(f.endpoint,{op:'prepareLeaseTransfer',expectedLeaseEpoch:0})).result;
  const next = await coreLease(t, f, {transferId:retryTransfer.transferId,expectedLeaseEpoch:0});
  assert.equal(next.receipt.result.leased,true);assert.equal(next.receipt.result.onlineUpdate.leaseEpoch,1);
  assert.notEqual(first.child.pid,next.child.pid);
  first.child.send('stop');await new Promise(resolve=>first.child.once('exit',resolve));
  await delay(45);
  assert.equal((await request(f.endpoint,{op:'status'})).result.pid,f.pid);
  assert.equal((await request(f.endpoint,{op:'abortLeaseTransfer',transferId:retryTransfer.transferId,expectedLeaseEpoch:0})).code,'core_update_lease_changed');
  assert.ok(frames.some(frame=>frame.value.generation===1));
  assert.ok(frames.some(frame=>frame.value.generation===2&&frame.value.count===1));
  assert.ok(frames.every((frame,index)=>!index||frame.sequence===frames[index-1].sequence+1));
  assert.equal(stream.destroyed,false);
  assert.deepEqual(streamErrors,[]);
  console.log(JSON.stringify({proof:'real-ipc-core-handoff',nativePid:f.pid,oldCorePid:first.receipt.pid,newCorePid:next.receipt.pid,streamFrames:frames.length,stateRestored:true,acceptedWriteAppliedOnce:true}));
});

test('failed takeover and invalid snapshots retain the old live owner and stream', async t => {
  const f=await nativeFixture(t);await coreLease(t,f);
  await request(f.endpoint,replacement(f,1,0));
  const failed=(await request(f.endpoint,replacement(f,2,1,{broken:true}))).result;
  assert.equal(failed.outcome,'rolled_back');assert.equal(failed.generation,1);assert.equal(failed.epoch,2);
  const next=(await request(f.endpoint,{...replacement(f,3,2,{invalid:true}),previousOwner:'codlet.core'})).result;
  assert.equal(next.outcome,'applied');
  const invalid=(await request(f.endpoint,{...replacement(f,4,3),previousOwner:'codlet.core'})).result;
  assert.equal(invalid.outcome,'rejected');assert.equal(invalid.error,'core_update_snapshot_invalid');assert.equal(invalid.epoch,3);assert.equal(invalid.generation,3);
});

test('cancellation stays explicitly unknown after a late write reply and aborts takeover while the old write is executing',async t=>{
  const f=await nativeFixture(t);await coreLease(t,f);await request(f.endpoint,replacement(f,1,0));
  await request(f.endpoint,{op:'write',operationId:'cancelled',expectedEpoch:1,method:'increment',params:{delay:100}});
  const cancelled=(await request(f.endpoint,{op:'cancelWrite',operationId:'cancelled'})).result;
  assert.equal(cancelled.outcome,'unknown');
  const rejected=(await request(f.endpoint,{...replacement(f,2,1),drainTimeoutMs:5})).result;
  assert.equal(rejected.outcome,'rejected');assert.equal(rejected.error,'core_update_writes_unsettled');assert.equal(rejected.generation,1);
  await delay(120);
  const late=(await request(f.endpoint,{op:'writeResult',operationId:'cancelled'})).result;
  assert.equal(late.outcome,'unknown');assert.equal(late.error,'core_write_cancelled');
  assert.equal(await readFile(f.log,'utf8'),'cancelled\n');
});

test('cancelling a draining update keeps its accepted write and old owner, and changed operation IDs cannot be reused',async t=>{
  const f=await nativeFixture(t);await coreLease(t,f);await request(f.endpoint,replacement(f,1,0));
  await request(f.endpoint,{op:'write',operationId:'settle-before-cancel',expectedEpoch:1,method:'increment',params:{delay:80}});
  const command=replacement(f,2,1),pending=request(f.endpoint,command);
  await delay(15);
  assert.equal((await request(f.endpoint,{op:'cancelUpdate',operationId:command.operationId})).result.outcome,'cancellation_requested');
  const retained=(await pending).result;
  assert.equal(retained.outcome,'rejected');assert.equal(retained.error,'core_update_cancelled');assert.equal(retained.generation,1);assert.equal(retained.epoch,1);
  assert.equal((await request(f.endpoint,{op:'writeResult',operationId:'settle-before-cancel'})).result.outcome,'applied');
  assert.equal((await request(f.endpoint,{...command,code:source(3)})).code,'client_bridge_operation_id_conflict');
});

test('one admission lease holds explicit plugin writes across the entire module transaction and resumes them in the new owner once',async t=>{
  const f=await nativeFixture(t);await coreLease(t,f);await request(f.endpoint,replacement(f,1,0));
  const frames=[];const stream=net.createConnection({host:'127.0.0.1',port:f.streamPort});let buffer='';const streamErrors=[];stream.on('error',error=>streamErrors.push(error.code));
  stream.on('data',bytes=>{buffer+=bytes;for(let at;(at=buffer.indexOf('\n'))>=0;){frames.push(JSON.parse(buffer.slice(0,at)));buffer=buffer.slice(at+1);}});t.after(()=>stream.destroy());
  const accepted={op:'write',operationId:'before-snapshot',expectedEpoch:1,method:'increment',params:{delay:75}};
  await request(f.endpoint,accepted);
  const begin={op:'beginAdmission',operationId:'whole-core-admission',expectedEpoch:1};
  const held=(await request(f.endpoint,begin)).result;
  assert.equal(held.outcome,'held');assert.equal(held.acceptedReceipts.find(receipt=>receipt.operationId===accepted.operationId).outcome,'applied');
  assert.equal((await request(f.endpoint,begin)).result.admissionToken,held.admissionToken);
  const duplicate=(await request(f.endpoint,{...begin,drainTimeoutMs:1}));assert.equal(duplicate.code,'client_bridge_operation_id_conflict');
  assert.equal((await request(f.endpoint,{...begin,operationId:'another-owner'})).result.error,'core_admission_owner_busy');
  let resolved=0;const queued=pluginWrite(f,'queued-during-snapshot').then(value=>{resolved++;return value;});const same=pluginWrite(f,'queued-during-snapshot').then(value=>{resolved++;return value;});
  const at=frames.length;await delay(65);assert.equal(resolved,0);assert.ok(frames.length>at);assert.equal(await readFile(f.log,'utf8'),'before-snapshot\n');
  const protectedUpdate={...replacement(f,2,1),admissionId:begin.operationId,admissionToken:held.admissionToken};
  assert.equal((await request(f.endpoint,replacement(f,2,1))).result.error,'core_admission_owner_changed');
  // The rejected attempt was a different immutable operation, not replayable.
  protectedUpdate.operationId='protected-source-takeover';
  const updated=(await request(f.endpoint,protectedUpdate)).result;assert.equal(updated.outcome,'applied');assert.equal(updated.onlineUpdate.writes.accepting,false);
  await delay(45);assert.equal(resolved,0);assert.equal((await request(f.endpoint,{op:'status'})).result.onlineUpdate.admission.operationId,begin.operationId);
  const release={op:'finishAdmission',operationId:'whole-core-release',expectedEpoch:2,admissionId:begin.operationId,admissionToken:held.admissionToken,disposition:'applied'};
  const resumed=(await request(f.endpoint,release)).result;assert.equal(resumed.outcome,'admission_resumed');assert.equal(resumed.onlineUpdate.writes.accepting,true);
  const [first,second]=await Promise.all([queued,same]);assert.equal(first.epoch,2);assert.equal(first.outcome,'applied');assert.deepEqual(second,first);
  assert.equal(await readFile(f.log,'utf8'),'before-snapshot\nqueued-during-snapshot\n');
  assert.equal((await request(f.endpoint,release)).result.outcome,'admission_resumed');await delay(35);assert.equal(resolved,2);
  assert.ok(frames.every((frame,index)=>!index||frame.sequence===frames[index-1].sequence+1));assert.equal(stream.destroyed,false);
  assert.deepEqual(streamErrors,[]);
});

test('failed source takeover keeps the outer lease held until old owners confirm restoration',async t=>{
  const f=await nativeFixture(t);await coreLease(t,f);await request(f.endpoint,replacement(f,1,0));
  const held=(await request(f.endpoint,{op:'beginAdmission',operationId:'rollback-admission',expectedEpoch:1})).result;
  let settled=false;const queued=pluginWrite(f,'rollback-queued').then(result=>{settled=true;return result;});await delay(25);assert.equal(settled,false);
  const failed=(await request(f.endpoint,{...replacement(f,2,1,{broken:true}),admissionId:'rollback-admission',admissionToken:held.admissionToken})).result;
  assert.equal(failed.outcome,'rolled_back');assert.equal(failed.onlineUpdate.writes.accepting,false);await delay(35);assert.equal(settled,false);
  const finished=(await request(f.endpoint,{op:'finishAdmission',operationId:'rollback-release',expectedEpoch:2,admissionId:'rollback-admission',admissionToken:held.admissionToken,disposition:'rolled_back'})).result;
  assert.equal(finished.outcome,'admission_resumed');assert.equal(finished.generation,1);assert.equal((await queued).outcome,'applied');assert.equal(await readFile(f.log,'utf8'),'rollback-queued\n');
});
test('a degraded source receipt preserves admission when neither takeover nor rollback is confirmed',async t=>{
  const f=await nativeFixture(t);await coreLease(t,f);
  await request(f.endpoint,{...replacement(f,1,0),code:source(1,{rollbackBroken:true})});
  const held=(await request(f.endpoint,{op:'beginAdmission',operationId:'degraded-admission',expectedEpoch:1})).result;
  const failed=(await request(f.endpoint,{...replacement(f,2,1,{broken:true}),operationId:'degraded-source',admissionId:'degraded-admission',admissionToken:held.admissionToken})).result;
  assert.equal(failed.outcome,'degraded');assert.equal(failed.onlineUpdate.writes.accepting,false);
  for(const disposition of ['applied','rolled_back']){
    const result=(await request(f.endpoint,{op:'finishAdmission',operationId:'degraded-release-'+disposition,expectedEpoch:2,admissionId:'degraded-admission',admissionToken:held.admissionToken,disposition})).result;
    assert.equal(result.outcome,'rejected');assert.equal(result.error,'core_admission_source_unconfirmed');
  }
  assert.equal((await request(f.endpoint,{op:'status'})).result.onlineUpdate.writes.accepting,false);
  assert.equal((await request(f.endpoint,{op:'status',operationId:'degraded-source'})).result.outcome,'degraded');
});
test('explicit fixture routes require the private launch gate, allocate once and outlive source generations',async t=>{
  const normal=await nativeFixture(t);await coreLease(t,normal);
  const input={op:'ownedFixtureRoute',operationId:'fixture-route-one',expectedEpoch:0,upstreamBaseUrl:'http://127.0.0.1:49321/v1'};
  assert.equal((await request(normal.endpoint,input)).result.error,'core_fixture_unavailable');
  const f=await nativeFixture(t,{ownedFixtureRoutes:true});await coreLease(t,f);
  await request(f.endpoint,replacement(f,1,0,{fixtureSource:true}));
  const command={...input,expectedEpoch:1};const registered=(await request(f.endpoint,command)).result;
  assert.equal(registered.outcome,'fixture_route_registered');assert.equal(registered.kind,'fixture-explicit-source');
  assert.equal((await request(f.endpoint,command)).result.routeBaseUrl,registered.routeBaseUrl);
  assert.equal((await request(f.endpoint,{...command,operationId:'second-route'})).result.error,'core_fixture_already_used');
  await request(f.endpoint,replacement(f,2,1));assert.equal((await request(f.endpoint,{op:'status'})).result.onlineUpdate.fixtureExplicitSource.registered,true);
  assert.equal(await readFile(f.log,'utf8'),'fixture-route-register:http://127.0.0.1:49321/v1\n');
  f.child.send('stop');await new Promise(resolve=>f.child.once('exit',resolve));
  assert.equal(await readFile(f.log,'utf8'),'fixture-route-register:http://127.0.0.1:49321/v1\nfixture-route-close\n');
});

test('lost admission acknowledgments are settled by original receipts while late cancelled writes remain explicit unknown',async t=>{
  const f=await nativeFixture(t);await coreLease(t,f);await request(f.endpoint,replacement(f,1,0));
  await request(f.endpoint,{op:'write',operationId:'late-admission-write',expectedEpoch:1,method:'increment',params:{delay:65}});
  await request(f.endpoint,{op:'cancelWrite',operationId:'late-admission-write'});await delay(85);
  const command={op:'beginAdmission',operationId:'lost-admission',expectedEpoch:1};
  // Send once and discard its reply; only query its immutable operation receipt.
  await new Promise(resolve=>{const socket=net.createConnection({host:f.endpoint.host,port:f.endpoint.port});socket.on('connect',()=>{socket.write(JSON.stringify({...command,token:TOKEN})+'\n',()=>{socket.destroy();resolve();});});socket.on('error',resolve);});
  await delay(35);const held=(await request(f.endpoint,{op:'status',operationId:command.operationId})).result;
  assert.equal(held.outcome,'blocked');assert.equal(held.acceptedReceipts.find(receipt=>receipt.operationId==='late-admission-write').outcome,'unknown');
  assert.equal((await request(f.endpoint,{op:'status'})).result.onlineUpdate.writes.accepting,false);
  assert.equal((await request(f.endpoint,{op:'finishAdmission',operationId:'unknown-disposition',expectedEpoch:1,admissionId:command.operationId,admissionToken:held.admissionToken,disposition:'unknown'})).result.error,'core_admission_disposition_invalid');
  const restored=(await request(f.endpoint,{op:'finishAdmission',operationId:'lost-release',expectedEpoch:1,admissionId:command.operationId,admissionToken:held.admissionToken,disposition:'rolled_back'})).result;assert.equal(restored.outcome,'admission_resumed');
  assert.equal((await request(f.endpoint,{op:'writeResult',operationId:'late-admission-write'})).result.outcome,'unknown');assert.equal(await readFile(f.log,'utf8'),'late-admission-write\n');
});
