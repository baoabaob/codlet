import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../runtime/skill-bridge.js',import.meta.url),'utf8').replaceAll('import(','loadModule(');
const profiles=JSON.parse(readFileSync(new URL('../compatibility/client-profiles.json',import.meta.url),'utf8')).builds.filter(p=>p.runtimeSkill);
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,0));};

function fixture(t,profile,{entry=true,version=profile.appVersion,reviewedProfiles=profiles}={}){
  const calls=[],coreCalls=[],imports=[];let registered=false,ticket=0;
  const client={getAppServerVersion:()=>profile.appServerVersion,setAppServerVersion(){},async sendRequest(method,params){calls.push({method,params});return {};}};
  const original=client.sendRequest,token={id:'scope'},family={read:()=>client},node={token,familyBindings:new Map([[family,new Map([['local',client]])]])};
  const root={__reactContainer$test:{memoizedProps:{value:new Map([['scope',node]])}}};
  const document={scripts:entry?[{src:profile.entry}]:[],readyState:'loading',getElementById:()=>root};
  const nativeModule={[profile.exports.client]:family};
  const scopeModule=profile.scopeModule?{[profile.exports.scope]:token}:nativeModule;
  if(!profile.scopeModule)nativeModule[profile.exports.scope]=token;
  const context=vm.createContext({console,setTimeout,clearTimeout,Map,Set,Symbol,location:{origin:'app://-',pathname:'/index.html'},document,electronBridge:{getSentryInitOptions:()=>({appVersion:version,buildNumber:profile.buildNumber})},loadModule:async resource=>{imports.push(resource);if(resource===profile.module)return nativeModule;assert.equal(resource,profile.scopeModule);return scopeModule;}});
  const config={marker:'test.skill',binding:'skillBinding',root:'/runtime',skillPath:'/runtime/codlet/SKILL.md',profiles:reviewedProfiles};
  const state=()=>vm.runInContext('globalThis[Symbol.for("test.skill")]',context);
  context.skillBinding=text=>{const input=JSON.parse(text);coreCalls.push(input.action);let reply;
    if(input.action==='complete'){registered=input.ok;reply={ready:registered};}
    else if(input.action==='invalidate'){registered=false;reply={ready:false};}
    else reply=input.action==='ensure'&&registered?{ready:true}:{ticket:++ticket,roots:[...(input.roots??[]).filter(p=>p!==config.root),config.root]};
    queueMicrotask(()=>state()?.receive(input.id,reply));
  };
  const install=vm.runInContext('('+source+')',context);install(config);
  t.after(()=>state()?.dispose([]));
  return {client,original,nativeModule,scopeModule,context,config,calls,coreCalls,imports,document,state};
}
for(const profile of profiles)test(`${profile.appVersion}: runtime skill reuses the native connection without a GUI and only adds an explicitly invoked skill`,async t=>{
  const f=fixture(t,profile),{client,calls,coreCalls,config}=f;
  const exports={...f.nativeModule},scopeExports={...f.scopeModule};Object.keys(f.nativeModule).forEach(k=>delete f.nativeModule[k]);Object.keys(f.scopeModule).forEach(k=>delete f.scopeModule[k]);
  await settle();assert.equal(f.state().status,'starting');
  Object.assign(f.nativeModule,exports);Object.assign(f.scopeModule,scopeExports);await new Promise(resolve=>setTimeout(resolve,130));await settle();
  assert.equal(f.state().status,'ready');assert.equal(calls[0].method,'skills/extraRoots/set');
  assert.deepEqual(f.imports,profile.scopeModule?[profile.module,profile.scopeModule]:[profile.module]);
  await client.sendRequest('skills/list',{cwds:['/project']});assert.equal(calls.filter(c=>c.method==='skills/extraRoots/set').length,1);
  await client.sendRequest('skills/extraRoots/set',{extraRoots:['/another-root']});assert.deepEqual([...calls.at(-1).params.extraRoots],['/another-root','/runtime']);
  await client.sendRequest('turn/start',{threadId:'one',input:[{type:'text',text:'/codlet 帮我创建一个插件：'}]});
  assert.equal(calls.at(-1).params.input.at(-1).type,'skill');assert.equal(calls.at(-1).params.input.at(-1).path,config.skillPath);
  await client.sendRequest('turn/start',{threadId:'two',input:[{type:'text',text:'regular message mentioning /codlet elsewhere'}]});assert.equal(calls.at(-1).params.input.length,1);
  client.setAppServerVersion(profile.appServerVersion);await settle();await client.sendRequest('skills/list',{});assert.ok(coreCalls.includes('invalidate'));
  await f.state().dispose(['/another-root']);assert.equal(client.sendRequest,f.original);assert.deepEqual([...calls.at(-1).params.extraRoots],['/another-root']);
});
test('cold documents wait for the reviewed entry, and disposal cancels every pending wait',async t=>{
  const f=fixture(t,profiles.at(-1),{entry:false});await settle();
  assert.equal(f.state().status,'starting');assert.equal(f.imports.length,0);
  f.document.scripts.push({src:profiles.at(-1).entry});
  await new Promise(r=>setTimeout(r,70));await settle();assert.equal(f.state().status,'ready');
  const waiting=fixture(t,profiles[0],{entry:false});await settle();const old=waiting.state();
  assert.equal(old.delays.size,1);await old.dispose([]);await settle();
  assert.equal(old.delays.size,0);assert.equal(waiting.imports.length,0);assert.equal(waiting.state(),undefined);
});
test('unknown builds and a changed entry never import native modules or alter the connection',async t=>{
  const unknown=fixture(t,profiles[0],{version:'unreviewed'});await settle();
  assert.equal(unknown.state().status,'failed');assert.equal(unknown.client.sendRequest,unknown.original);assert.equal(unknown.imports.length,0);
  const changed=fixture(t,profiles.at(-1),{entry:false});changed.document.readyState='complete';
  await new Promise(r=>setTimeout(r,70));await settle();
  assert.equal(changed.state().status,'failed');assert.equal(changed.imports.length,0);assert.equal(changed.client.sendRequest,changed.original);
});

test('runtime skill distinguishes same-version platform entries and rejects ambiguity',async t=>{
  const profile=profiles.at(-1),other={...profile,entry:'app://-/assets/other-platform-entry.js',module:'app://-/assets/other-platform-module.js'};
  const f=fixture(t,profile,{reviewedProfiles:[other,profile]});await settle();
  assert.equal(f.state().status,'ready');
  assert.deepEqual(f.imports,profile.scopeModule?[profile.module,profile.scopeModule]:[profile.module]);
  const ambiguous=fixture(t,profile,{entry:false,reviewedProfiles:[other,profile]});
  ambiguous.document.scripts.push({src:other.entry},{src:profile.entry});
  await new Promise(r=>setTimeout(r,70));await settle();
  assert.equal(ambiguous.state().status,'failed');assert.match(ambiguous.state().error,/ambiguous/);
  assert.equal(ambiguous.imports.length,0);assert.equal(ambiguous.client.sendRequest,ambiguous.original);
});
