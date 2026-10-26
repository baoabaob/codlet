import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { installBackendSpawn, effectiveProviders, providerTrust, lastStringOverride } = createRequire(import.meta.url)('../host/backend-spawn.cjs');
const contract=(...settings)=>({api:1,initialize:true,configRead:true,accountRead:true,routing:'runtime',providerOverrides:['openai_base_url',...settings]});
async function spawnPrepared(hook, prototype, child, options) {
  const initial = new EventEmitter();
  prototype.spawn.call(initial, options);
  assert.equal(hook.ownsProcess(initial), false);
  assert.equal((await hook.ready()).policyReady, true);
  prototype.spawn.call(child, options);
}

test('effective provider routing preserves ChatGPT/API-key defaults and custom response providers', () => {
  assert.equal(effectiveProviders({accountType:'chatgpt'}).get('openai_base_url'),'https://chatgpt.com/backend-api/codex');
  assert.equal(effectiveProviders({accountType:'apiKey'}).get('openai_base_url'),'https://api.openai.com/v1');
  const routes=effectiveProviders({accountType:'chatgpt',openaiBaseUrl:'https://owned.example/v2',providerBaseUrls:{custom:'https://custom.example/v1'}});
  assert.deepEqual([...routes],[['openai_base_url','https://owned.example/v2'],['model_providers.custom.base_url','https://custom.example/v1']]);
});

test('a default custom provider uses its own auth rule rather than an explicit built-in endpoint',()=>{
  const policy={modelProvider:'custom',accountType:'chatgpt',openaiBaseUrl:'https://builtin.example/v1',providerBaseUrls:{custom:null,keyOnly:null},providerAuthDefaults:{custom:true,keyOnly:false}};
  assert.deepEqual([...effectiveProviders(policy)],[['openai_base_url','https://builtin.example/v1'],['model_providers.custom.base_url','https://chatgpt.com/backend-api/codex'],['model_providers.keyOnly.base_url','https://api.openai.com/v1']]);
  assert.equal(effectiveProviders({...policy,accountType:'apiKey'}).get('model_providers.custom.base_url'),'https://api.openai.com/v1');
  assert.throws(()=>effectiveProviders({...policy,providerAuthDefaults:{}}),{code:'backend_provider_unsupported'});
  assert.throws(()=>effectiveProviders({...policy,accountType:'unknown'}),{code:'backend_auth_mode_unsupported'});
});

test('account changes update default custom routes while explicit provider endpoints stay fixed',async()=>{
  const routes=[],prototype={spawn(){return 'started';}},file=path.resolve('codex.exe');
  const source={reserveRoute({upstreamBaseUrl}){const route={baseUrl:`http://127.0.0.1:43210/${routes.length}`,upstreamBaseUrl,ready:Promise.resolve(),async update(value){route.updated=value;},close(){route.closed=true;}};routes.push(route);return route;}};
  const policy={modelProvider:'custom',accountType:'chatgpt',openaiBaseUrl:'https://builtin.example/v1',providerBaseUrls:{custom:null,fixed:'https://fixed.example/v1'},providerAuthDefaults:{custom:true},contract:contract('model_providers.custom.base_url','model_providers.fixed.base_url')};
  const hook=installBackendSpawn({source,runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+1000},{prototype,verify(){return{binarySha256:'verified'};},probe(){return policy;},prepare(plan){return{arguments:plan.arguments};}});
  const child=new EventEmitter();
  try{
    await spawnPrepared(hook,prototype,child,{file,args:[file,'app-server'],envPairs:[]});
    assert.equal((await hook.ready()).available,true);assert.equal(hook.isProviderSupported(child,'custom'),true);
    hook.updateAccountMode(child,'apiKey');await hook.pendingAccountUpdate(child);
    assert.equal(routes[0].updated,undefined);assert.deepEqual(routes[1].updated,{upstreamBaseUrl:'https://api.openai.com/v1'});assert.equal(routes[2].updated,undefined);
    child.emit('exit');assert(routes.every(route=>route.closed));
  }finally{hook.close();}
});

test('last exact CLI config override preserves Desktop-owned local provider base', () => {
  const args=['app-server','--stdio','-c','openai_base_url="https://old.example/v1"','--config=openai_base_url="http://127.0.0.1:43210/v1"'];
  assert.equal(lastStringOverride(args,'openai_base_url'),'http://127.0.0.1:43210/v1');
  assert.equal(lastStringOverride(args,'chatgpt_base_url'),undefined);
});

test('owned verified backend receives only route config; original environment and unrelated children remain untouched', async () => {
  const reservations=[], dispatched=[], environment={HTTPS_PROXY:'http://corporate.invalid',OTHER:'original'};
  const source={reserveRoute({upstreamBaseUrl}) {const item={baseUrl:`http://127.0.0.1:43210/r${reservations.length}/`,ready:Promise.resolve(),close(){item.closed=true},async update(value){item.updated=value},upstreamBaseUrl};reservations.push(item);return item;}};
  const prototype={spawn(options){dispatched.push(options);return 'started';}}, original=prototype.spawn;
  const hook=installBackendSpawn({source,runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+1000},{prototype,
    verify(){return {binarySha256:'verified'}},
    probe(){return {accountType:'chatgpt',providerBaseUrls:{custom:'https://custom.example/v1'},contract:contract('model_providers.custom.base_url')}},
    prepare(plan){return {arguments:[...plan.arguments,'-c',`openai_base_url=${plan.providerRoutes.openai_base_url}`,'-c',`model_providers.custom.base_url=${plan.providerRoutes['model_providers.custom.base_url']}`]}}});
  try {
    const unrelated={file:process.execPath,args:[process.execPath,'--version'],envPairs:['OTHER=original']};
    prototype.spawn.call(new EventEmitter(),unrelated);
    assert.equal(dispatched[0],unrelated);
    const executable=path.resolve('codex.exe');
    const owned={file:executable,args:[executable,'app-server','--stdio'],envPairs:Object.entries(environment).map(([key,value])=>`${key}=${value}`)};
    const child=new EventEmitter();await spawnPrepared(hook,prototype,child,owned);
    assert.equal((await hook.ready()).available,true);
    assert.equal(reservations.length,2);
    assert.deepEqual(reservations.map(value=>value.upstreamBaseUrl),['https://chatgpt.com/backend-api/codex','https://custom.example/v1']);
    assert.equal(dispatched[1],owned,'First spawn keeps Native configuration while routes register');
    assert.equal(dispatched[2].envPairs,owned.envPairs);
    assert.equal(dispatched[2].args.at(-1),'model_providers.custom.base_url=http://127.0.0.1:43210/r1/');
    assert.equal(environment.HTTPS_PROXY,'http://corporate.invalid');
    hook.updateAccountMode(child,'apiKey');await hook.pendingAccountUpdate(child);
    assert.deepEqual(reservations[0].updated,{upstreamBaseUrl:'https://api.openai.com/v1'});
    child.emit('exit');assert(reservations.every(value=>value.closed));
  } finally {hook.close();assert.equal(prototype.spawn,original);}
});

test('existing provider CA is passed only as a scoped route trust input', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-trust-'));t.after(()=>fs.rmSync(directory,{recursive:true}));
  const file=path.join(directory,'owned.pem');fs.writeFileSync(file,'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');
  assert.match(providerTrust({CODEX_CA_CERTIFICATE:file,SSL_CERT_FILE:'ignored'},directory),/BEGIN CERTIFICATE/u);
  assert.equal(providerTrust({OTHER:'value'},directory),undefined);
  assert.throws(()=>providerTrust({CODEX_CA_CERTIFICATE:''},directory),{code:'backend_provider_trust_unsupported'});
});

test('a failed backend contract keeps its original launch and reports only the failed source', async () => {
  const dispatched=[],prototype={spawn(value){dispatched.push(value);return 'original';}};
  const hook=installBackendSpawn({source:{reserveRoute(){throw Error('should not route')}},runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+1000},{prototype,verify(){return{binarySha256:'unlisted',recorded:false}},probe(){return{accountType:'apiKey'}}});
  try {
    const executable=path.resolve('codex.exe'),options={file:executable,args:[executable,'app-server'],envPairs:['OTHER=original']};
    assert.equal(prototype.spawn.call(new EventEmitter(),options),'original');
    assert.equal(dispatched[0],options);
    assert.equal((await hook.ready()).reason,'backend_contract_unavailable');
  } finally {hook.close();}
});

test('client-owned backend routes and process identity survive source replacement and close only with the child',async()=>{
  const routes=[],state={owned:new WeakSet(),trust:new WeakMap(),accounts:new WeakMap(),providers:new WeakMap(),records:new Set(),pending:new Set(),prepared:0};
  const source={reserveRoute(){const route={baseUrl:'http://127.0.0.1:43210/owned/',ready:Promise.resolve(),closed:false,close(){route.closed=true;}};routes.push(route);return route;}};
  const prototype={spawn(){return 'started';}},original=prototype.spawn;
  const dependencies={prototype,state,verify(){return{binarySha256:'unlisted',recorded:false}},probe(){return {accountType:'apiKey',contract:contract()};},prepare(plan){return {arguments:plan.arguments};}};
  const configuration={source,runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+1000};
  const first=installBackendSpawn(configuration,dependencies),child=new EventEmitter(),file=path.resolve('codex.exe');
  await spawnPrepared(first,prototype,child,{file,args:[file,'app-server'],envPairs:[]});
  assert.equal((await first.ready()).available,true);first.close();assert.equal(prototype.spawn,original);assert.equal(routes[0].closed,false);
  const next=installBackendSpawn(configuration,dependencies);assert.equal(next.ownsProcess(child),true);assert.equal((await next.ready()).available,true);
  next.close();assert.equal(routes[0].closed,false);child.emit('exit');assert.equal(routes[0].closed,true);assert.equal(state.records.size,0);
});

test('settled owned routes stay ready even after the startup deadline passes',async()=>{
  const state={owned:new WeakSet(),trust:new WeakMap(),accounts:new WeakMap(),providers:new WeakMap(),records:new Set(),pending:new Set(),prepared:1};
  const child=new EventEmitter();state.owned.add(child);state.records.add({child});
  const prototype={spawn(){throw Error('must not reconnect');}},original=prototype.spawn;
  const hook=installBackendSpawn({source:{reserveRoute(){}},runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()-1},{prototype,state});
  try {assert.equal((await hook.ready()).available,true);}
  finally {hook.close();assert.equal(prototype.spawn,original);}
});

test('an asynchronous policy probe lets Native spawn immediately and routes only a prepared reconnect', async () => {
  const dispatched=[],routes=[],prototype={spawn(options){dispatched.push(options);return 'started';}};
  let complete,probes=0;
  const hook=installBackendSpawn({source:{reserveRoute(){const route={baseUrl:'http://127.0.0.1:43210/ready/',ready:Promise.resolve(),close(){}};routes.push(route);return route;}},deadlineUnixMs:Date.now()+1000},{
    prototype,verify(){return {binarySha256:'verified'};},
    probe(){probes++;return new Promise(resolve=>{complete=resolve;});},
    prepare(plan){return {arguments:[...plan.arguments,'-c',`openai_base_url=${plan.providerRoutes.openai_base_url}`]};}
  });
  const file=path.resolve('codex.exe'),options={file,args:[file,'app-server'],envPairs:['OTHER=preserved']},first=new EventEmitter();
  try {
    assert.equal(prototype.spawn.call(first,options),'started');
    assert.equal(dispatched[0],options);assert.equal(routes.length,0);
    assert.equal(hook.canRecover(first),false);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(probes,1);
    complete({accountType:'apiKey',contract:contract()});
    assert.equal((await hook.ready()).policyReady,true);
    assert.equal(hook.canRecover(first),true);
    const next=new EventEmitter();
    prototype.spawn.call(next,options);
    assert.equal((await hook.ready()).available,true);
    assert.equal(probes,1);assert.equal(routes.length,1);
    assert.equal(dispatched[1].envPairs,options.envPairs);
    assert.equal(dispatched[1].args.at(-1),'openai_base_url=http://127.0.0.1:43210/ready/');
    assert.equal(hook.ownsProcess(first),false);assert.equal(hook.ownsProcess(next),true);
  } finally {hook.close();}
});

test('an owned backend restart prepares fresh policy before replacing its live process',async()=>{
  const prototype={spawn(){return 'started';}},routes=[],file=path.resolve('codex.exe');let probes=0,complete;
  const policy={accountType:'apiKey',contract:contract()};
  const hook=installBackendSpawn({source:{reserveRoute(){const route={baseUrl:'http://127.0.0.1:43210/ready/',ready:Promise.resolve(),close(){route.closed=true;}};routes.push(route);return route;}},deadlineUnixMs:Date.now()+1000},{
    prototype,verify:()=>({binarySha256:'verified'}),probe:()=>++probes===1?policy:new Promise(resolve=>{complete=resolve;}),prepare:plan=>({arguments:plan.arguments})
  });
  const options={file,args:[file,'app-server'],envPairs:[]},first=new EventEmitter();
  try{
    await spawnPrepared(hook,prototype,first,options);assert.equal(hook.ownsProcess(first),true);
    const pending=hook.prepareConnection({proc:first},{forRestart:true});
    assert.equal(probes,2);assert.equal(routes[0].closed,undefined);assert.equal(hook.ownsProcess(first),true);
    complete(policy);await pending;
    const next=new EventEmitter();prototype.spawn.call(next,options);
    assert.equal(probes,2);assert.equal(hook.ownsProcess(next),true);assert.equal(routes.length,2);
  }finally{await hook.close();}
});

test('a failed restart leaves its owner alive and a later explicit retry probes again',async()=>{
  const prototype={spawn(){}},file=path.resolve('codex.exe');let probes=0;
  const hook=installBackendSpawn({source:{reserveRoute:()=>({baseUrl:'http://127.0.0.1:43210/ready/',ready:Promise.resolve(),close(){}})},deadlineUnixMs:Date.now()+1000},{
    prototype,verify:()=>({binarySha256:'verified'}),probe:()=>++probes===2?Promise.reject(Object.assign(Error(),{code:'backend_config_unavailable'})):{accountType:'apiKey',contract:contract()},prepare:plan=>({arguments:plan.arguments})
  });
  const child=new EventEmitter();
  try{
    await spawnPrepared(hook,prototype,child,{file,args:[file,'app-server'],envPairs:[]});
    await assert.rejects(hook.prepareConnection({proc:child},{forRestart:true}),{code:'backend_config_unavailable'});
    assert.equal(hook.ownsProcess(child),true);
    await hook.prepareConnection({proc:child},{forRestart:true});assert.equal(probes,3);
    const replacement=new EventEmitter();prototype.spawn.call(replacement,{file,args:[file,'app-server'],envPairs:[]});
    assert.equal(probes,3);assert.equal(hook.ownsProcess(replacement),true);assert.equal((await hook.ready()).available,true);
  }finally{await hook.close();}
});

test('closing a pending policy generation cannot publish routes or capture a later process', async () => {
  const prototype={spawn(){return 'native';}},original=prototype.spawn;
  let complete;
  const hook=installBackendSpawn({source:{reserveRoute(){assert.fail('retired policy must not register routes');}},deadlineUnixMs:Date.now()+1000},{
    prototype,verify(){return {binarySha256:'verified'};},probe(){return new Promise(resolve=>{complete=resolve;});}
  });
  const file=path.resolve('codex.exe'),child=new EventEmitter();
  prototype.spawn.call(child,{file,args:[file,'app-server'],envPairs:[]});
  hook.close();complete({accountType:'apiKey',contract:contract()});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prototype.spawn,original);
  assert.equal(hook.canRecover(child),false);
  assert.equal(hook.inspect().available,false);
});

test('late Native connection preparation reuses a verified policy across environment key ordering', async () => {
  const prototype={spawn(){return 'native';}},file=path.resolve('codex.exe');
  let probes=0;
  const hook=installBackendSpawn({source:{reserveRoute(){return {baseUrl:'http://127.0.0.1:43210/late/',ready:Promise.resolve(),close(){}};}},deadlineUnixMs:Date.now()+1000},{
    prototype,verify(){return {binarySha256:'verified'};},
    async probe(){probes++;return {accountType:'apiKey',contract:contract()};},
    prepare(plan){return {arguments:plan.arguments};}
  });
  const existing=Object.assign(new EventEmitter(),{spawnfile:file,spawnargs:[file,'app-server']});
  try {
    await hook.prepareConnection({proc:existing,options:{env:{SECOND:'two',FIRST:'one'},cwd:process.cwd()}});
    assert.equal(hook.canRecover(existing),true);
    const replacement=new EventEmitter();
    prototype.spawn.call(replacement,{file,args:[file,'app-server'],envPairs:['FIRST=one','SECOND=two']});
    assert.equal(probes,1);assert.equal(hook.ownsProcess(replacement),true);
    assert.equal((await hook.ready()).available,true);
  } finally {await hook.close();}
});

test('a pending route cannot publish a launch URL and failed preparation leaves a live child untouched', async () => {
  const dispatched=[],routes=[],prototype={spawn(options){dispatched.push(options);return 'native';}};
  let rejectRoute;
  const hook=installBackendSpawn({source:{reserveRoute(){const route={baseUrl:'http://127.0.0.1:43210/pending/',ready:new Promise((_resolve,reject)=>{rejectRoute=reject;}),close(){route.closed=true;}};routes.push(route);return route;}},deadlineUnixMs:Date.now()+1000},{
    prototype,verify:()=>({binarySha256:'verified'}),probe:()=>({accountType:'apiKey',contract:contract()}),prepare(){assert.fail('unconfirmed routes cannot reach Native');}
  });
  try {
    const file=path.resolve('codex.exe'), options={file,args:[file,'app-server'],envPairs:[]}, child=new EventEmitter();
    prototype.spawn.call(child,options); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(hook.canRecover(child),false); assert.equal(dispatched.length,1); assert.equal(dispatched[0],options);
    rejectRoute(Object.assign(Error(),{code:'backend_route_unavailable'})); await hook.ready();
    assert.equal(hook.canRecover(child),false); assert.equal(hook.ownsProcess(child),false); assert.equal(routes[0].closed,true);
    assert.equal(dispatched.length,1);
  } finally {await hook.close();}
});

test('exiting the waiting child retires its pending route objects and rejects their late receipt', async () => {
  let complete,route;
  const prototype={spawn(){return 'native';}},hook=installBackendSpawn({source:{reserveRoute(){return route={baseUrl:'http://127.0.0.1:43210/late/',ready:new Promise(resolve=>{complete=resolve;}),close(){route.closed=true;}};}},deadlineUnixMs:Date.now()+1000},{
    prototype,verify:()=>({binarySha256:'verified'}),probe:()=>({accountType:'apiKey',contract:contract()})
  });
  const child=new EventEmitter(),file=path.resolve('codex.exe');
  try {
    prototype.spawn.call(child,{file,args:[file,'app-server'],envPairs:[]}); await new Promise(resolve=>setImmediate(resolve));
    child.emit('exit'); assert.equal(route.closed,true); complete(); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(hook.canRecover(child),false); assert.equal(hook.inspect().policyReady,false); assert.equal(hook.ownsProcess(child),false);
  } finally {await hook.close();}
});
