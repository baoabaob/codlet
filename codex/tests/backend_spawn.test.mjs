import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { installBackendSpawn, effectiveProviders, providerTrust, lastStringOverride } = createRequire(import.meta.url)('../host/backend-spawn.cjs');

test('effective provider routing preserves ChatGPT/API-key defaults and custom response providers', () => {
  assert.equal(effectiveProviders({accountType:'chatgpt'}).get('openai_base_url'),'https://chatgpt.com/backend-api/codex');
  assert.equal(effectiveProviders({accountType:'apiKey'}).get('openai_base_url'),'https://api.openai.com/v1');
  const routes=effectiveProviders({accountType:'chatgpt',openaiBaseUrl:'https://owned.example/v2',providerBaseUrls:{custom:'https://custom.example/v1'}});
  assert.deepEqual([...routes],[['openai_base_url','https://owned.example/v2'],['model_providers.custom.base_url','https://custom.example/v1']]);
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
    probe(){return {accountType:'chatgpt',providerBaseUrls:{custom:'https://custom.example/v1'}}},
    prepare(plan){return {arguments:[...plan.arguments,'-c',`openai_base_url=${plan.providerRoutes.openai_base_url}`,'-c',`model_providers.custom.base_url=${plan.providerRoutes['model_providers.custom.base_url']}`]}}});
  try {
    const unrelated={file:process.execPath,args:[process.execPath,'--version'],envPairs:['OTHER=original']};
    prototype.spawn.call(new EventEmitter(),unrelated);
    assert.equal(dispatched[0],unrelated);
    const executable=path.resolve('codex.exe');
    const owned={file:executable,args:[executable,'app-server','--stdio'],envPairs:Object.entries(environment).map(([key,value])=>`${key}=${value}`)};
    const child=new EventEmitter();prototype.spawn.call(child,owned);
    assert.equal((await hook.ready()).available,true);
    assert.equal(reservations.length,2);
    assert.deepEqual(reservations.map(value=>value.upstreamBaseUrl),['https://chatgpt.com/backend-api/codex','https://custom.example/v1']);
    assert.equal(dispatched[1].envPairs,owned.envPairs);
    assert.equal(dispatched[1].args.at(-1),'model_providers.custom.base_url=http://127.0.0.1:43210/r1/');
    assert.equal(environment.HTTPS_PROXY,'http://corporate.invalid');
    hook.updateAccountMode(child,'apiKey');await hook.pendingAccountUpdate(child);
    assert.deepEqual(reservations[0].updated,{upstreamBaseUrl:'https://api.openai.com/v1'});
    child.emit('exit');assert(reservations.every(value=>value.closed));
  } finally {hook.close();assert.equal(prototype.spawn,original);}
});

test('existing provider CA is passed only as a scoped route trust input', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-trust-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'owned.pem');fs.writeFileSync(file,'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n');
  assert.match(providerTrust({CODEX_CA_CERTIFICATE:file,SSL_CERT_FILE:'ignored'},directory),/BEGIN CERTIFICATE/u);
  assert.equal(providerTrust({OTHER:'value'},directory),undefined);
  assert.throws(()=>providerTrust({CODEX_CA_CERTIFICATE:''},directory),{code:'backend_provider_trust_unsupported'});
});

test('unverified backend uses its original launch and reports only backend source unsupported', async () => {
  const dispatched=[],prototype={spawn(value){dispatched.push(value);return 'original';}};
  const hook=installBackendSpawn({source:{reserveRoute(){throw Error('should not route')}},runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+1000},{prototype,verify(){throw Object.assign(Error('unverified'),{code:'backend_build_unverified'})}});
  try {
    const executable=path.resolve('codex.exe'),options={file:executable,args:[executable,'app-server'],envPairs:['OTHER=original']};
    assert.equal(prototype.spawn.call(new EventEmitter(),options),'original');
    assert.equal(dispatched[0],options);
    assert.equal((await hook.ready()).reason,'backend_build_unverified');
  } finally {hook.close();}
});

test('client-owned backend routes and process identity survive source replacement and close only with the child',async()=>{
  const routes=[],state={owned:new WeakSet(),trust:new WeakMap(),accounts:new WeakMap(),providers:new WeakMap(),records:new Set(),pending:new Set(),prepared:0};
  const source={reserveRoute(){const route={baseUrl:'http://127.0.0.1:43210/owned/',ready:Promise.resolve(),closed:false,close(){route.closed=true;}};routes.push(route);return route;}};
  const prototype={spawn(){return 'started';}},original=prototype.spawn;
  const dependencies={prototype,state,verify(){},probe(){return {accountType:'apiKey'};},prepare(plan){return {arguments:plan.arguments};}};
  const configuration={source,runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+1000};
  const first=installBackendSpawn(configuration,dependencies),child=new EventEmitter(),file=path.resolve('codex.exe');
  prototype.spawn.call(child,{file,args:[file,'app-server'],envPairs:[]});
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
