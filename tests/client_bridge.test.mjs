import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import Module from 'node:module';
import {spawn} from 'node:child_process';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {startClientBridge}=require('../runtime/client-bridge-bundle.cjs');
const {observeModules}=require('../runtime/client-bridge-bundle.cjs');
const {plan,sameExecutable}=require('../runtime/client-bridge-bootstrap.cjs');
const TOKEN='a'.repeat(48);
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'codlet-client-bridge-'));
  let ready=false;const bridge=startClientBridge({app:{isReady:()=>ready,getAppPath:()=>directory}},{token:TOKEN},{identity:()=>({pid:process.pid,executable:process.execPath,type:'browser'})});
  const endpoint=await bridge.endpoint();
  t.after(async()=>{await bridge.close();const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));await rm(resolved,{recursive:true});});
  return {bridge,endpoint,directory,ready:()=>ready=true};
}
function request(endpoint,input,token=TOKEN){return new Promise((resolve,reject)=>{const socket=net.createConnection({host:endpoint.host,port:endpoint.port});let body='';socket.on('connect',()=>socket.write(JSON.stringify({...input,token})+'\n'));socket.on('data',data=>body+=data);socket.on('error',reject);socket.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(Error('connection_closed'));}});});}
const source=value=>`module.exports={validateClientSource(electron,context){const record=context.modules.list().find(record=>record.name==='native.cjs');if(!record)throw Object.assign(Error(),{code:'native_missing'});},installElectronTraffic(electron,configuration,context){const record=context.modules.list().find(record=>record.name==='native.cjs');const Native=record.evaluate('Native');const original=Native.prototype.value;Native.prototype.value=()=>${JSON.stringify(value)};return{ready:async()=>({installed:true,activatedSources:[],unsupportedSources:[]}),close(){Native.prototype.value=original;}};}};`;
function compile(directory){const filename=path.join(directory,'native.cjs'),module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(directory);module._compile('class Native {constructor(){this.created=true;}value(){return "original";}};module.exports={Native};',filename);return module.exports.Native;}
test('a late source can replace native hooks repeatedly while the same process and object stay alive',async t=>{
  const f=await fixture(t),Native=compile(f.directory),object=new Native();f.ready();
  assert.equal(f.bridge.inspect().moduleObserver.modules,1);
  assert.deepEqual(f.bridge.inspect().activation.installed,false);
  let reply=await request(f.endpoint,{op:'replace',operationId:'first',expectedEpoch:0,previousOwner:null,owner:'dev.adapter',generation:1,code:source('one'),configuration:{}});
  assert.equal(reply.result.outcome,'applied');assert.equal(object.value(),'one');assert.equal(reply.result.pid,process.pid);
  reply=await request(f.endpoint,{op:'replace',operationId:'second',expectedEpoch:1,previousOwner:'dev.adapter',owner:'dev.adapter',generation:2,code:source('two'),configuration:{}});
  assert.equal(reply.result.epoch,2);assert.equal(object.value(),'two');
  assert.equal(f.bridge.inspect().moduleObserver.modules,1);
  const cleared=await request(f.endpoint,{op:'clear',operationId:'clear',expectedEpoch:2,previousOwner:'dev.adapter'});
  assert.equal(cleared.result.owner,null);assert.equal(object.value(),'original');
});
test('bad authorization, stale generations and failed preflight cannot replace the running source',async t=>{
  const f=await fixture(t),Native=compile(f.directory),object=new Native();f.ready();
  await assert.rejects(request(f.endpoint,{op:'status'},'b'.repeat(48)),/connection_closed/);
  await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:f.endpoint.host,port:f.endpoint.port});
    socket.on('connect',()=>socket.write('null\n'));socket.on('error',error=>error.code==='ECONNRESET'?resolve():reject(error));socket.on('close',resolve);
  });
  assert.equal((await request(f.endpoint,{op:'status'})).result.pid,process.pid);
  await request(f.endpoint,{op:'replace',operationId:'install',expectedEpoch:0,previousOwner:null,owner:'dev.adapter',generation:1,code:source('working'),configuration:{}});
  const stale=await request(f.endpoint,{op:'clear',operationId:'stale',expectedEpoch:0,previousOwner:'dev.adapter'});assert.equal(stale.result.error,'client_bridge_stale_epoch');assert.equal(stale.result.epoch,1);
  const invalid=await request(f.endpoint,{op:'replace',operationId:'invalid',expectedEpoch:1,previousOwner:'dev.adapter',owner:'dev.adapter',generation:2,code:'module.exports={validateClientSource(){throw Object.assign(Error(),{code:"unsupported_build"});}};',configuration:{}});
  assert.equal(invalid.result.error,'unsupported_build');assert.equal(invalid.result.outcome,'rejected');assert.equal(object.value(),'working');assert.equal(f.bridge.inspect().epoch,1);
  const receipt=await request(f.endpoint,{op:'status',operationId:'invalid'});assert.equal(receipt.result.error,'unsupported_build');assert.equal(receipt.result.pid,process.pid);assert.equal(receipt.result.owner,'dev.adapter');
});
test('activation failure restores the old hooks and repeated receipts do not replay replacement',async t=>{
  const f=await fixture(t),Native=compile(f.directory),object=new Native();f.ready();
  const initial={op:'replace',operationId:'install',expectedEpoch:0,previousOwner:null,owner:'dev.adapter',generation:1,code:source('working'),configuration:{}};
  await request(f.endpoint,initial);const repeated=await request(f.endpoint,initial);assert.equal(repeated.result.epoch,1);
  const failed=await request(f.endpoint,{...initial,operationId:'broken',expectedEpoch:1,previousOwner:'dev.adapter',generation:2,code:'module.exports={installElectronTraffic(){throw Object.assign(Error(),{code:"activation_failed"});}};'});
  assert.equal(failed.result.outcome,'rolled_back');assert.equal(object.value(),'working');assert.equal(failed.result.epoch,2);
});
test('the module observer records live native constructors and a lost Core lease retires hooks and the listener',async t=>{
  const f=await fixture(t),Native=compile(f.directory),object=new Native();f.ready();
  const registry=globalThis[Symbol.for(`codlet.client.modules.${TOKEN}`)];
  assert.ok(registry.instances(Native).includes(object));
  await request(f.endpoint,{op:'replace',operationId:'install',expectedEpoch:0,previousOwner:null,owner:'dev.adapter',generation:1,code:source('working'),configuration:{}});
  const lease=net.createConnection({host:f.endpoint.host,port:f.endpoint.port});
  await new Promise((resolve,reject)=>{lease.once('connect',()=>lease.write(JSON.stringify({op:'lease',token:TOKEN})+'\n'));lease.once('data',resolve);lease.once('error',reject);});
  lease.destroy();
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(object.value(),'original');
  assert.equal(globalThis[Symbol.for(`codlet.client.modules.${TOKEN}`)],undefined);
  await assert.rejects(request(f.endpoint,{op:'status'}),/ECONNREFUSED/);
});
test('captured module bindings remain available after readiness and subscriptions retire independently',async t=>{
  const {createHash}=require('node:crypto');
  const directory=await mkdtemp(path.join(tmpdir(),'codlet-client-modules-'));
  const key=Symbol.for('codlet.test.modules'),registry=observeModules(directory,key);
  t.after(async()=>{registry.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));await rm(directory,{recursive:true});});
  const code='let Native=class {value(){return "original";}};module.exports={Native};';
  function compile(name,code){const filename=path.join(directory,name),module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(directory);module._compile(code,filename);return module.exports;}
  const native=compile('native.cjs',code),records=registry.list();
  assert.equal(records[0].hash,createHash('sha256').update(code).digest('hex'));
  assert.equal(records[0].evaluate('Native'),native.Native);
  let count=0;const unsubscribe=registry.subscribe(()=>count++);
  assert.equal(count,1);assert.equal(registry.inspect().subscribers,1);
  unsubscribe();assert.equal(registry.inspect().subscribers,0);
  compile('second.cjs',code);assert.equal(count,1);assert.equal(registry.inspect().modules,2);
});

test('startup source failures retain only a finite diagnostic code and keep the generic bridge alive',async t=>{
  const f=await fixture(t);compile(f.directory);
  await f.bridge.installInitial({owner:'dev.adapter',generation:1,configuration:{},code:`module.exports={installElectronTraffic(){return {ready:async()=>{throw Object.assign(Error('private payload must not be logged'),{code:'backend_route_timeout'});},close(){}};}};`});
  f.ready();
  const result=await f.bridge.ready();
  assert.equal(result.owner,null);assert.equal(result.activation.installed,false);
  assert.equal(result.sourceError,'backend_route_timeout');assert.ok(result.moduleObserver.modules>0);
  assert.equal(JSON.stringify(result).includes('private payload'),false);
  assert.equal((await request(f.endpoint,{op:'status'})).result.sourceError,'backend_route_timeout');
});

test('initial readiness runs over the authenticated transport and its receipt does not replay initialization',async t=>{
  const f=await fixture(t);compile(f.directory);
  await f.bridge.installInitial({owner:'dev.adapter',generation:1,configuration:{},code:`module.exports={installElectronTraffic(){let calls=0;return {ready:async()=>{if(++calls!==1)throw Error('replayed');return {installed:true,activatedSources:[],unsupportedSources:[]};},close(){}};}};`});
  assert.equal(f.bridge.inspect().activation.installed,false);f.ready();
  const input={op:'ready',operationId:'startup-ready',expectedEpoch:0};
  const first=(await request(f.endpoint,input)).result,repeated=(await request(f.endpoint,input)).result;
  assert.equal(first.outcome,'applied');assert.equal(first.activation.installed,true);assert.equal(first.epoch,0);
  assert.deepEqual(repeated,first);assert.equal(first.owner,'dev.adapter');
});
test('Core establishes its recovery transport before entry without an adapter and closes the temporary inspector',async t=>{
  const {attach}=require('../runtime/client-bridge-bootstrap.cjs');
  const root=await mkdtemp(path.join(tmpdir(),'codlet-owned-bridge-'));
  await mkdir(path.join(root,'node_modules','electron'),{recursive:true});
  await writeFile(path.join(root,'node_modules','electron','index.js'),`module.exports={app:{isReady:()=>globalThis.nativeReady===true,getAppPath:()=>${JSON.stringify(root)}}};`);
  await writeFile(path.join(root,'preload.cjs'),'process.type="browser";');
  await writeFile(path.join(root,'native.cjs'),'class Native {constructor(){this.live=true;}};module.exports={Native};');
  await writeFile(path.join(root,'main.cjs'),'require("./native.cjs");globalThis.nativeReady=true;setInterval(()=>{},1000);');
  const child=spawn(process.execPath,['--inspect-brk=127.0.0.1:0','--require',path.join(root,'preload.cjs'),path.join(root,'main.cjs')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('error',()=>{});child.stderr.on('error',()=>{});
  t.after(async()=>{child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true});});
  const inspectorUrl=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('owned_inspector_timeout')),5000);child.stderr.on('data',bytes=>{text+=bytes;const match=text.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36}/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);});
  const code=await readFile(new URL('../runtime/client-bridge-bundle.cjs',import.meta.url),'utf8');
  let result;
  try{result=await attach({inspectorUrl,expectedPid:child.pid,executable:process.execPath,traffic:{}},code);}catch(error){error.message='bootstrap: '+error.message;throw error;}
  assert.equal(result.exactChildVerified,true);assert.equal(result.bridge.pid,child.pid);assert.equal(result.activation.installed,false);
  let status;try{status=await request(result.bridge,{op:'status'},result.bridge.token);}catch(error){error.message='bridge status: '+error.message;throw error;}
  assert.equal(status.result.pid,child.pid);assert.ok(status.result.moduleObserver.modules>=1);
});
test('public fuse planning binds a single bounded edit to the current owned image and rejects unknown schemas', {skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'codlet-public-fuse-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true});});
  const executable=path.join(root,'fixture.exe'),dll=path.join(root,'chrome.dll');
  await writeFile(executable,Buffer.alloc(256));
  const sentinel=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),image=Buffer.alloc(256);
  sentinel.copy(image,64);image[64+sentinel.length]=1;image[65+sentinel.length]=4;
  image.write('1110',66+sentinel.length);await writeFile(dll,image);
  const result=await plan(executable);
  const {createHash}=require('node:crypto');
  assert.equal(result.moduleData.sha256,createHash('sha256').update(image).digest('hex'));
  assert.deepEqual(result.moduleData.patches,[{fileOffset:69+sentinel.length,expected:[48],replacement:[49]}]);
  assert.deepEqual(await readFile(dll),image);assert.equal(sameExecutable(executable,dll),false);
  image[69+sentinel.length]=49;await writeFile(dll,image);assert.equal((await plan(executable)).moduleData,null);
  image[64+sentinel.length]=2;await writeFile(dll,image);
  await assert.rejects(plan(executable),{code:'client_bridge_fuse_unsupported'});
});
