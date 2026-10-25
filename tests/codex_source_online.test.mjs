import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import Module from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {installElectronTraffic}=require('../codex/host/electron-main.cjs');
const {installDesktopPlaintext}=require('../codex/host/electron-plaintext.cjs');
const hash=value=>createHash('sha256').update(value).digest('hex');

test('Core source snapshots restore using the same owned backends and never reconnect them during takeover',async()=>{
  const child={pid:42},route={baseUrl:'http://127.0.0.1:44001/existing'};
  const resources=new Map([['plaintextSource',{ready:Promise.resolve()}],['backendState',{records:new Set([{child,reservations:[route]}])}],['desktopState',{taskRoutes:new Set([route])}]]);
  const context={resources,modules:{list:()=>[]}};
  let recoveries=0,routeClosed=0,sourceClosed=0,preparing=false,suspensions=0;
  resources.get('plaintextSource').close=()=>sourceClosed++;
  const dependencies={recover:async()=>recoveries++,diagnose(){},
    installBackend:()=>({ownsProcess:value=>value===child,inspect:()=>({available:true}),ready:async()=>({available:true}),close(){}}),
    installDesktop:()=>({inspect:()=>({available:true,taskConfigurationAvailable:true}),ready:async()=>({available:true,taskConfigurationAvailable:true}),canSuspend:()=>!preparing,suspend(){suspensions++;},close(){}})};
  route.close=()=>routeClosed++;
  const electron={app:{isReady:()=>true}},configuration={source:{},deadlineUnixMs:Date.now()+5000};
  const old=installElectronTraffic(electron,configuration,context,dependencies);await old.ready();
  preparing=true;assert.throws(()=>old.snapshot(),{code:'core_update_source_busy'});assert.equal(old.suspend(),false);assert.equal(suspensions,0);
  preparing=false;const saved=old.snapshot();assert.deepEqual(saved.backends,[{pid:42,routes:[route.baseUrl]}]);
  assert.equal(old.suspend(),true);
  const next=installElectronTraffic(electron,configuration,context,dependencies);next.restore(saved);await next.ready();
  assert.equal(next.confirmTakeover(),true);await old.close();
  assert.equal(recoveries,1);assert.equal(routeClosed,0);assert.equal(sourceClosed,0);
  assert.equal(resources.get('backendState').records.values().next().value.child,child);
  await next.close();assert.equal(routeClosed,0);
});

test('task provider routes stay open through source suspend and close until their owned backend exits',async()=>{
  const code='class $s {constructor(proc){this.proc=proc;this.sent=[];}send(message){this.sent.push(JSON.parse(message));}};module.exports={$s};';
  const filename=path.join(process.cwd(),'application-network-startup-CY4ZWOz-.js');
  const mod=new Module(filename);mod.filename=filename;mod.paths=Module._nodeModulePaths(process.cwd());
  mod._compile(code+'\nmodule.exports.evaluate=e=>eval(e);',filename);
  const record={name:path.basename(filename),hash:hash(code),exported:mod.exports,evaluate:mod.exports.evaluate};
  const moduleRegistry={subscribe(callback){callback(record);return()=>{};}};
  const child=new EventEmitter();let reserved=0,closed=0;
  const source={interceptHttp(){},reserveRoute(){reserved++;return {baseUrl:'http://127.0.0.1:44002/task',ready:Promise.resolve(),close(){closed++;}};}};
  const state={taskRoutes:new Set(),routesByProcess:new WeakMap(),sendQueues:new WeakMap()};
  const options={source,moduleRegistry,state,ownsBackendProcess:value=>value===child,deadlineUnixMs:Date.now()+2000};
  const deps={expectedHashes:{[record.name]:record.hash}};
  const old=installDesktopPlaintext({app:{isReady:()=>true}},options,deps);
  const native=new mod.exports.$s(child);
  const message=JSON.stringify({id:1,method:'thread/start',params:{config:{'model_providers.custom.base_url':'https://example.test/v1'}}});
  native.send(message);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reserved,1);assert.equal(native.sent.length,1);
  old.suspend();assert.equal(closed,0);
  const next=installDesktopPlaintext({app:{isReady:()=>true}},options,deps);
  old.close();native.send(message);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reserved,1);assert.equal(closed,0);assert.equal(native.sent.length,2);
  next.close();assert.equal(closed,0);
  child.emit('exit');assert.equal(closed,1);assert.equal(state.taskRoutes.size,0);state.scope.disable();
});
