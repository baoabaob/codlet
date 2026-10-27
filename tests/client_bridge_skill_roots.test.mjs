import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

async function fixture(t,mode){
  const process=spawn(globalThis.process.execPath,[fileURLToPath(new URL('./fixtures/client-bridge-skill-roots.cjs',import.meta.url)),mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='',sequence=0;process.stderr.on('data',chunk=>stderr+=chunk);
  const lines=createInterface({input:process.stdout})[Symbol.asyncIterator]();
  const next=async()=>{const value=await lines.next();assert.equal(value.done,false,stderr);return JSON.parse(value.value);};
  const endpoint=await next();assert.equal(endpoint.kind,'endpoint');assert.equal(endpoint.pid,process.pid);
  const control=async(action,fields={})=>{const id=++sequence;process.stdin.write(JSON.stringify({id,action,...fields})+'\n');assert.deepEqual(await next(),{kind:'control',id,action});};
  t.after(async()=>{if(process.exitCode===null&&process.signalCode===null){const exited=new Promise(resolve=>process.once('exit',resolve));process.stdin.end();await exited;}assert.equal(process.exitCode,0,stderr);});
  return {endpoint,control};
}
function request(endpoint,input){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:endpoint.host,port:endpoint.port});let body='';
    socket.on('connect',()=>socket.write(JSON.stringify({...input,token:endpoint.token})+'\n'));
    socket.on('data',chunk=>body+=chunk);socket.on('error',reject);socket.on('end',()=>{try{const response=JSON.parse(body);assert.equal(response.ok,true);resolve(response.result);}catch(error){reject(error);}});
  });
}
const query=(endpoint,extra={})=>request(endpoint,{op:'skillRoots',clientId:'actual-test-client',clientEpoch:1,anchors:[],...extra});
for(const mode of ['source','bundle'])test(`actual ${mode} skillRoots TCP envelopes retain server identity for every observation state`,{timeout:15000},async t=>{
  const {endpoint,control}=await fixture(t,mode),seen=[];
  const read=async extra=>{const result=await query(endpoint,extra);assert.equal(result.pid,endpoint.pid);assert.equal(result.executable,process.execPath);assert.equal(result.type,'browser');seen.push(result);return result;};
  const unobserved=await read();assert.equal(unobserved.status,'unobserved');assert.equal(unobserved.reason,'no_anchor');
  await control('owner',{disposed:false});
  const observed=await read();assert.equal(observed.status,'observed');assert.equal(observed.provenance,'fresh');assert.equal(observed.rootCount,0);assert.deepEqual(observed.fragments,[]);
  await control('set',{requestId:'held',roots:['C:/Native/原有😀']});
  const pending=await read({authorityId:observed.authorityId});assert.equal(pending.status,'unknown');assert.equal(pending.reason,'root_write_pending');
  await control('reply',{requestId:'held'});
  const confirmed=await read({authorityId:observed.authorityId});assert.equal(confirmed.status,'observed');assert.equal(confirmed.provenance,'confirmed');assert.deepEqual(confirmed.fragments,[{index:0,text:'C:/Native/原有😀',complete:true}]);
  await control('set',{requestId:'overlap-a',roots:['C:/one']});await control('set',{requestId:'overlap-b',roots:['C:/two']});
  await control('reply',{requestId:'overlap-b'});await control('reply',{requestId:'overlap-a'});
  const unknown=await read({authorityId:observed.authorityId});assert.equal(unknown.status,'unknown');assert.equal(unknown.reason,'root_write_unknown');
  const retired=await read({authorityId:'retired-fixture-authority',clientId:'unbound-client'});assert.equal(retired.status,'retired');assert.equal(retired.authorityId,'retired-fixture-authority');
  await control('wrongIdentity',{enabled:true});const wrong=await query(endpoint);assert.notEqual(wrong.pid,endpoint.pid);
  await control('missingIdentity',{enabled:true});assert.equal((await query(endpoint)).pid,undefined);
  assert.equal(seen.length,6);await control('stop');
});
for(const mode of ['source','bundle'])test(`actual ${mode} update control results and retained receipts carry server identity without replay`,{timeout:15000},async t=>{
  const {endpoint,control}=await fixture(t,mode);
  const identity=result=>{assert.equal(result.pid,endpoint.pid);assert.equal(result.executable,process.execPath);assert.equal(result.type,'browser');return result;};
  const target=identity(await request(endpoint,{op:'officialUpdateTarget'}));assert.deepEqual(target.target,{id:'c'.repeat(64),version:'0.0.0'});assert.equal(target.reason,null);assert.equal(target.installation,null);assert.equal(target.fixtureCalls,0);
  const command={op:'officialUpdateInstall',operationId:'controlled-install',targetId:target.target.id};
  const initial=request(endpoint,command);
  // Wait for the actual command queue to reserve this ID, without dispatching it again.
  let pending;do{pending=identity(await request(endpoint,{op:'status',operationId:command.operationId}));}while(pending.unknown===true);
  assert.equal(pending.pending,true);assert.equal((await request(endpoint,{op:'officialUpdateTarget'})).fixtureCalls,1);
  await control('finishUpdate');const result=identity(await initial);assert.equal(result.accepted,true);assert.deepEqual(result.target,target.target);
  assert.deepEqual(identity(await request(endpoint,{op:'status',operationId:command.operationId})),result);
  assert.deepEqual(identity(await request(endpoint,command)),result);
  const last=identity(await request(endpoint,{op:'officialUpdateTarget'}));assert.equal(last.fixtureCalls,1);
  const unknown=identity(await request(endpoint,{op:'status',operationId:'never-dispatched'}));assert.equal(unknown.pending,false);assert.equal(unknown.unknown,true);
  await control('stop');
});
