import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

const source = readFileSync(new URL('../src/official_update_bridge.js', import.meta.url), 'utf8').replaceAll('import(', 'loadModule(');
const profiles = JSON.parse(readFileSync(new URL('../compatibility/official-update-profiles.json', import.meta.url), 'utf8')).builds;

function guardedFixture(){
  const profile=profiles.at(-1),token={id:'AppScope'},atom={},state={downloadProgressPercent:null,installProgressPercent:null,isUpdateReady:true,lifecycleState:'ready',relaunchNotice:null,supportsAutoInstallWhenIdle:false};
  const node={token,store:new Map([[atom,state]]),familyBindings:new Map()},chain=new Map([[token.id,node]]),root={__reactContainer$test:{memoizedProps:{value:chain}}};
  let installed=0,prompts=0,choice=()=>({accepted:false,suppress:false});const alerts=[];
  const services={appUpdates:{installUpdate(){assert.equal(this,services.appUpdates);installed++;}}},modules=new Map();
  const provide=(url,key,value)=>{if(!modules.has(url))modules.set(url,{});modules.get(url)[key]=value;};
  provide(profile.module,profile.officialUpdates.stateSelector,{scope:token,resolve:()=>({read:callback=>callback(atom)})});
  provide(profile.scopeModule??profile.module,profile.exports.scope,token);
  const serviceUrl=profile.servicesModule??profile.module;
  provide(serviceUrl,profile.exports.services,services);provide(serviceUrl,profile.exports.servicesSetter,value=>{modules.get(serviceUrl)[profile.exports.services]=value;});
  const window={};window.top=window;
  const context=vm.createContext({Map,window,crypto:{randomUUID},document:{scripts:[{src:profile.entry}],documentElement:{lang:'zh-CN'},getElementById:()=>root},location:{origin:'app://-',pathname:'/index.html'},electronBridge:{getSentryInitOptions:()=>profile},loadModule:async url=>modules.get(url),alert:message=>alerts.push(message),__codletRendererV1:{__confirmOfficialUpdate:async()=>{prompts++;return choice();}}});
  const run=action=>vm.runInContext(source.replace('__CODLET_PROFILES__',JSON.stringify({builds:[profile]})).replace('__CODLET_ACTION__',JSON.stringify(action)),context);
  return{run,state,services,alerts,choose:value=>{choice=value;},install:()=>modules.get(serviceUrl)[profile.exports.services].appUpdates.installUpdate(),current:()=>modules.get(serviceUrl)[profile.exports.services],counts:()=>({installed,prompts})};
}

test('Native update warning cancels cleanly, coalesces clicks, remembers suppression and restores its service',async()=>{
  const f=guardedFixture();await f.run({kind:'status',guard:true,warnBeforeUpdate:true});
  await f.install();assert.deepEqual(f.counts(),{installed:0,prompts:1});
  let resolve;f.choose(()=>new Promise(done=>{resolve=done;}));
  const first=f.install(),second=f.install();await Promise.resolve();assert.equal(f.counts().prompts,2);
  resolve({accepted:true,suppress:true});await new Promise(done=>setImmediate(done));
  const status=await f.run({kind:'status',guard:true,warnBeforeUpdate:true});assert.ok(status.warningRequest.id);assert.equal(f.counts().installed,0);
  await f.run({kind:'status',guard:true,warnBeforeUpdate:false,warningReceipt:{id:status.warningRequest.id,saved:true}});await Promise.all([first,second]);
  assert.equal(f.counts().installed,1);await f.install();assert.deepEqual(f.counts(),{installed:2,prompts:2});
  await f.run({kind:'dispose'});assert.equal(f.current(),f.services);
});

test('a preference write failure does not revoke the confirmed Native update and combined dispatch has its own consent',async()=>{
  const f=guardedFixture();await f.run({kind:'status',guard:true,warnBeforeUpdate:true});f.choose(()=>({accepted:true,suppress:true}));
  const pending=f.install();await new Promise(done=>setImmediate(done));const status=await f.run({kind:'status',guard:true,warnBeforeUpdate:true});
  await f.run({kind:'status',guard:true,warnBeforeUpdate:true,warningReceipt:{id:status.warningRequest.id,saved:false}});await pending;
  assert.equal(f.counts().installed,1);assert.equal(f.alerts.length,1);
  await f.run({kind:'install',id:'combined-test'});assert.deepEqual(f.counts(),{installed:2,prompts:1});await f.run({kind:'dispose'});
});

for (const profile of profiles) test(`update bridge binds the observed entry and service for ${profile.appVersion}/${profile.buildNumber}/${profile.entry}`, async () => {
  const token = { id: 'AppScope' }, atom = {}, state = { downloadProgressPercent: null, installProgressPercent: null,
    isUpdateReady: true, lifecycleState: 'ready', relaunchNotice: null, supportsAutoInstallWhenIdle: false };
  const node = { token, store: new Map([[atom, state]]), familyBindings: new Map() };
  const chain = new Map([[token.id, node]]), root = { __reactContainer$test: { memoizedProps: { value: chain } } };
  let installed = 0;
  const selector = { scope: token, resolve() { return { read(callback) { callback(atom); } }; } };
  const modules = new Map(), imports = [];
  const provide = (url, name, value) => { if (!modules.has(url)) modules.set(url, {}); modules.get(url)[name] = value; };
  provide(profile.module, profile.officialUpdates.stateSelector, selector);
  provide(profile.scopeModule ?? profile.module, profile.exports.scope, token);
  provide(profile.servicesModule ?? profile.module, profile.exports.services, { appUpdates: { installUpdate() { installed++; } } });
  const window = {}; window.top = window;
  const document = { scripts: [{ src: profile.entry }], getElementById: () => root };
  const context = vm.createContext({ Map, window, document,
    location: { origin: 'app://-', pathname: '/index.html' }, electronBridge: { getSentryInitOptions: () => profile },
    loadModule: async url => { imports.push(url); return modules.get(url); } });
  const otherPlatform = { ...profile, entry: 'app://-/assets/other-platform-entry.js', module: 'app://-/assets/other-platform-module.js' };
  const run = async action => JSON.parse(JSON.stringify(await vm.runInContext(source.replace('__CODLET_PROFILES__', JSON.stringify({ builds: [otherPlatform, profile] }))
    .replace('__CODLET_ACTION__', JSON.stringify(action)), context)));
  assert.deepEqual(await run({ kind: 'probe' }), { available: true, phase: 'ready', isUpdateReady: true });
  assert.deepEqual(imports, [...new Set([profile.module, profile.scopeModule, profile.servicesModule].filter(Boolean))]);
  assert.deepEqual(await run({ kind: 'install', id: 'fixture-install' }), { available: true, phase: 'ready', isUpdateReady: true, accepted: true });
  assert.equal(installed, 1);
  assert.deepEqual(await run({ kind: 'install', id: 'fixture-install' }), { available: true, phase: 'ready', isUpdateReady: true, accepted: true });
  assert.equal(installed, 1);
  state.lifecycleState = 'idle'; state.isUpdateReady = false;
  await run({ kind: 'retire', id: 'fixture-install' });
  assert.equal((await run({ kind: 'install', id: 'not-ready' })).accepted, false);
  state.lifecycleState = 'ready'; state.isUpdateReady = true;
  const previousImports = imports.length;
  document.scripts = [{ src: 'app://-/assets/unreviewed-entry.js' }];
  assert.deepEqual(await run({ kind: 'install', id: 'unknown-entry' }), { available: false, reason: 'profile' });
  document.scripts = [{ src: profile.entry }, { src: otherPlatform.entry }];
  assert.deepEqual(await run({ kind: 'install', id: 'ambiguous-entry' }), { available: false, reason: 'profile' });
  assert.equal(imports.length, previousImports);
  assert.equal(installed, 1);
});
