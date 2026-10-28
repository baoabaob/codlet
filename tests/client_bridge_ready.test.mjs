import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const require=createRequire(import.meta.url);
const mode=process.env.CODLET_BRIDGE_TEST_MODE??'bundle';
assert.ok(['source','bundle'].includes(mode));
const {startClientBridge}=require(mode==='bundle'?'../runtime/client-bridge-bundle.cjs':'../runtime/client-bridge.cjs');
const TOKEN='d'.repeat(48);
const empty={installed:false,activatedSources:[],unsupportedSources:[]};
const failed={installed:false,pending:false,pendingSources:[],activatedSources:[],unsupportedSources:[{id:'client-source',reason:'contract_unavailable'}]};
async function fixture(t,runtime){
  const directory=await mkdtemp(path.join(tmpdir(),'codlet-ready-contract-'));
  const bridge=startClientBridge({app:{isReady:()=>false,getAppPath:()=>directory}},{token:TOKEN},{
    identity:()=>({pid:process.pid,executable:process.execPath,type:'browser'}),
    load:()=>({installElectronTraffic:()=>runtime}),
  });
  t.after(async()=>{await bridge.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));await rm(directory,{recursive:true});});
  await bridge.installInitial({owner:'dev.ready-contract',generation:1,code:'controlled-source',configuration:{}});
  return {bridge,endpoint:await bridge.endpoint()};
}
function request(endpoint,input){return new Promise((resolve,reject)=>{
  const socket=net.createConnection({host:endpoint.host,port:endpoint.port});let body='';
  socket.on('connect',()=>socket.write(JSON.stringify({...input,token:TOKEN})+'\n'));
  socket.on('data',bytes=>body+=bytes);socket.on('error',reject);
  socket.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(Error('connection_closed'));}});
});}
for(const code of ['backend_route_timeout','host_stopping','unsafe/endpoint?token=private'])test(`${mode}: ready rejection keeps a terminal schema and the original safe error classification: ${code}`,async t=>{
  let readyCalls=0,closeCalls=0;
  const f=await fixture(t,{ready:async()=>{readyCalls++;throw Object.assign(Error('private Native payload'),{code});},close(){closeCalls++;}});
  const command={op:'ready',operationId:'same-original-ready',expectedEpoch:0};
  const first=(await request(f.endpoint,command)).result;
  assert.deepEqual(first.activation,failed);assert.equal(first.owner,null);
  assert.equal(first.sourceError,code.includes('/')?'client_bridge_operation_failed':code);
  assert.equal(first.outcome,'applied');assert.equal(first.pid,process.pid);
  const repeated=(await request(f.endpoint,command)).result;
  assert.deepEqual(repeated,first);assert.equal(readyCalls,1);assert.equal(closeCalls,1);
  const status=(await request(f.endpoint,{op:'status'})).result;
  assert.deepEqual(status.activation,failed);assert.equal(status.sourceError,first.sourceError);
  assert.equal(JSON.stringify(first).includes('private'),false);
});
for(const terminal of ['fulfill','reject'])test(`${mode}: owner retirement cannot publish a late ready ${terminal}`,async t=>{
  let completeReady,finishClose,enteredReady,enteredClose,readyCalls=0;
  const readyEntered=new Promise(resolve=>enteredReady=resolve);
  const closeEntered=new Promise(resolve=>enteredClose=resolve);
  let nativeInstalled=false;
  const f=await fixture(t,{
    ready(){readyCalls++;enteredReady();return new Promise((resolve,reject)=>{completeReady=()=>{nativeInstalled=true;terminal==='fulfill'?resolve({installed:true,activatedSources:[{id:'late'}],unsupportedSources:[]}):reject(Object.assign(Error('private'),{code:'host_stopping'}));};});},
    inspect:()=>({activation:nativeInstalled?{installed:true,activatedSources:[{id:'late'}],unsupportedSources:[]}:empty}),
    close(){enteredClose();return new Promise(resolve=>finishClose=resolve);},
  });
  const ready=f.bridge.ready();await readyEntered;
  const closing=f.bridge.close();await closeEntered;
  assert.equal(f.bridge.inspect().owner,null);assert.deepEqual(f.bridge.inspect().activation,empty);
  completeReady();const result=await ready;
  assert.equal(result.owner,null);assert.deepEqual(result.activation,empty);assert.equal(result.sourceError,null);
  finishClose();await closing;assert.equal(readyCalls,1);
  await assert.rejects(f.bridge.installInitial({owner:'dev.retired',generation:2,code:'controlled-source',configuration:{}}),{code:'client_bridge_initial_state_invalid'});
});

test(`${mode}: ready entered after retirement never invokes the retained source`,async t=>{
  let readyCalls=0,finishClose,enteredClose;
  const closeEntered=new Promise(resolve=>enteredClose=resolve);
  const f=await fixture(t,{ready(){readyCalls++;return {installed:true};},close(){enteredClose();return new Promise(resolve=>finishClose=resolve);}});
  t.after(()=>finishClose?.());
  const closing=f.bridge.close();await closeEntered;
  const result=await f.bridge.ready();
  assert.equal(readyCalls,0);assert.equal(result.owner,null);assert.deepEqual(result.activation,empty);
  finishClose();await closing;
});

test(`${mode}: retirement between ready reservation and its microtask prevents source invocation`,async t=>{
  let readyCalls=0,finishClose,enteredClose,closing;
  const closeEntered=new Promise(resolve=>enteredClose=resolve);
  const f=await fixture(t,{ready(){readyCalls++;return {installed:true};},close(){enteredClose();return new Promise(resolve=>finishClose=resolve);}});
  t.after(()=>finishClose?.());
  const ready=f.bridge.ready();
  // The resolved listening await resumes ready first, reserving its promise.
  // This queued retirement then runs before that promise's ready() callback.
  await new Promise(resolve=>queueMicrotask(()=>{closing=f.bridge.close();resolve();}));
  const result=await ready;await closeEntered;
  assert.equal(readyCalls,0);assert.equal(result.owner,null);assert.deepEqual(result.activation,empty);
  finishClose();await closing;
});
