import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import Module from 'node:module';
import {createHash} from 'node:crypto';
const {recoverLocalBackends,installElectronTraffic,validateClientSource}=createRequire(import.meta.url)('../host/electron-main.cjs');
function fixture() {
  const calls=[];
  class Connection {
    constructor(file='codex.exe') {this.connection={proc:{spawnfile:path.resolve(file)}};this.pending=0;this.turnCwds={pendingByStartId:new Map(),startedByTurnId:new Map()};}
    getPendingRequestCount(){return this.pending;}
    async restart(options){calls.push({connection:this,options});}
  }
  const connections=[],context={modules:{list:()=>[{name:'native.cjs',hash:'reviewed',evaluate:()=>Connection}],instances:()=>connections}};
  const dependencies={profiles:{'native.cjs':{hash:'reviewed',connectionSymbol:'Connection'}},verify(){}};
  return {calls,Connection,connections,context,dependencies};
}
test('late source recovery reconnects only verified idle local backends and preserves owned backends',async()=>{
  const f=fixture(),local=new f.Connection(),owned=new f.Connection(),other=new f.Connection('helper.exe'),remote=new f.Connection();
  remote.connection={};f.connections.push(local,owned,other,remote);
  await recoverLocalBackends(f.context,child=>child===owned.connection.proc,f.dependencies);
  assert.deepEqual(f.calls,[{connection:local,options:{intent:'restart',killCodexProcess:false}}]);
});
test('split connection modules require their exact reviewed hash before idle recovery',async()=>{
  const f=fixture(),local=new f.Connection();f.connections.push(local);
  f.dependencies.profiles['native.cjs']={hash:'reviewed',kind:'connection',symbol:'Connection'};
  await recoverLocalBackends(f.context,()=>false,f.dependencies);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].connection,local);
  f.calls.length=0;f.dependencies.profiles['native.cjs'].hash='other-build';
  await recoverLocalBackends(f.context,()=>false,f.dependencies);assert.equal(f.calls.length,0);
});
test('pending requests or active turns reject recovery before any backend is reconnected',async()=>{
  for(const busy of ['request','starting-turn','active-turn']){
    const f=fixture(),idle=new f.Connection(),connection=new f.Connection();f.connections.push(idle,connection);
    if(busy==='request')connection.pending=1;
    else connection.turnCwds[busy==='starting-turn'?'pendingByStartId':'startedByTurnId'].set('owned',true);
    await assert.rejects(recoverLocalBackends(f.context,()=>false,f.dependencies),{code:'client_source_backend_busy'});
    assert.equal(f.calls.length,0);
  }
});
test('a request that starts during asynchronous policy preparation prevents reconnect',async()=>{
  const f=fixture(),local=new f.Connection();f.connections.push(local);
  await assert.rejects(recoverLocalBackends(f.context,()=>false,{
    ...f.dependencies,canRecover:()=>true,
    async prepareConnection(){await Promise.resolve();local.pending=1;}
  }),{code:'client_source_backend_busy'});
  assert.equal(f.calls.length,0);
});
test('runtime-discovered connections can recover an unlisted backend identity through normal launch probing',async()=>{
  const f=fixture(),local=new f.Connection();f.connections.push(local);
  await recoverLocalBackends(f.context,()=>false,{connections:[f.Connection],verify:()=>({recorded:false,binarySha256:'unlisted'})});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].connection,local);
});
test('unreadable backend identities and unmatched legacy module mappings never receive a reconnect',async()=>{
  const f=fixture();f.connections.push(new f.Connection());
  await assert.rejects(recoverLocalBackends(f.context,()=>false,{...f.dependencies,verify(){throw Object.assign(Error(),{code:'backend_identity_unavailable'});}}),{code:'backend_identity_unavailable'});
  f.dependencies.profiles['native.cjs'].hash='different';
  await recoverLocalBackends(f.context,()=>false,f.dependencies);
  assert.equal(f.calls.length,0);
});
test('a replacement attaches reviewed hooks to initialized modules and removes its subscriptions on retirement',async()=>{
  const {installDesktopPlaintext}=createRequire(import.meta.url)('../host/electron-plaintext.cjs');
  const records=[],subscribers=new Set();
  const registry={list:()=>records,subscribe(callback){subscribers.add(callback);records.forEach(callback);return()=>subscribers.delete(callback);}};
  const bootstrap='let Pt=class {fetch(){} request(){}};module.exports={Pt};',main='let wEe=class {performDesktopFetch(){}};module.exports={wEe};';
  const hash=code=>createHash('sha256').update(code).digest('hex');
  function compile(name,code){const filename=path.join(process.cwd(),name),module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(process.cwd());module._compile(code+'\nmodule.exports.evaluate=expression=>eval(expression);',filename);records.push({name,filename,hash:hash(code),evaluate:module.exports.evaluate});return module.exports;}
  const native=compile('bootstrap-DK4EfNwt.js',bootstrap);compile('main-LM8MUIFp.js',main);
  const original=native.Pt.prototype.fetch,options={expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main)}};
  for(let generation=0;generation<2;generation++){
    const hook=installDesktopPlaintext({app:{isReady:()=>true}},{source:{interceptHttp(){}},moduleRegistry:registry,deadlineUnixMs:Date.now()+500},options);
    assert.equal((await hook.ready()).available,true);assert.notEqual(native.Pt.prototype.fetch,original);
    hook.close();assert.equal(native.Pt.prototype.fetch,original);assert.equal(subscribers.size,0);
  }
});
function entryFixture(beforeReady = true, backendAvailable = true) {
  let ready = !beforeReady, resolve;
  const source={ready:new Promise(value=>resolve=value)},resources=new Map([['plaintextSource',source]]);
  const desktopState={available:true,taskConfigurationAvailable:true};
  const backendState={available:backendAvailable,reason:backendAvailable?null:'child_unavailable'};
  const context={resources,modules:{}};
  const configuration={source:{},deadlineUnixMs:Date.now()+1000};
  const calls=[];
  const dependencies={
    diagnose(){},
    installDesktop:()=>({ready:async()=>desktopState,inspect:()=>desktopState,close(){calls.push('desktop-close');}}),
    installBackend:()=>({ready:async()=>backendState,inspect:()=>backendState,ownsProcess:()=>backendAvailable,close(){calls.push('backend-close');}}),
    recover:async()=>calls.push('reconnect')
  };
  return {source,context,configuration,calls,dependencies,electron:{app:{isReady:()=>ready}},resume(){ready=true;resolve();}};
}
test('a pre-entry install stays a startup install after asynchronous readiness and never reconnects initialization requests',async()=>{
  const f=entryFixture();
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);
  const pending=entry.ready();f.resume();const result=await pending;
  assert.equal(result.installed,true);assert.equal(result.activatedSources.length,2);
  assert.equal(f.calls.includes('reconnect'),false);await entry.close();
});
test('a startup policy prepared in the background is handed to the verified idle recovery path',async()=>{
  const f=entryFixture(true,false);
  let available=false;
  const prepared={available:false,policyReady:true,reason:'backend_config_pending'};
  f.dependencies.installBackend=()=>({
    ready:async()=>available?{available:true,reason:null}:prepared,inspect:()=>prepared,
    ownsProcess:()=>available,canRecover:()=>true,prepareConnection:async()=>{},close(){}
  });
  f.dependencies.recover=async(_context,_owns,options)=>{
    assert.equal(options.canRecover(),true);
    assert.equal(typeof options.prepareConnection,'function');
    available=true;f.calls.push('reconnect');
  };
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);f.resume();
  const result=await entry.ready();
  assert.deepEqual(result.activatedSources.map(source=>source.id),['desktop-main-http','owned-backend-provider']);
  assert.deepEqual(f.calls,['reconnect']);await entry.close();
});
test('a busy late backend leaves the independent Desktop source available without interrupting the backend',async()=>{
  const f=entryFixture(false,false);
  f.dependencies.recover=async()=>{throw Object.assign(Error(),{code:'client_source_backend_busy'});};
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);f.resume();
  const result=await entry.ready();assert.equal(result.installed,true);
  assert.deepEqual(result.activatedSources.map(source=>source.id),['desktop-main-http']);
  assert.deepEqual(result.unsupportedSources,[{id:'owned-backend-provider',reason:'child_unavailable'}]);
  assert.equal(entry.inspect().recovery.reason,'client_source_backend_busy');await entry.close();
});

test('an expired pre-entry deadline is armed again when startup readiness begins',async()=>{
  const f=entryFixture(true,false);
  f.configuration.deadlineUnixMs=Date.now()-1;
  f.dependencies.installDesktop=()=>({
    ready:async options=>({available:options?.deadlineUnixMs>Date.now(),taskConfigurationAvailable:false}),
    inspect:()=>({available:false}),close(){}
  });
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);
  f.resume();
  const result=await entry.ready();
  assert.equal(result.installed,true);assert.deepEqual(result.activatedSources.map(source=>source.id),['desktop-main-http']);
  assert.equal(f.calls.includes('reconnect'),false);await entry.close();
});

test('module discovery waits for Electron readiness without spending its budget on native bootstrap',async t=>{
  const f=entryFixture(true,false);let now=100000,resolveApp,observedDeadline;
  t.mock.method(Date,'now',()=>now);
  f.electron.app.whenReady=()=>new Promise(resolve=>resolveApp=resolve);
  f.dependencies.installDesktop=()=>({
    ready:async options=>{observedDeadline=options.deadlineUnixMs;return {available:true,taskConfigurationAvailable:false};},
    inspect:()=>({available:true}),close(){}
  });
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);
  const pending=entry.ready();f.resume();await Promise.resolve();
  assert.equal(observedDeadline,undefined);
  now+=3500;resolveApp();assert.equal((await pending).installed,true);
  assert.equal(observedDeadline,108000);assert.equal(f.calls.includes('reconnect'),false);await entry.close();
});

test('a startup backend route timeout does not discard verified Desktop coverage',async()=>{
  const f=entryFixture(true,false);
  f.dependencies.installBackend=()=>({
    ready:async()=>{throw Object.assign(Error(),{code:'backend_route_timeout'});},
    inspect:()=>({available:false,reason:'route_unavailable'}),ownsProcess:()=>false,close(){}
  });
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);
  f.resume();
  const result=await entry.ready();
  assert.equal(result.installed,true);assert.deepEqual(result.activatedSources.map(source=>source.id),['desktop-main-http']);
  assert.deepEqual(result.unsupportedSources,[{id:'owned-backend-provider',reason:'route_unavailable'}]);
  assert.equal(entry.inspect().recovery.reason,'backend_route_timeout');await entry.close();
});
test('source preflight admits the observer ABI independently of source fingerprints and reconnects',()=>{
  const context={modules:{list:()=>[{name:'future-entry.js',hash:'unlisted'}],subscribe(){return()=>{}},instances(){throw Error('preflight must not select a reconnect');}}};
  assert.doesNotThrow(()=>validateClientSource({app:{isReady:()=>true}},context));
  assert.throws(()=>validateClientSource({app:{isReady:()=>true}},{modules:{list:()=>[]}}),{code:'client_bridge_required'});
});

test('a diagnostic write failure cannot reject source activation',async()=>{
  const f=entryFixture();f.dependencies.diagnose=()=>{throw Error('read-only temporary directory');};
  const entry=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);f.resume();
  assert.equal((await entry.ready()).installed,true);await entry.close();
});

test('a source replacement cannot silently lose an active capability and the old source resumes',async()=>{
  const f=entryFixture();f.context.resources.set('backendState',{records:new Set()});f.context.resources.set('desktopState',{taskRoutes:new Set()});
  const install=f.dependencies.installDesktop;
  f.dependencies.installDesktop=(...args)=>({...install(...args),suspend(){}});
  const original=installElectronTraffic(f.electron,f.configuration,f.context,f.dependencies);f.resume();await original.ready();
  const snapshot=original.snapshot();assert.deepEqual(snapshot.activatedSources,['desktop-main-http','owned-backend-provider']);assert.equal(original.suspend(),true);
  const candidate=installElectronTraffic(f.electron,f.configuration,f.context,{...f.dependencies,installBackend:()=>({
    ready:async()=>({available:false,reason:'backend_contract_unavailable'}),inspect:()=>({available:false}),ownsProcess:()=>false,close(){}
  })});
  candidate.restore(snapshot);await assert.rejects(candidate.ready(),{code:'core_update_source_capability_lost'});await candidate.close();
  assert.equal(await original.resume(snapshot),true);assert.deepEqual(original.inspect().backend.available,true);await original.close();
});
